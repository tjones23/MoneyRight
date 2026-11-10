import { describe, expect, it } from "vitest";
import { estimateAsset, indexAt, type AssetValuation, type IndexPoint } from "./valuation";

const car: AssetValuation = { valueCents: 20_000_00, asOf: "2026-01-01", method: "depreciation", annualRateBps: 1500, zip: null };
const home: AssetValuation = { valueCents: 400_000_00, asOf: "2025-06-10", method: "home_index", annualRateBps: 0, zip: "43215" };
const index: IndexPoint[] = [
  { month: "2025-05", value: 250_000 },
  { month: "2025-06", value: 260_000 },
  { month: "2025-12", value: 273_000 },
];

describe("estimateAsset", () => {
  it("holds a fixed value", () => {
    expect(estimateAsset({ ...car, method: "fixed" }, "2030-01-01").valueCents).toBe(20_000_00);
  });

  it("depreciates by compounding, a share a year", () => {
    expect(estimateAsset(car, "2026-01-01").valueCents).toBe(20_000_00);
    // 365 of 365.25 days: a hair under a full 15%.
    expect(estimateAsset(car, "2027-01-01").valueCents).toBe(17_001_89);
    expect(estimateAsset(car, "2028-01-01").valueCents).toBeCloseTo(14_450_00, -3);
  });

  it("never estimates before its date", () => {
    expect(estimateAsset(car, "2025-06-01").valueCents).toBe(20_000_00);
  });

  it("moves a home with its ZIP's index since the month it was valued", () => {
    expect(estimateAsset(home, "2026-03-01", index)).toEqual({ valueCents: 420_000_00, indexMonth: "2025-12" });
  });

  it("holds a home until there's an index", () => {
    expect(estimateAsset(home, "2026-03-01", [])).toEqual({ valueCents: 400_000_00, indexMonth: null });
  });

  it("measures from the first reading when valued before the index starts", () => {
    expect(estimateAsset({ ...home, asOf: "2020-01-01" }, "2026-03-01", index).valueCents).toBe(436_800_00);
  });
});

describe("indexAt", () => {
  it("takes the last reading in or before the month", () => {
    expect(indexAt(index, "2025-06-01")?.month).toBe("2025-06");
    expect(indexAt(index, "2025-09-30")?.month).toBe("2025-06");
    expect(indexAt(index, "2025-04-30")).toBeNull();
  });
});
