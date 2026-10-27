import { describe, expect, it } from "vitest";
import { plaidKind } from "./account-kinds";
import { groupByKind, netWorth } from "./net-worth";

describe("account kinds", () => {
  it("maps Plaid types", () => {
    expect(plaidKind("depository", "checking")).toBe("cash");
    expect(plaidKind("credit", "credit card")).toBe("credit");
    expect(plaidKind("investment", "401k")).toBe("investment");
    expect(plaidKind("loan", "mortgage")).toBe("mortgage");
    expect(plaidKind("loan", "student")).toBe("student_loan");
    expect(plaidKind("loan", "auto")).toBe("loan");
    expect(plaidKind("brokerage", null)).toBe("investment");
  });
});

describe("netWorth", () => {
  it("subtracts what's owed, skips excluded accounts, and counts missing balances", () => {
    const result = netWorth([
      { kind: "cash", balanceCents: 5_000_00, includeInNetWorth: true },
      { kind: "investment", balanceCents: 20_000_00, includeInNetWorth: true },
      { kind: "credit", balanceCents: 1_200_00, includeInNetWorth: true },
      { kind: "mortgage", balanceCents: 200_000_00, includeInNetWorth: false },
      { kind: "student_loan", balanceCents: null, includeInNetWorth: true },
    ]);
    expect(result).toEqual({ assetsCents: 25_000_00, liabilitiesCents: 1_200_00, netWorthCents: 23_800_00, missing: 1 });
  });

  it("groups in display order", () => {
    const groups = groupByKind([{ kind: "credit" as const }, { kind: "cash" as const }, { kind: "cash" as const }]);
    expect(groups.map((g) => [g.kind, g.items.length])).toEqual([
      ["cash", 2],
      ["credit", 1],
    ]);
  });
});
