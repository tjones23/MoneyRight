import { backup } from "node:sqlite";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AppContext } from "./context";
import { BACKUP_SUFFIX, backupDay, backupsToKeep, encryptBackup } from "@/lib/backup-format";
import { dateKey } from "@/lib/local-date";

/**
 * Nightly backups: a consistent copy through SQLite's backup API (safe while
 * the app writes), encrypted (lib/backup-format.ts), written to
 * MONEYRIGHT_BACKUP_DIR — ideally somewhere off this disk, like an iCloud
 * Drive folder — then pruned to 14 dailies and 12 monthlies.
 */

export function backupDir(ctx: AppContext): string {
  // Default: .moneyright/backups/<production|development>, beside the data.
  return process.env.MONEYRIGHT_BACKUP_DIR || join(dirname(ctx.dataDir), "backups", basename(ctx.dataDir));
}

/** True when backups land beside the database, where a disk failure takes both. */
export function backupDirIsLocal(): boolean {
  return !process.env.MONEYRIGHT_BACKUP_DIR;
}

export interface BackupInfo {
  name: string;
  day: string;
  bytes: number;
  modifiedAt: number;
}

export function listBackups(ctx: AppContext): BackupInfo[] {
  const dir = backupDir(ctx);
  let names: string[];
  try {
    names = readdirSync(/*turbopackIgnore: true*/ dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => backupDay(n))
    .map((name) => {
      const stat = statSync(/*turbopackIgnore: true*/ join(dir, name));
      return { name, day: backupDay(name)!, bytes: stat.size, modifiedAt: stat.mtimeMs };
    })
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** Makes today's backup (replacing an earlier one today) and prunes old ones. Returns its path. */
export async function makeBackup(ctx: AppContext, now: number): Promise<string> {
  const dir = backupDir(ctx);
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true, mode: 0o700 });
  const final = join(dir, `moneyright-${dateKey(now)}${BACKUP_SUFFIX}`);
  const plainCopy = join(ctx.dataDir, `.backup-${process.pid}.db`);
  try {
    // The plain copy lives a moment in the private data directory, never in the backup one.
    await backup(ctx.db, plainCopy);
    const sealed = encryptBackup(ctx.key, readFileSync(/*turbopackIgnore: true*/ plainCopy));
    const partial = `${final}.partial`;
    writeFileSync(/*turbopackIgnore: true*/ partial, sealed, { mode: 0o600 });
    renameSync(/*turbopackIgnore: true*/ partial, final);
    chmodSync(/*turbopackIgnore: true*/ final, 0o600);
  } finally {
    rmSync(/*turbopackIgnore: true*/ plainCopy, { force: true });
  }
  ctx.db.prepare("INSERT INTO meta (key, value) VALUES ('last_backup_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(now));
  ctx.db.prepare("DELETE FROM meta WHERE key = 'last_backup_error'").run();

  const keep = backupsToKeep(listBackups(ctx).map((b) => b.day));
  for (const b of listBackups(ctx)) {
    if (!keep.has(b.day)) rmSync(/*turbopackIgnore: true*/ join(dir, b.name), { force: true });
  }
  return final;
}

export function lastBackup(ctx: AppContext): { at: number | null; error: string | null } {
  const get = (key: string) =>
    (ctx.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  const at = get("last_backup_at");
  return { at: at ? Number(at) : null, error: get("last_backup_error") };
}

export function recordBackupError(ctx: AppContext, error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${(error as NodeJS.ErrnoException).code ?? error.message}` : "unknown";
  ctx.db
    .prepare("INSERT INTO meta (key, value) VALUES ('last_backup_error', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(message.slice(0, 200));
}

/** Due when there's been no backup in about a day. */
export function backupDue(ctx: AppContext, now: number): boolean {
  const { at } = lastBackup(ctx);
  return at === null || now - at > 23 * 60 * 60_000;
}
