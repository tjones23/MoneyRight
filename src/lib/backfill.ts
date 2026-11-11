import { addDays, daysBetween, type DateKey } from "./local-date";

/**
 * Balances before an account's first real reading, worked back from it.
 *
 * Plaid gives up to two years of transactions but only today's balance, so
 * the past is the first reading less everything that happened since:
 *
 *   - A bank account or card: exact, give or take a transaction Plaid
 *     dated a day off — each day is the next day's balance with that day's
 *     posted transactions undone.
 *   - An investment account: rough. Without past prices, only money moved
 *     in or out is known; the rest of the change is put down to growth at
 *     the assumed yearly return, spread evenly.
 *
 * Every balance here is a day's closing balance, like a snapshot. Pure:
 * everything comes in as arguments.
 */

export interface EstimatedBalance {
  day: DateKey;
  balanceCents: number;
}

export interface Flow {
  day: DateKey;
  /** The change to the stored balance: for a card, what's owed. */
  cents: number;
}

/**
 * Closing balances before `anchorDay`, from flows on or before it. A row
 * for the day before each day with flows, back to the day before the
 * earliest: that's as far as the transactions vouch for the account.
 */
export function rewindBalances(anchorDay: DateKey, anchorCents: number, flows: Flow[]): EstimatedBalance[] {
  const byDay = new Map<DateKey, number>();
  for (const f of flows) {
    if (f.day > anchorDay) continue;
    byDay.set(f.day, (byDay.get(f.day) ?? 0) + f.cents);
  }
  const days = [...byDay.keys()].sort().reverse();
  const rows: EstimatedBalance[] = [];
  let balance = anchorCents;
  for (const day of days) {
    balance -= byDay.get(day)!;
    rows.push({ day: addDays(day, -1), balanceCents: balance });
  }
  return rows.reverse();
}

/**
 * Plaid's transaction sign is money out of the account. Out of a bank
 * account lowers its balance; charged to a card raises what's owed.
 */
export function transactionFlow(liability: boolean, amountCents: number): number {
  return liability ? amountCents : -amountCents;
}

/**
 * Daily closing values from `startDay` up to (not including) `anchorDay`:
 * each the next day's value less that day's flows, shrunk by a day's growth
 * at `annualReturnBps`. Never below zero — an account can't be worth less.
 */
export function rewindWithGrowth(
  anchorDay: DateKey,
  anchorCents: number,
  flows: Flow[],
  startDay: DateKey,
  annualReturnBps: number,
): EstimatedBalance[] {
  const byDay = new Map<DateKey, number>();
  for (const f of flows) byDay.set(f.day, (byDay.get(f.day) ?? 0) + f.cents);
  const dailyGrowth = Math.pow(1 + annualReturnBps / 10_000, 1 / 365);
  const rows: EstimatedBalance[] = [];
  let value = anchorCents;
  for (let day = anchorDay; daysBetween(startDay, day) > 0; day = addDays(day, -1)) {
    value = Math.max(0, (value - (byDay.get(day) ?? 0)) / dailyGrowth);
    rows.push({ day: addDays(day, -1), balanceCents: Math.round(value) });
  }
  return rows.reverse();
}

/** What a Plaid investment transaction is, as far as it matters here. */
export interface InvestmentMove {
  day: DateKey;
  type: string;
  subtype: string | null;
  /** Plaid's sign: positive is cash out of the account. */
  amountCents: number;
  /** Shares, positive in; for a transfer of securities that has no cash amount. */
  quantity: number | null;
  priceCents: number | null;
}

/** Money put in or taken out — anything else (buys, sells, dividends, fees) stays inside the account or is growth. */
const OUTSIDE_SUBTYPES = new Set(["contribution", "deposit", "withdrawal", "distribution", "transfer", "loan payment"]);

/** The change a move makes to the account's value from outside, or 0 if it's internal. */
export function investmentFlow(move: InvestmentMove): number {
  const outside = move.type === "transfer" || (move.type === "cash" && OUTSIDE_SUBTYPES.has(move.subtype ?? ""));
  if (!outside) return 0;
  if (move.amountCents !== 0) return -move.amountCents;
  // Shares moved in kind: their value then, the best there is.
  if (move.quantity && move.priceCents) return Math.round(move.quantity * move.priceCents);
  return 0;
}
