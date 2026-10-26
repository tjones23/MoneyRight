/**
 * How long a sign-in lasts.
 *
 * A session moves through stages: `password` (right password, second factor
 * not yet given), `enroll` (a new account that has to set up its
 * authenticator before anything else), then `full`. Only `full` reaches any
 * financial data. The early stages are short-lived, so a half-finished sign-in
 * on a borrowed device doesn't linger.
 *
 * Takes `now` rather than reading the clock, so it's deterministic to test.
 */

export type SessionStage = "password" | "enroll" | "full";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Signed out after this long without a request. */
export const IDLE_TIMEOUT_MS: Record<SessionStage, number> = {
  password: 10 * MINUTE,
  enroll: 30 * MINUTE,
  full: 3 * DAY,
};

/** Signed out this long after signing in, however active. */
export const ABSOLUTE_TIMEOUT_MS = 14 * DAY;

/** `lastSeen` is only written back this often, not on every request. */
export const TOUCH_INTERVAL_MS = 5 * MINUTE;

export interface SessionTimes {
  stage: SessionStage;
  createdAt: number;
  lastSeenAt: number;
}

export function isExpired(s: SessionTimes, now: number): boolean {
  if (now - s.createdAt > ABSOLUTE_TIMEOUT_MS) return true;
  return now - s.lastSeenAt > IDLE_TIMEOUT_MS[s.stage];
}

export function shouldTouch(s: SessionTimes, now: number): boolean {
  return now - s.lastSeenAt > TOUCH_INTERVAL_MS;
}

/** The cookie's own Max-Age: never longer than the session could live. */
export function cookieMaxAgeSeconds(s: SessionTimes, now: number): number {
  const idleEnd = now + IDLE_TIMEOUT_MS[s.stage];
  const absoluteEnd = s.createdAt + ABSOLUTE_TIMEOUT_MS;
  return Math.max(0, Math.floor((Math.min(idleEnd, absoluteEnd) - now) / 1000));
}

/** Usernames: what people sign in with. Lower-cased; letters, digits, . _ - */
export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

export function usernameProblem(name: string): string | null {
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) return "3–32 characters: letters, numbers, dots, dashes or underscores.";
  return null;
}
