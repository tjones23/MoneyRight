import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { base32Encode } from "./base32";

/**
 * Time-based one-time passwords (RFC 6238): HMAC-SHA1, six digits, 30-second
 * steps — the only parameters every authenticator app agrees on.
 *
 * Takes `now` rather than reading the clock, so it's deterministic to test.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now that still count, for a phone clock a little off. */
export const TOTP_WINDOW = 1;

/** A fresh 160-bit secret, the size RFC 4226 recommends for SHA-1. */
export function newTotpSecret(): Uint8Array {
  return randomBytes(20);
}

export function totpCounter(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** RFC 4226 HOTP for one counter value. */
export function hotp(secret: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, "0");
}

export function totp(secret: Uint8Array, nowMs: number): string {
  return hotp(secret, totpCounter(nowMs));
}

/**
 * The counter a code matches within the window, or null. Callers store the
 * counter and pass it back as `lastCounter`, so a code can't be replayed —
 * not even within its own 30 seconds.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastCounter: number | null,
): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const now = totpCounter(nowMs);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const counter = now + delta;
    if (lastCounter !== null && counter <= lastCounter) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, counter)), Buffer.from(clean))) return counter;
  }
  return null;
}

/** The `otpauth://` URI an authenticator app scans from a QR code. */
export function otpauthUri(secret: Uint8Array, account: string, issuer = "MoneyRight"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}
