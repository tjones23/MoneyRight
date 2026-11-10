import { describe, expect, it } from "vitest";
import { forecast, goalProgress, homeGrowthRate, recentPace, type ForecastAccount } from "./forecast";
import type { IndexPoint } from "./valuation";

const TODAY = "2026-11-09";
const assumptions = { investmentReturnBps: 500, monthlySavingsCents: 1000_00 };

const cash: ForecastAccount = { id: 1, kind: "cash", balanceCents: 10_000_00, includeInNetWorth: true, method: { type: "linked", history: [] } };
const brokerage: ForecastAccount = { id: 2, kind: "investment", balanceCents: 100_000_00, includeInNetWorth: true, method: { type: "linked", history: [] } };
const mortgage: ForecastAccount = {
  id: 3,
  kind: "mortgage",
  balanceCents: 200_000_00,
  includeInNetWorth: true,
  method: {
    type: "linked",
    history: [
      { day: "2026-08-11", balanceCents: 201_800_00 },
      { day: "2026-11-09", balanceCents: 200_000_00 },
    ],
  },
};
const loan: ForecastAccount = {
  id: 4,
  kind: "student_loan",
  balanceCents: 1_000_00,
  includeInNetWorth: true,
  method: {
    type: "schedule",
    schedule: { principalCents: 1_000_00, accruedInterestCents: 0, annualRateBps: 0, monthlyPaymentCents: 100_00, paymentDay: 15, anchorDate: TODAY },
  },
};

describe("forecast", () => {
  it("starts from today's net worth and adds each month's savings", () => {
    const f = forecast([cash], assumptions, TODAY, 12);
    expect(f.days[0]).toBe(TODAY);
    expect(f.days[12]).toBe("2027-11-09");
    expect(f.netWorthCents[0]).toBe(10_000_00);
    expect(f.netWorthCents[12]).toBe(22_000_00);
  });

  it("grows investments at the assumed return", () => {
    const f = forecast([brokerage], { ...assumptions, monthlySavingsCents: 0 }, TODAY, 12);
    expect(f.byAccount.get(2)![12]).toBeCloseTo(105_000_00, -3);
  });

  it("pays a linked loan down at its recent pace, never past zero", () => {
    // 1,800 over 90 days: 20 a day.
    expect(recentPace(mortgage.method.type === "linked" ? mortgage.method.history : [], TODAY)).toBe(-20_00);
    const f = forecast([mortgage], { ...assumptions, monthlySavingsCents: 0 }, TODAY, 360);
    expect(f.byAccount.get(3)![12]).toBe(200_000_00 - 20_00 * 365);
    expect(f.byAccount.get(3)!.at(-1)).toBe(0);
    expect(f.netWorthCents[0]).toBe(-200_000_00);
  });

  it("follows a loan's schedule", () => {
    const f = forecast([loan], { ...assumptions, monthlySavingsCents: 0 }, TODAY, 12);
    expect(f.byAccount.get(4)![1]).toBe(900_00);
    expect(f.byAccount.get(4)![12]).toBe(0);
  });

  it("leaves out what isn't counted, but still projects it", () => {
    const f = forecast([{ ...cash, includeInNetWorth: false }], { ...assumptions, monthlySavingsCents: 0 }, TODAY, 1);
    expect(f.netWorthCents).toEqual([0, 0]);
    expect(f.byAccount.get(1)).toEqual([10_000_00, 10_000_00]);
  });
});

describe("homeGrowthRate", () => {
  const months = (n: number, yearly: number): IndexPoint[] =>
    Array.from({ length: n }, (_, i) => ({ month: `m${String(i).padStart(3, "0")}`, value: 100 * Math.pow(1 + yearly, i / 12) }));

  it("is the recent yearly rate, capped", () => {
    expect(homeGrowthRate(months(61, 0.04))).toBeCloseTo(0.04, 6);
    expect(homeGrowthRate(months(61, 0.2))).toBe(0.08);
    expect(homeGrowthRate(months(6, 0.04))).toBe(0);
  });
});

describe("goalProgress", () => {
  const kinds = new Map([
    [1, "cash" as const],
    [4, "student_loan" as const],
  ]);
  const f = forecast([cash, loan], assumptions, TODAY, 24);

  it("projects when net worth gets there, and whether that's in time", () => {
    const p = goalProgress({ id: 1, name: "20k", accountId: null, targetCents: 20_000_00, targetDate: "2027-12-31" }, f, kinds);
    expect(p).toMatchObject({ direction: "up", reached: false, onTrack: true });
    expect(p.projectedDay! < "2027-12-31").toBe(true);
    const late = goalProgress({ id: 2, name: "40k", accountId: null, targetCents: 40_000_00, targetDate: "2027-06-01" }, f, kinds);
    expect(late).toMatchObject({ projectedDay: null, onTrack: false });
  });

  it("counts a debt goal as met going down", () => {
    const p = goalProgress({ id: 3, name: "Pay off", accountId: 4, targetCents: 0, targetDate: null }, f, kinds);
    expect(p).toMatchObject({ direction: "down", currentCents: 1_000_00, onTrack: null });
    expect(p.projectedDay).not.toBeNull();
  });
});
