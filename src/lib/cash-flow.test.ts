import { describe, expect, it } from "vitest";
import { averageMonthlyNet, merchantKey, monthlyFlow, monthsEnding, receivedTransfers, recurringCharges, type Txn } from "./cash-flow";

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
