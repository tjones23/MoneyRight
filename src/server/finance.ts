import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import { pruneHomeIndex } from "./home-index";
import { AccountError, type Ctx } from "./accounts";
import { open, seal } from "@/lib/sealed";
import { isLiability, type AccountKind } from "@/lib/account-kinds";
import type { LoanSchedule } from "@/lib/amortization";
import type { AssetValuation, ValuationMethod } from "@/lib/valuation";
import type { DateKey } from "@/lib/local-date";

/**
 * Connections, accounts, balances and loan schedules: the money side of the
 * database, framework-free like accounts.ts. Every read and write that takes
 * a `userId` is scoped to it, so one person can never touch another's rows
 * by guessing an id.
 */

export type Provider = "plaid";
export type ConnectionStatus = "ok" | "reconnect" | "error";

export interface Connection {
  id: number;
  userId: number;
  provider: Provider;
  externalId: string;
  institutionName: string;
  status: ConnectionStatus;
  statusCode: string | null;
  lastSyncedAt: number | null;
  lastAttemptAt: number | null;
  createdAt: number;
  /** The Item's products, once a refresh has asked; null before that. */
  products: string[] | null;
  transactionsSyncedAt: number | null;
}

interface ConnectionRow {
  id: number;
  user_id: number;
  provider: Provider;
  external_id: string;
  institution_name: string;
  access_token: string;
  status: ConnectionStatus;
  status_code: string | null;
  last_synced_at: number | null;
  last_attempt_at: number | null;
  created_at: number;
  products: string | null;
  transactions_synced_at: number | null;
}

function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    externalId: row.external_id,
    institutionName: row.institution_name,
    status: row.status,
    statusCode: row.status_code,
    lastSyncedAt: row.last_synced_at,
    lastAttemptAt: row.last_attempt_at,
    createdAt: row.created_at,
    products: row.products === null || row.products === undefined ? null : row.products.split(",").filter(Boolean),
    transactionsSyncedAt: row.transactions_synced_at ?? null,
  };
}

function tokenContext(provider: Provider, externalId: string) {
  return `token:${provider}:${externalId}`;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface NewConnection {
  userId: number;
  provider: Provider;
  externalId: string;
  institutionName: string;
  accessToken: string;
}

/**
 * Saves a link, or refreshes one that already exists (a reconnect can hand
 * back the same enrollment). A link already saved by someone else is refused.
 */
export function saveConnection(ctx: Ctx, link: NewConnection, now: number): Connection {
  const sealed = seal(ctx.key, link.accessToken, tokenContext(link.provider, link.externalId));
  return transaction(ctx.db, () => {
    const existing = ctx.db
      .prepare("SELECT * FROM connections WHERE provider = ? AND external_id = ?")
      .get(link.provider, link.externalId) as ConnectionRow | undefined;
    if (existing && existing.user_id !== link.userId) throw new AccountError("That login is already linked by someone else.");
    if (existing) {
      ctx.db
        .prepare(
          "UPDATE connections SET access_token = ?, institution_name = ?, status = 'ok', status_code = NULL WHERE id = ?",
        )
        .run(sealed, link.institutionName, existing.id);
      return toConnection({ ...existing, access_token: sealed, status: "ok", status_code: null });
    }
    const result = ctx.db
      .prepare(
        "INSERT INTO connections (user_id, provider, external_id, institution_name, access_token, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(link.userId, link.provider, link.externalId, link.institutionName, sealed, now);
    return getConnectionById(ctx.db, Number(result.lastInsertRowid))!;
  });
}

function getConnectionById(db: DatabaseSync, id: number): Connection | null {
  const row = db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined;
  return row ? toConnection(row) : null;
}

export function getConnection(db: DatabaseSync, userId: number, id: number): Connection | null {
  const row = db.prepare("SELECT * FROM connections WHERE id = ? AND user_id = ?").get(id, userId) as
    | ConnectionRow
    | undefined;
  return row ? toConnection(row) : null;
}

export function listConnections(db: DatabaseSync, userId: number): Connection[] {
  return (
    db.prepare("SELECT * FROM connections WHERE user_id = ? ORDER BY institution_name, id").all(userId) as unknown as ConnectionRow[]
  ).map(toConnection);
}

/**
 * Everyone's connections due a refresh: not tried since `before`, or — after
 * a passing failure (the bank down, a rate limit) — not since `errorBefore`.
 */
export function connectionsDue(db: DatabaseSync, before: number, errorBefore: number): Connection[] {
  return (
    db
      .prepare(
        `SELECT * FROM connections
         WHERE last_attempt_at IS NULL OR last_attempt_at < ? OR (status = 'error' AND last_attempt_at < ?)
         ORDER BY id`,
      )
      .all(before, errorBefore) as unknown as ConnectionRow[]
  ).map(toConnection);
}

/** The decrypted access token. Only the provider clients should see it. */
export function connectionToken(ctx: Ctx, connection: Connection): string {
  const row = ctx.db.prepare("SELECT access_token FROM connections WHERE id = ?").get(connection.id) as {
    access_token: string;
  };
  return open(ctx.key, row.access_token, tokenContext(connection.provider, connection.externalId)).toString();
}

export function recordAttempt(
  db: DatabaseSync,
  id: number,
  outcome: { status: ConnectionStatus; code?: string | null },
  now: number,
) {
  db.prepare(
    `UPDATE connections SET status = ?, status_code = ?, last_attempt_at = ?,
       last_synced_at = CASE WHEN ? = 'ok' THEN ? ELSE last_synced_at END
     WHERE id = ?`,
  ).run(outcome.status, outcome.code ?? null, now, outcome.status, now, id);
}

export function setConnectionProducts(db: DatabaseSync, id: number, products: string[]) {
  db.prepare("UPDATE connections SET products = ? WHERE id = ?").run(products.join(","), id);
}

/** The cursor Plaid's transaction sync resumes from; null before the first sync. */
export function transactionsCursor(db: DatabaseSync, id: number): string | null {
  const row = db.prepare("SELECT transactions_cursor FROM connections WHERE id = ?").get(id) as
    | { transactions_cursor: string | null }
    | undefined;
  return row?.transactions_cursor || null;
}

export function deleteConnection(db: DatabaseSync, userId: number, id: number) {
  db.prepare("DELETE FROM connections WHERE id = ? AND user_id = ?").run(id, userId);
}

// ---------------------------------------------------------------------------
// Plaid's lifetime Item cap
//
// The Trial plan allows 10 Production Items, ever: removing one doesn't give
// its slot back. Counted per database (Plaid counts per team, and this Mac is
// the team's only user), and only for production links.
// ---------------------------------------------------------------------------

export const PLAID_TRIAL_ITEMS = 10;

export function plaidItemsUsed(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'plaid_items_created'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function countPlaidItem(db: DatabaseSync) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('plaid_items_created', '1')
     ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
  ).run();
}

// ---------------------------------------------------------------------------
// Accounts and balances
// ---------------------------------------------------------------------------

export interface LinkedAccount {
  externalId: string;
  name: string;
  kind: AccountKind;
  subtype: string | null;
  mask: string | null;
  currency: string;
}

/** Saves each account a connection reports, and marks any it stopped reporting as gone. Returns ids by external id. */
export function saveLinkedAccounts(
  db: DatabaseSync,
  connection: Connection,
  accounts: LinkedAccount[],
  now: number,
): Map<string, number> {
  const ids = new Map<string, number>();
  transaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO accounts (user_id, connection_id, external_id, name, institution_name, kind, subtype, mask, currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, external_id) DO UPDATE SET
         name = excluded.name, institution_name = excluded.institution_name, kind = excluded.kind,
         subtype = excluded.subtype, mask = excluded.mask, currency = excluded.currency, gone = 0
       RETURNING id`,
    );
    for (const a of accounts) {
      const row = upsert.get(
        connection.userId,
        connection.id,
        a.externalId,
        a.name,
        connection.institutionName,
        a.kind,
        a.subtype,
        a.mask,
        a.currency,
        now,
      ) as { id: number };
      ids.set(a.externalId, row.id);
    }
    const keep = [...ids.values()];
    db.prepare(
      `UPDATE accounts SET gone = 1 WHERE connection_id = ? AND id NOT IN (${keep.map(() => "?").join(",") || "NULL"})`,
    ).run(connection.id, ...keep);
  });
  return ids;
}

export function recordBalance(
  db: DatabaseSync,
  accountId: number,
  day: DateKey,
  balanceCents: number,
  availableCents: number | null,
  now: number,
) {
  db.prepare(
    `INSERT INTO balance_snapshots (account_id, day, balance_cents, available_cents, recorded_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, day) DO UPDATE SET
       balance_cents = excluded.balance_cents, available_cents = excluded.available_cents, recorded_at = excluded.recorded_at`,
  ).run(accountId, day, balanceCents, availableCents, now);
}

export interface AccountView {
  id: number;
  connectionId: number | null;
  name: string;
  institutionName: string;
  kind: AccountKind;
  subtype: string | null;
  mask: string | null;
  includeInNetWorth: boolean;
  gone: boolean;
  balanceCents: number | null;
  balanceDay: DateKey | null;
  balanceRecordedAt: number | null;
  /** Linked through a provider, projected from a loan schedule, or an estimated asset value. */
  source: Provider | "schedule" | "estimate";
  connectionStatus: ConnectionStatus | null;
}

/** Each of the user's accounts with its latest balance. */
export function listAccounts(db: DatabaseSync, userId: number): AccountView[] {
  const rows = db
    .prepare(
      `SELECT a.*, c.provider, c.status AS connection_status, v.account_id AS valuation_id,
              s.balance_cents, s.day AS balance_day, s.recorded_at AS balance_recorded_at
       FROM accounts a
       LEFT JOIN connections c ON c.id = a.connection_id
       LEFT JOIN asset_valuations v ON v.account_id = a.id
       LEFT JOIN balance_snapshots s ON s.account_id = a.id
         AND s.day = (SELECT MAX(day) FROM balance_snapshots WHERE account_id = a.id)
       WHERE a.user_id = ?
       ORDER BY a.institution_name, a.name, a.id`,
    )
    .all(userId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    connectionId: (r.connection_id as number | null) ?? null,
    name: r.name as string,
    institutionName: r.institution_name as string,
    kind: r.kind as AccountKind,
    subtype: (r.subtype as string | null) ?? null,
    mask: (r.mask as string | null) ?? null,
    includeInNetWorth: r.include_in_net_worth === 1,
    gone: r.gone === 1,
    balanceCents: (r.balance_cents as number | null) ?? null,
    balanceDay: (r.balance_day as string | null) ?? null,
    balanceRecordedAt: (r.balance_recorded_at as number | null) ?? null,
    source: r.connection_id !== null ? (r.provider as Provider) : r.valuation_id !== null ? "estimate" : "schedule",
    connectionStatus: (r.connection_status as ConnectionStatus | null) ?? null,
  }));
}

/** Every snapshot of the user's accounts (or one of them) up to `to`. */
export function snapshots(db: DatabaseSync, userId: number, to: DateKey, accountId?: number) {
  return db
    .prepare(
      `SELECT s.account_id, s.day, s.balance_cents FROM balance_snapshots s
       JOIN accounts a ON a.id = s.account_id
       WHERE a.user_id = ? AND s.day <= ? ${accountId === undefined ? "" : "AND a.id = ?"}
       ORDER BY s.day`,
    )
    .all(userId, to, ...(accountId === undefined ? [] : [accountId]))
    .map((r) => ({ accountId: r.account_id as number, day: r.day as string, balanceCents: r.balance_cents as number }));
}

/** One of the user's accounts, or null. */
export function getAccount(db: DatabaseSync, userId: number, accountId: number): AccountView | null {
  return listAccounts(db, userId).find((a) => a.id === accountId) ?? null;
}

/** The earliest day this user has any balance for. */
export function firstBalanceDay(db: DatabaseSync, userId: number): DateKey | null {
  const row = db
    .prepare(
      "SELECT MIN(s.day) AS day FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?",
    )
    .get(userId) as { day: string | null };
  return row.day;
}

export function setIncludeInNetWorth(db: DatabaseSync, userId: number, accountId: number, include: boolean) {
  db.prepare("UPDATE accounts SET include_in_net_worth = ? WHERE id = ? AND user_id = ?").run(
    include ? 1 : 0,
    accountId,
    userId,
  );
}

/** Removes a gone account (and its history). Live linked accounts come back on the next sync, so they're refused. */
export function deleteAccount(db: DatabaseSync, userId: number, accountId: number) {
  const row = db.prepare("SELECT connection_id, gone FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId) as
    | { connection_id: number | null; gone: number }
    | undefined;
  if (!row) return;
  if (row.connection_id !== null && row.gone !== 1) {
    throw new AccountError("A linked account comes back on the next refresh — remove the whole connection instead, or leave it out of net worth.");
  }
  db.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?").run(accountId, userId);
}

// ---------------------------------------------------------------------------
// Loan schedules (federal student loans: no free aggregator covers them)
// ---------------------------------------------------------------------------

export interface ScheduledLoan {
  accountId: number;
  userId: number;
  name: string;
  servicer: string;
  includeInNetWorth: boolean;
  schedule: LoanSchedule;
}

export function addScheduledLoan(
  db: DatabaseSync,
  userId: number,
  details: { name: string; servicer: string; schedule: LoanSchedule },
  now: number,
): number {
  return transaction(db, () => {
    const result = db
      .prepare(
        "INSERT INTO accounts (user_id, name, institution_name, kind, subtype, created_at) VALUES (?, ?, ?, 'student_loan', 'federal', ?)",
      )
      .run(userId, details.name, details.servicer, now);
    const accountId = Number(result.lastInsertRowid);
    writeSchedule(db, accountId, details.schedule, now);
    return accountId;
  });
}

function writeSchedule(db: DatabaseSync, accountId: number, s: LoanSchedule, now: number) {
  db.prepare(
    `INSERT INTO loan_schedules (account_id, principal_cents, accrued_interest_cents, annual_rate_bps, monthly_payment_cents, payment_day, anchor_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       principal_cents = excluded.principal_cents, accrued_interest_cents = excluded.accrued_interest_cents,
       annual_rate_bps = excluded.annual_rate_bps, monthly_payment_cents = excluded.monthly_payment_cents,
       payment_day = excluded.payment_day, anchor_date = excluded.anchor_date, updated_at = excluded.updated_at`,
  ).run(
    accountId,
    s.principalCents,
    s.accruedInterestCents,
    s.annualRateBps,
    s.monthlyPaymentCents,
    s.paymentDay,
    s.anchorDate,
    now,
  );
}

/** Re-anchors a loan: the servicer's numbers as of a date, after which projection resumes. */
export function updateScheduledLoan(
  db: DatabaseSync,
  userId: number,
  accountId: number,
  details: { name: string; servicer: string; schedule: LoanSchedule },
  now: number,
) {
  transaction(db, () => {
    const updated = db
      .prepare(
        "UPDATE accounts SET name = ?, institution_name = ? WHERE id = ? AND user_id = ? AND id IN (SELECT account_id FROM loan_schedules)",
      )
      .run(details.name, details.servicer, accountId, userId);
    if (updated.changes !== 1) throw new AccountError("That loan doesn't exist.");
    writeSchedule(db, accountId, details.schedule, now);
    // Snapshots after the new anchor came from the old numbers; they're redone on the next refresh.
    db.prepare("DELETE FROM balance_snapshots WHERE account_id = ? AND day >= ?").run(accountId, details.schedule.anchorDate);
  });
}

export function listScheduledLoans(db: DatabaseSync, userId?: number): ScheduledLoan[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.user_id, a.name, a.institution_name, a.include_in_net_worth, l.*
       FROM loan_schedules l JOIN accounts a ON a.id = l.account_id
       ${userId === undefined ? "" : "WHERE a.user_id = ?"}
       ORDER BY a.name, a.id`,
    )
    .all(...(userId === undefined ? [] : [userId])) as Record<string, unknown>[];
  return rows.map((r) => ({
    accountId: r.id as number,
    userId: r.user_id as number,
    name: r.name as string,
    servicer: r.institution_name as string,
    includeInNetWorth: r.include_in_net_worth === 1,
    schedule: {
      principalCents: r.principal_cents as number,
      accruedInterestCents: r.accrued_interest_cents as number,
      annualRateBps: r.annual_rate_bps as number,
      monthlyPaymentCents: r.monthly_payment_cents as number,
      paymentDay: r.payment_day as number,
      anchorDate: r.anchor_date as string,
    },
  }));
}

export function deleteScheduledLoan(db: DatabaseSync, userId: number, accountId: number) {
  db.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ? AND id IN (SELECT account_id FROM loan_schedules)").run(
    accountId,
    userId,
  );
}

// ---------------------------------------------------------------------------
// Assets: homes, vehicles and anything else owned (nothing free links them)
// ---------------------------------------------------------------------------

export type AssetKind = "property" | "vehicle" | "other";

export const ASSET_KINDS: AssetKind[] = ["property", "vehicle", "other"];

export interface Asset {
  accountId: number;
  userId: number;
  name: string;
  kind: AssetKind;
  includeInNetWorth: boolean;
  valuation: AssetValuation;
  updatedAt: number;
  /** For a home valued from its address. */
  estimate: AddressEstimate | null;
}

export interface AssetDetails {
  name: string;
  kind: AssetKind;
  valuation: AssetValuation;
}

/** The line shown under the name, standing in for an institution. */
function assetDescription(details: AssetDetails): string {
  if (details.kind === "property") return details.valuation.zip ? `Home · ${details.valuation.zip}` : "Home";
  return details.kind === "vehicle" ? "Vehicle" : "Asset";
}

function writeValuation(db: DatabaseSync, accountId: number, v: AssetValuation, now: number) {
  db.prepare(
    `INSERT INTO asset_valuations (account_id, value_cents, as_of, method, annual_rate_bps, zip, address, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       value_cents = excluded.value_cents, as_of = excluded.as_of, method = excluded.method,
       annual_rate_bps = excluded.annual_rate_bps, zip = excluded.zip, address = excluded.address,
       updated_at = excluded.updated_at`,
  ).run(
    accountId,
    v.valueCents,
    v.asOf,
    v.method,
    v.method === "depreciation" ? v.annualRateBps : 0,
    v.zip,
    v.method === "address" ? (v.address ?? null) : null,
    now,
  );
}

/** The outcome of looking a home's value up by its address. */
export interface AddressEstimate {
  lowCents: number | null;
  highCents: number | null;
  attemptAt: number | null;
  /** Null after a success. */
  error: string | null;
}

/** Records a fresh estimate (the value, as of `day`) or, with `error`, a failed one that keeps the last value. */
export function recordAddressEstimate(
  db: DatabaseSync,
  accountId: number,
  outcome: { valueCents: number; lowCents: number | null; highCents: number | null; zip: string | null; day: string } | { error: string },
  now: number,
) {
  if ("error" in outcome) {
    db.prepare("UPDATE asset_valuations SET estimate_attempt_at = ?, estimate_error = ? WHERE account_id = ?").run(
      now,
      outcome.error,
      accountId,
    );
    return;
  }
  db.prepare(
    `UPDATE asset_valuations SET value_cents = ?, as_of = ?, zip = COALESCE(?, zip), estimate_low_cents = ?, estimate_high_cents = ?,
       estimate_attempt_at = ?, estimate_error = NULL WHERE account_id = ?`,
  ).run(outcome.valueCents, outcome.day, outcome.zip, outcome.lowCents, outcome.highCents, now, accountId);
}

export function addAsset(db: DatabaseSync, userId: number, details: AssetDetails, now: number): number {
  return transaction(db, () => {
    const result = db
      .prepare("INSERT INTO accounts (user_id, name, institution_name, kind, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, details.name, assetDescription(details), details.kind, now);
    const accountId = Number(result.lastInsertRowid);
    writeValuation(db, accountId, details.valuation, now);
    return accountId;
  });
}

/** A new value as of a date (or a new way of estimating), from which the estimate resumes. */
export function updateAsset(
  db: DatabaseSync,
  userId: number,
  accountId: number,
  details: AssetDetails,
  now: number,
  { keepHistory = false }: { keepHistory?: boolean } = {},
) {
  transaction(db, () => {
    const updated = db
      .prepare(
        `UPDATE accounts SET name = ?, institution_name = ?, kind = ?
         WHERE id = ? AND user_id = ? AND id IN (SELECT account_id FROM asset_valuations)`,
      )
      .run(details.name, assetDescription(details), details.kind, accountId, userId);
    if (updated.changes !== 1) throw new AccountError("That asset doesn't exist.");
    writeValuation(db, accountId, details.valuation, now);
    // Estimates after the new value's date came from the old one; they're redone on the next refresh.
    // Unless the value didn't change (a rename): then they still stand.
    if (!keepHistory) {
      db.prepare("DELETE FROM balance_snapshots WHERE account_id = ? AND day >= ?").run(accountId, details.valuation.asOf);
    }
    pruneHomeIndex(db);
  });
}

export function listAssets(db: DatabaseSync, userId?: number): Asset[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.user_id, a.name, a.kind, a.include_in_net_worth, v.*
       FROM asset_valuations v JOIN accounts a ON a.id = v.account_id
       ${userId === undefined ? "" : "WHERE a.user_id = ?"}
       ORDER BY a.name, a.id`,
    )
    .all(...(userId === undefined ? [] : [userId])) as Record<string, unknown>[];
  return rows.map((r) => ({
    accountId: r.id as number,
    userId: r.user_id as number,
    name: r.name as string,
    kind: r.kind as AssetKind,
    includeInNetWorth: r.include_in_net_worth === 1,
    updatedAt: r.updated_at as number,
    valuation: {
      valueCents: r.value_cents as number,
      asOf: r.as_of as string,
      method: r.method as ValuationMethod,
      annualRateBps: r.annual_rate_bps as number,
      zip: (r.zip as string | null) ?? null,
      address: (r.address as string | null) ?? null,
    },
    estimate:
      r.method === "address"
        ? {
            lowCents: (r.estimate_low_cents as number | null) ?? null,
            highCents: (r.estimate_high_cents as number | null) ?? null,
            attemptAt: (r.estimate_attempt_at as number | null) ?? null,
            error: (r.estimate_error as string | null) ?? null,
          }
        : null,
  }));
}

export function deleteAsset(db: DatabaseSync, userId: number, accountId: number) {
  db.prepare(
    "DELETE FROM accounts WHERE id = ? AND user_id = ? AND id IN (SELECT account_id FROM asset_valuations)",
  ).run(accountId, userId);
  pruneHomeIndex(db);
}

// ---------------------------------------------------------------------------
// Equity: the loans secured by an asset (a home's mortgage, a car's loan)
// ---------------------------------------------------------------------------

/** Which of the user's accounts can be set against an asset: anything owed but a card. */
export function securableLoans(db: DatabaseSync, userId: number): AccountView[] {
  return listAccounts(db, userId).filter((a) => isLiability(a.kind) && a.kind !== "credit" && !a.gone);
}

/** Loan account ids by the asset they're set against. */
export function assetLoans(db: DatabaseSync, userId: number): Map<number, number[]> {
  const rows = db
    .prepare(
      `SELECT l.asset_account_id, l.loan_account_id FROM asset_loans l
       JOIN accounts a ON a.id = l.asset_account_id
       WHERE a.user_id = ? ORDER BY l.loan_account_id`,
    )
    .all(userId) as { asset_account_id: number; loan_account_id: number }[];
  const byAsset = new Map<number, number[]>();
  for (const r of rows) byAsset.set(r.asset_account_id, [...(byAsset.get(r.asset_account_id) ?? []), r.loan_account_id]);
  return byAsset;
}

/**
 * Sets which loans an asset secures, replacing what was there. A loan moves
 * here from any other asset; ids that aren't the user's own debts are refused.
 */
export function setAssetLoans(db: DatabaseSync, userId: number, assetAccountId: number, loanAccountIds: number[]) {
  transaction(db, () => {
    const asset = db
      .prepare("SELECT 1 FROM accounts a JOIN asset_valuations v ON v.account_id = a.id WHERE a.id = ? AND a.user_id = ?")
      .get(assetAccountId, userId);
    if (!asset) throw new AccountError("That asset doesn't exist.");
    const allowed = new Set(securableLoans(db, userId).map((a) => a.id));
    if (loanAccountIds.some((id) => !allowed.has(id))) throw new AccountError("Only your own loans can be set against an asset.");
    db.prepare("DELETE FROM asset_loans WHERE asset_account_id = ?").run(assetAccountId);
    const insert = db.prepare(
      `INSERT INTO asset_loans (loan_account_id, asset_account_id) VALUES (?, ?)
       ON CONFLICT (loan_account_id) DO UPDATE SET asset_account_id = excluded.asset_account_id`,
    );
    for (const id of new Set(loanAccountIds)) insert.run(id, assetAccountId);
  });
}
