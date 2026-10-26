/**
 * MoneyRight's local admin commands — for this Mac's terminal only, never
 * the web. Whoever can run these can already read the data directory, so
 * they need no sign-in.
 *
 *   npm run moneyright -- backup                  # back up now
 *   npm run moneyright -- restore <file> [--key <master.key>] [--force]
 *   npm run moneyright -- reset-2fa <username>    # clear a lost authenticator
 *   npm run moneyright -- reset-password <username>
 *
 * Production data by default; add --dev for the dev server's.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createContext, defaultDataDir, type Environment } from "../src/server/context";
import { transaction } from "../src/server/db";
import { logEvent } from "../src/server/accounts";
import { makeBackup } from "../src/server/backup";
import { decryptBackup } from "../src/lib/backup-format";
import { hashPassword, passwordProblem } from "../src/lib/password";
import { normalizeUsername } from "../src/lib/session-policy";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--key"));
const [command, target] = positional;

const env: Environment = flag("--dev") ? "development" : "production";
const dir = process.env.MONEYRIGHT_DATA_DIR || defaultDataDir(env);

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function open() {
  if (!existsSync(join(dir, "moneyright.db"))) fail(`No database at ${dir}. (--dev for the dev server's.)`);
  return createContext(dir, env);
}

function findUser(db: DatabaseSync, username: string) {
  const user = db.prepare("SELECT id, display_name FROM users WHERE username = ?").get(normalizeUsername(username)) as
    | { id: number; display_name: string }
    | undefined;
  if (!user) fail(`No account named "${username}".`);
  return user;
}

/** Reads a line without echoing it. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      write.call(rl, s.startsWith(prompt) ? prompt : "");
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  switch (command) {
    case "backup": {
      const ctx = open();
      const path = await makeBackup(ctx, Date.now());
      console.log(`✓ Backed up to ${path}`);
      return;
    }

    case "restore": {
      if (!target) fail("Which backup? npm run moneyright -- restore <file>");
      const keyPath = option("--key") ?? join(dir, "master.key");
      if (!existsSync(keyPath)) fail(`No master.key at ${keyPath}. Pass --key <path> to the one you saved.`);
      const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
      const database = decryptBackup(key, readFileSync(target));

      const dbPath = join(dir, "moneyright.db");
      if (existsSync(dbPath) && !flag("--force")) {
        fail(`${dbPath} exists. Stop the server, then re-run with --force — the current database is kept beside it.`);
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (existsSync(dbPath)) {
        const aside = `${dbPath}.before-restore-${Date.now()}`;
        renameSync(dbPath, aside);
        for (const suffix of ["-wal", "-shm"]) if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, aside + suffix);
        console.log(`  The previous database is at ${aside}`);
      }
      writeFileSync(dbPath, database, { mode: 0o600 });
      if (keyPath !== join(dir, "master.key")) copyFileSync(keyPath, join(dir, "master.key"));
      // Opening it checks it's whole and brings it up to this build's schema.
      createContext(dir, env).db.close();
      console.log(`✓ Restored ${target} into ${dir}. Start the server.`);
      return;
    }

    case "reset-2fa": {
      if (!target) fail("Whose? npm run moneyright -- reset-2fa <username>");
      const { db } = open();
      const user = findUser(db, target);
      transaction(db, () => {
        db.prepare("UPDATE users SET totp_secret = NULL, totp_last_counter = NULL WHERE id = ?").run(user.id);
        db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(user.id);
        db.prepare("DELETE FROM passkeys WHERE user_id = ?").run(user.id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
        logEvent(db, user.id, "authenticator-reset", Date.now(), "from this Mac's terminal");
      });
      console.log(`✓ ${user.display_name}'s authenticator, recovery codes and passkeys are cleared, and they're signed out.`);
      console.log("  They set up a new authenticator at their next sign-in.");
      return;
    }

    case "reset-password": {
      if (!target) fail("Whose? npm run moneyright -- reset-password <username>");
      const { db } = open();
      const user = findUser(db, target);
      const password = await askHidden(`New password for ${user.display_name}: `);
      const problem = passwordProblem(password);
      if (problem) fail(problem);
      if ((await askHidden("Again: ")) !== password) fail("They don't match.");
      const hash = await hashPassword(password);
      transaction(db, () => {
        db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(hash, Date.now(), user.id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
        logEvent(db, user.id, "password-changed", Date.now(), "from this Mac's terminal");
      });
      console.log(`✓ Password changed, and ${user.display_name} is signed out everywhere.`);
      return;
    }

    default: {
      const header = readFileSync(new URL(import.meta.url), "utf8").split("*/")[0];
      console.log(header.replace(/^\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
      if (command) process.exit(1);
    }
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
