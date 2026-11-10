import type { DatabaseSync } from "node:sqlite";
import { AccountError } from "./accounts";
import { listAssets, recordAddressEstimate, type Asset } from "./finance";
import { ProviderError } from "./providers/http";
import type { HomeEstimate, RentcastClient } from "./providers/rentcast";
import { daysBetween, dateKey } from "@/lib/local-date";

/**
 * Homes valued from their address through RentCast: looked up when added,
 * then again monthly. RentCast's free plan is 50 requests a month and it
 * bills past that with no cap of its own, so MoneyRight stops itself well
 * short: every request is counted per calendar month, here, before it's sent.
 */

export const RENTCAST_MONTHLY_CAP = 40;
/** RentCast's estimates move slowly; monthly is plenty. */
export const REESTIMATE_AFTER_DAYS = 30;
/** After a failure, wait a day before asking again. */
const RETRY_AFTER_MS = 24 * 60 * 60_000;

function counterKey(now: number) {
  return `rentcast_requests_${dateKey(now).slice(0, 7)}`;
}

export function rentcastRequestsThisMonth(db: DatabaseSync, now: number = Date.now()): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(counterKey(now)) as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/** Counts a request about to be sent, or refuses it at the cap. */
function spendRequest(db: DatabaseSync, now: number) {
  if (rentcastRequestsThisMonth(db, now) >= RENTCAST_MONTHLY_CAP) {
    throw new AccountError(
      `This month's ${RENTCAST_MONTHLY_CAP} address lookups are used up (RentCast's free plan bills past 50). Try again next month, or enter a value by hand.`,
    );
  }
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, '1')
     ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
  ).run(counterKey(now));
}

/** A plain-language reason for a failed lookup; RentCast's codes are safe to show, its messages aren't needed. */
export function lookupProblem(error: unknown): string {
  if (error instanceof AccountError) return error.message;
  if (error instanceof ProviderError) {
    if (error.code === "no_estimate" || error.status === 404) return "RentCast couldn't find that address — check the street, city, state and ZIP.";
    if (error.status === 401 || error.status === 403) return `RentCast refused the API key (${error.code}). Check RENTCAST_API_KEY and that the free plan is active.`;
    return `RentCast didn't answer (${error.code}). It'll be tried again tomorrow.`;
  }
  return "The lookup failed unexpectedly.";
}

/** One lookup, counted against the month's cap. */
export async function lookUpHome(db: DatabaseSync, client: RentcastClient, address: string, now: number): Promise<HomeEstimate> {
  spendRequest(db, now);
  return client.valueEstimate(address);
}

/** Address-valued homes whose estimate is a month old, not tried in the last day. */
export function homeEstimatesDue(db: DatabaseSync, now: number): Asset[] {
  const today = dateKey(now);
  return listAssets(db).filter(
    (a) =>
      a.valuation.method === "address" &&
      a.valuation.address &&
      daysBetween(a.valuation.asOf, today) >= REESTIMATE_AFTER_DAYS &&
      (a.estimate?.attemptAt === null || a.estimate?.attemptAt === undefined || now - a.estimate.attemptAt >= RETRY_AFTER_MS),
  );
}

/** Looks each due home up again. A failure keeps the last value and is shown on the Accounts page. */
export async function refreshHomeEstimates(db: DatabaseSync, client: RentcastClient, now: number): Promise<number> {
  let refreshed = 0;
  for (const asset of homeEstimatesDue(db, now)) {
    try {
      const estimate = await lookUpHome(db, client, asset.valuation.address!, now);
      recordAddressEstimate(db, asset.accountId, { ...estimate, day: dateKey(now) }, now);
      refreshed++;
    } catch (error) {
      recordAddressEstimate(db, asset.accountId, { error: lookupProblem(error) }, now);
      // At the cap, the rest would fail the same way.
      if (error instanceof AccountError) break;
    }
  }
  return refreshed;
}
