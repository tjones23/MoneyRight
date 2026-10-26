import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import {
  AccountError,
  advanceSession,
  changePassword,
  checkPassword,
  checkSecondFactor,
  confirmTotp,
  createFirstAdmin,
  createInvite,
  createSession,
  enrollmentRecoveryCodes,
  findSession,
  inviteIsUsable,
  INVITE_TTL_MS,
  listSessions,
  pendingTotpSecret,
  redeemInvite,
  resetTotp,
  revokeSession,
  unusedRecoveryCodeCount,
  type Ctx,
} from "./accounts";
import { totp } from "@/lib/totp";
import { hashToken } from "@/lib/tokens";

const T0 = Date.UTC(2026, 9, 26, 12);
const local = { userAgent: "test", tailnetLogin: null };
const admin = { username: "Alex", displayName: "Alex", password: "a long enough password" };

let ctx: Ctx;
beforeEach(() => {
  ctx = { db: openDatabase(":memory:"), key: randomBytes(32) };
});

/** Sign up and set up TOTP; returns the user id, its secret and recovery codes. */
async function enrolledAdmin() {
  const id = await createFirstAdmin(ctx.db, admin, T0);
  const token = createSession(ctx.db, id, "enroll", local, T0);
  const { session } = findSession(ctx.db, token, null, T0)!;
  const secret = pendingTotpSecret(ctx, session);
  const codes = confirmTotp(ctx, session, totp(secret, T0), T0)!;
  return { id, secret, codes };
}

describe("first account", () => {
  it("is an admin, and there can be only one made this way", async () => {
    const id = await createFirstAdmin(ctx.db, admin, T0);
    expect(id).toBe(1);
    await expect(createFirstAdmin(ctx.db, { ...admin, username: "other" }, T0)).rejects.toThrow(AccountError);
  });

  it("validates the username and password", async () => {
    await expect(createFirstAdmin(ctx.db, { ...admin, username: "a b" }, T0)).rejects.toThrow(/characters/);
    await expect(createFirstAdmin(ctx.db, { ...admin, password: "short" }, T0)).rejects.toThrow(/12/);
  });
});

describe("signing in", () => {
  it("checks the password case-insensitively by username only", async () => {
    await createFirstAdmin(ctx.db, admin, T0);
    expect(await checkPassword(ctx.db, "ALEX", admin.password)).toMatchObject({ username: "alex", isAdmin: true });
    expect(await checkPassword(ctx.db, "alex", "wrong password here")).toBeNull();
    expect(await checkPassword(ctx.db, "nobody", admin.password)).toBeNull();
  });

  it("keeps the enrollment QR stable until confirmed, and rejects a wrong first code", async () => {
    const id = await createFirstAdmin(ctx.db, admin, T0);
    const token = createSession(ctx.db, id, "enroll", local, T0);
    const { session } = findSession(ctx.db, token, null, T0)!;
    const secret = pendingTotpSecret(ctx, session);
    expect(pendingTotpSecret(ctx, session)).toEqual(secret);
    expect(confirmTotp(ctx, session, "000000", T0)).toBeNull();
  });

  it("shows the recovery codes on the enrollment session only until it continues", async () => {
    const id = await createFirstAdmin(ctx.db, admin, T0);
    const token = createSession(ctx.db, id, "enroll", local, T0);
    const { session } = findSession(ctx.db, token, null, T0)!;
    const codes = confirmTotp(ctx, session, totp(pendingTotpSecret(ctx, session), T0), T0)!;
    expect(enrollmentRecoveryCodes(ctx, session)).toEqual(codes);
    const next = advanceSession(ctx.db, session, "full", T0);
    expect(enrollmentRecoveryCodes(ctx, findSession(ctx.db, next, null, T0)!.session)).toBeNull();
  });

  it("accepts a TOTP code once, then a recovery code once", async () => {
    const { id, secret, codes } = await enrolledAdmin();
    expect(codes).toHaveLength(10);
    // Enrollment used this step's code already.
    expect(checkSecondFactor(ctx, id, totp(secret, T0), T0)).toBeNull();
    const later = T0 + 60_000;
    expect(checkSecondFactor(ctx, id, totp(secret, later), later)).toBe("totp");
    expect(checkSecondFactor(ctx, id, totp(secret, later), later)).toBeNull();

    expect(checkSecondFactor(ctx, id, codes[0].toUpperCase(), later)).toBe("recovery");
    expect(checkSecondFactor(ctx, id, codes[0], later)).toBeNull();
    expect(unusedRecoveryCodeCount(ctx.db, id)).toBe(9);
  });

  it("stores the TOTP secret sealed, and sessions by hash only", async () => {
    const { id, secret } = await enrolledAdmin();
    const row = ctx.db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(id) as { totp_secret: string };
    expect(row.totp_secret.startsWith("v1.")).toBe(true);
    expect(row.totp_secret).not.toContain(Buffer.from(secret).toString("base64url"));

    const token = createSession(ctx.db, id, "full", local, T0);
    expect(ctx.db.prepare("SELECT 1 FROM sessions WHERE id_hash = ?").get(token)).toBeUndefined();
    expect(ctx.db.prepare("SELECT 1 FROM sessions WHERE id_hash = ?").get(hashToken(token))).toBeDefined();
  });
});

describe("sessions", () => {
  it("only work for the tailnet login that signed in", async () => {
    const { id } = await enrolledAdmin();
    const token = createSession(ctx.db, id, "full", { userAgent: null, tailnetLogin: "alex@example.com" }, T0);
    expect(findSession(ctx.db, token, "alex@example.com", T0)).not.toBeNull();
    expect(findSession(ctx.db, token, "sam@example.com", T0)).toBeNull();
    expect(findSession(ctx.db, token, null, T0)).toBeNull();
  });

  it("expire, and are deleted when found expired", async () => {
    const { id } = await enrolledAdmin();
    const token = createSession(ctx.db, id, "password", local, T0);
    expect(findSession(ctx.db, token, null, T0 + 11 * 60_000)).toBeNull();
    expect(ctx.db.prepare("SELECT 1 FROM sessions WHERE id_hash = ?").get(hashToken(token))).toBeUndefined();
  });

  it("get a new cookie value when they advance", async () => {
    const { id } = await enrolledAdmin();
    const before = createSession(ctx.db, id, "password", local, T0);
    const { session } = findSession(ctx.db, before, null, T0)!;
    const after = advanceSession(ctx.db, session, "full", T0);
    expect(findSession(ctx.db, before, null, T0)).toBeNull();
    expect(findSession(ctx.db, after, null, T0)?.session.stage).toBe("full");
  });

  it("can only be revoked by their owner", async () => {
    const { id } = await enrolledAdmin();
    const token = createSession(ctx.db, id, "full", local, T0);
    revokeSession(ctx.db, 999, hashToken(token), T0);
    expect(listSessions(ctx.db, id)).toHaveLength(1);
    revokeSession(ctx.db, id, hashToken(token), T0);
    expect(listSessions(ctx.db, id)).toHaveLength(0);
  });

  it("other than this one end when the password changes", async () => {
    const { id } = await enrolledAdmin();
    const keep = createSession(ctx.db, id, "full", local, T0);
    createSession(ctx.db, id, "full", local, T0);
    await expect(changePassword(ctx.db, id, "wrong password!!", "new password here", hashToken(keep), T0)).rejects.toThrow();
    await changePassword(ctx.db, id, admin.password, "new password here", hashToken(keep), T0);
    expect(listSessions(ctx.db, id).map((s) => s.idHash)).toEqual([hashToken(keep)]);
    expect(await checkPassword(ctx.db, "alex", "new password here")).not.toBeNull();
  });
});

describe("invites", () => {
  it("are made by admins, work once, and expire", async () => {
    const { id } = await enrolledAdmin();
    const token = createInvite(ctx.db, id, "Sam", T0);
    expect(inviteIsUsable(ctx.db, token, T0 + INVITE_TTL_MS + 1)).toBe(false);

    const sam = await redeemInvite(ctx.db, token, { username: "sam", displayName: "Sam", password: "sam's long password" }, T0);
    expect(sam).toBe(2);
    await expect(
      redeemInvite(ctx.db, token, { username: "sam2", displayName: "Sam", password: "sam's long password" }, T0),
    ).rejects.toThrow(/expired or was already used/);
    expect(() => createInvite(ctx.db, sam, "", T0)).toThrow(/admin/);
  });

  it("make regular accounts whose authenticator an admin can reset", async () => {
    const { id } = await enrolledAdmin();
    const samId = await redeemInvite(
      ctx.db,
      createInvite(ctx.db, id, "", T0),
      { username: "sam", displayName: "Sam", password: "sam's long password" },
      T0,
    );
    const token = createSession(ctx.db, samId, "enroll", local, T0);
    const { session } = findSession(ctx.db, token, null, T0)!;
    confirmTotp(ctx, session, totp(pendingTotpSecret(ctx, session), T0), T0);
    expect((await checkPassword(ctx.db, "sam", "sam's long password"))?.hasTotp).toBe(true);

    expect(() => resetTotp(ctx.db, samId, id, T0)).toThrow(/admin/);
    resetTotp(ctx.db, id, samId, T0);
    expect((await checkPassword(ctx.db, "sam", "sam's long password"))?.hasTotp).toBe(false);
    expect(listSessions(ctx.db, samId)).toHaveLength(0);
  });
});
