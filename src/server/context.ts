import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "./db";
import { KEY_BYTES } from "@/lib/sealed";
import { newSetupCode } from "@/lib/tokens";

/**
 * Where MoneyRight keeps its state, and the one open database.
 *
 *   .moneyright/production/   what `next start` uses
 *   .moneyright/development/  what `next dev` uses — so trying things out
 *                             never touches real data
 *
 * (The turbopackIgnore comments tell the build these paths are data, not
 * source, so it doesn't trace the whole project into the server output.)
 *
 * Each holds `moneyright.db`, its `master.key` (unless MONEYRIGHT_MASTER_KEY
 * is set), and, until the first account exists, `setup-code`. All are owner
 * read/write only. The directory is gitignored; FileVault covers it at rest.
 */

export type Environment = "production" | "development";

export interface AppContext {
  db: DatabaseSync;
  key: Buffer;
  dataDir: string;
  /**
   * Whether signing in takes an authenticator code. Always, except on the
   * dev server with a database the dev server itself made — so debugging
   * needs no authenticator entry, and pointing `next dev` at production data
   * (MONEYRIGHT_DATA_DIR) still asks for codes.
   */
  secondFactorRequired: boolean;
}

export function currentEnvironment(): Environment {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export function defaultDataDir(env: Environment): string {
  return join(process.cwd(), ".moneyright", env);
}

export function dataDir(): string {
  return process.env.MONEYRIGHT_DATA_DIR || defaultDataDir(currentEnvironment());
}

/**
 * Which kind of server made this database, stamped once and never changed.
 * A database from before the stamp existed counts as development only if it
 * sits in the dev server's own default directory; anything else, production.
 */
export function databaseEnvironment(db: DatabaseSync, dir: string, env: Environment, isNew: boolean): Environment {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'environment'").get() as { value: string } | undefined;
  if (row) return row.value === "development" ? "development" : "production";
  const stamped: Environment =
    env === "development" && (isNew || dir === defaultDataDir("development")) ? "development" : "production";
  db.prepare("INSERT INTO meta (key, value) VALUES ('environment', ?)").run(stamped);
  return stamped;
}

/**
 * The key is made once, alongside a brand-new database. A database that
 * exists without its key is an error, not a fresh start: a new key would
 * leave every sealed value in it unreadable.
 */
export function loadMasterKey(dir: string, databaseIsNew: boolean): Buffer {
  const fromEnv = process.env.MONEYRIGHT_MASTER_KEY;
  if (fromEnv) return checkKey(Buffer.from(fromEnv, "base64"), "MONEYRIGHT_MASTER_KEY");

  const path = join(dir, "master.key");
  if (existsSync(/*turbopackIgnore: true*/ path)) return checkKey(Buffer.from(readFileSync(/*turbopackIgnore: true*/ path, "utf8").trim(), "base64"), path);
  if (!databaseIsNew) {
    throw new Error(`${path} is missing but the database already exists — restore the key from a backup.`);
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(/*turbopackIgnore: true*/ path, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  return key;
}

function checkKey(key: Buffer, where: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error(`${where} must hold ${KEY_BYTES} bytes, base64.`);
  return key;
}

export function createContext(dir: string, env: Environment = currentEnvironment()): AppContext {
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true, mode: 0o700 });
  chmodSync(/*turbopackIgnore: true*/ dir, 0o700);
  const dbPath = join(dir, "moneyright.db");
  const databaseIsNew = !existsSync(/*turbopackIgnore: true*/ dbPath);
  const key = loadMasterKey(dir, databaseIsNew);
  const db = openDatabase(dbPath);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(/*turbopackIgnore: true*/ dbPath + suffix)) chmodSync(/*turbopackIgnore: true*/ dbPath + suffix, 0o600);
  }
  const madeBy = databaseEnvironment(db, dir, env, databaseIsNew);
  return { db, key, dataDir: dir, secondFactorRequired: !(env === "development" && madeBy === "development") };
}

// One per server process. Kept on globalThis so dev-mode hot reloads reuse it
// instead of opening the file again on every edit.
const globalForContext = globalThis as unknown as { __moneyright?: AppContext };

export function appContext(): AppContext {
  const existing = globalForContext.__moneyright;
  if (!existing) return (globalForContext.__moneyright = createContext(dataDir()));
  // A hot reload can bring new migrations into a database opened before them.
  if (process.env.NODE_ENV === "development") migrate(existing.db);
  return existing;
}

// ---------------------------------------------------------------------------
// The setup code
//
// Until the first account exists, anyone who can reach the sign-in page could
// claim it. So creating it takes a code that only this Mac can read: written
// to the data directory at startup, printed by the launcher, deleted once
// used.
// ---------------------------------------------------------------------------

export function setupCodePath(dir: string): string {
  return join(dir, "setup-code");
}

export function hasUsers(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM users LIMIT 1").get() !== undefined;
}

/** Writes a setup code if there are no accounts and no code yet; returns the code in effect. */
export function ensureSetupCode(ctx: AppContext): string | null {
  const path = setupCodePath(ctx.dataDir);
  if (hasUsers(ctx.db)) {
    rmSync(/*turbopackIgnore: true*/ path, { force: true });
    return null;
  }
  if (existsSync(/*turbopackIgnore: true*/ path)) return readFileSync(/*turbopackIgnore: true*/ path, "utf8").trim();
  const code = newSetupCode();
  writeFileSync(/*turbopackIgnore: true*/ path, code + "\n", { mode: 0o600 });
  return code;
}

export function readSetupCode(ctx: AppContext): string | null {
  const path = setupCodePath(ctx.dataDir);
  return existsSync(/*turbopackIgnore: true*/ path) ? readFileSync(/*turbopackIgnore: true*/ path, "utf8").trim() : null;
}

export function clearSetupCode(ctx: AppContext) {
  rmSync(/*turbopackIgnore: true*/ setupCodePath(ctx.dataDir), { force: true });
}
