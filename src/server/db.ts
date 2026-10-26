import { DatabaseSync } from "node:sqlite";

/**
 * The SQLite database, through Node's built-in `node:sqlite` — synchronous,
 * no native add-on, one file. One server process owns it; WAL lets a backup
 * read while the app writes.
 *
 * Migrations are an ordered list, applied in a transaction each and counted
 * in `PRAGMA user_version`. Never edit one that has shipped — add the next.
 */

const MIGRATIONS: string[] = [
  // 1: accounts, sign-in, invites.
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    -- Sealed (see lib/sealed.ts); null until the authenticator is set up.
    totp_secret TEXT,
    -- The last TOTP step accepted, so a code can't be used twice.
    totp_last_counter INTEGER,
    created_at INTEGER NOT NULL,
    password_changed_at INTEGER NOT NULL
  );

  CREATE TABLE recovery_codes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

  CREATE TABLE sessions (
    -- SHA-256 of the cookie value; the value itself is never stored.
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('password', 'enroll', 'full')),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT,
    -- The tailnet identity that signed in; the session only works for it.
    tailnet_login TEXT,
    -- A sealed TOTP secret being set up, until its first code confirms it.
    pending_totp_secret TEXT,
    -- Sealed recovery codes, shown until the new account continues past them.
    pending_recovery_codes TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE security_events (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX security_events_user ON security_events(user_id, at);
  `,
  // 2: facts about the database itself — which kind of server made it.
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync) {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (current > MIGRATIONS.length) {
    throw new Error(`Database is at version ${current}, newer than this build knows (${MIGRATIONS.length}).`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Runs `fn` in one transaction, rolled back if it throws. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
