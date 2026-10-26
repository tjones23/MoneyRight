"use server";

import { timingSafeEqual } from "node:crypto";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { appContext, clearSetupCode, hasUsers, readSetupCode } from "@/server/context";
import {
  AccountError,
  advanceSession,
  checkPassword,
  checkSecondFactor,
  confirmTotp,
  createFirstAdmin,
  createSession,
  endSession,
  logEvent,
  redeemInvite,
} from "@/server/accounts";
import {
  allowAttempt,
  clearSessionCookie,
  currentSession,
  homeFor,
  requestInfo,
  requireStage,
  setSessionCookie,
} from "@/server/auth";
import type { RequestInfo } from "@/server/auth";
import { normalizeSetupCode } from "@/lib/tokens";
import { normalizeUsername } from "@/lib/session-policy";

/**
 * Signing up, in and out. Every action re-derives who's asking from the
 * request itself — the page it was rendered on proves nothing.
 */

export interface FormState {
  error?: string;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(normalizeSetupCode(a));
  const y = Buffer.from(normalizeSetupCode(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const TOO_MANY = "Too many tries. Wait 15 minutes and try again.";

export async function setupAction(_prev: FormState, form: FormData): Promise<FormState> {
  const ctx = appContext();
  if (hasUsers(ctx.db)) redirect("/login");
  const request = await requestInfo();
  if (!allowAttempt("setup", "-", request)) return { error: TOO_MANY };

  const expected = readSetupCode(ctx);
  if (!expected || !sameCode(field(form, "setupCode"), expected)) {
    return { error: "That setup code isn't right. The launcher prints it when the server starts." };
  }
  if (field(form, "password") !== field(form, "confirm")) return { error: "The passwords don't match." };

  let userId: number;
  try {
    userId = await createFirstAdmin(
      ctx.db,
      { username: field(form, "username"), displayName: field(form, "displayName"), password: field(form, "password") },
      Date.now(),
    );
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message };
    throw error;
  }
  clearSetupCode(ctx);
  return startSession(userId, false, request);
}

export async function inviteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const ctx = appContext();
  const request = await requestInfo();
  if (!allowAttempt("invite", "-", request)) return { error: TOO_MANY };
  if (field(form, "password") !== field(form, "confirm")) return { error: "The passwords don't match." };

  let userId: number;
  try {
    userId = await redeemInvite(
      ctx.db,
      field(form, "token"),
      { username: field(form, "username"), displayName: field(form, "displayName"), password: field(form, "password") },
      Date.now(),
    );
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message };
    throw error;
  }
  return startSession(userId, false, request);
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const ctx = appContext();
  const request = await requestInfo();
  const username = normalizeUsername(field(form, "username"));
  if (!allowAttempt("password", username, request)) return { error: TOO_MANY };

  const user = await checkPassword(ctx.db, username, field(form, "password"));
  const now = Date.now();
  if (!user) {
    logEvent(ctx.db, null, "sign-in-failed", now, `username "${username.slice(0, 32)}"`);
    return { error: "That username and password don't match." };
  }

  // A previous half-finished sign-in on this browser is replaced, not stacked.
  const previous = await currentSession();
  if (previous) endSession(ctx.db, previous.session.idHash);
  return startSession(user.id, user.hasTotp, request);
}

/**
 * A new session, at whichever stage comes next: the authenticator code if
 * there is one, setting one up if not — or, on the dev server with its own
 * data, straight in (see AppContext.secondFactorRequired).
 */
async function startSession(userId: number, hasTotp: boolean, request: RequestInfo): Promise<never> {
  const ctx = appContext();
  const now = Date.now();
  const stage = !ctx.secondFactorRequired ? "full" : hasTotp ? "password" : "enroll";
  const token = createSession(ctx.db, userId, stage, request, now);
  if (stage === "full") logEvent(ctx.db, userId, "signed-in", now, "dev server, no authenticator");
  await setSessionCookie(token, stage, request.https);
  redirect(homeFor(stage));
}

export async function verifyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const ctx = appContext();
  const { session, user, request } = await requireStage("password");
  if (!allowAttempt("second-factor", user.username, request)) return { error: TOO_MANY };

  const now = Date.now();
  const how = checkSecondFactor(ctx, user.id, field(form, "code"), now);
  if (!how) {
    logEvent(ctx.db, user.id, "second-factor-failed", now);
    return { error: "That code isn't right. Codes change every 30 seconds — try the current one." };
  }
  const token = advanceSession(ctx.db, session, "full", now);
  logEvent(ctx.db, user.id, "signed-in", now, `${how}${request.tailnetLogin ? ` from ${request.tailnetLogin}` : " on this Mac"}`);
  await setSessionCookie(token, "full", request.https);
  redirect("/");
}

export async function enrollAction(_prev: FormState, form: FormData): Promise<FormState> {
  const ctx = appContext();
  const { session, user, request } = await requireStage("enroll");
  if (user.hasTotp) redirect("/enroll");
  if (!allowAttempt("enroll", user.username, request)) return { error: TOO_MANY };

  const codes = confirmTotp(ctx, session, field(form, "code"), Date.now());
  if (!codes) return { error: "That code doesn't match. Check the app shows MoneyRight, and use the current code." };
  // The session stays at "enroll" until finishEnrollAction; the page now
  // renders the recovery codes from the session.
  refresh();
  return {};
}

/** "I've saved them": the authenticator is set up, so the session is complete. */
export async function finishEnrollAction() {
  const ctx = appContext();
  const { session, user, request } = await requireStage("enroll");
  if (!user.hasTotp) redirect("/enroll");
  const now = Date.now();
  const token = advanceSession(ctx.db, session, "full", now);
  logEvent(ctx.db, user.id, "signed-in", now, "after setting up the authenticator");
  await setSessionCookie(token, "full", request.https);
  redirect("/");
}

export async function signOutAction() {
  const current = await currentSession();
  if (current) {
    endSession(appContext().db, current.session.idHash);
    logEvent(appContext().db, current.user.id, "signed-out", Date.now());
  }
  await clearSessionCookie();
  redirect("/login");
}
