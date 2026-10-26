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
  // 3: linked institutions, their accounts, daily balances, loan schedules.
  `
  CREATE TABLE connections (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('teller', 'plaid')),
    -- Teller's enrollment id, or Plaid's item id.
    external_id TEXT NOT NULL,
    institution_name TEXT NOT NULL,
    -- Sealed (lib/sealed.ts), bound to provider and external id.
    access_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'reconnect', 'error')),
    -- The provider's error code when status isn't ok; never a message with data in it.
    status_code TEXT,
    last_synced_at INTEGER,
    last_attempt_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (provider, external_id)
  );
  CREATE INDEX connections_user ON connections(user_id);

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Null for an account MoneyRight works out itself (a loan schedule).
    connection_id INTEGER REFERENCES connections(id) ON DELETE CASCADE,
    external_id TEXT,
    name TEXT NOT NULL,
    institution_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    subtype TEXT,
    mask TEXT,
    currency TEXT NOT NULL DEFAULT 'USD',
    include_in_net_worth INTEGER NOT NULL DEFAULT 1,
    -- The provider stopped returning it (closed, or deselected).
    gone INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (connection_id, external_id)
  );
  CREATE INDEX accounts_user ON accounts(user_id);

  -- One balance per account per day, the day's last reading winning.
  CREATE TABLE balance_snapshots (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    balance_cents INTEGER NOT NULL,
    available_cents INTEGER,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, day)
  );

  CREATE TABLE loan_schedules (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    principal_cents INTEGER NOT NULL,
    accrued_interest_cents INTEGER NOT NULL DEFAULT 0,
    annual_rate_bps INTEGER NOT NULL,
    monthly_payment_cents INTEGER NOT NULL,
    payment_day INTEGER NOT NULL CHECK (payment_day BETWEEN 1 AND 31),
    anchor_date TEXT NOT NULL,
    updated_at INTEGER NOT NULL
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
