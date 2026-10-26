import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { appContext, hasUsers } from "./context";
import { findSession } from "./accounts";
import type { Session, User } from "./accounts";
import { checkNetwork, parseAllowedLogins } from "@/lib/network-gate";
import { cookieMaxAgeSeconds } from "@/lib/session-policy";
import type { SessionStage } from "@/lib/session-policy";
import { createRateLimiterState, recordHit } from "@/lib/rate-limit";

/**
 * The data access layer for identity: the only place that reads the session
 * cookie. Pages call `requireUser()`; Server Actions call it too, since an
 * action is a public endpoint whatever page it was rendered on.
 */

export const SESSION_COOKIE = "mr_session";

export interface RequestInfo {
  /** The tailnet login `tailscale serve` vouched for; null on this Mac. */
  tailnetLogin: string | null;
  https: boolean;
  userAgent: string | null;
}

/**
 * The request as the network gate sees it. The proxy already turned away
 * anything the gate refuses; this re-checks rather than trusting that, since
 * it's cheap and it's what supplies the tailnet login.
 */
export async function requestInfo(): Promise<RequestInfo> {
  const h = await headers();
  const gate = checkNetwork((name) => h.get(name), parseAllowedLogins(process.env.MONEYRIGHT_ALLOWED_LOGINS));
  if (!gate.ok) throw new Error(`Refused: ${gate.reason}`);
  return {
    tailnetLogin: gate.via === "tailnet" ? gate.login : null,
    https: h.get("x-forwarded-proto") === "https",
    userAgent: h.get("user-agent"),
  };
}

export interface Current {
  session: Session;
  user: User;
  request: RequestInfo;
}

/** The signed-in session at any stage, or null. */
export async function currentSession(): Promise<Current | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const request = await requestInfo();
  const found = findSession(appContext().db, token, request.tailnetLogin, Date.now());
  return found ? { ...found, request } : null;
}

/** Where a session at each stage belongs. */
export function homeFor(stage: SessionStage): string {
  return stage === "full" ? "/" : stage === "enroll" ? "/enroll" : "/login/verify";
}

/** A fully signed-in user, or a redirect to wherever they are in signing in. */
export async function requireUser(): Promise<Current> {
  const current = await currentSession();
  if (!current) redirect(hasUsers(appContext().db) ? "/login" : "/setup");
  if (current.session.stage !== "full") redirect(homeFor(current.session.stage));
  return current;
}

export async function requireAdmin(): Promise<Current> {
  const current = await requireUser();
  if (!current.user.isAdmin) redirect("/settings");
  return current;
}

/** A session at exactly `stage`, or a redirect to where it belongs. */
export async function requireStage(stage: SessionStage): Promise<Current> {
  const current = await currentSession();
  if (!current) redirect("/login");
  if (current.session.stage !== stage) redirect(homeFor(current.session.stage));
  return current;
}

/** Only in a Server Action or Route Handler — cookies can't be set mid-render. */
export async function setSessionCookie(token: string, stage: SessionStage, https: boolean) {
  const now = Date.now();
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Strict: no other site can make a request that carries it.
    sameSite: "strict",
    // Over the tailnet it's HTTPS; on this Mac it's plain http://localhost.
    secure: https,
    path: "/",
    maxAge: cookieMaxAgeSeconds({ stage, createdAt: now, lastSeenAt: now }, now),
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

// ---------------------------------------------------------------------------
// Rate limits on guessing. In memory: one server process, and a restart
// forgetting them costs an attacker a restart they can't cause.
// ---------------------------------------------------------------------------

const limiter = createRateLimiterState();
const WINDOW_MS = 15 * 60_000;

/** False once this account or this device has tried too often lately. */
export function allowAttempt(kind: string, username: string, request: RequestInfo): boolean {
  const now = Date.now();
  const source = request.tailnetLogin ?? "local";
  const byAccount = recordHit(limiter, `${kind}:user:${username}`, now, WINDOW_MS, 8);
  const bySource = recordHit(limiter, `${kind}:source:${source}`, now, WINDOW_MS, 20);
  return byAccount && bySource;
}
