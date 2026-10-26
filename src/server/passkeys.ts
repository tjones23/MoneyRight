import type { DatabaseSync } from "node:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { AccountError, logEvent, type Session, type User } from "./accounts";

/**
 * Passkeys (WebAuthn), as the second factor in place of a six-digit code.
 * Always after the password, never instead of it; the authenticator app
 * stays as the fallback, so losing a passkey never locks anyone out.
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
    userID: new TextEncoder().encode(`moneyright-user-${user.id}`),
    attestationType: "none",
    excludeCredentials: credentialsFor(db, user.id, rp.id).map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
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
// Using one (at sign-in, after the password)
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
  const credential = credentialsFor(db, session.userId, rp.id).find((c) => c.id === response.id);
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
      session.userId,
    );
    return true;
  } catch {
    return false;
  }
}

export function removePasskey(db: DatabaseSync, userId: number, id: number, now: number) {
  const removed = db.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").run(id, userId);
  if (removed.changes) logEvent(db, userId, "passkey-removed", now);
}
