import { isLiability, type AccountKind } from "./account-kinds";
import { addDays, daysBetween, type DateKey } from "./local-date";

/**
 * Net worth over time, from daily snapshots.
 *
 * Snapshots are sparse — a connection that fails for a few days leaves gaps —
 * so each account carries its last known balance forward until the next
 * one. An account that's gone (closed, deselected) stops at its last
 * snapshot instead of counting forever. An account only joins the total from
 * its first snapshot, so linking one shows up as an addition, not as growth;
 * `changes` keeps the two apart.
 *
 * Pure: everything comes in as arguments.
 */

export interface HistoryAccount {
  id: number;
  kind: AccountKind;
  includeInNetWorth: boolean;
  gone: boolean;
}

export interface Snapshot {
  accountId: number;
  day: DateKey;
  balanceCents: number;
}

export interface NetWorthPoint {
  day: DateKey;
  netWorthCents: number;
  assetsCents: number;
  liabilitiesCents: number;
}

export type Range = "30d" | "90d" | "1y" | "all";

export const RANGES: { value: Range; label: string }[] = [
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "all", label: "All" },
];

export function parseRange(value: unknown): Range {
  return value === "90d" || value === "1y" || value === "all" ? value : "30d";
}

/** The first day of a range ending `today`, never before the first data. */
export function rangeStart(range: Range, today: DateKey, firstDay: DateKey | null): DateKey {
  const back = range === "30d" ? 30 : range === "90d" ? 90 : range === "1y" ? 365 : Infinity;
  const start = Number.isFinite(back) ? addDays(today, -back) : (firstDay ?? today);
  return firstDay && daysBetween(start, firstDay) > 0 ? firstDay : start;
}

/** Each account's balance on each day from `from` to `to`, carried forward. */
function* walk(accounts: HistoryAccount[], snapshots: Snapshot[], from: DateKey, to: DateKey) {
  const byAccount = new Map<number, Snapshot[]>();
  for (const s of [...snapshots].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    const list = byAccount.get(s.accountId);
    if (list) list.push(s);
    else byAccount.set(s.accountId, [s]);
  }
  const cursor = new Map<number, number>();
  const current = new Map<number, number>();
  for (let day = from; daysBetween(day, to) >= 0; day = addDays(day, 1)) {
    for (const account of accounts) {
      const list = byAccount.get(account.id) ?? [];
      let i = cursor.get(account.id) ?? 0;
      while (i < list.length && list[i].day <= day) {
        current.set(account.id, list[i].balanceCents);
        i++;
      }
      cursor.set(account.id, i);
      // A gone account stops after its last snapshot.
      if (account.gone && i === list.length && list.length > 0 && list[list.length - 1].day < day) {
        current.delete(account.id);
      }
    }
    yield { day, balances: current };
  }
}

export function netWorthSeries(accounts: HistoryAccount[], snapshots: Snapshot[], from: DateKey, to: DateKey): NetWorthPoint[] {
  const counted = accounts.filter((a) => a.includeInNetWorth);
  const kinds = new Map(counted.map((a) => [a.id, a.kind]));
  const points: NetWorthPoint[] = [];
  for (const { day, balances } of walk(counted, snapshots, from, to)) {
    let assets = 0;
    let liabilities = 0;
    for (const [id, cents] of balances) {
      if (isLiability(kinds.get(id)!)) liabilities += cents;
      else assets += cents;
    }
    points.push({ day, netWorthCents: assets - liabilities, assetsCents: assets, liabilitiesCents: liabilities });
  }
  return points;
}

/** One account's balance per day, carried forward; null before its first snapshot. */
export function accountSeries(snapshots: Snapshot[], from: DateKey, to: DateKey): { day: DateKey; balanceCents: number | null }[] {
  const account: HistoryAccount = { id: 0, kind: "cash", includeInNetWorth: true, gone: false };
  const points = [];
  for (const { day, balances } of walk([account], snapshots.map((s) => ({ ...s, accountId: 0 })), from, to)) {
    points.push({ day, balanceCents: balances.get(0) ?? null });
  }
  return points;
}

export interface AccountChange {
  accountId: number;
  startCents: number | null;
  endCents: number | null;
  /** The effect on net worth: a loan paid down is positive. */
  effectCents: number;
  status: "changed" | "added" | "removed";
}

export interface ChangeSummary {
  /** Net worth moved this much from accounts that existed throughout. */
  changeCents: number;
  /** Plus this much from accounts first seen during the range. */
  addedCents: number;
  /** Less this much from accounts that went away during it. */
  removedCents: number;
  accounts: AccountChange[];
}

export function changes(accounts: HistoryAccount[], snapshots: Snapshot[], from: DateKey, to: DateKey): ChangeSummary {
  const counted = accounts.filter((a) => a.includeInNetWorth);
  let start = new Map<number, number>();
  let end = new Map<number, number>();
  let first = true;
  for (const { balances } of walk(counted, snapshots, from, to)) {
    if (first) {
      start = new Map(balances);
      first = false;
    }
    end = balances;
  }
  const summary: ChangeSummary = { changeCents: 0, addedCents: 0, removedCents: 0, accounts: [] };
  for (const account of counted) {
    const s = start.get(account.id) ?? null;
    const e = end.get(account.id) ?? null;
    if (s === null && e === null) continue;
    const sign = isLiability(account.kind) ? -1 : 1;
    const effect = sign * ((e ?? 0) - (s ?? 0));
    const status = s === null ? "added" : e === null ? "removed" : "changed";
    if (status === "added") summary.addedCents += effect;
    else if (status === "removed") summary.removedCents += effect;
    else summary.changeCents += effect;
    summary.accounts.push({ accountId: account.id, startCents: s, endCents: e, effectCents: effect, status });
  }
  summary.accounts.sort((a, b) => Math.abs(b.effectCents) - Math.abs(a.effectCents));
  return summary;
}

/** Round, readable axis ticks covering [min, max]: 0 / 5K / 10K. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.1, 100_00);
    return niceTicks(min - pad, max + pad, count);
  }
  const rough = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough)!;
  const ticks = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 0.001; t += step) ticks.push(Math.round(t));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}
