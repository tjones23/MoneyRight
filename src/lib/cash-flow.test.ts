import { describe, expect, it } from "vitest";
import { averageMonthlyNet, merchantKey, monthlyFlow, monthsEnding, recurringCharges, type Txn } from "./cash-flow";

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
