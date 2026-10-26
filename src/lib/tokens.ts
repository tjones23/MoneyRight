import { createHash, randomBytes } from "node:crypto";
import { base32Encode } from "./base32";

/**
 * Random bearer values — session cookies, invite links, the setup code,
 * recovery codes — and how they're stored. Each is high-entropy, so a plain
 * SHA-256 is enough to keep the database from holding anything usable; only
 * passwords, which people choose, need argon2.
 */

/** 256 bits, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const RECOVERY_CODE_COUNT = 10;

/** Ten codes like "k7m2-q9xp-4tdw" — 60 bits each, easy to read off paper. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = base32Encode(randomBytes(8)).slice(0, 12).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}

/** What a typed recovery code is compared as: no case, no dashes or spaces. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return hashToken(normalizeRecoveryCode(code));
}

/** The one-time setup code shown by the launcher: short enough to type. */
export function newSetupCode(): string {
  const raw = base32Encode(randomBytes(10)).slice(0, 16);
  return raw.match(/.{4}/g)!.join("-");
}

export function normalizeSetupCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}
