import type { Ctx } from "./accounts";
import {
  connectionToken,
  connectionsDue,
  listScheduledLoans,
  recordAttempt,
  recordBalance,
  saveLinkedAccounts,
  type Connection,
  type ConnectionStatus,
} from "./finance";
import { ProviderError } from "./providers/http";
import { plaidBalanceCents, toLinkedAccount as plaidAccount, type PlaidClient } from "./providers/plaid";
import { projectLoan } from "@/lib/amortization";
import { dateKey } from "@/lib/local-date";

/**
 * Fetching balances: one connection at a time, each writing today's
 * snapshot for every account it reports. Errors are recorded on the
 * connection by code — the page turns them into "reconnect" buttons — and
 * never stop the others.
 */

export interface Providers {
  plaid: PlaidClient | null;
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
  return accounts.length;
}

/** Today's projected balance for every scheduled loan (or one user's). */
export function syncScheduledLoans(ctx: Ctx, now: number, userId?: number) {
  const day = dateKey(now);
  for (const loan of listScheduledLoans(ctx.db, userId)) {
    const position = projectLoan(loan.schedule, day);
    recordBalance(ctx.db, loan.accountId, day, position.balanceCents, null, now);
  }
}

/** One pass of the scheduler: every connection that's due, then the loans. */
export async function syncDue(ctx: Ctx, providers: Providers, now: number) {
  const due = connectionsDue(ctx.db, now - REFRESH_EVERY_MS, now - RETRY_AFTER_MS);
  for (const connection of due) {
    await syncConnection(ctx, providers, connection, Date.now());
  }
  syncScheduledLoans(ctx, now);
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
