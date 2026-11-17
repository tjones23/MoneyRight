import { describe, expect, it } from "vitest";
import {
  OTHER_SOURCES,
  averageMonthlyNet,
  incomeBySource,
  merchantKey,
  monthlyFlow,
  monthsEnding,
  periodOf,
  periodsEnding,
  receivedTransfers,
  recurringCharges,
  type Txn,
} from "./cash-flow";

function txn(day: string, amountCents: number, more: Partial<Txn> = {}): Txn {
  return { accountId: 1, day, amountCents, name: "Thing", merchant: null, category: "GENERAL_MERCHANDISE", categoryDetailed: null, pending: false, ...more };
}

describe("monthlyFlow", () => {
  const txns = [
    txn("2026-09-01", -5000_00, { category: "INCOME", categoryDetailed: "INCOME_WAGES" }),
    txn("2026-09-03", 120_00, { category: "FOOD_AND_DRINK" }),
    txn("2026-09-05", 300_00),
    txn("2026-09-09", -50_00), // a refund
    txn("2026-09-10", 1800_00, { category: "LOAN_PAYMENTS", categoryDetailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" }),
    txn("2026-09-12", 900_00, { category: "LOAN_PAYMENTS", categoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }),
    txn("2026-09-14", 1000_00, { category: "TRANSFER_OUT" }),
    txn("2026-09-20", 40_00, { pending: true }),
    txn("2026-10-02", 10_00),
  ];

  it("counts income and spending, leaving out transfers, card payments and pending", () => {
    const [sep] = monthlyFlow(txns, ["2026-09"]);
    expect(sep.incomeCents).toBe(5000_00);
    expect(sep.spendingCents).toBe(120_00 + 250_00 + 1800_00);
    expect(sep.netCents).toBe(5000_00 - 2170_00);
    expect(sep.byCategory.map((c) => c.category)).toEqual(["LOAN_PAYMENTS", "GENERAL_MERCHANDISE", "FOOD_AND_DRINK"]);
  });

  it("counts money sent from outside as income, but not money moved between your own accounts", () => {
    const zelle = txn("2026-09-02", -200_00, { name: "Zelle from Sam", category: "TRANSFER_IN", categoryDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" });
    const stripe = txn("2026-09-04", -1234_56, { name: "STRIPE TRANSFER", category: "TRANSFER_IN", categoryDetailed: "TRANSFER_IN_DEPOSIT" });
    // Savings to checking: out of account 2, into account 1 two days later.
    const fromSavings = txn("2026-09-08", 500_00, { accountId: 2, category: "TRANSFER_OUT", categoryDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" });
    const intoChecking = txn("2026-09-10", -500_00, { category: "TRANSFER_IN", categoryDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" });
    // An unlinked brokerage paying out, and a cash advance: your own money, or borrowed.
    const brokerage = txn("2026-09-11", -300_00, { category: "TRANSFER_IN", categoryDetailed: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS" });
    const advance = txn("2026-09-12", -100_00, { category: "TRANSFER_IN", categoryDetailed: "TRANSFER_IN_CASH_ADVANCES_AND_LOANS" });
    const pendingVenmo = txn("2026-09-13", -40_00, { category: "TRANSFER_IN", categoryDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER", pending: true });
    const all = [zelle, stripe, fromSavings, intoChecking, brokerage, advance, pendingVenmo];

    expect(receivedTransfers(all)).toEqual(new Set([zelle, stripe]));
    const [sep] = monthlyFlow(all, ["2026-09"]);
    expect(sep.incomeCents).toBe(200_00 + 1234_56);
    expect(sep.spendingCents).toBe(0);
  });

  it("doesn't pair a transfer in with an outflow from the same account, or one too far apart", () => {
    const sameAccount = txn("2026-09-01", 500_00, { category: "TRANSFER_OUT" });
    const weeksLater = txn("2026-09-20", 500_00, { accountId: 2, category: "TRANSFER_OUT" });
    const venmo = txn("2026-09-02", -500_00, { category: "TRANSFER_IN", categoryDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" });
    expect(receivedTransfers([sameAccount, weeksLater, venmo])).toEqual(new Set([venmo]));
  });

  it("averages only whole months after transactions begin", () => {
    // Today is in November: September is whole but is the first month seen, so only October counts.
    expect(averageMonthlyNet(txns, "2026-11-09", 6)).toBe(-10_00);
    expect(averageMonthlyNet([], "2026-11-09")).toBeNull();
  });

  it("lists months oldest first, across a year end", () => {
    expect(monthsEnding("2027-02-10", 4)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
});

describe("recurringCharges", () => {
  const netflix = (day: string, cents = 15_49) => txn(day, cents, { name: `NETFLIX.COM #${day.slice(5, 7)}`, merchant: "Netflix" });

  it("finds a steady monthly charge, with its next date", () => {
    const found = recurringCharges([netflix("2026-08-15"), netflix("2026-09-15"), netflix("2026-10-15")], "2026-11-01");
    expect(found).toEqual([
      expect.objectContaining({ name: "Netflix", cadence: "monthly", amountCents: 15_49, nextDay: "2026-11-15", occurrences: 3 }),
    ]);
  });

  it("drops one that stopped, or that's irregular", () => {
    expect(recurringCharges([netflix("2026-05-15"), netflix("2026-06-15"), netflix("2026-07-15")], "2026-11-01")).toEqual([]);
    expect(recurringCharges([netflix("2026-08-01"), netflix("2026-08-29"), netflix("2026-10-20")], "2026-11-01")).toEqual([]);
    expect(recurringCharges([netflix("2026-08-15", 1500), netflix("2026-09-15", 9000), netflix("2026-10-15", 400)], "2026-11-01")).toEqual([]);
  });

  it("knows a merchant however it's spelled", () => {
    expect(merchantKey({ merchant: null, name: "SHELL OIL 57442 #12" })).toBe(merchantKey({ merchant: null, name: "Shell Oil 99120" }));
  });
});

describe("periods", () => {
  it("starts weeks on Monday and knows month, quarter and year ends", () => {
    // 2026-11-16 is a Monday; the 15th a Sunday.
    expect(periodOf("2026-11-15", "week")).toEqual({ key: "2026-11-09", start: "2026-11-09", end: "2026-11-15" });
    expect(periodOf("2026-11-16", "week").start).toBe("2026-11-16");
    expect(periodOf("2028-02-10", "month")).toEqual({ key: "2028-02", start: "2028-02-01", end: "2028-02-29" });
    expect(periodOf("2026-11-16", "quarter")).toEqual({ key: "2026-Q4", start: "2026-10-01", end: "2026-12-31" });
    expect(periodOf("2026-11-16", "year")).toEqual({ key: "2026", start: "2026-01-01", end: "2026-12-31" });
  });

  it("counts back across a year end, oldest first", () => {
    expect(periodsEnding("2026-02-03", "quarter", 3).map((p) => p.key)).toEqual(["2025-Q3", "2025-Q4", "2026-Q1"]);
    expect(periodsEnding("2026-01-02", "week", 2).map((p) => p.key)).toEqual(["2025-12-22", "2025-12-29"]);
  });
});

describe("incomeBySource", () => {
  const pay = (day: string, cents: number, name = "ACME CORP PAYROLL 12345") =>
    txn(day, -cents, { name, category: "INCOME", categoryDetailed: "INCOME_WAGES" });
  const txns = [
    txn("2026-07-03", 80_00), // the first transaction: July is partly covered
    pay("2026-07-15", 4000_00),
    pay("2026-08-15", 4000_00, "ACME CORP PAYROLL 67890"),
    pay("2026-09-15", 4000_00),
    pay("2026-10-15", 4200_00),
    txn("2026-09-02", -200_00, { name: "Zelle from Sam", category: "TRANSFER_IN", categoryDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" }),
    txn("2026-10-30", -12_34, { name: "Interest paid", category: "INCOME", categoryDetailed: "INCOME_INTEREST_EARNED" }),
    txn("2026-11-01", -1500_00, { merchant: "Stripe", name: "STRIPE TRANSFER", category: "TRANSFER_IN", categoryDetailed: "TRANSFER_IN_DEPOSIT" }),
    txn("2026-10-10", 1000_00, { category: "TRANSFER_OUT" }),
  ];
  const months = periodsEnding("2026-11-16", "month", 6);

  it("splits money in by payer, the same total monthlyFlow counts", () => {
    const result = incomeBySource(txns, months, "2026-11-16");
    expect(result.sources.map((s) => [s.label, s.totalCents])).toEqual([
      ["ACME CORP PAYROLL 12345", 16200_00],
      ["Stripe", 1500_00],
      ["Zelle from Sam", 200_00],
      ["Interest paid", 12_34],
    ]);
    expect(result.sources[0].detail).toBe("Paychecks");
    expect(result.sources[1].detail).toBe("Sent to you");
    const flows = monthlyFlow(txns, months.map((p) => p.key));
    expect(result.periods.map((p) => p.totalCents)).toEqual(flows.map((f) => f.incomeCents));
    expect(result.totalCents).toBe(16200_00 + 1500_00 + 200_00 + 12_34);
  });

  it("marks periods before, part-way into and still in progress, and averages only whole ones", () => {
    const result = incomeBySource(txns, months, "2026-11-16");
    expect(result.periods.map((p) => (p.empty ? "empty" : p.partial ? "partial" : p.current ? "current" : "whole"))).toEqual([
      "empty",
      "partial",
      "whole",
      "whole",
      "whole",
      "current",
    ]);
    // August, September, October.
    expect(result.averageCents).toBe(Math.round((4000_00 + 4200_00 + 4212_34) / 3));
  });

  it("groups by kind", () => {
    const result = incomeBySource(txns, months, "2026-11-16", { by: "kind" });
    expect(result.sources.map((s) => [s.label, s.totalCents, s.detail])).toEqual([
      ["Paychecks", 16200_00, "1 payer"],
      ["Sent to you", 1700_00, "2 payers"],
      ["Interest", 12_34, "1 payer"],
    ]);
  });

  it("folds the smaller sources together, and keeps each source's color whatever the window", () => {
    const folded = incomeBySource(txns, months, "2026-11-16", { maxSources: 2 });
    expect(folded.sources.map((s) => s.key)).toEqual([merchantKey(txns[1]), "stripe", OTHER_SOURCES]);
    expect(folded.sources.at(-1)).toMatchObject({ totalCents: 212_34, detail: "2 smaller sources", slot: -1 });

    // Just November: Stripe is the only source shown, and keeps the second color.
    const november = incomeBySource(txns, periodsEnding("2026-11-16", "month", 1), "2026-11-16");
    expect(november.sources).toMatchObject([{ key: "stripe", slot: 1 }]);
  });

  it("names a lone extra source rather than folding it", () => {
    const result = incomeBySource(txns, months, "2026-11-16", { maxSources: 3 });
    expect(result.sources.map((s) => s.key)).not.toContain(OTHER_SOURCES);
    expect(result.sources).toHaveLength(4);
  });
});
