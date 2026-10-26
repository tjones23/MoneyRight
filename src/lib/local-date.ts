/**
 * Calendar dates as "YYYY-MM-DD" strings in this Mac's time zone — the day a
 * balance snapshot belongs to, a loan's payment dates. Arithmetic goes
 * through UTC noon so daylight-saving changes can't shift a day.
 */

export type DateKey = string;

export function dateKey(ms: number): DateKey {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function toUtcNoon(key: DateKey): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

function fromUtc(ms: number): DateKey {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (negative if `b` is earlier). */
export function daysBetween(a: DateKey, b: DateKey): number {
  return Math.round((toUtcNoon(b) - toUtcNoon(a)) / 86_400_000);
}

export function addDays(key: DateKey, days: number): DateKey {
  return fromUtc(toUtcNoon(key) + days * 86_400_000);
}

/** Day `day` of the month `months` after `key`'s, clamped to that month's length. */
export function nthMonthDay(key: DateKey, months: number, day: number): DateKey {
  const [y, m] = key.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12)).getUTCDate();
  first.setUTCDate(Math.min(day, length));
  return fromUtc(first.getTime());
}

/** Today, on this Mac's calendar. */
export function todayKey(): DateKey {
  return dateKey(Date.now());
}
