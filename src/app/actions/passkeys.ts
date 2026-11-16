"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { appContext } from "@/server/context";
import { AccountError, advanceSession, createSession, endSession, getUser, logEvent } from "@/server/accounts";
import {
  allowAttempt,
  currentSession,
  describeSource,
  homeFor,
  requestInfo,
  requireStage,
  requireUser,
  sessionBinding,
  setSessionCookie,
} from "@/server/auth";
import {
  finishAuthentication,
  finishPasskeySignIn,
  finishRegistration,
  removePasskey,
  startAuthentication,
  startPasskeySignIn,
  startRegistration,
} from "@/server/passkeys";

/** Adding, using and removing passkeys. See server/passkeys.ts. */

export type PasskeyResult = { ok: true } | { ok: false; error: string };

export async function passkeyRegistrationOptionsAction() {
  const { session, user, request } = await requireUser();
  return startRegistration(appContext().db, session, user, request.relyingParty, Date.now());
}

export async function addPasskeyAction(response: RegistrationResponseJSON, name: string): Promise<PasskeyResult> {
  const { session, user, request } = await requireUser();
  try {
    await finishRegistration(appContext().db, session, user, response, request.relyingParty, String(name ?? ""), Date.now());
  } catch (error) {
    if (error instanceof AccountError) return { ok: false, error: error.message };
    throw error;
  }
  refresh();
  return { ok: true };
}

export async function removePasskeyAction(form: FormData) {
  const { user } = await requireUser();
  removePasskey(appContext().db, user.id, Number(form.get("id")), Date.now());
  refresh();
}

/** At sign-in, after the password: the challenge for this host's passkeys, or null if there are none. */
export async function passkeySignInOptionsAction() {
  const { session, request } = await requireStage("password");
  return startAuthentication(appContext().db, session, request.relyingParty, Date.now());
}

export async function passkeySignInAction(response: AuthenticationResponseJSON): Promise<PasskeyResult> {
  const ctx = appContext();
  const { session, user, request } = await requireStage("password");
  if (!allowAttempt("second-factor", user.username, request)) return { ok: false, error: "Too many tries. Wait 15 minutes." };
  const now = Date.now();
  if (!(await finishAuthentication(ctx.db, session, response, request.relyingParty, now))) {
    logEvent(ctx.db, user.id, "second-factor-failed", now, "passkey");
    return { ok: false, error: "That passkey didn't work. Try again, or use your authenticator code." };
  }
  const token = advanceSession(ctx.db, session, "full", now);
  logEvent(ctx.db, user.id, "signed-in", now, `passkey${describeSource(request)}`);
  await setSessionCookie(token, "full", request.https);
  redirect("/");
}

// ---------------------------------------------------------------------------
// Signing in with a passkey alone, from the sign-in page: no username or
// password. Needs no session — this is what starts one.
// ---------------------------------------------------------------------------

export async function passkeyLoginOptionsAction() {
  const { relyingParty } = await requestInfo();
  return startPasskeySignIn(appContext().db, relyingParty, Date.now());
}

export async function passkeyLoginAction(challengeId: string, response: AuthenticationResponseJSON): Promise<PasskeyResult> {
  const ctx = appContext();
  const request = await requestInfo();
  // Counted per passkey and per device, like passwords are per account.
  if (!allowAttempt("passkey-login", String(response?.id ?? "").slice(0, 100), request)) {
    return { ok: false, error: "Too many tries. Wait 15 minutes and try again." };
  }
  const now = Date.now();
  const userId = await finishPasskeySignIn(ctx.db, String(challengeId ?? ""), response, request.relyingParty, now);
  const user = userId === null ? null : getUser(ctx.db, userId);
  if (!user) {
    logEvent(ctx.db, null, "sign-in-failed", now, "passkey");
    return { ok: false, error: "That passkey isn't one MoneyRight knows at this address. Sign in with your password." };
  }

  // A previous half-finished sign-in on this browser is replaced, not stacked.
  const previous = await currentSession();
  if (previous) endSession(ctx.db, previous.session.idHash);
  // A passkey with Face ID / Touch ID is both factors. Only an account with no
  // authenticator yet (which can't normally have a passkey) still sets one up.
  const stage = !ctx.secondFactorRequired || user.hasTotp ? "full" : "enroll";
  const token = createSession(ctx.db, user.id, stage, { userAgent: request.userAgent, tailnetLogin: sessionBinding(request) }, now);
  if (stage === "full") logEvent(ctx.db, user.id, "signed-in", now, `passkey, no password${describeSource(request)}`);
  await setSessionCookie(token, stage, request.https);
  redirect(homeFor(stage));
}
