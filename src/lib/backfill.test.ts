import { describe, expect, it } from "vitest";
import { investmentFlow, rewindBalances, rewindWithGrowth, transactionFlow, type InvestmentMove } from "./backfill";

describe("rewindBalances", () => {
  it("undoes each day's transactions, closing the day before", () => {
    const rows = rewindBalances("2026-11-09", 1000_00, [
      { day: "2026-11-05", cents: transactionFlow(false, 50_00) },
      { day: "2026-11-03", cents: transactionFlow(false, -2000_00) },
      { day: "2026-11-03", cents: transactionFlow(false, 5_00) },
    ]);
    expect(rows).toEqual([
      { day: "2026-11-02", balanceCents: -945_00 },
      { day: "2026-11-04", balanceCents: 1050_00 },
    ]);
  });

  it("counts the first reading's own day, and ignores anything after it", () => {
    const rows = rewindBalances("2026-11-09", 100_00, [
      { day: "2026-11-09", cents: -10_00 },
      { day: "2026-11-10", cents: 999_00 },
    ]);
    expect(rows).toEqual([{ day: "2026-11-08", balanceCents: 110_00 }]);
  });

  it("raises what's owed on a card for a charge, and lowers it for a payment", () => {
    expect(transactionFlow(true, 40_00)).toBe(40_00);
    expect(transactionFlow(true, -500_00)).toBe(-500_00);
    const rows = rewindBalances("2026-11-09", 300_00, [
      { day: "2026-11-08", cents: transactionFlow(true, 40_00) },
      { day: "2026-11-07", cents: transactionFlow(true, -500_00) },
    ]);
    expect(rows).toEqual([
      { day: "2026-11-06", balanceCents: 760_00 },
      { day: "2026-11-07", balanceCents: 260_00 },
    ]);
  });

  it("has nothing to say without transactions", () => {
    expect(rewindBalances("2026-11-09", 100_00, [])).toEqual([]);
  });
});

describe("rewindWithGrowth", () => {
  it("at no growth, takes off only the money that came in", () => {
    const rows = rewindWithGrowth("2026-11-09", 10_000_00, [{ day: "2026-11-07", cents: 1_000_00 }], "2026-11-05", 0);
    expect(rows.map((r) => r.day)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(rows.map((r) => r.balanceCents)).toEqual([9_000_00, 9_000_00, 10_000_00, 10_000_00]);
  });

  it("shrinks the value by the assumed return going back", () => {
    const rows = rewindWithGrowth("2026-11-09", 10_000_00, [], "2025-11-09", 500);
    expect(rows).toHaveLength(365);
    expect(rows[0]).toEqual({ day: "2025-11-09", balanceCents: Math.round(10_000_00 / 1.05) });
    expect(rows.at(-1)!.balanceCents).toBeLessThan(10_000_00);
  });

  it("never goes below zero", () => {
    const rows = rewindWithGrowth("2026-11-09", 100_00, [{ day: "2026-11-08", cents: 500_00 }], "2026-11-06", 0);
    expect(rows.map((r) => r.balanceCents)).toEqual([0, 0, 100_00]);
  });
});

describe("investmentFlow", () => {
  const move = (more: Partial<InvestmentMove>): InvestmentMove => ({
    day: "2026-11-01",
    type: "cash",
    subtype: null,
    amountCents: 0,
    quantity: null,
    priceCents: null,
    ...more,
  });

  it("counts money put in and taken out", () => {
    expect(investmentFlow(move({ subtype: "contribution", amountCents: -500_00 }))).toBe(500_00);
    expect(investmentFlow(move({ subtype: "deposit", amountCents: -20_00 }))).toBe(20_00);
    expect(investmentFlow(move({ subtype: "withdrawal", amountCents: 200_00 }))).toBe(-200_00);
  });

  it("leaves out what happens inside the account", () => {
    expect(investmentFlow(move({ type: "buy", subtype: "buy", amountCents: 1_000_00 }))).toBe(0);
    expect(investmentFlow(move({ type: "sell", subtype: "sell", amountCents: -1_000_00 }))).toBe(0);
    expect(investmentFlow(move({ subtype: "dividend", amountCents: -12_00 }))).toBe(0);
    expect(investmentFlow(move({ type: "fee", subtype: "account fee", amountCents: 5_00 }))).toBe(0);
  });

  it("values shares moved in kind at their price then", () => {
    expect(investmentFlow(move({ type: "transfer", subtype: "transfer", quantity: 10, priceCents: 100_00 }))).toBe(1_000_00);
    expect(investmentFlow(move({ type: "transfer", subtype: "transfer", quantity: -2, priceCents: 50_00 }))).toBe(-100_00);
  });
});
