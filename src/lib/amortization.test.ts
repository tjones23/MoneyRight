import { describe, expect, it } from "vitest";
import { paymentCoversInterest, paymentDates, projectLoan, type LoanSchedule } from "./amortization";
import { addDays, daysBetween, isDateKey, nthMonthDay } from "./local-date";

const loan: LoanSchedule = {
  principalCents: 10_000_00,
  accruedInterestCents: 0,
  annualRateBps: 600, // 6%
  monthlyPaymentCents: 200_00,
  paymentDay: 15,
  anchorDate: "2026-01-15",
};

describe("dates", () => {
  it("does day arithmetic on calendar dates", () => {
    expect(daysBetween("2026-01-15", "2026-02-15")).toBe(31);
    expect(daysBetween("2026-03-01", "2026-03-31")).toBe(30); // across the DST change
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isDateKey("2026-02-29")).toBe(false);
    expect(isDateKey("2028-02-29")).toBe(true);
  });

  it("clamps a payment day to short months", () => {
    expect(nthMonthDay("2026-01-31", 1, 31)).toBe("2026-02-28");
    expect(paymentDates("2026-01-31", "2026-04-30", 31)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });
});

describe("projectLoan", () => {
  it("is the anchor balance on the anchor date", () => {
    expect(projectLoan(loan, "2026-01-15")).toMatchObject({ principalCents: 10_000_00, balanceCents: 10_000_00, paymentsMade: 0 });
  });

  it("accrues simple daily interest between payments", () => {
    // 31 days at 6% on $10,000: 10000 × 0.06 × 31 / 365.25 = $50.92
    const p = projectLoan(loan, "2026-02-14");
    expect(p.paymentsMade).toBe(0);
    expect(p.accruedInterestCents).toBe(Math.round((10_000_00 * 0.06 * 30) / 365.25));
  });

  it("applies each payment to interest first, then principal", () => {
    const p = projectLoan(loan, "2026-02-15");
    const interest = (10_000_00 * 0.06 * 31) / 365.25;
    expect(p.paymentsMade).toBe(1);
    expect(p.accruedInterestCents).toBe(0);
    expect(p.principalCents).toBe(Math.round(10_000_00 - (200_00 - interest)));
  });

  it("lets interest build when the payment doesn't cover it, and never compounds it", () => {
    const small = { ...loan, monthlyPaymentCents: 10_00 };
    expect(paymentCoversInterest(small)).toBe(false);
    const p = projectLoan(small, "2027-01-15");
    expect(p.principalCents).toBe(10_000_00);
    // A year of 6% simple interest, less twelve $10 payments.
    expect(p.accruedInterestCents).toBeCloseTo(600_00 - 120_00, -2);
  });

  it("pays a loan off and stops", () => {
    const p = projectLoan({ ...loan, principalCents: 300_00 }, "2026-12-31");
    expect(p.paidOff).toBe(true);
    expect(p.balanceCents).toBe(0);
    expect(p.paymentsMade).toBe(2);
  });

  it("with no payment, only accrues", () => {
    const p = projectLoan({ ...loan, monthlyPaymentCents: 0 }, "2026-07-15");
    expect(p.principalCents).toBe(10_000_00);
    expect(p.balanceCents).toBeGreaterThan(10_000_00);
  });

  it("doesn't project backwards", () => {
    expect(projectLoan(loan, "2025-12-01").balanceCents).toBe(10_000_00);
  });
});
