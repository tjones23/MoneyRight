"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { appContext } from "@/server/context";
import { AccountError, advanceSession, logEvent } from "@/server/accounts";
import { allowAttempt, requireStage, requireUser, setSessionCookie } from "@/server/auth";
import { finishAuthentication, finishRegistration, removePasskey, startAuthentication, startRegistration } from "@/server/passkeys";

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
  logEvent(ctx.db, user.id, "signed-in", now, `passkey${request.tailnetLogin ? ` from ${request.tailnetLogin}` : " on this Mac"}`);
  await setSessionCookie(token, "full", request.https);
  redirect("/");
}
