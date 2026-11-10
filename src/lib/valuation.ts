import { daysBetween, type DateKey } from "./local-date";

/**
 * What a home, a vehicle or anything else owned is worth today, estimated
 * from one known value — the same idea as a loan schedule.
 *
 * Nothing free prices a particular car or house, so the person enters a
 * value (an appraisal, a purchase price, a KBB or Consumer Reports lookup)
 * and how it should move after that:
 *
 *   fixed         stays put until updated
 *   depreciation  loses a share of its value each year, compounding — a
 *                 car's usual curve
 *   home_index    moves with its ZIP code's home values (Zillow's ZHVI):
 *                 the entered value × index now ÷ index when it was true
 *   address       a home valued from its address by RentCast, fetched
 *                 again monthly (home-estimates.ts); held in between
 *
 * Pure: takes the date to value at, and the index, rather than reading them.
 */

export type ValuationMethod = "fixed" | "depreciation" | "home_index" | "address";

export interface AssetValuation {
  valueCents: number;
  /** The date `valueCents` was true. */
  asOf: DateKey;
  method: ValuationMethod;
  /** Depreciation per year, e.g. 15% → 1500. Unused by the other methods. */
  annualRateBps: number;
  /** Five digits: for home_index, and the matched ZIP for address. */
  zip: string | null;
  /** For address: what was entered, e.g. "12 Elm St, Boston, MA 02134". */
  address?: string | null;
}

/** One month of an index: "YYYY-MM" and the level that month. */
export interface IndexPoint {
  month: string;
  value: number;
}

export interface AssetEstimate {
  valueCents: number;
  /** For home_index: the month of the index reading used, or null with no index yet. */
  indexMonth: string | null;
}

const DAYS_PER_YEAR = 365.25;

/** A common rule of thumb for cars a few years old; the person can change it. */
export const DEFAULT_VEHICLE_DEPRECIATION_BPS = 1500;

/** The last reading in or before `day`'s month, from points sorted by month. */
export function indexAt(points: IndexPoint[], day: DateKey): IndexPoint | null {
  const month = day.slice(0, 7);
  let found: IndexPoint | null = null;
  for (const p of points) {
    if (p.month > month) break;
    found = p;
  }
  return found;
}

export function estimateAsset(v: AssetValuation, to: DateKey, index: IndexPoint[] = []): AssetEstimate {
  const days = Math.max(0, daysBetween(v.asOf, to));
  switch (v.method) {
    case "depreciation": {
      const factor = Math.pow(1 - v.annualRateBps / 10_000, days / DAYS_PER_YEAR);
      return { valueCents: Math.round(v.valueCents * factor), indexMonth: null };
    }
    case "home_index": {
      const now = indexAt(index, to);
      // Valued before the index starts: measure from its first reading.
      const then = indexAt(index, v.asOf) ?? index[0] ?? null;
      if (!now || !then || then.value <= 0 || days === 0) return { valueCents: v.valueCents, indexMonth: now?.month ?? null };
      return { valueCents: Math.round((v.valueCents * now.value) / then.value), indexMonth: now.month };
    }
    default:
      return { valueCents: v.valueCents, indexMonth: null };
  }
}
