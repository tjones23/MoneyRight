"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { appContext } from "@/server/context";
import { AccountError, advanceSession, logEvent } from "@/server/accounts";
import { allowAttempt, describeSource, requestInfo, requireStage, requireUser, setSessionCookie } from "@/server/auth";
import {
  addPushDevice,
  APPROVAL_TTL_MS,
  decideApproval,
  fetchSender,
  listPushDevices,
  pushApprovalStatus,
  removePushDevice,
  removePushDeviceByEndpoint,
  sendTestPush,
  startPushApproval,
  takeApproval,
  vapidPublicKey,
  type ApprovalStatus,
  type NewPushDevice,
} from "@/server/push";
import { describeDevice } from "@/lib/devices";

/** Sign-in approvals by push notification. See server/push.ts. */

export type PushResult = { ok: true; message?: string } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Settings: turning a phone on and off
// ---------------------------------------------------------------------------

export async function pushPublicKeyAction(): Promise<string> {
  await requireUser();
  return vapidPublicKey(appContext());
}

export async function addPushDeviceAction(subscription: NewPushDevice, name: string): Promise<PushResult> {
  const { user, request } = await requireUser();
  try {
    addPushDevice(
      appContext(),
      user.id,
      { endpoint: String(subscription?.endpoint ?? ""), keys: subscription?.keys },
      String(name ?? "") || describeDevice(request.userAgent),
      request.relyingParty.origin,
      Date.now(),
    );
  } catch (error) {
    if (error instanceof AccountError) return { ok: false, error: error.message };
    throw error;
  }
  refresh();
  return { ok: true };
}

/** Whether the browser's current subscription is one of this user's devices. */
export async function pushDeviceKnownAction(endpoint: string): Promise<boolean> {
  const { user } = await requireUser();
  const row = appContext().db.prepare("SELECT 1 FROM push_devices WHERE user_id = ? AND endpoint = ?").get(user.id, String(endpoint));
  return row !== undefined;
}

export async function forgetThisPushDeviceAction(endpoint: string) {
  const { user } = await requireUser();
  removePushDeviceByEndpoint(appContext().db, user.id, String(endpoint), Date.now());
  refresh();
}

export async function removePushDeviceAction(form: FormData) {
  const { user } = await requireUser();
  removePushDevice(appContext().db, user.id, Number(form.get("id")), Date.now());
  refresh();
}

export async function sendTestPushAction(): Promise<PushResult> {
  const { user, request } = await requireUser();
  if (!allowAttempt("push-test", user.username, request)) return { ok: false, error: "That's enough tests for now. Try again later." };
  const ctx = appContext();
  const total = listPushDevices(ctx.db, user.id).length;
  const sent = await sendTestPush(ctx, user.id, fetchSender, Date.now());
  refresh();
  if (sent === 0) return { ok: false, error: "No device took the notification. Turn it off and on again on the phone." };
  return { ok: true, message: `Sent to ${sent} of ${total}.` };
}

// ---------------------------------------------------------------------------
// Signing in: after the password, ask the phone
// ---------------------------------------------------------------------------

export type SendPushResult = { ok: true; number: string; expiresInSeconds: number } | { ok: false; error: string };

export async function sendSignInPushAction(): Promise<SendPushResult> {
  const ctx = appContext();
  const { session, user, request } = await requireStage("password");
  if (!allowAttempt("push", user.username, request)) return { ok: false, error: "Too many requests. Wait 15 minutes, or use a code." };
  try {
    const detail = `${describeDevice(request.userAgent)}${describeSource(request)}`;
    const { number, sent } = await startPushApproval(ctx, session, detail, fetchSender, Date.now());
    if (sent === 0) return { ok: false, error: "Your phone couldn't be reached. Use your authenticator code instead." };
    return { ok: true, number, expiresInSeconds: APPROVAL_TTL_MS / 1000 };
  } catch (error) {
    if (error instanceof AccountError) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * Polled by the signing-in screen. Once the phone approves, this finishes
 * signing in: a new session cookie, and a redirect home.
 */
export async function signInPushStatusAction(): Promise<ApprovalStatus> {
  const ctx = appContext();
  const { session, user, request } = await requireStage("password");
  const now = Date.now();
  const status = pushApprovalStatus(ctx.db, session, now);
  if (status !== "approved") return status;
  if (!takeApproval(ctx.db, session)) return "none";
  const token = advanceSession(ctx.db, session, "full", now);
  logEvent(ctx.db, user.id, "signed-in", now, `approved on phone${describeSource(request)}`);
  await setSessionCookie(token, "full", request.https);
  redirect("/");
}

// ---------------------------------------------------------------------------
// On the phone: answering a request. No session needed — the link is the
// proof of holding the phone (see server/push.ts) — but the network gate
// still applies, and requestInfo() re-checks it.
// ---------------------------------------------------------------------------

export interface ApproveState {
  error?: string;
  outcome?: "approved" | "denied" | "gone";
}

export async function answerApprovalAction(_prev: ApproveState, form: FormData): Promise<ApproveState> {
  await requestInfo();
  const token = String(form.get("token") ?? "");
  const approve = form.get("decision") === "approve";
  const result = decideApproval(
    appContext().db,
    token,
    approve ? { approve: true, number: String(form.get("number") ?? "") } : { approve: false },
    Date.now(),
  );
  if (result === "wrong-number") return { error: "That's not the number on the sign-in screen. Check it and try again." };
  return { outcome: result };
}
