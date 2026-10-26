import { isLiability, KIND_ORDER, type AccountKind } from "./account-kinds";

/** Net worth from a set of balances: assets minus what's owed. */

export interface BalanceLine {
  kind: AccountKind;
  /** As stored: the positive amount owed, for a liability. */
  balanceCents: number | null;
  includeInNetWorth: boolean;
}

export interface NetWorth {
  assetsCents: number;
  liabilitiesCents: number;
  netWorthCents: number;
  /** Included accounts with no balance yet — the total is missing them. */
  missing: number;
}

export function netWorth(lines: BalanceLine[]): NetWorth {
  let assets = 0;
  let liabilities = 0;
  let missing = 0;
  for (const line of lines) {
    if (!line.includeInNetWorth) continue;
    if (line.balanceCents === null) {
      missing++;
      continue;
    }
    if (isLiability(line.kind)) liabilities += line.balanceCents;
    else assets += line.balanceCents;
  }
  return { assetsCents: assets, liabilitiesCents: liabilities, netWorthCents: assets - liabilities, missing };
}

/** Accounts bucketed by kind, in display order, empty kinds left out. */
export function groupByKind<T extends { kind: AccountKind }>(items: T[]): { kind: AccountKind; items: T[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter(
    (g) => g.items.length > 0,
  );
}
