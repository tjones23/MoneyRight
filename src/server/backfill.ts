import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import type { PlaidInvestmentTransaction } from "./providers/plaid";
import { isLiability, type AccountKind } from "@/lib/account-kinds";
import { investmentFlow, rewindBalances, rewindWithGrowth, transactionFlow, type EstimatedBalance, type Flow } from "@/lib/backfill";
import { addDays, type DateKey } from "@/lib/local-date";
import { dollarsToCents } from "@/lib/money";

/**
 * History from before an account was linked, saved as estimated snapshots
 * (see lib/backfill.ts for how it's worked out). Estimates only ever sit
 * before an account's first real reading, and a real one replaces any
 * estimate on its day.
 */

interface Anchor {
  day: DateKey;
  balanceCents: number;
}

/** An account's first real reading, or null before it has one. */
function firstReading(db: DatabaseSync, accountId: number): Anchor | null {
  const row = db
    .prepare("SELECT day, balance_cents FROM balance_snapshots WHERE account_id = ? AND estimated = 0 ORDER BY day LIMIT 1")
    .get(accountId) as { day: string; balance_cents: number } | undefined;
  return row ? { day: row.day, balanceCents: row.balance_cents } : null;
}

/** Replaces an account's estimates with `rows`. Run inside a transaction. */
function replaceEstimates(db: DatabaseSync, accountId: number, anchorDay: DateKey, rows: EstimatedBalance[], now: number) {
  db.prepare("DELETE FROM balance_snapshots WHERE account_id = ? AND estimated = 1").run(accountId);
  const insert = db.prepare(
    `INSERT INTO balance_snapshots (account_id, day, balance_cents, available_cents, recorded_at, estimated)
     VALUES (?, ?, ?, NULL, ?, 1) ON CONFLICT (account_id, day) DO NOTHING`,
  );
  for (const r of rows) if (r.day < anchorDay) insert.run(accountId, r.day, r.balanceCents, now);
}

/**
 * Works each bank account and card on a connection back from its first
 * reading through its posted transactions. Cheap and local, so it's redone
 * after every transactions sync: late-arriving history fills in.
 */
export function backfillFromTransactions(db: DatabaseSync, connectionId: number, now: number): number {
  const accounts = db
    .prepare("SELECT id, kind FROM accounts WHERE connection_id = ? AND kind IN ('cash', 'credit')")
    .all(connectionId) as { id: number; kind: AccountKind }[];
  let filled = 0;
  transaction(db, () => {
    for (const account of accounts) {
      const anchor = firstReading(db, account.id);
      if (!anchor) continue;
      const flows: Flow[] = (
        db
          .prepare("SELECT day, amount_cents FROM transactions WHERE account_id = ? AND pending = 0 AND day <= ?")
          .all(account.id, anchor.day) as { day: string; amount_cents: number }[]
      ).map((t) => ({ day: t.day, cents: transactionFlow(isLiability(account.kind), t.amount_cents) }));
      const rows = rewindBalances(anchor.day, anchor.balanceCents, flows);
      replaceEstimates(db, account.id, anchor.day, rows, now);
      if (rows.length) filled++;
    }
  });
  return filled;
}

/**
 * Works each investment account on a connection back from its first
 * reading: money in and out from Plaid's investment transactions, growth at
 * `annualReturnBps`. Only as far back as the account's earliest transaction,
 * which is the evidence it existed. Done once per connection, once every
 * investment account on it has a reading.
 */
export function backfillInvestments(
  db: DatabaseSync,
  connectionId: number,
  accountIds: Map<string, number>,
  moves: PlaidInvestmentTransaction[],
  annualReturnBps: number,
  now: number,
): number {
  const byAccount = new Map<number, PlaidInvestmentTransaction[]>();
  for (const m of moves) {
    const id = accountIds.get(m.account_id);
    if (id === undefined || (m.iso_currency_code && m.iso_currency_code !== "USD")) continue;
    byAccount.set(id, [...(byAccount.get(id) ?? []), m]);
  }
  const investments = db
    .prepare("SELECT id FROM accounts WHERE connection_id = ? AND kind = 'investment'")
    .all(connectionId) as { id: number }[];
  let filled = 0;
  let unread = false;
  transaction(db, () => {
    for (const { id } of investments) {
      const anchor = firstReading(db, id);
      if (!anchor) unread = true;
      const list = (byAccount.get(id) ?? []).filter((m) => m.date <= (anchor?.day ?? ""));
      if (!anchor || list.length === 0) continue;
      const flows: Flow[] = list.map((m) => ({
        day: m.date,
        cents: investmentFlow({
          day: m.date,
          type: m.type,
          subtype: m.subtype,
          amountCents: dollarsToCents(m.amount) ?? 0,
          quantity: m.quantity,
          priceCents: dollarsToCents(m.price),
        }),
      }));
      const earliest = list.reduce((min, m) => (m.date < min ? m.date : min), list[0].date);
      const rows = rewindWithGrowth(anchor.day, anchor.balanceCents, flows, addDays(earliest, -1), annualReturnBps);
      replaceEstimates(db, id, anchor.day, rows, now);
      if (rows.length) filled++;
    }
    // An account without a reading yet has nothing to work back from: try again next refresh.
    if (!unread) db.prepare("UPDATE connections SET investments_backfilled_at = ? WHERE id = ?").run(now, connectionId);
  });
  return filled;
}

/** Whether a connection's investment accounts still need working back. */
export function investmentsBackfillDue(db: DatabaseSync, connectionId: number): boolean {
  const row = db.prepare("SELECT investments_backfilled_at FROM connections WHERE id = ?").get(connectionId) as
    | { investments_backfilled_at: number | null }
    | undefined;
  return row !== undefined && row.investments_backfilled_at === null;
}
