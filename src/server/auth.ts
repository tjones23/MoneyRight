import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { appContext, hasUsers } from "./context";
import { findSession, PUBLIC_SESSION } from "./accounts";
import type { Session, User } from "./accounts";
import { checkNetwork, parseAllowedLogins } from "@/lib/network-gate";
import { publicAccessEnabled } from "@/lib/public-access";
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
  /** Straight from this Mac, from a tailnet member, or over Funnel. */
  via: "local" | "tailnet" | "public";
  /** The tailnet login `tailscale serve` vouched for; null otherwise. */
  tailnetLogin: string | null;
  /** The visitor's address, for a request over Funnel; null otherwise. */
  publicAddress: string | null;
  https: boolean;
  userAgent: string | null;
  /** For passkeys: the host and origin the browser is on. */
  relyingParty: { id: string; origin: string };
}

/**
 * The request as the network gate sees it. The proxy already turned away
 * anything the gate refuses; this re-checks rather than trusting that, since
 * it's cheap and it's what supplies the tailnet login.
 */
export async function requestInfo(): Promise<RequestInfo> {
  const h = await headers();
  const gate = checkNetwork((name) => h.get(name), parseAllowedLogins(process.env.MONEYRIGHT_ALLOWED_LOGINS), {
    allowPublic: publicAccessEnabled(),
  });
  if (!gate.ok) throw new Error(`Refused: ${gate.reason}`);
  const https = h.get("x-forwarded-proto") === "https";
  // Next fills X-Forwarded-Host from Host; the gate has already vetted both.
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  return {
    via: gate.via,
    tailnetLogin: gate.via === "tailnet" ? gate.login : null,
    publicAddress: gate.via === "public" ? gate.address : null,
    https,
    userAgent: h.get("user-agent"),
    relyingParty: { id: host.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""), origin: `${https ? "https" : "http"}://${host}` },
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
  const found = findSession(appContext().db, token, sessionBinding(request), Date.now());
  return found ? { ...found, request } : null;
}

/**
 * What a session is tied to: the tailnet login that signed in, or for one
 * signed in over Funnel, the internet as a whole — so it never works from a
 * tailnet login, nor a tailnet session from off the tailnet.
 */
export function sessionBinding(request: RequestInfo): string | null {
  return request.via === "public" ? PUBLIC_SESSION : request.tailnetLogin;
}

/** " from alex@example.com", " from the internet (203.0.113.9)", " on this Mac" — for the event log. */
export function describeSource(request: RequestInfo): string {
  if (request.via === "tailnet") return ` from ${request.tailnetLogin}`;
  if (request.via === "public") return ` from the internet (${request.publicAddress})`;
  return " on this Mac";
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
  // Over Funnel every visitor would otherwise share one bucket with this
  // Mac, so a stranger could lock the owner out; each address gets its own.
  const source = request.tailnetLogin ?? (request.via === "public" ? `ip:${request.publicAddress}` : "local");
  const byAccount = recordHit(limiter, `${kind}:user:${username}`, now, WINDOW_MS, 8);
  const bySource = recordHit(limiter, `${kind}:source:${source}`, now, WINDOW_MS, 20);
  return byAccount && bySource;
}
