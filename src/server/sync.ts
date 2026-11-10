import type { Ctx } from "./accounts";
import {
  connectionToken,
  connectionsDue,
  listAssets,
  listScheduledLoans,
  recordAttempt,
  recordBalance,
  saveLinkedAccounts,
  setConnectionProducts,
  transactionsCursor,
  type Connection,
  type ConnectionStatus,
} from "./finance";
import { ProviderError } from "./providers/http";
import { plaidBalanceCents, toLinkedAccount as plaidAccount, type PlaidClient } from "./providers/plaid";
import { applyTransactions } from "./transactions";
import { refreshHomeEstimates } from "./home-estimates";
import type { RentcastClient } from "./providers/rentcast";
import { homeIndex, homeIndexDue, refreshHomeIndex, type LineSource } from "./home-index";
import { projectLoan } from "@/lib/amortization";
import { estimateAsset, type IndexPoint } from "@/lib/valuation";
import { dateKey } from "@/lib/local-date";

/**
 * Fetching balances: one connection at a time, each writing today's
 * snapshot for every account it reports. Errors are recorded on the
 * connection by code — the page turns them into "reconnect" buttons — and
 * never stop the others.
 */

export interface Providers {
  plaid: PlaidClient | null;
  /** Home values by address; null (or absent) until RENTCAST_API_KEY is set. */
  rentcast?: RentcastClient | null;
}

const HOUR = 60 * 60_000;
/** Each connection is refreshed about once a day — Plaid's own cache updates daily. */
export const REFRESH_EVERY_MS = 20 * HOUR;
/** After a passing failure, try again in an hour. */
export const RETRY_AFTER_MS = HOUR;

export interface SyncResult {
  status: ConnectionStatus;
  code: string | null;
  accounts: number;
}

export async function syncConnection(ctx: Ctx, providers: Providers, connection: Connection, now: number): Promise<SyncResult> {
  const day = dateKey(now);
  try {
    const token = connectionToken(ctx, connection);
    if (!providers.plaid) throw new ProviderError("plaid", 0, "not_configured", false, true);
    const count = await syncPlaid(ctx, providers.plaid, connection, token, day, now);
    recordAttempt(ctx.db, connection.id, { status: "ok" }, now);
    return { status: "ok", code: null, accounts: count };
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : null;
    const status: ConnectionStatus = providerError?.needsReconnect ? "reconnect" : "error";
    const code = providerError?.code ?? "unexpected";
    // Code and connection id only: messages and bodies can carry account details.
    console.warn(`[moneyright] sync of connection #${connection.id} (${connection.provider}) failed: ${code}`);
    if (!providerError) console.warn(error instanceof Error ? error.name : "non-error thrown");
    recordAttempt(ctx.db, connection.id, { status, code }, now);
    return { status, code, accounts: 0 };
  }
}

async function syncPlaid(ctx: Ctx, plaid: PlaidClient, connection: Connection, token: string, day: string, now: number) {
  const { accounts } = await plaid.getAccounts(token);
  const ids = saveLinkedAccounts(ctx.db, connection, accounts.map(plaidAccount), now);
  for (const account of accounts) {
    const { balance, available } = plaidBalanceCents(account);
    if (balance !== null) recordBalance(ctx.db, ids.get(account.account_id)!, day, balance, available, now);
  }
  await syncTransactions(ctx, plaid, connection, token, ids, now);
  return accounts.length;
}

/**
 * New, changed and removed transactions since the last sync — only for an
 * Item that already has Transactions (asking any other would add the product
 * and its billing). A failure here is logged and retried next refresh; the
 * balances above still count.
 */
async function syncTransactions(
  ctx: Ctx,
  plaid: PlaidClient,
  connection: Connection,
  token: string,
  ids: Map<string, number>,
  now: number,
) {
  try {
    const products = await plaid.getItemProducts(token);
    setConnectionProducts(ctx.db, connection.id, products);
    if (!products.includes("transactions")) return;
    const page = await plaid.syncTransactions(token, transactionsCursor(ctx.db, connection.id));
    applyTransactions(ctx.db, connection.id, ids, page, now);
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : "unexpected";
    console.warn(`[moneyright] transactions for connection #${connection.id} failed: ${code}`);
  }
}

/** Today's projected balance for every scheduled loan (or one user's). */
export function syncScheduledLoans(ctx: Ctx, now: number, userId?: number) {
  const day = dateKey(now);
  for (const loan of listScheduledLoans(ctx.db, userId)) {
    const position = projectLoan(loan.schedule, day);
    recordBalance(ctx.db, loan.accountId, day, position.balanceCents, null, now);
  }
}

/** Today's estimated value for every asset (or one user's). */
export function syncAssets(ctx: Ctx, now: number, userId?: number) {
  const day = dateKey(now);
  const indexes = new Map<string, IndexPoint[]>();
  for (const asset of listAssets(ctx.db, userId)) {
    const zip = asset.valuation.method === "home_index" ? asset.valuation.zip : null;
    if (zip && !indexes.has(zip)) indexes.set(zip, homeIndex(ctx.db, zip));
    const estimate = estimateAsset(asset.valuation, day, zip ? indexes.get(zip) : []);
    recordBalance(ctx.db, asset.accountId, day, estimate.valueCents, null, now);
  }
}

/**
 * Downloads home values if they're due, then re-estimates every asset. A
 * failure is recorded (homeIndexStatus) and estimates carry on from the
 * readings already kept. One download at a time, however it was started.
 */
let homeIndexRunning: Promise<boolean> | null = null;

export function syncHomeIndex(ctx: Ctx, now: number, source?: LineSource): Promise<boolean> {
  homeIndexRunning ??= (async () => {
    try {
      if (!homeIndexDue(ctx.db, now)) return false;
      try {
        const found = await refreshHomeIndex(ctx.db, now, source);
        console.log(`[moneyright] home value index refreshed for ${found} ZIP code${found === 1 ? "" : "s"}`);
      } catch (error) {
        console.warn("[moneyright] home value index refresh failed:", error instanceof Error ? error.message : "unexpected");
      }
      syncAssets(ctx, now);
      return true;
    } finally {
      homeIndexRunning = null;
    }
  })();
  return homeIndexRunning;
}

/** One pass of the scheduler: every connection that's due, then the loans and assets. */
export async function syncDue(ctx: Ctx, providers: Providers, now: number) {
  const due = connectionsDue(ctx.db, now - REFRESH_EVERY_MS, now - RETRY_AFTER_MS);
  for (const connection of due) {
    await syncConnection(ctx, providers, connection, Date.now());
  }
  syncScheduledLoans(ctx, now);
  if (providers.rentcast) {
    try {
      const count = await refreshHomeEstimates(ctx.db, providers.rentcast, now);
      if (count) console.log(`[moneyright] re-estimated ${count} home${count === 1 ? "" : "s"} from their address`);
    } catch (error) {
      console.warn("[moneyright] home estimates failed:", error instanceof Error ? error.name : "unexpected");
    }
  }
  syncAssets(ctx, now);
  await syncHomeIndex(ctx, now);
  return due.length;
}

/**
 * Withdraws this app's access at the provider. Best effort: a token that's
 * already dead is harmless, and the person asked for it gone either way.
 */
export async function revokeConnection(ctx: Ctx, providers: Providers, connection: Connection) {
  try {
    const token = connectionToken(ctx, connection);
    await providers.plaid?.removeItem(token);
  } catch (error) {
    console.warn(
      `[moneyright] revoking connection #${connection.id} failed:`,
      error instanceof ProviderError ? error.code : "unexpected",
    );
  }
}
