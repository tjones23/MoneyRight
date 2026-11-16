import type { DatabaseSync } from "node:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { AccountError, logEvent, type Session, type User } from "./accounts";
import { hashToken, newToken } from "@/lib/tokens";

/**
 * Passkeys (WebAuthn). Two ways to use one:
 *
 * - **On its own**, from the sign-in page: no username, no password. A
 *   passkey is something you have (the device or synced keychain) unlocked
 *   by something you are or know (Face ID, Touch ID, the device passcode) —
 *   user verification is required, so it's both factors at once, and it
 *   can't be phished: the browser only offers it to the host it was made on.
 * - **As the second step** after a password, in place of a six-digit code.
 *
 * The authenticator app stays as the fallback either way, so losing a
 * passkey never locks anyone out.
 *
 * A passkey belongs to the host it was made on (the relying party ID):
 * one made at moneyright.<tailnet>.ts.net doesn't work at localhost, and
 * the reverse — so only the current host's passkeys are offered.
 *
 * The challenge in flight lives on the session row for five minutes and is
 * spent by the first attempt to use it.
 */

export interface RelyingParty {
  /** The bare hostname: "moneyright.example.ts.net", or "localhost". */
  id: string;
  /** Scheme, host and port the browser used. */
  origin: string;
}

export interface Passkey {
  id: number;
  name: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const CHALLENGE_TTL_MS = 5 * 60_000;

/** The WebAuthn user handle: stable per account, and not the username, which could change. */
function userHandle(userId: number): string {
  return `moneyright-user-${userId}`;
}

export function listPasskeys(db: DatabaseSync, userId: number): Passkey[] {
  return db
    .prepare("SELECT id, name, rp_id, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at")
    .all(userId)
    .map((r) => ({
      id: r.id as number,
      name: r.name as string,
      rpId: r.rp_id as string,
      createdAt: r.created_at as number,
      lastUsedAt: (r.last_used_at as number | null) ?? null,
    }));
}

export function hasPasskeyFor(db: DatabaseSync, userId: number, rpId: string): boolean {
  return db.prepare("SELECT 1 FROM passkeys WHERE user_id = ? AND rp_id = ?").get(userId, rpId) !== undefined;
}

function storeChallenge(db: DatabaseSync, session: Session, challenge: string, now: number) {
  db.prepare("UPDATE sessions SET webauthn_challenge = ?, webauthn_challenge_at = ? WHERE id_hash = ?").run(
    challenge,
    now,
    session.idHash,
  );
}

/** The session's challenge, if fresh — and spent either way. */
function takeChallenge(db: DatabaseSync, session: Session, now: number): string | null {
  const row = db
    .prepare("SELECT webauthn_challenge, webauthn_challenge_at FROM sessions WHERE id_hash = ?")
    .get(session.idHash) as { webauthn_challenge: string | null; webauthn_challenge_at: number | null } | undefined;
  db.prepare("UPDATE sessions SET webauthn_challenge = NULL, webauthn_challenge_at = NULL WHERE id_hash = ?").run(session.idHash);
  if (!row?.webauthn_challenge || !row.webauthn_challenge_at || now - row.webauthn_challenge_at > CHALLENGE_TTL_MS) return null;
  return row.webauthn_challenge;
}

function credentialsFor(db: DatabaseSync, userId: number, rpId: string) {
  return db
    .prepare("SELECT credential_id, public_key, counter, transports FROM passkeys WHERE user_id = ? AND rp_id = ?")
    .all(userId, rpId)
    .map((r) => ({
      id: r.credential_id as string,
      publicKey: new Uint8Array(r.public_key as Uint8Array),
      counter: r.counter as number,
      transports: r.transports ? (JSON.parse(r.transports as string) as string[]) : undefined,
    }));
}

// ---------------------------------------------------------------------------
// Adding one (from Settings, fully signed in)
// ---------------------------------------------------------------------------

export async function startRegistration(db: DatabaseSync, session: Session, user: User, rp: RelyingParty, now: number) {
  const options = await generateRegistrationOptions({
    rpName: "MoneyRight",
    rpID: rp.id,
    userName: user.username,
    userDisplayName: user.displayName,
    // Stable per account, and not the username, which could change.
    userID: new TextEncoder().encode(userHandle(user.id)),
    attestationType: "none",
    excludeCredentials: credentialsFor(db, user.id, rp.id).map((c) => ({ id: c.id, transports: c.transports })),
    // Discoverable, so it can sign in on its own, without a username first.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  storeChallenge(db, session, options.challenge, now);
  return options;
}

export async function finishRegistration(
  db: DatabaseSync,
  session: Session,
  user: User,
  response: RegistrationResponseJSON,
  rp: RelyingParty,
  name: string,
  now: number,
): Promise<void> {
  const challenge = takeChallenge(db, session, now);
  if (!challenge) throw new AccountError("That took too long — try adding the passkey again.");
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
    });
  } catch {
    throw new AccountError("That passkey couldn't be verified.");
  }
  if (!verification.verified) throw new AccountError("That passkey couldn't be verified.");
  const { credential } = verification.registrationInfo;
  try {
    db.prepare(
      "INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, rp_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      user.id,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      rp.id,
      name.trim().slice(0, 60) || "Passkey",
      now,
    );
  } catch {
    throw new AccountError("That passkey is already added.");
  }
  logEvent(db, user.id, "passkey-added", now, `${name.trim().slice(0, 60) || "Passkey"} for ${rp.id}`);
}

// ---------------------------------------------------------------------------
// Using one as the second step (at sign-in, after the password)
// ---------------------------------------------------------------------------

export async function startAuthentication(db: DatabaseSync, session: Session, rp: RelyingParty, now: number) {
  const credentials = credentialsFor(db, session.userId, rp.id);
  if (credentials.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: credentials.map((c) => ({ id: c.id, transports: c.transports })),
    userVerification: "required",
  });
  storeChallenge(db, session, options.challenge, now);
  return options;
}

/** True when the response is a valid signature from one of this user's passkeys. */
export async function finishAuthentication(
  db: DatabaseSync,
  session: Session,
  response: AuthenticationResponseJSON,
  rp: RelyingParty,
  now: number,
): Promise<boolean> {
  const challenge = takeChallenge(db, session, now);
  if (!challenge) return false;
  return verifyAssertion(db, session.userId, challenge, response, rp, now);
}

/** Checks an assertion against one user's passkeys for this host, and records its use. */
async function verifyAssertion(
  db: DatabaseSync,
  userId: number,
  challenge: string,
  response: AuthenticationResponseJSON,
  rp: RelyingParty,
  now: number,
): Promise<boolean> {
  const credential = credentialsFor(db, userId, rp.id).find((c) => c.id === response.id);
  if (!credential) return false;
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential,
      requireUserVerification: true,
    });
    if (!verified) return false;
    db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ? AND user_id = ?").run(
      authenticationInfo.newCounter,
      now,
      credential.id,
      userId,
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signing in with a passkey alone (no username, no password)
// ---------------------------------------------------------------------------

/**
 * A challenge for whichever passkey the browser offers. There's no session
 * yet, so it's kept under a random id the browser holds until it answers.
 */
export async function startPasskeySignIn(db: DatabaseSync, rp: RelyingParty, now: number) {
  db.prepare("DELETE FROM passkey_challenges WHERE created_at < ?").run(now - CHALLENGE_TTL_MS);
  // No allowCredentials: the browser lists every passkey it has for this host.
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "required" });
  const challengeId = newToken();
  db.prepare("INSERT INTO passkey_challenges (id_hash, challenge, rp_id, created_at) VALUES (?, ?, ?, ?)").run(
    hashToken(challengeId),
    options.challenge,
    rp.id,
    now,
  );
  return { options, challengeId };
}

/**
 * The user a passkey signed in, or null. The challenge is spent by the first
 * attempt, and must have been issued for this same host.
 */
export async function finishPasskeySignIn(
  db: DatabaseSync,
  challengeId: string,
  response: AuthenticationResponseJSON,
  rp: RelyingParty,
  now: number,
): Promise<number | null> {
  const idHash = hashToken(String(challengeId));
  const row = db.prepare("SELECT challenge, rp_id, created_at FROM passkey_challenges WHERE id_hash = ?").get(idHash) as
    | { challenge: string; rp_id: string; created_at: number }
    | undefined;
  db.prepare("DELETE FROM passkey_challenges WHERE id_hash = ?").run(idHash);
  if (!row || row.rp_id !== rp.id || now - row.created_at > CHALLENGE_TTL_MS) return null;

  const owner = db
    .prepare("SELECT user_id FROM passkeys WHERE credential_id = ? AND rp_id = ?")
    .get(String(response?.id ?? ""), rp.id) as { user_id: number } | undefined;
  if (!owner) return null;
  // The passkey names its account too; it must be the one the credential belongs to.
  const handle = response.response?.userHandle;
  if (handle && Buffer.from(handle, "base64url").toString() !== userHandle(owner.user_id)) return null;

  return (await verifyAssertion(db, owner.user_id, row.challenge, response, rp, now)) ? owner.user_id : null;
}

export function removePasskey(db: DatabaseSync, userId: number, id: number, now: number) {
  const removed = db.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").run(id, userId);
  if (removed.changes) logEvent(db, userId, "passkey-removed", now);
}
