import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import { AccountError, logEvent, type Ctx, type Session } from "./accounts";
import { open, seal } from "@/lib/sealed";
import { hashToken, newToken } from "@/lib/tokens";
import {
  encryptPayload,
  isPushEndpoint,
  newVapidKeys,
  vapidAuthorization,
  validSubscriptionKeys,
  type PushSubscriptionKeys,
  type VapidKeys,
} from "@/lib/web-push";

/**
 * Approving a sign-in from your phone: the second step by push notification,
 * in place of typing a code.
 *
 * A phone opts in from Settings (on iPhone, from MoneyRight on the Home
 * Screen — iOS only delivers web push to Home Screen apps). After the
 * password, the signing-in screen sends every opted-in device a notification
 * carrying a one-time link, and shows a two-digit number. Tapping the
 * notification opens the link; typing that number there approves.
 *
 * What it proves: the link is encrypted to keys only that phone's browser
 * holds (the push service sees ciphertext), so opening it means holding the
 * phone. The number means whoever approves can see the screen that's signing
 * in, so a stray request — someone else with your password — can't be
 * approved by reflex. Requests last two minutes; three wrong numbers deny.
 *
 * Always after the password; the authenticator app and
 * recovery codes keep working.
 */

export const APPROVAL_TTL_MS = 2 * 60_000;
export const MAX_WRONG_NUMBERS = 3;

export interface PushDevice {
  id: number;
  name: string;
  origin: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PushMessage {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Delivers one message; returns the push service's HTTP status. */
export type PushSender = (message: PushMessage) => Promise<number>;

export const fetchSender: PushSender = async ({ endpoint, headers, body }) => {
  const response = await fetch(endpoint, { method: "POST", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(10_000) });
  return response.status;
};

// ---------------------------------------------------------------------------
// The server's own push identity (VAPID), made once and kept in `meta`
// ---------------------------------------------------------------------------

const VAPID_CONTEXT = "vapid";

export function vapidKeys(ctx: Ctx): VapidKeys {
  const row = ctx.db.prepare("SELECT value FROM meta WHERE key = 'vapid'").get() as { value: string } | undefined;
  if (row) return JSON.parse(open(ctx.key, row.value, VAPID_CONTEXT).toString()) as VapidKeys;
  const keys = newVapidKeys();
  ctx.db
    .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('vapid', ?)")
    .run(seal(ctx.key, JSON.stringify(keys), VAPID_CONTEXT));
  // Re-read: if two requests raced, both use whichever was stored first.
  return vapidKeys(ctx);
}

/** What the browser subscribes with. */
export function vapidPublicKey(ctx: Ctx): string {
  return vapidKeys(ctx).publicKey;
}

/**
 * Push services want a contact for the sender: a mailto: or https: URL.
 * The site's own address says who's sending without naming anyone.
 */
function vapidSubject(origin: string): string {
  return process.env.MONEYRIGHT_PUSH_CONTACT || (origin.startsWith("https://") ? origin : "mailto:moneyright@localhost");
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function keysContext(endpoint: string) {
  return `push-keys:${hashToken(endpoint)}`;
}

export interface NewPushDevice {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

export function addPushDevice(ctx: Ctx, userId: number, device: NewPushDevice, name: string, origin: string, now: number): void {
  if (!isPushEndpoint(device.endpoint)) throw new AccountError("This browser's push service isn't one MoneyRight knows.");
  if (!device.keys || !validSubscriptionKeys(device.keys)) throw new AccountError("This browser sent keys MoneyRight can't use.");
  const label = name.trim().slice(0, 60) || "Phone";
  transaction(ctx.db, () => {
    // A browser re-subscribing (or handed to someone else) replaces its old entry.
    ctx.db.prepare("DELETE FROM push_devices WHERE endpoint = ?").run(device.endpoint);
    ctx.db
      .prepare("INSERT INTO push_devices (user_id, name, endpoint, keys, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        userId,
        label,
        device.endpoint,
        seal(ctx.key, JSON.stringify({ p256dh: device.keys.p256dh, auth: device.keys.auth }), keysContext(device.endpoint)),
        origin,
        now,
      );
    logEvent(ctx.db, userId, "push-device-added", now, label);
  });
}

export function listPushDevices(db: DatabaseSync, userId: number): PushDevice[] {
  return db
    .prepare("SELECT id, name, origin, created_at, last_used_at FROM push_devices WHERE user_id = ? ORDER BY created_at")
    .all(userId)
    .map((r) => ({
      id: r.id as number,
      name: r.name as string,
      origin: r.origin as string,
      createdAt: r.created_at as number,
      lastUsedAt: (r.last_used_at as number | null) ?? null,
    }));
}

export function hasPushDevice(db: DatabaseSync, userId: number): boolean {
  return db.prepare("SELECT 1 FROM push_devices WHERE user_id = ?").get(userId) !== undefined;
}

export function removePushDevice(db: DatabaseSync, userId: number, id: number, now: number) {
  const removed = db.prepare("DELETE FROM push_devices WHERE id = ? AND user_id = ?").run(id, userId);
  if (removed.changes) logEvent(db, userId, "push-device-removed", now);
}

/** Removes the device a browser is subscribed with, if it's this user's. */
export function removePushDeviceByEndpoint(db: DatabaseSync, userId: number, endpoint: string, now: number) {
  const removed = db.prepare("DELETE FROM push_devices WHERE endpoint = ? AND user_id = ?").run(endpoint, userId);
  if (removed.changes) logEvent(db, userId, "push-device-removed", now);
}

interface DeviceRow {
  id: number;
  endpoint: string;
  keys: string;
  origin: string;
}

/**
 * Sends one message to each device; returns how many push services took it.
 * A subscription the service says is gone (404, 410) is removed — the
 * phone uninstalled the app or turned notifications off.
 */
async function sendToDevices(
  ctx: Ctx,
  devices: DeviceRow[],
  payloadFor: (device: DeviceRow) => object,
  send: PushSender,
  now: number,
): Promise<number> {
  const vapid = vapidKeys(ctx);
  const results = await Promise.all(
    devices.map(async (device) => {
      try {
        const keys = JSON.parse(open(ctx.key, device.keys, keysContext(device.endpoint)).toString()) as PushSubscriptionKeys;
        const status = await send({
          endpoint: device.endpoint,
          headers: {
            Authorization: vapidAuthorization(device.endpoint, vapid, vapidSubject(device.origin), now),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            // Worthless once the request expires, so the service may drop it after.
            TTL: String(Math.floor(APPROVAL_TTL_MS / 1000)),
            Urgency: "high",
          },
          body: encryptPayload(JSON.stringify(payloadFor(device)), keys),
        });
        if (status === 404 || status === 410) {
          ctx.db.prepare("DELETE FROM push_devices WHERE id = ?").run(device.id);
          return false;
        }
        if (status < 200 || status >= 300) console.warn(`[moneyright] push service answered ${status}`);
        return status >= 200 && status < 300;
      } catch (error) {
        console.warn(`[moneyright] push failed: ${error instanceof Error ? error.message : error}`);
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

function devicesFor(db: DatabaseSync, userId: number): DeviceRow[] {
  return db.prepare("SELECT id, endpoint, keys, origin FROM push_devices WHERE user_id = ?").all(userId) as unknown as DeviceRow[];
}

/** From Settings: a notification that only says it works. */
export async function sendTestPush(ctx: Ctx, userId: number, send: PushSender, now: number): Promise<number> {
  return sendToDevices(
    ctx,
    devicesFor(ctx.db, userId),
    () => ({ title: "MoneyRight", body: "Sign-in requests will show up like this.", url: "/settings", tag: "test" }),
    send,
    now,
  );
}

// ---------------------------------------------------------------------------
// Requests to approve a sign-in
// ---------------------------------------------------------------------------

export type ApprovalStatus = "none" | "pending" | "approved" | "denied" | "expired";

/**
 * Sends a sign-in request to every one of the user's devices, replacing any
 * earlier one for this session. `detail` says which browser is asking, from
 * where. Returns the number to show, and how many devices it reached.
 */
export async function startPushApproval(
  ctx: Ctx,
  session: Session,
  detail: string,
  send: PushSender,
  now: number,
): Promise<{ number: string; sent: number }> {
  const devices = devicesFor(ctx.db, session.userId);
  if (devices.length === 0) throw new AccountError("No phone is set up for sign-in requests.");
  const number = String(randomInt(10, 100));
  const links = new Map<number, string>();
  transaction(ctx.db, () => {
    ctx.db.prepare("DELETE FROM push_approvals WHERE session_id_hash = ?").run(session.idHash);
    const { lastInsertRowid } = ctx.db
      .prepare(
        "INSERT INTO push_approvals (session_id_hash, user_id, number, detail, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(session.idHash, session.userId, number, detail.slice(0, 200), now, now + APPROVAL_TTL_MS);
    const insert = ctx.db.prepare("INSERT INTO push_approval_links (token_hash, approval_id, device_id) VALUES (?, ?, ?)");
    for (const device of devices) {
      const token = newToken();
      insert.run(hashToken(token), Number(lastInsertRowid), device.id);
      links.set(device.id, token);
    }
  });
  const sent = await sendToDevices(
    ctx,
    devices,
    (device) => ({
      title: "Sign in to MoneyRight?",
      body: `${detail}. Tap to approve or deny.`,
      url: `/approve/${links.get(device.id)}`,
      tag: "sign-in",
    }),
    send,
    now,
  );
  logEvent(ctx.db, session.userId, "push-sent", now, `to ${sent} of ${devices.length} device${devices.length === 1 ? "" : "s"}`);
  return { number, sent };
}

/** Where this session's request stands, as the signing-in screen polls it. */
export function pushApprovalStatus(db: DatabaseSync, session: Session, now: number): ApprovalStatus {
  const row = db.prepare("SELECT status, expires_at FROM push_approvals WHERE session_id_hash = ?").get(session.idHash) as
    | { status: "pending" | "approved" | "denied"; expires_at: number }
    | undefined;
  if (!row) return "none";
  if (row.status === "pending" && now > row.expires_at) return "expired";
  return row.status;
}

/**
 * Spends an approval: true exactly once, for the session it was made for.
 * The caller then advances the session (which deletes the row with it).
 */
export function takeApproval(db: DatabaseSync, session: Session): boolean {
  const taken = db
    .prepare("DELETE FROM push_approvals WHERE session_id_hash = ? AND status = 'approved'")
    .run(session.idHash);
  return taken.changes === 1;
}

export interface ApprovalRequest {
  displayName: string;
  detail: string;
  createdAt: number;
  expiresAt: number;
  deviceName: string;
}

interface LinkRow {
  approval_id: number;
  device_id: number;
  user_id: number;
  status: string;
  expires_at: number;
  created_at: number;
  detail: string;
  number: string;
  wrong_tries: number;
  display_name: string;
  device_name: string;
}

function linkRow(db: DatabaseSync, token: string): LinkRow | undefined {
  return db
    .prepare(
      `SELECT l.approval_id, l.device_id, a.user_id, a.status, a.expires_at, a.created_at, a.detail, a.number, a.wrong_tries,
              u.display_name, d.name AS device_name
         FROM push_approval_links l
         JOIN push_approvals a ON a.id = l.approval_id
         JOIN users u ON u.id = a.user_id
         JOIN push_devices d ON d.id = l.device_id
        WHERE l.token_hash = ?`,
    )
    .get(hashToken(token)) as LinkRow | undefined;
}

/** The request behind a link, if it can still be answered. */
export function pendingApproval(db: DatabaseSync, token: string, now = Date.now()): ApprovalRequest | null {
  const row = linkRow(db, token);
  if (!row || row.status !== "pending" || now > row.expires_at) return null;
  return {
    displayName: row.display_name,
    detail: row.detail,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deviceName: row.device_name,
  };
}

export type Decision = "approved" | "denied" | "wrong-number" | "gone";

/**
 * Answers a request from the phone. Approving takes the number on the
 * signing-in screen; denying doesn't. The update is guarded on `pending`, so
 * two answers racing can't both count.
 */
export function decideApproval(
  db: DatabaseSync,
  token: string,
  answer: { approve: true; number: string } | { approve: false },
  now: number,
): Decision {
  const row = linkRow(db, token);
  if (!row || row.status !== "pending" || now > row.expires_at) return "gone";

  const deny = (why: string): Decision => {
    const done = db
      .prepare("UPDATE push_approvals SET status = 'denied', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
      .run(now, row.device_id, row.approval_id);
    if (!done.changes) return "gone";
    logEvent(db, row.user_id, "push-denied", now, `${why} on ${row.device_name} — ${row.detail}`);
    return "denied";
  };

  if (!answer.approve) return deny("denied");

  if (answer.number.trim() !== row.number) {
    const tries = row.wrong_tries + 1;
    if (tries >= MAX_WRONG_NUMBERS) return deny("wrong number three times");
    db.prepare("UPDATE push_approvals SET wrong_tries = ? WHERE id = ? AND status = 'pending'").run(tries, row.approval_id);
    return "wrong-number";
  }

  const done = db
    .prepare("UPDATE push_approvals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
    .run(now, row.device_id, row.approval_id);
  if (!done.changes) return "gone";
  db.prepare("UPDATE push_devices SET last_used_at = ? WHERE id = ?").run(now, row.device_id);
  logEvent(db, row.user_id, "push-approved", now, `on ${row.device_name}`);
  return "approved";
}
