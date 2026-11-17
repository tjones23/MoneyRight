import { addDays, daysBetween, nthMonthDay, type DateKey } from "./local-date";

/**
 * Money in and out, from transactions: monthly income and spending by
 * category, and the charges that recur.
 *
 * Amounts keep Plaid's sign — positive is money out of an account. Moving
 * money between your own accounts isn't spending, so transfers and credit
 * card payments are left out (the card's purchases already count). Money
 * to or from someone else — Venmo, Zelle, a Stripe payout — is filed by
 * Plaid as a transfer too, so a transfer no other account of yours took the
 * other side of counts: income when received, spending when sent
 * (outsideTransfers). A refund nets against the category it came back to rather than counting as income.
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
  // Transfers sent to someone else (outsideTransfers).
  SENT: "Sent to people",
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

/**
 * Plaid's kinds of transfer that can be money between you and someone else:
 * Venmo, Zelle and Cash App, a Stripe payout, a deposited check. Not savings,
 * investments, a cash advance or a cash withdrawal — your own money, or
 * borrowed.
 */
const OUTSIDE_KINDS = new Set([
  "TRANSFER_IN_ACCOUNT_TRANSFER",
  "TRANSFER_IN_DEPOSIT",
  "TRANSFER_IN_OTHER_TRANSFER_IN",
  "TRANSFER_OUT_ACCOUNT_TRANSFER",
  "TRANSFER_OUT_OTHER_TRANSFER_OUT",
]);

/** How far apart the two sides of one of your own transfers can post. */
const TRANSFER_DAYS = 5;

/**
 * Transfers to or from someone else: no other account of yours took the
 * other side — the same amount the other way within a few days. Received,
 * they're money in; sent, spending.
 */
export function outsideTransfers(txns: Txn[]): Set<Txn> {
  const byAmount = new Map<number, Txn[]>();
  for (const t of txns) {
    if (!t.pending) byAmount.set(t.amountCents, [...(byAmount.get(t.amountCents) ?? []), t]);
  }
  const paired = new Set<Txn>();
  const outside = new Set<Txn>();
  for (const t of txns) {
    if (t.pending || t.amountCents === 0 || paired.has(t) || !OUTSIDE_KINDS.has(t.categoryDetailed ?? "")) continue;
    const pair = (byAmount.get(-t.amountCents) ?? []).find(
      (o) => !paired.has(o) && o.accountId !== t.accountId && Math.abs(daysBetween(o.day, t.day)) <= TRANSFER_DAYS,
    );
    if (pair) {
      paired.add(t);
      paired.add(pair);
    } else outside.add(t);
  }
  return outside;
}

/** What counts: settled, and not a transfer — unless it's one with someone else. */
function counts(t: Txn, outside: Set<Txn>): boolean {
  return !t.pending && (!isTransfer(t) || outside.has(t));
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

export function monthlyFlow(txns: Txn[], months: string[], outside = outsideTransfers(txns)): MonthFlow[] {
  const wanted = new Set(months);
  const flows = new Map(months.map((m) => [m, { income: 0, categories: new Map<string, number>() }]));
  for (const t of txns) {
    const month = t.day.slice(0, 7);
    if (!wanted.has(month) || !counts(t, outside)) continue;
    const flow = flows.get(month)!;
    if (t.category === "INCOME" || (outside.has(t) && t.amountCents < 0)) {
      flow.income -= t.amountCents;
      continue;
    }
    const category = outside.has(t) ? "SENT" : t.category && t.category in CATEGORY_LABEL ? t.category : "OTHER";
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
export function recurringCharges(txns: Txn[], today: DateKey, outside = outsideTransfers(txns)): Recurring[] {
  const groups = new Map<string, Txn[]>();
  for (const t of txns) {
    if (!counts(t, outside) || t.amountCents <= 0 || t.category === "INCOME") continue;
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

// ---------------------------------------------------------------------------
// Income by source
// ---------------------------------------------------------------------------

export type Interval = "week" | "month" | "quarter" | "year";

/** How many of each the income chart shows: a quarter of weeks, a year of months, two of quarters — Plaid keeps two years. */
export const INTERVALS: { value: Interval; label: string; count: number }[] = [
  { value: "week", label: "Weeks", count: 13 },
  { value: "month", label: "Months", count: 12 },
  { value: "quarter", label: "Quarters", count: 8 },
  { value: "year", label: "Years", count: 3 },
];

export interface Period {
  /** "2026-11-09" (the week's Monday), "2026-11", "2026-Q4" or "2026". */
  key: string;
  start: DateKey;
  /** Inclusive. */
  end: DateKey;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/** The period `day` falls in. Weeks start on Monday. */
export function periodOf(day: DateKey, interval: Interval): Period {
  const [y, m] = day.split("-").map(Number);
  if (interval === "week") {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const start = addDays(day, -((weekday + 6) % 7));
    return { key: start, start, end: addDays(start, 6) };
  }
  if (interval === "month") {
    const start = `${y}-${pad2(m)}-01`;
    return { key: start.slice(0, 7), start, end: addDays(nthMonthDay(start, 1, 1), -1) };
  }
  if (interval === "quarter") {
    const q = Math.floor((m - 1) / 3);
    const start = `${y}-${pad2(q * 3 + 1)}-01`;
    return { key: `${y}-Q${q + 1}`, start, end: addDays(nthMonthDay(start, 3, 1), -1) };
  }
  return { key: String(y), start: `${y}-01-01`, end: `${y}-12-31` };
}

/** The `count` periods ending with `today`'s, oldest first. */
export function periodsEnding(today: DateKey, interval: Interval, count: number): Period[] {
  const periods = [periodOf(today, interval)];
  while (periods.length < count) periods.unshift(periodOf(addDays(periods[0].start, -1), interval));
  return periods;
}

export type IncomeGrouping = "payer" | "kind";

const INCOME_KIND: Record<string, string> = {
  INCOME_WAGES: "Paychecks",
  INCOME_DIVIDENDS: "Dividends",
  INCOME_INTEREST_EARNED: "Interest",
  INCOME_RETIREMENT_PENSION: "Retirement and pension",
  INCOME_TAX_REFUND: "Tax refunds",
  INCOME_UNEMPLOYMENT: "Unemployment",
};

/** What sort of money in a transaction is: a paycheck, interest, money someone sent. */
export function incomeKind(t: Txn): string {
  if (t.category !== "INCOME") return "Sent to you";
  return (t.categoryDetailed && INCOME_KIND[t.categoryDetailed]) || "Other income";
}

/** The key of the smaller sources, folded together. */
export const OTHER_SOURCES = "other";

export interface IncomeSource {
  /** The same whichever interval is shown, so a source keeps its color. */
  key: string;
  label: string;
  /** For a payer, the kind of money it sends; for a kind, how many payers. */
  detail: string;
  /** Over the periods shown. */
  totalCents: number;
  /** Its color: rank over all of history, from 0; −1 for "Everything else". */
  slot: number;
}

export interface IncomePeriod extends Period {
  /** Money in by source key; a source with nothing this period is absent. */
  bySource: Record<string, number>;
  totalCents: number;
  /** Today falls in it: not over yet. */
  current: boolean;
  /** Transactions begin part-way through it, so it's undercounted. */
  partial: boolean;
  /** Over before transactions begin: nothing known. */
  empty: boolean;
}

export interface IncomeBreakdown {
  periods: IncomePeriod[];
  /** Largest first over the periods shown, "Everything else" last; at most `maxSources` + 1. */
  sources: IncomeSource[];
  totalCents: number;
  /** Per period, over the whole ones (over, and fully covered); null with none. */
  averageCents: number | null;
}

/**
 * Money in, split by where it came from, per period — exactly what
 * monthlyFlow counts as income. Which sources get named is decided over all
 * of `txns`, not just the periods shown, so switching from months to weeks
 * doesn't reshuffle them or their colors; past `maxSources`, the rest fold
 * into "Everything else".
 */
export function incomeBySource(
  txns: Txn[],
  periods: Period[],
  today: DateKey,
  { by = "payer", maxSources = 5, outside = outsideTransfers(txns) }: { by?: IncomeGrouping; maxSources?: number; outside?: Set<Txn> } = {},
): IncomeBreakdown {
  const income = txns.filter((t) => counts(t, outside) && (t.category === "INCOME" || (outside.has(t) && t.amountCents < 0)));
  // Newest first, so a payer is labelled the way the bank spells it now.
  income.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

  const keyOf = (t: Txn) => (by === "kind" ? incomeKind(t) : merchantKey(t) || "unknown");
  const meta = new Map<string, { label: string; detail: string; allTime: number; payers: Set<string> }>();
  for (const t of income) {
    const key = keyOf(t);
    let m = meta.get(key);
    if (!m) {
      m = { label: by === "kind" ? key : t.merchant || t.name, detail: incomeKind(t), allTime: 0, payers: new Set() };
      meta.set(key, m);
    }
    m.allTime -= t.amountCents;
    m.payers.add(merchantKey(t));
  }
  const ranked = [...meta].sort((a, b) => b[1].allTime - a[1].allTime).map(([key]) => key);
  // Folding a single source into "Everything else" hides it for nothing: name it.
  const named = new Set(ranked.length <= maxSources + 1 ? ranked : ranked.slice(0, maxSources));

  const first = txns.reduce<string | null>((min, t) => (min === null || t.day < min ? t.day : min), null);
  const shown = periods.map<IncomePeriod>((p) => ({
    ...p,
    bySource: {},
    totalCents: 0,
    current: p.start <= today && today <= p.end,
    partial: first !== null && p.start < first && first <= p.end,
    empty: first === null || p.end < first,
  }));
  const totals = new Map<string, number>();
  for (const t of income) {
    const period = shown.find((p) => p.start <= t.day && t.day <= p.end);
    if (!period) continue;
    const key = named.has(keyOf(t)) ? keyOf(t) : OTHER_SOURCES;
    period.bySource[key] = (period.bySource[key] ?? 0) - t.amountCents;
    period.totalCents -= t.amountCents;
    totals.set(key, (totals.get(key) ?? 0) - t.amountCents);
  }

  const sources: IncomeSource[] = ranked
    .filter((key) => named.has(key) && totals.get(key))
    .map((key) => {
      const m = meta.get(key)!;
      return {
        key,
        slot: ranked.indexOf(key),
        label: m.label,
        detail: by === "kind" ? `${m.payers.size} ${m.payers.size === 1 ? "payer" : "payers"}` : m.detail,
        totalCents: totals.get(key)!,
      };
    })
    .sort((a, b) => b.totalCents - a.totalCents);
  if (totals.get(OTHER_SOURCES)) {
    const folded = ranked.filter((key) => !named.has(key)).length;
    sources.push({
      key: OTHER_SOURCES,
      slot: -1,
      label: "Everything else",
      detail: `${folded} smaller ${by === "kind" ? "kinds" : "sources"}`,
      totalCents: totals.get(OTHER_SOURCES)!,
    });
  }

  const whole = shown.filter((p) => !p.current && !p.partial && !p.empty);
  return {
    periods: shown,
    sources,
    totalCents: shown.reduce((n, p) => n + p.totalCents, 0),
    averageCents: whole.length ? Math.round(whole.reduce((n, p) => n + p.totalCents, 0) / whole.length) : null,
  };
}
