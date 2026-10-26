import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Field encryption for secrets the app has to read back — TOTP secrets now,
 * bank-link access tokens in phase 2. AES-256-GCM with a fresh 96-bit IV per
 * value, so equal plaintexts never look equal, and the tag means a tampered
 * value fails to open rather than decrypting to garbage.
 *
 * `context` is bound in as additional data — say "totp:<userId>" — so a value
 * copied from one row or column to another won't open there either.
 *
 * Format: "v1." + base64url(iv ‖ tag ‖ ciphertext). The version prefix leaves
 * room to rotate the key or algorithm later without guessing at old values.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_BYTES = 32;

export function seal(key: Uint8Array, plaintext: Uint8Array | string, context: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** Throws if the value was altered, sealed under another key, or for another context. */
export function open(key: Uint8Array, sealed: string, context: string): Buffer {
  assertKey(key);
  const [version, payload] = sealed.split(".", 2);
  if (version !== VERSION || !payload) throw new Error("Unrecognized sealed value");
  const raw = Buffer.from(payload, "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Sealed value is truncated");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

function assertKey(key: Uint8Array) {
  if (key.length !== KEY_BYTES) throw new Error(`Encryption key must be ${KEY_BYTES} bytes`);
}
