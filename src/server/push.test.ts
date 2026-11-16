import { createECDH, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { AccountError, advanceSession, createSession, findSession, recentEvents, resetTotp, type Ctx, type Session } from "./accounts";
import {
  addPushDevice,
  APPROVAL_TTL_MS,
  decideApproval,
  hasPushDevice,
  listPushDevices,
  pendingApproval,
  pushApprovalStatus,
  removePushDevice,
  startPushApproval,
  takeApproval,
  vapidKeys,
  type PushMessage,
  type PushSender,
} from "./push";
import { decryptPayload } from "@/lib/web-push.fixtures";

/**
 * Users are inserted directly rather than through createFirstAdmin, so these
 * need no argon2.
 */

const T0 = Date.UTC(2026, 10, 16, 12);
let ctx: Ctx;
let userId: number;

function addUser(username: string, isAdmin = false): number {
  const r = ctx.db
    .prepare(
      "INSERT INTO users (username, display_name, password_hash, is_admin, created_at, password_changed_at) VALUES (?, ?, 'x', ?, ?, ?)",
    )
    .run(username, username.toUpperCase(), isAdmin ? 1 : 0, T0, T0);
  return Number(r.lastInsertRowid);
}

/** A phone's browser: its push subscription, and the private half only it holds. */
function phone(host = "web.push.apple.com") {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  return {
    subscription: {
      endpoint: `https://${host}/${randomBytes(8).toString("hex")}`,
      keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    },
    /** What the notification says, as the phone's service worker sees it. */
    read(message: PushMessage): { title: string; body: string; url: string } {
      return JSON.parse(decryptPayload(message.body, ua.getPrivateKey(), auth));
    },
  };
}

function passwordSession(id = userId): Session {
  const token = createSession(ctx.db, id, "password", { userAgent: "Chrome on Windows", tailnetLogin: null }, T0);
  return findSession(ctx.db, token, null, T0)!.session;
}

/** A fake push service: records what it's sent, answers `status`. */
function pushService(status = 201) {
  const sent: PushMessage[] = [];
  const send: PushSender = async (m) => {
    sent.push(m);
    return status;
  };
  return { sent, send };
}

beforeEach(() => {
  ctx = { db: openDatabase(":memory:"), key: randomBytes(32) };
  userId = addUser("alex", true);
});

describe("devices", () => {
  it("adds, lists and removes; a re-subscribed browser replaces its entry", () => {
    const { subscription } = phone();
    addPushDevice(ctx, userId, subscription, "iPhone", "https://moneyright.example.ts.net", T0);
    addPushDevice(ctx, userId, subscription, "iPhone again", "https://moneyright.example.ts.net", T0 + 1);
    const devices = listPushDevices(ctx.db, userId);
    expect(devices.map((d) => d.name)).toEqual(["iPhone again"]);
    // Only the owner can remove it.
    removePushDevice(ctx.db, addUser("sam"), devices[0].id, T0);
    expect(hasPushDevice(ctx.db, userId)).toBe(true);
    removePushDevice(ctx.db, userId, devices[0].id, T0);
    expect(hasPushDevice(ctx.db, userId)).toBe(false);
  });

  it("refuses endpoints that aren't a push service, and bad keys", () => {
    const { subscription } = phone();
    expect(() =>
      addPushDevice(ctx, userId, { ...subscription, endpoint: "https://169.254.169.254/latest" }, "x", "o", T0),
    ).toThrow(AccountError);
    expect(() =>
      addPushDevice(ctx, userId, { ...subscription, keys: { p256dh: "AAAA", auth: "AAAA" } }, "x", "o", T0),
    ).toThrow(AccountError);
  });

  it("keeps the subscription keys sealed", () => {
    const { subscription } = phone();
    addPushDevice(ctx, userId, subscription, "iPhone", "https://x", T0);
    const row = ctx.db.prepare("SELECT keys FROM push_devices").get() as { keys: string };
    expect(row.keys.startsWith("v1.")).toBe(true);
    expect(row.keys).not.toContain(subscription.keys.auth);
  });

  it("makes the VAPID key once", () => {
    expect(vapidKeys(ctx)).toEqual(vapidKeys(ctx));
  });

  it("are cleared by an admin's authenticator reset", () => {
    const other = addUser("sam");
    ctx.db.prepare("UPDATE users SET totp_secret = 'x' WHERE id = ?").run(other);
    addPushDevice(ctx, other, phone().subscription, "Pixel", "https://x", T0);
    resetTotp(ctx.db, userId, other, T0);
    expect(hasPushDevice(ctx.db, other)).toBe(false);
  });
});

describe("approving a sign-in", () => {
  let iphone: ReturnType<typeof phone>;
  let session: Session;
  let service: ReturnType<typeof pushService>;
  let number: string;
  let token: string;

  beforeEach(async () => {
    iphone = phone();
    addPushDevice(ctx, userId, iphone.subscription, "iPhone", "https://moneyright.example.ts.net", T0);
    session = passwordSession();
    service = pushService();
    const result = await startPushApproval(ctx, session, "Chrome on Windows on this Mac", service.send, T0);
    expect(result.sent).toBe(1);
    number = result.number;
    token = iphone.read(service.sent[0]).url.replace("/approve/", "");
  });

  it("sends the phone an encrypted, VAPID-signed link — and the number only to the screen", () => {
    const message = service.sent[0];
    expect(message.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(message.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(message.body.toString("latin1")).not.toContain("approve");
    const shown = iphone.read(message);
    expect(shown.title).toBe("Sign in to MoneyRight?");
    expect(shown.body).toContain("Chrome on Windows");
    expect(shown.body).not.toContain(number);
    expect(number).toMatch(/^\d{2}$/);
    expect(pushApprovalStatus(ctx.db, session, T0)).toBe("pending");
  });

  it("shows the request on the phone until it's answered", () => {
    expect(pendingApproval(ctx.db, token, T0)).toMatchObject({ displayName: "ALEX", deviceName: "iPhone" });
    expect(pendingApproval(ctx.db, "not-a-token", T0)).toBeNull();
  });

  it("approves with the right number, once, for that session only", () => {
    expect(decideApproval(ctx.db, token, { approve: true, number }, T0 + 1000)).toBe("approved");
    expect(decideApproval(ctx.db, token, { approve: true, number }, T0 + 1000)).toBe("gone");
    expect(pushApprovalStatus(ctx.db, session, T0 + 2000)).toBe("approved");
    expect(takeApproval(ctx.db, passwordSession())).toBe(false);
    expect(takeApproval(ctx.db, session)).toBe(true);
    expect(takeApproval(ctx.db, session)).toBe(false);
    expect(listPushDevices(ctx.db, userId)[0].lastUsedAt).toBe(T0 + 1000);
  });

  it("denies after three wrong numbers", () => {
    const wrong = number === "10" ? "11" : "10";
    expect(decideApproval(ctx.db, token, { approve: true, number: wrong }, T0)).toBe("wrong-number");
    expect(decideApproval(ctx.db, token, { approve: true, number: wrong }, T0)).toBe("wrong-number");
    expect(decideApproval(ctx.db, token, { approve: true, number: wrong }, T0)).toBe("denied");
    expect(decideApproval(ctx.db, token, { approve: true, number }, T0)).toBe("gone");
    expect(pushApprovalStatus(ctx.db, session, T0)).toBe("denied");
  });

  it("can be denied from the phone, and says so in the activity log", () => {
    expect(decideApproval(ctx.db, token, { approve: false }, T0)).toBe("denied");
    expect(pushApprovalStatus(ctx.db, session, T0)).toBe("denied");
    expect(takeApproval(ctx.db, session)).toBe(false);
    expect(recentEvents(ctx.db, userId).map((e) => e.event)).toContain("push-denied");
  });

  it("expires after two minutes", () => {
    const late = T0 + APPROVAL_TTL_MS + 1;
    expect(pushApprovalStatus(ctx.db, session, late)).toBe("expired");
    expect(pendingApproval(ctx.db, token, late)).toBeNull();
    expect(decideApproval(ctx.db, token, { approve: true, number }, late)).toBe("gone");
  });

  it("is replaced by a new request, whose number and link are fresh", async () => {
    await startPushApproval(ctx, session, "again", service.send, T0 + 5000);
    expect(decideApproval(ctx.db, token, { approve: true, number }, T0 + 6000)).toBe("gone");
    const newToken = iphone.read(service.sent[1]).url.replace("/approve/", "");
    expect(newToken).not.toBe(token);
    expect(pendingApproval(ctx.db, newToken, T0 + 6000)).not.toBeNull();
  });

  it("goes with the session when it moves on", () => {
    advanceSession(ctx.db, session, "full", T0 + 1000);
    expect(pendingApproval(ctx.db, token, T0 + 1000)).toBeNull();
  });
});

describe("unreachable phones", () => {
  it("removes a subscription the push service says is gone", async () => {
    addPushDevice(ctx, userId, phone().subscription, "Old phone", "https://x", T0);
    const result = await startPushApproval(ctx, passwordSession(), "x", pushService(410).send, T0);
    expect(result.sent).toBe(0);
    expect(hasPushDevice(ctx.db, userId)).toBe(false);
  });

  it("keeps it through other errors", async () => {
    addPushDevice(ctx, userId, phone().subscription, "Phone", "https://x", T0);
    const failing: PushSender = async () => {
      throw new Error("offline");
    };
    expect((await startPushApproval(ctx, passwordSession(), "x", failing, T0)).sent).toBe(0);
    expect(hasPushDevice(ctx.db, userId)).toBe(true);
  });

  it("needs a device to ask", async () => {
    await expect(startPushApproval(ctx, passwordSession(), "x", pushService().send, T0)).rejects.toThrow(AccountError);
  });
});
