import { describe, expect, it } from "vitest";
import { accountSeries, changes, netWorthSeries, niceTicks, parseRange, rangeStart, type HistoryAccount } from "./history";

const cash: HistoryAccount = { id: 1, kind: "cash", includeInNetWorth: true, gone: false };
const loan: HistoryAccount = { id: 2, kind: "student_loan", includeInNetWorth: true, gone: false };
const brokerage: HistoryAccount = { id: 3, kind: "investment", includeInNetWorth: true, gone: false };

describe("netWorthSeries", () => {
  it("carries balances forward across missing days and subtracts what's owed", () => {
    const series = netWorthSeries(
      [cash, loan],
      [
        { accountId: 1, day: "2026-10-01", balanceCents: 1000_00 },
        { accountId: 2, day: "2026-10-01", balanceCents: 400_00 },
        { accountId: 1, day: "2026-10-03", balanceCents: 1500_00 },
      ],
      "2026-10-01",
      "2026-10-04",
    );
    expect(series.map((p) => p.netWorthCents)).toEqual([600_00, 600_00, 1100_00, 1100_00]);
    expect(series[2]).toMatchObject({ assetsCents: 1500_00, liabilitiesCents: 400_00 });
  });

  it("starts from the balance before the range", () => {
    const series = netWorthSeries([cash], [{ accountId: 1, day: "2026-09-01", balanceCents: 50_00 }], "2026-10-01", "2026-10-02");
    expect(series.map((p) => p.netWorthCents)).toEqual([50_00, 50_00]);
  });

  it("drops a gone account after its last snapshot, and skips excluded ones", () => {
    const gone = { ...brokerage, gone: true };
    const excluded = { ...cash, id: 9, includeInNetWorth: false };
    const series = netWorthSeries(
      [gone, excluded],
      [
        { accountId: 3, day: "2026-10-01", balanceCents: 200_00 },
        { accountId: 9, day: "2026-10-01", balanceCents: 999_00 },
      ],
      "2026-10-01",
      "2026-10-02",
    );
    expect(series.map((p) => p.netWorthCents)).toEqual([200_00, 0]);
  });
});

describe("changes", () => {
  it("separates real change from accounts added during the range", () => {
    const summary = changes(
      [cash, loan, brokerage],
      [
        { accountId: 1, day: "2026-10-01", balanceCents: 1000_00 },
        { accountId: 2, day: "2026-10-01", balanceCents: 500_00 },
        { accountId: 1, day: "2026-10-10", balanceCents: 1200_00 },
        { accountId: 2, day: "2026-10-10", balanceCents: 450_00 },
        { accountId: 3, day: "2026-10-05", balanceCents: 7000_00 },
      ],
      "2026-10-01",
      "2026-10-10",
    );
    // Cash +200, loan paid down 50 (a gain), brokerage linked mid-range.
    expect(summary.changeCents).toBe(250_00);
    expect(summary.addedCents).toBe(7000_00);
    expect(summary.accounts.map((a) => [a.accountId, a.status, a.effectCents])).toEqual([
      [3, "added", 7000_00],
      [1, "changed", 200_00],
      [2, "changed", 50_00],
    ]);
  });
});

describe("accountSeries", () => {
  it("is null before the first snapshot", () => {
    const series = accountSeries([{ accountId: 5, day: "2026-10-02", balanceCents: 10_00 }], "2026-10-01", "2026-10-03");
    expect(series.map((p) => p.balanceCents)).toEqual([null, 10_00, 10_00]);
  });
});

describe("ranges", () => {
  it("parses, and never starts before the first data", () => {
    expect(parseRange("1y")).toBe("1y");
    expect(parseRange("nonsense")).toBe("30d");
    expect(rangeStart("30d", "2026-10-26", "2026-01-01")).toBe("2026-09-26");
    expect(rangeStart("1y", "2026-10-26", "2026-10-20")).toBe("2026-10-20");
    expect(rangeStart("all", "2026-10-26", "2026-03-04")).toBe("2026-03-04");
  });
});

describe("niceTicks", () => {
  it("covers the range with round steps", () => {
    expect(niceTicks(1234_00, 9876_00)).toEqual([0, 2500_00, 5000_00, 7500_00, 10000_00]);
    const flat = niceTicks(5000_00, 5000_00);
    expect(flat[0]).toBeLessThan(5000_00);
    expect(flat[flat.length - 1]).toBeGreaterThan(5000_00);
    const negative = niceTicks(-30000_00, 12000_00);
    expect(negative[0]).toBeLessThanOrEqual(-30000_00);
    expect(negative).toContain(0);
  });
});
