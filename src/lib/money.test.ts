import { describe, expect, it } from "vitest";
import { dollarsToCents, formatCents, formatChange, parseDecimalToCents } from "./money";

describe("parseDecimalToCents", () => {
  it("reads decimal strings exactly", () => {
    expect(parseDecimalToCents("28575.02")).toBe(2857502);
    expect(parseDecimalToCents("0.1")).toBe(10);
    expect(parseDecimalToCents("-12.5")).toBe(-1250);
    expect(parseDecimalToCents("1,234")).toBe(123400);
    expect(parseDecimalToCents("$9.99")).toBe(999);
    expect(parseDecimalToCents(".5")).toBe(50);
  });

  it("rounds a third decimal half-up", () => {
    expect(parseDecimalToCents("1.005")).toBe(101);
    expect(parseDecimalToCents("1.004")).toBe(100);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "abc", "1.2.3", "--1", null, undefined]) expect(parseDecimalToCents(bad)).toBeNull();
  });
});

describe("dollarsToCents", () => {
  it("rounds JSON numbers to cents", () => {
    expect(dollarsToCents(110.1)).toBe(11010);
    expect(dollarsToCents(0.29)).toBe(29);
    expect(dollarsToCents(null)).toBeNull();
    expect(dollarsToCents(Number.NaN)).toBeNull();
  });
});

describe("formatting", () => {
  it("shows dollars, and signed changes", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(123456, { whole: true })).toBe("$1,235");
    expect(formatChange(1204_00)).toBe("+$1,204.00");
    expect(formatChange(-88_10)).toBe("−$88.10");
  });
});
