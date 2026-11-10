import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import type { TransactionsPage } from "./providers/plaid";
import type { Txn } from "@/lib/cash-flow";
import type { DateKey } from "@/lib/local-date";
import { dollarsToCents } from "@/lib/money";

/**
 * Transactions from Plaid's /transactions/sync, kept per account. Like the
 * rest of finance.ts, every read is scoped to a user.
 */

/**
 * Applies one sync's changes and moves the cursor on, together — so a crash
 * mid-way repeats the sync rather than skipping it. `accountIds` maps Plaid's
 * account ids to this connection's accounts; anything else is ignored.
 */
export function applyTransactions(
  db: DatabaseSync,
  connectionId: number,
  accountIds: Map<string, number>,
  page: TransactionsPage,
  now: number,
): number {
  let saved = 0;
  transaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO transactions (account_id, external_id, day, amount_cents, name, merchant, category, category_detailed, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (external_id) DO UPDATE SET
         account_id = excluded.account_id, day = excluded.day, amount_cents = excluded.amount_cents, name = excluded.name,
         merchant = excluded.merchant, category = excluded.category, category_detailed = excluded.category_detailed,
         pending = excluded.pending`,
    );
    for (const t of [...page.added, ...page.modified]) {
      const accountId = accountIds.get(t.account_id);
      const cents = dollarsToCents(t.amount);
      if (accountId === undefined || cents === null || (t.iso_currency_code && t.iso_currency_code !== "USD")) continue;
      upsert.run(
        accountId,
        t.transaction_id,
        t.date,
        cents,
        (t.name || "Transaction").slice(0, 200),
        t.merchant_name?.slice(0, 200) ?? null,
        t.personal_finance_category?.primary ?? null,
        t.personal_finance_category?.detailed ?? null,
        t.pending ? 1 : 0,
      );
      saved++;
    }
    // Only this connection's own transactions can be removed through it.
    const remove = db.prepare(
      "DELETE FROM transactions WHERE external_id = ? AND account_id IN (SELECT id FROM accounts WHERE connection_id = ?)",
    );
    for (const id of page.removed) remove.run(id, connectionId);
    db.prepare("UPDATE connections SET transactions_cursor = ?, transactions_synced_at = ? WHERE id = ?").run(
      page.nextCursor,
      now,
      connectionId,
    );
  });
  return saved;
}

export interface TransactionView extends Txn {
  id: number;
  accountName: string;
}

/** The user's transactions from `from` on (all, without it), newest first. Only accounts counted in net worth, unless asked. */
export function listTransactions(
  db: DatabaseSync,
  userId: number,
  opts: { from?: DateKey; includeUncounted?: boolean } = {},
): TransactionView[] {
  return db
    .prepare(
      `SELECT t.*, a.name AS account_name FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE a.user_id = ? AND t.day >= ? ${opts.includeUncounted ? "" : "AND a.include_in_net_worth = 1"}
       ORDER BY t.day DESC, t.id DESC`,
    )
    .all(userId, opts.from ?? "0000-00-00")
    .map((r) => ({
      id: r.id as number,
      accountId: r.account_id as number,
      accountName: r.account_name as string,
      day: r.day as string,
      amountCents: r.amount_cents as number,
      name: r.name as string,
      merchant: (r.merchant as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      categoryDetailed: (r.category_detailed as string | null) ?? null,
      pending: r.pending === 1,
    }));
}

/** Whether any of the user's connections fetches transactions, and when last. */
export function transactionsStatus(db: DatabaseSync, userId: number): { connections: number; lastSyncedAt: number | null } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(transactions_synced_at) AS last FROM connections
       WHERE user_id = ? AND ',' || COALESCE(products, '') || ',' LIKE '%,transactions,%'`,
    )
    .get(userId) as { n: number; last: number | null };
  return { connections: row.n, lastSyncedAt: row.last };
}
