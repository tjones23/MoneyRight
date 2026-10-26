import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The backup file: the whole database, gzipped, then AES-256-GCM.
 *
 *   "MRBK" ‖ version (1 byte) ‖ IV (12) ‖ tag (16) ‖ ciphertext
 *
 * The key is derived from master.key (HKDF, its own label), so a backup can
 * sit somewhere less private — iCloud Drive, a USB stick — without exposing
 * balances, and restoring needs master.key, kept apart (a password manager).
 * A backup and its key in the same place protect nothing.
 */

const MAGIC = Buffer.from("MRBK");
const VERSION = 1;
const AAD = Buffer.from("moneyright-backup-v1");

export function backupKey(masterKey: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "moneyright backup v1", 32));
}

export function encryptBackup(masterKey: Uint8Array, database: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", backupKey(masterKey), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(gzipSync(database)), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Throws if it isn't a MoneyRight backup, was altered, or was made under another key. */
export function decryptBackup(masterKey: Uint8Array, file: Uint8Array): Buffer {
  const buf = Buffer.from(file);
  if (buf.length < 33 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("Not a MoneyRight backup.");
  if (buf[4] !== VERSION) throw new Error(`Backup format v${buf[4]} is newer than this build understands.`);
  const decipher = createDecipheriv("aes-256-gcm", backupKey(masterKey), buf.subarray(5, 17));
  decipher.setAAD(AAD);
  decipher.setAuthTag(buf.subarray(17, 33));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(33)), decipher.final()]);
  } catch {
    throw new Error("This backup doesn't open with this master.key (or it was damaged).");
  }
  return gunzipSync(plain);
}

export const BACKUP_SUFFIX = ".mrbak";

/** "moneyright-2026-10-26.mrbak" → "2026-10-26". */
export function backupDay(name: string): string | null {
  return /^moneyright-(\d{4}-\d{2}-\d{2})\.mrbak$/.exec(name)?.[1] ?? null;
}

/**
 * Which backups to keep: the newest `daily`, plus the newest of each month
 * for the last `monthly` months. Everything else can go.
 */
export function backupsToKeep(days: string[], daily = 14, monthly = 12): Set<string> {
  const sorted = [...new Set(days)].sort().reverse();
  const keep = new Set(sorted.slice(0, daily));
  const months = new Set<string>();
  for (const day of sorted) {
    const month = day.slice(0, 7);
    if (months.has(month)) continue;
    if (months.size >= monthly) break;
    months.add(month);
    keep.add(day);
  }
  return keep;
}
