import type { DatabaseSync } from "node:sqlite";
import { AccountError } from "./accounts";
import { listAccounts, listAssets, listScheduledLoans, snapshots } from "./finance";
import { homeIndex } from "./home-index";
import { listTransactions } from "./transactions";
import { averageMonthlyNet } from "@/lib/cash-flow";
import type { ForecastAccount, Goal } from "@/lib/forecast";
import { addDays, type DateKey } from "@/lib/local-date";

/** The forecast's assumptions and the person's goals; every read scoped to a user. */

export const DEFAULT_INVESTMENT_RETURN_BPS = 500;

export interface ForecastSettings {
  investmentReturnBps: number;
  /** Null: use the recent average from transactions. */
  monthlySavingsCents: number | null;
}

export function forecastSettings(db: DatabaseSync, userId: number): ForecastSettings {
  const row = db.prepare("SELECT * FROM forecast_settings WHERE user_id = ?").get(userId) as
    | { investment_return_bps: number; monthly_savings_cents: number | null }
    | undefined;
  return {
    investmentReturnBps: row?.investment_return_bps ?? DEFAULT_INVESTMENT_RETURN_BPS,
    monthlySavingsCents: row?.monthly_savings_cents ?? null,
  };
}

export function saveForecastSettings(db: DatabaseSync, userId: number, s: ForecastSettings, now: number) {
  db.prepare(
    `INSERT INTO forecast_settings (user_id, investment_return_bps, monthly_savings_cents, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET investment_return_bps = excluded.investment_return_bps,
       monthly_savings_cents = excluded.monthly_savings_cents, updated_at = excluded.updated_at`,
  ).run(userId, s.investmentReturnBps, s.monthlySavingsCents, now);
}

/** Recent average monthly savings from transactions, or null without any. */
export function measuredSavings(db: DatabaseSync, userId: number, today: DateKey): number | null {
  return averageMonthlyNet(listTransactions(db, userId, { from: addDays(today, -400) }), today);
}

/** Each account with what the forecast needs to move it. */
export function forecastAccounts(db: DatabaseSync, userId: number, today: DateKey): ForecastAccount[] {
  const loans = new Map(listScheduledLoans(db, userId).map((l) => [l.accountId, l.schedule]));
  const assets = new Map(listAssets(db, userId).map((a) => [a.accountId, a.valuation]));
  const history = new Map<number, { day: DateKey; balanceCents: number }[]>();
  for (const s of snapshots(db, userId, today)) {
    if (s.day < addDays(today, -120)) continue;
    history.set(s.accountId, [...(history.get(s.accountId) ?? []), { day: s.day, balanceCents: s.balanceCents }]);
  }
  return listAccounts(db, userId)
    .filter((a) => !a.gone)
    .map((a) => {
      const schedule = loans.get(a.id);
      const valuation = assets.get(a.id);
      const method: ForecastAccount["method"] = schedule
        ? { type: "schedule", schedule }
        : valuation
          ? { type: "asset", valuation, index: valuation.zip ? homeIndex(db, valuation.zip) : [] }
          : { type: "linked", history: history.get(a.id) ?? [] };
      return { id: a.id, kind: a.kind, balanceCents: a.balanceCents, includeInNetWorth: a.includeInNetWorth, method };
    });
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export function listGoals(db: DatabaseSync, userId: number): Goal[] {
  return db
    .prepare("SELECT * FROM goals WHERE user_id = ? ORDER BY COALESCE(target_date, '9999'), id")
    .all(userId)
    .map((r) => ({
      id: r.id as number,
      name: r.name as string,
      accountId: (r.account_id as number | null) ?? null,
      targetCents: r.target_cents as number,
      targetDate: (r.target_date as string | null) ?? null,
    }));
}

export function addGoal(db: DatabaseSync, userId: number, goal: Omit<Goal, "id">, now: number): number {
  if (goal.accountId !== null) {
    const own = db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?").get(goal.accountId, userId);
    if (!own) throw new AccountError("That account doesn't exist.");
  }
  const result = db
    .prepare("INSERT INTO goals (user_id, account_id, name, target_cents, target_date, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, goal.accountId, goal.name, goal.targetCents, goal.targetDate, now);
  return Number(result.lastInsertRowid);
}

export function deleteGoal(db: DatabaseSync, userId: number, goalId: number) {
  db.prepare("DELETE FROM goals WHERE id = ? AND user_id = ?").run(goalId, userId);
}
