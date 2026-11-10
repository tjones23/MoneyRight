import { addDays, daysBetween, nthMonthDay, type DateKey } from "./local-date";

/**
 * Money in and out, from transactions: monthly income and spending by
 * category, and the charges that recur.
 *
 * Amounts keep Plaid's sign — positive is money out of an account. Moving
 * money between your own accounts isn't spending, so transfers and credit
 * card payments are left out (the card's purchases already count). A refund
 * nets against the category it came back to rather than counting as income.
 * Loan payments (a mortgage, MOHELA) do count: that cash is gone.
 *
 * Pure: takes today rather than reading the clock.
 */

export interface Txn {
  accountId: number;
  day: DateKey;
  /** Positive is money out. */
  amountCents: number;
  name: string;
  merchant: string | null;
  /** Plaid's personal finance category, primary and detailed. */
  category: string | null;
  categoryDetailed: string | null;
  pending: boolean;
}

export const CATEGORY_LABEL: Record<string, string> = {
  INCOME: "Income",
  LOAN_PAYMENTS: "Loan payments",
  BANK_FEES: "Bank fees",
  ENTERTAINMENT: "Entertainment",
  FOOD_AND_DRINK: "Food and drink",
  GENERAL_MERCHANDISE: "Shopping",
  HOME_IMPROVEMENT: "Home improvement",
  MEDICAL: "Medical",
  PERSONAL_CARE: "Personal care",
  GENERAL_SERVICES: "Services",
  GOVERNMENT_AND_NON_PROFIT: "Government and charity",
  TRANSPORTATION: "Transportation",
  TRAVEL: "Travel",
  RENT_AND_UTILITIES: "Rent and utilities",
  OTHER: "Other",
  // Never counted (isTransfer); named for the transaction list.
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
  LOAN_DISBURSEMENTS: "Loan received",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? "Other";
}

/** Money moved between your own accounts, or borrowed: neither earned nor spent. */
export function isTransfer(t: Txn): boolean {
  return (
    t.category === "TRANSFER_IN" ||
    t.category === "TRANSFER_OUT" ||
    t.category === "LOAN_DISBURSEMENTS" ||
    t.categoryDetailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"
  );
}

/** What counts: settled, and not a transfer. */
function counts(t: Txn): boolean {
  return !t.pending && !isTransfer(t);
}

export interface MonthFlow {
  /** "YYYY-MM". */
  month: string;
  incomeCents: number;
  spendingCents: number;
  /** Income − spending: what was saved (or, negative, drawn down). */
  netCents: number;
  /** Spending by category, largest first; a category refunds outweighed is left out. */
  byCategory: { category: string; cents: number }[];
}

export function monthlyFlow(txns: Txn[], months: string[]): MonthFlow[] {
  const wanted = new Set(months);
  const flows = new Map(months.map((m) => [m, { income: 0, categories: new Map<string, number>() }]));
  for (const t of txns) {
    const month = t.day.slice(0, 7);
    if (!wanted.has(month) || !counts(t)) continue;
    const flow = flows.get(month)!;
    if (t.category === "INCOME") {
      flow.income -= t.amountCents;
      continue;
    }
    const category = t.category && t.category in CATEGORY_LABEL ? t.category : "OTHER";
    flow.categories.set(category, (flow.categories.get(category) ?? 0) + t.amountCents);
  }
  return months.map((month) => {
    const { income, categories } = flows.get(month)!;
    const byCategory = [...categories]
      .map(([category, cents]) => ({ category, cents }))
      .filter((c) => c.cents > 0)
      .sort((a, b) => b.cents - a.cents);
    const spending = byCategory.reduce((n, c) => n + c.cents, 0);
    return { month, incomeCents: income, spendingCents: spending, netCents: income - spending, byCategory };
  });
}

/** The `count` months ending with `today`'s, oldest first. */
export function monthsEnding(today: DateKey, count: number): string[] {
  const [y, m] = today.split("-").map(Number);
  const months: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

/**
 * Average monthly savings over the last `count` whole months (this month
 * isn't over), counting only months after transactions begin. Null with none.
 */
export function averageMonthlyNet(txns: Txn[], today: DateKey, count = 6): number | null {
  const first = txns.reduce<string | null>((min, t) => (min === null || t.day < min ? t.day : min), null);
  if (!first) return null;
  const months = monthsEnding(today, count + 1)
    .slice(0, -1)
    // A month only partly covered would read as a month of low spending.
    .filter((m) => m > first.slice(0, 7));
  if (months.length === 0) return null;
  const flows = monthlyFlow(txns, months);
  return Math.round(flows.reduce((n, f) => n + f.netCents, 0) / flows.length);
}

// ---------------------------------------------------------------------------
// Recurring charges
// ---------------------------------------------------------------------------

export type Cadence = "weekly" | "every two weeks" | "monthly" | "yearly";

export interface Recurring {
  name: string;
  cadence: Cadence;
  /** The usual charge. */
  amountCents: number;
  /** What it comes to per month, for comparing a yearly fee with a weekly one. */
  monthlyCents: number;
  lastDay: DateKey;
  nextDay: DateKey;
  occurrences: number;
}

const CADENCES: { cadence: Cadence; min: number; max: number; minCount: number }[] = [
  { cadence: "weekly", min: 5, max: 9, minCount: 4 },
  { cadence: "every two weeks", min: 12, max: 16, minCount: 3 },
  { cadence: "monthly", min: 26, max: 35, minCount: 3 },
  { cadence: "yearly", min: 350, max: 380, minCount: 2 },
];

const DAYS_PER_MONTH = 365.25 / 12;

/** One merchant however the bank spells it this time: case, store numbers and punctuation dropped. */
export function merchantKey(t: Pick<Txn, "merchant" | "name">): string {
  return (t.merchant || t.name)
    .toLowerCase()
    .replace(/[#*]?\d+/g, " ")
    .replace(/[^a-z&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Most of `values` within `share` of `centre`. */
function steady(values: number[], centre: number, share: number): boolean {
  const near = values.filter((v) => Math.abs(v - centre) <= Math.abs(centre) * share).length;
  return near >= Math.ceil(values.length * 0.75);
}

/**
 * Charges that come at a steady rhythm for a steady amount, and are still
 * coming: subscriptions, bills, a loan payment. Largest monthly cost first.
 */
export function recurringCharges(txns: Txn[], today: DateKey): Recurring[] {
  const groups = new Map<string, Txn[]>();
  for (const t of txns) {
    if (!counts(t) || t.amountCents <= 0 || t.category === "INCOME") continue;
    const key = merchantKey(t);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  const found: Recurring[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    // Two charges on one day are one visit, for rhythm.
    const days = [...new Set(group.map((t) => t.day))];
    if (days.length < 2) continue;
    const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d));
    const gap = median(gaps);
    const fit = CADENCES.find((c) => gap >= c.min && gap <= c.max);
    if (!fit || days.length < fit.minCount || !steady(gaps, gap, 0.25)) continue;
    const amounts = group.map((t) => t.amountCents);
    const amount = Math.round(median(amounts));
    if (!steady(amounts, amount, 0.25)) continue;
    const last = days.at(-1)!;
    // Stopped: overdue by more than half a cycle.
    if (daysBetween(last, today) > gap * 1.5 + 3) continue;
    const latest = group.at(-1)!;
    found.push({
      name: latest.merchant || latest.name,
      cadence: fit.cadence,
      amountCents: amount,
      monthlyCents: Math.round((amount * DAYS_PER_MONTH) / gap),
      lastDay: last,
      // Monthly and yearly bills keep their day of the month; weekly ones their day of the week.
      nextDay:
        fit.cadence === "monthly" || fit.cadence === "yearly"
          ? nthMonthDay(last, fit.cadence === "monthly" ? 1 : 12, Number(last.slice(8, 10)))
          : addDays(last, Math.round(gap)),
      occurrences: days.length,
    });
  }
  return found.sort((a, b) => b.monthlyCents - a.monthlyCents);
}
