import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import { hasUsers } from "./context";
import { dummyPasswordHash, hashPassword, needsRehash, passwordProblem, verifyPassword } from "@/lib/password";
import { open, seal } from "@/lib/sealed";
import { isExpired, normalizeUsername, shouldTouch, usernameProblem } from "@/lib/session-policy";
import type { SessionStage } from "@/lib/session-policy";
import { hashRecoveryCode, hashToken, newRecoveryCodes, newToken } from "@/lib/tokens";
import { newTotpSecret, verifyTotp } from "@/lib/totp";

/**
 * Accounts, sessions and invites: everything about who someone is, and
 * nothing about Next. Every function takes the database (and the key, where
 * it unseals anything) and `now`, so the whole flow is testable against an
 * in-memory database. `auth.ts` is the thin layer that adds cookies.
 */

export interface Ctx {
  db: DatabaseSync;
  key: Buffer;
}

export interface User {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  hasTotp: boolean;
}

export interface Session {
  idHash: string;
  userId: number;
  stage: SessionStage;
  createdAt: number;
  lastSeenAt: number;
  userAgent: string | null;
  tailnetLogin: string | null;
}

export class AccountError extends Error {}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  totp_secret: string | null;
  totp_last_counter: number | null;
}

interface SessionRow {
  id_hash: string;
  user_id: number;
  stage: SessionStage;
  created_at: number;
  last_seen_at: number;
  user_agent: string | null;
  tailnet_login: string | null;
  pending_totp_secret: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    hasTotp: row.totp_secret !== null,
  };
}

function toSession(row: SessionRow): Session {
  return {
    idHash: row.id_hash,
    userId: row.user_id,
    stage: row.stage,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
    tailnetLogin: row.tailnet_login,
  };
}

function userRow(db: DatabaseSync, id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getUser(db: DatabaseSync, id: number): User | null {
  const row = userRow(db, id);
  return row ? toUser(row) : null;
}

export function listUsers(db: DatabaseSync): User[] {
  return (db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as UserRow[]).map(toUser);
}

export function logEvent(db: DatabaseSync, userId: number | null, event: string, now: number, detail = "") {
  db.prepare("INSERT INTO security_events (user_id, at, event, detail) VALUES (?, ?, ?, ?)").run(
    userId,
    now,
    event,
    detail,
  );
}

export function recentEvents(db: DatabaseSync, userId: number, limit = 20) {
  return db
    .prepare("SELECT at, event, detail FROM security_events WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?")
    .all(userId, limit) as { at: number; event: string; detail: string }[];
}

// ---------------------------------------------------------------------------
// Creating accounts
// ---------------------------------------------------------------------------

export interface NewAccount {
  username: string;
  displayName: string;
  password: string;
}

function checkNewAccount(db: DatabaseSync, account: NewAccount): string {
  const username = normalizeUsername(account.username);
  const problem =
    usernameProblem(username) ??
    (account.displayName.trim() ? null : "Enter a name.") ??
    passwordProblem(account.password);
  if (problem) throw new AccountError(problem);
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) {
    throw new AccountError("That username is taken.");
  }
  return username;
}

async function insertUser(db: DatabaseSync, account: NewAccount, isAdmin: boolean, now: number): Promise<number> {
  const username = checkNewAccount(db, account);
  const hash = await hashPassword(account.password);
  // Checked again inside the transaction: the hash took a moment.
  return transaction(db, () => {
    if (isAdmin && hasUsers(db)) throw new AccountError("MoneyRight is already set up.");
    checkNewAccount(db, account);
    const result = db
      .prepare(
        "INSERT INTO users (username, display_name, password_hash, is_admin, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(username, account.displayName.trim(), hash, isAdmin ? 1 : 0, now, now);
    const id = Number(result.lastInsertRowid);
    logEvent(db, id, "account-created", now, isAdmin ? "first account (admin)" : "");
    return id;
  });
}

/** The first account, made with the setup code. Always an admin. */
export async function createFirstAdmin(db: DatabaseSync, account: NewAccount, now: number): Promise<number> {
  if (hasUsers(db)) throw new AccountError("MoneyRight is already set up.");
  return insertUser(db, account, true, now);
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

export function createInvite(db: DatabaseSync, adminId: number, note: string, now: number): string {
  const admin = getUser(db, adminId);
  if (!admin?.isAdmin) throw new AccountError("Only an admin can invite people.");
  const token = newToken();
  db.prepare("INSERT INTO invites (token_hash, created_by, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    hashToken(token),
    adminId,
    note.trim().slice(0, 80),
    now,
    now + INVITE_TTL_MS,
  );
  logEvent(db, adminId, "invite-created", now, note.trim().slice(0, 80));
  return token;
}

export function inviteIsUsable(db: DatabaseSync, token: string, now = Date.now()): boolean {
  const row = db.prepare("SELECT expires_at, used_at FROM invites WHERE token_hash = ?").get(hashToken(token)) as
    | { expires_at: number; used_at: number | null }
    | undefined;
  return !!row && row.used_at === null && row.expires_at > now;
}

export function listOpenInvites(db: DatabaseSync, now = Date.now()) {
  return db
    .prepare(
      "SELECT token_hash AS id, note, created_at AS createdAt, expires_at AS expiresAt FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
    )
    .all(now) as { id: string; note: string; createdAt: number; expiresAt: number }[];
}

export function revokeInvite(db: DatabaseSync, adminId: number, id: string) {
  if (!getUser(db, adminId)?.isAdmin) throw new AccountError("Only an admin can revoke invites.");
  db.prepare("DELETE FROM invites WHERE token_hash = ? AND used_at IS NULL").run(id);
}

export async function redeemInvite(db: DatabaseSync, token: string, account: NewAccount, now: number): Promise<number> {
  if (!inviteIsUsable(db, token, now)) throw new AccountError("This invite link has expired or was already used.");
  const id = await insertUser(db, account, false, now);
  const used = db
    .prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL")
    .run(now, id, hashToken(token));
  if (used.changes !== 1) {
    // Someone used the same link in the moment the password was hashing.
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    throw new AccountError("This invite link was already used.");
  }
  return id;
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** The user, if the password is right. Takes as long either way. */
export async function checkPassword(db: DatabaseSync, username: string, password: string): Promise<User | null> {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(normalizeUsername(username)) as
    | UserRow
    | undefined;
  if (!row) {
    await verifyPassword(password, await dummyPasswordHash());
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  if (needsRehash(row.password_hash)) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(password), row.id);
  }
  return toUser(row);
}

/** Changes the password and signs out every other session. */
export async function changePassword(
  db: DatabaseSync,
  userId: number,
  current: string,
  next: string,
  keepSession: string,
  now: number,
) {
  const row = userRow(db, userId);
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    throw new AccountError("Your current password isn't right.");
  }
  const problem = passwordProblem(next);
  if (problem) throw new AccountError(problem);
  const hash = await hashPassword(next);
  transaction(db, () => {
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(hash, now, userId);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(userId, keepSession);
    logEvent(db, userId, "password-changed", now);
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionMeta {
  userAgent: string | null;
  tailnetLogin: string | null;
}

/** A new session; returns the cookie value. */
export function createSession(db: DatabaseSync, userId: number, stage: SessionStage, meta: SessionMeta, now: number) {
  const token = newToken();
  db.prepare(
    "INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen_at, user_agent, tailnet_login) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(hashToken(token), userId, stage, now, now, meta.userAgent?.slice(0, 300) ?? null, meta.tailnetLogin);
  return token;
}

/**
 * The session behind a cookie value, if it's still good and the request
 * comes from the same tailnet identity that signed in. A cookie lifted from
 * one person's browser doesn't work from anyone else's tailnet login.
 */
export function findSession(
  db: DatabaseSync,
  token: string,
  tailnetLogin: string | null,
  now: number,
): { session: Session; user: User } | null {
  const idHash = hashToken(token);
  const row = db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idHash) as SessionRow | undefined;
  if (!row) return null;
  const session = toSession(row);
  if (isExpired(session, now)) {
    db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
    return null;
  }
  if (session.tailnetLogin !== tailnetLogin) return null;
  const user = getUser(db, session.userId);
  if (!user) return null;
  if (shouldTouch(session, now)) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(now, idHash);
    session.lastSeenAt = now;
  }
  return { session, user };
}

/**
 * Moves a session to its next stage under a brand-new cookie value, so a
 * value seen before the second factor is worthless after it.
 */
export function advanceSession(db: DatabaseSync, session: Session, stage: SessionStage, now: number): string {
  const token = newToken();
  transaction(db, () => {
    db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(session.idHash);
    db.prepare(
      "INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen_at, user_agent, tailnet_login) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(hashToken(token), session.userId, stage, now, now, session.userAgent, session.tailnetLogin);
  });
  return token;
}

export function endSession(db: DatabaseSync, idHash: string) {
  db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
}

export function listSessions(db: DatabaseSync, userId: number): Session[] {
  return (
    db
      .prepare("SELECT * FROM sessions WHERE user_id = ? AND stage = 'full' ORDER BY last_seen_at DESC")
      .all(userId) as unknown as SessionRow[]
  ).map(toSession);
}

/** Ends one of the user's own sessions (and only their own). */
export function revokeSession(db: DatabaseSync, userId: number, idHash: string, now: number) {
  const result = db.prepare("DELETE FROM sessions WHERE id_hash = ? AND user_id = ?").run(idHash, userId);
  if (result.changes) logEvent(db, userId, "session-revoked", now);
}

export function revokeOtherSessions(db: DatabaseSync, userId: number, keep: string, now: number) {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(userId, keep);
  logEvent(db, userId, "signed-out-everywhere-else", now);
}

// ---------------------------------------------------------------------------
// The second factor
// ---------------------------------------------------------------------------

function totpContext(userId: number) {
  return `totp:${userId}`;
}

function pendingContext(idHash: string) {
  return `totp-pending:${idHash}`;
}

function pendingCodesContext(idHash: string) {
  return `recovery-pending:${idHash}`;
}

/**
 * The secret being set up on this session, made on first ask and kept until
 * confirmed — so reloading the page doesn't change the QR code under you.
 */
export function pendingTotpSecret(ctx: Ctx, session: Session): Buffer {
  const row = ctx.db.prepare("SELECT pending_totp_secret FROM sessions WHERE id_hash = ?").get(session.idHash) as
    | { pending_totp_secret: string | null }
    | undefined;
  if (row?.pending_totp_secret) return open(ctx.key, row.pending_totp_secret, pendingContext(session.idHash));
  const secret = Buffer.from(newTotpSecret());
  ctx.db
    .prepare("UPDATE sessions SET pending_totp_secret = ? WHERE id_hash = ?")
    .run(seal(ctx.key, secret, pendingContext(session.idHash)), session.idHash);
  return secret;
}

/**
 * Confirms the authenticator with its first code. Returns the recovery codes,
 * or null if the code was wrong. They're stored as hashes for good, and
 * sealed on this enrollment session only until it continues
 * (`advanceSession` replaces the row), so the page can show them once.
 */
export function confirmTotp(ctx: Ctx, session: Session, code: string, now: number): string[] | null {
  const secret = pendingTotpSecret(ctx, session);
  const counter = verifyTotp(secret, code, now, null);
  if (counter === null) return null;
  const codes = newRecoveryCodes();
  transaction(ctx.db, () => {
    ctx.db
      .prepare("UPDATE users SET totp_secret = ?, totp_last_counter = ? WHERE id = ?")
      .run(seal(ctx.key, secret, totpContext(session.userId)), counter, session.userId);
    storeRecoveryCodes(ctx.db, session.userId, codes);
    ctx.db
      .prepare("UPDATE sessions SET pending_totp_secret = NULL, pending_recovery_codes = ? WHERE id_hash = ?")
      .run(seal(ctx.key, JSON.stringify(codes), pendingCodesContext(session.idHash)), session.idHash);
    logEvent(ctx.db, session.userId, "authenticator-set-up", now);
  });
  return codes;
}

/** The recovery codes made on this enrollment session, while it lasts. */
export function enrollmentRecoveryCodes(ctx: Ctx, session: Session): string[] | null {
  const row = ctx.db.prepare("SELECT pending_recovery_codes FROM sessions WHERE id_hash = ?").get(session.idHash) as
    | { pending_recovery_codes: string | null }
    | undefined;
  if (!row?.pending_recovery_codes) return null;
  return JSON.parse(open(ctx.key, row.pending_recovery_codes, pendingCodesContext(session.idHash)).toString());
}

function storeRecoveryCodes(db: DatabaseSync, userId: number, codes: string[]) {
  db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
  const insert = db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
  for (const code of codes) insert.run(userId, hashRecoveryCode(code));
}

/** A fresh set of recovery codes; the old ones stop working. */
export function regenerateRecoveryCodes(db: DatabaseSync, userId: number, now: number): string[] {
  const codes = newRecoveryCodes();
  transaction(db, () => {
    storeRecoveryCodes(db, userId, codes);
    logEvent(db, userId, "recovery-codes-replaced", now);
  });
  return codes;
}

export function unusedRecoveryCodeCount(db: DatabaseSync, userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .get(userId) as { n: number };
  return row.n;
}

/**
 * Checks a six-digit code, or a recovery code (which is then spent).
 * Returns how it was accepted, or null.
 */
export function checkSecondFactor(ctx: Ctx, userId: number, input: string, now: number): "totp" | "recovery" | null {
  const row = userRow(ctx.db, userId);
  if (!row?.totp_secret) return null;

  if (/^\s*\d{3}\s?\d{3}\s*$/.test(input)) {
    const secret = open(ctx.key, row.totp_secret, totpContext(userId));
    const counter = verifyTotp(secret, input, now, row.totp_last_counter);
    if (counter === null) return null;
    // Guarded on the old counter, so two requests racing with one code can't both win.
    const updated = ctx.db
      .prepare("UPDATE users SET totp_last_counter = ? WHERE id = ? AND totp_last_counter IS ?")
      .run(counter, userId, row.totp_last_counter);
    return updated.changes === 1 ? "totp" : null;
  }

  const spent = ctx.db
    .prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
    .run(now, userId, hashRecoveryCode(input));
  if (spent.changes !== 1) return null;
  logEvent(ctx.db, userId, "recovery-code-used", now, `${unusedRecoveryCodeCount(ctx.db, userId)} left`);
  return "recovery";
}

/**
 * An admin clears someone's authenticator — a lost phone, with the recovery
 * codes lost too — and their passkeys with it. They're signed out, and set
 * one up again at next sign-in.
 */
export function resetTotp(db: DatabaseSync, adminId: number, userId: number, now: number) {
  if (!getUser(db, adminId)?.isAdmin) throw new AccountError("Only an admin can reset an authenticator.");
  if (adminId === userId) throw new AccountError("Reset your own from a recovery code instead.");
  transaction(db, () => {
    db.prepare("UPDATE users SET totp_secret = NULL, totp_last_counter = NULL WHERE id = ?").run(userId);
    db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM passkeys WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    logEvent(db, userId, "authenticator-reset", now, `by admin #${adminId}`);
  });
}
