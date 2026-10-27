import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import { AccountError, type Ctx } from "./accounts";
import { open, seal } from "@/lib/sealed";
import type { AccountKind } from "@/lib/account-kinds";
import type { LoanSchedule } from "@/lib/amortization";
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
  source: Provider | "schedule";
  connectionStatus: ConnectionStatus | null;
}

/** Each of the user's accounts with its latest balance. */
export function listAccounts(db: DatabaseSync, userId: number): AccountView[] {
  const rows = db
    .prepare(
      `SELECT a.*, c.provider, c.status AS connection_status,
              s.balance_cents, s.day AS balance_day, s.recorded_at AS balance_recorded_at
       FROM accounts a
       LEFT JOIN connections c ON c.id = a.connection_id
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
    source: r.connection_id === null ? "schedule" : (r.provider as Provider),
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
      .prepare("UPDATE accounts SET name = ?, institution_name = ? WHERE id = ? AND user_id = ? AND connection_id IS NULL")
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
  db.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ? AND connection_id IS NULL").run(accountId, userId);
}
