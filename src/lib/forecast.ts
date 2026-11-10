import { isLiability, type AccountKind } from "./account-kinds";
import { projectLoan, type LoanSchedule } from "./amortization";
import { daysBetween, nthMonthDay, type DateKey } from "./local-date";
import { estimateAsset, indexAt, type AssetValuation, type IndexPoint } from "./valuation";

/**
 * Net worth, projected month by month, and whether goals get reached.
 *
 * Each account moves the way MoneyRight already understands it:
 *   a loan schedule        amortizes (projectLoan)
 *   a vehicle, a fixed asset   its own estimate (estimateAsset)
 *   a home on the index    grows at its ZIP's recent yearly rate
 *   a linked loan          keeps paying down at its last 90 days' pace
 *   investments            grow at the assumed yearly return
 *   cash, cards, the rest  hold
 * and on top, each month's savings (income − spending) add up. That's
 * deliberately simple: a forecast is a direction, not a promise.
 *
 * Pure: takes today and every input rather than reading them.
 */

export type ForecastMethod =
  | { type: "schedule"; schedule: LoanSchedule }
  | { type: "asset"; valuation: AssetValuation; index: IndexPoint[] }
  | { type: "linked"; history: { day: DateKey; balanceCents: number }[] };

export interface ForecastAccount {
  id: number;
  kind: AccountKind;
  /** Today's balance, or null if it has none yet (then it's left out). */
  balanceCents: number | null;
  includeInNetWorth: boolean;
  method: ForecastMethod;
}

export interface Assumptions {
  /** e.g. 5% → 500. */
  investmentReturnBps: number;
  /** Added to net worth each month; negative draws it down. */
  monthlySavingsCents: number;
}

export interface Forecast {
  /** Today, then the same day of each following month. */
  days: DateKey[];
  netWorthCents: number[];
  /** Each account's projected balance at each of `days`. */
  byAccount: Map<number, number[]>;
}

const DAYS_PER_YEAR = 365.25;
/** A home index's recent rate, kept within reason before it's compounded for decades. */
const MAX_HOME_GROWTH = 0.08;
const TREND_DAYS = 90;

/** Yearly growth of a home index over (up to) its last five years; 0 with under a year of data. */
export function homeGrowthRate(index: IndexPoint[]): number {
  if (index.length < 13) return 0;
  const latest = index.at(-1)!;
  const span = Math.min(60, index.length - 1);
  const start = index[index.length - 1 - span];
  if (start.value <= 0) return 0;
  const rate = Math.pow(latest.value / start.value, 12 / span) - 1;
  return Math.max(-MAX_HOME_GROWTH, Math.min(MAX_HOME_GROWTH, rate));
}

/** Change per day of a linked balance over its last 90 days, or 0 without a month of data. */
export function recentPace(history: { day: DateKey; balanceCents: number }[], today: DateKey): number {
  const recent = history.filter((h) => daysBetween(h.day, today) <= TREND_DAYS && daysBetween(h.day, today) >= 0);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent.at(-1)!;
  const days = daysBetween(first.day, last.day);
  return days >= 30 ? (last.balanceCents - first.balanceCents) / days : 0;
}

function projector(account: ForecastAccount, assumptions: Assumptions, today: DateKey): (day: DateKey) => number {
  const now = account.balanceCents ?? 0;
  const years = (day: DateKey) => daysBetween(today, day) / DAYS_PER_YEAR;
  const m = account.method;
  if (m.type === "schedule") return (day) => (day === today ? now : projectLoan(m.schedule, day).balanceCents);
  if (m.type === "asset") {
    const home = m.valuation.method === "home_index" || m.valuation.method === "address";
    if (!home) return (day) => (day === today ? now : estimateAsset(m.valuation, day).valueCents);
    // Today's estimate from the index, then its recent rate onward (only if there's a reading to grow from).
    const growth = indexAt(m.index, today) ? homeGrowthRate(m.index) : 0;
    return (day) => Math.round(now * Math.pow(1 + growth, years(day)));
  }
  if (account.kind === "investment") {
    const r = assumptions.investmentReturnBps / 10_000;
    return (day) => Math.round(now * Math.pow(1 + r, years(day)));
  }
  if (isLiability(account.kind) && account.kind !== "credit") {
    // Only a balance going down is extrapolated: a loan's growth is usually interest the next payment clears.
    const pace = recentPace(m.history, today);
    if (pace < 0) return (day) => Math.max(0, Math.round(now + pace * daysBetween(today, day)));
  }
  return () => now;
}

export function forecast(accounts: ForecastAccount[], assumptions: Assumptions, today: DateKey, months: number): Forecast {
  const dayOfMonth = Number(today.slice(8, 10));
  const days = Array.from({ length: months + 1 }, (_, k) => (k === 0 ? today : nthMonthDay(today, k, dayOfMonth)));
  const byAccount = new Map<number, number[]>();
  const netWorth = days.map((_, k) => k * assumptions.monthlySavingsCents);
  for (const account of accounts) {
    if (account.balanceCents === null) continue;
    const project = projector(account, assumptions, today);
    const values = days.map(project);
    byAccount.set(account.id, values);
    if (!account.includeInNetWorth) continue;
    const sign = isLiability(account.kind) ? -1 : 1;
    values.forEach((v, k) => (netWorth[k] += sign * v));
  }
  return { days, netWorthCents: netWorth, byAccount };
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export interface Goal {
  id: number;
  name: string;
  /** Null: net worth. */
  accountId: number | null;
  targetCents: number;
  targetDate: DateKey | null;
}

export interface GoalProgress {
  /** "down" for a debt: reached when what's owed is at or below the target. */
  direction: "up" | "down";
  currentCents: number | null;
  reached: boolean;
  /** The first forecast month it's met, or null if not within the forecast. */
  projectedDay: DateKey | null;
  /** Null without a target date. */
  onTrack: boolean | null;
}

export function goalProgress(goal: Goal, f: Forecast, kinds: Map<number, AccountKind>): GoalProgress {
  const kind = goal.accountId === null ? null : kinds.get(goal.accountId);
  const direction = kind && isLiability(kind) ? "down" : "up";
  const series = goal.accountId === null ? f.netWorthCents : f.byAccount.get(goal.accountId);
  const met = (v: number) => (direction === "down" ? v <= goal.targetCents : v >= goal.targetCents);
  if (!series) return { direction, currentCents: null, reached: false, projectedDay: null, onTrack: null };
  const at = series.findIndex(met);
  const projectedDay = at < 0 ? null : f.days[at];
  return {
    direction,
    currentCents: series[0],
    reached: at === 0,
    projectedDay,
    onTrack: goal.targetDate === null ? null : projectedDay !== null && projectedDay <= goal.targetDate,
  };
}
