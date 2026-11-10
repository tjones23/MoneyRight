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
  // 4: passkeys, as an alternative to the authenticator code.
  `
  CREATE TABLE passkeys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- base64url credential id, from the authenticator.
    credential_id TEXT NOT NULL UNIQUE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    -- The host it was made on: a passkey for the tailnet name doesn't work on localhost.
    rp_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX passkeys_user ON passkeys(user_id);

  -- The WebAuthn challenge in flight for this session, and when it was issued.
  ALTER TABLE sessions ADD COLUMN webauthn_challenge TEXT;
  ALTER TABLE sessions ADD COLUMN webauthn_challenge_at INTEGER;
  `,
  // 5: homes, vehicles and other things owned, valued from one known point.
  `
  CREATE TABLE asset_valuations (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    value_cents INTEGER NOT NULL,
    as_of TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('fixed', 'depreciation', 'home_index')),
    -- Depreciation per year in hundredths of a percent; 0 unless method is depreciation.
    annual_rate_bps INTEGER NOT NULL DEFAULT 0,
    -- Five-digit ZIP code, for the home value index.
    zip TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Zillow's home value index, monthly, for the ZIP codes someone has a home in.
  CREATE TABLE home_value_index (
    zip TEXT NOT NULL,
    month TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (zip, month)
  );
  `,
  // 6: equity (loans against assets), transactions, the forecast and goals.
  `
  -- Each loan secures at most one asset; an asset may have several (a mortgage and a HELOC).
  CREATE TABLE asset_loans (
    loan_account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    asset_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX asset_loans_asset ON asset_loans(asset_account_id);

  -- The Item's products, from /item/get, comma-separated: transactions are only
  -- fetched for an Item that already has them, since asking adds (and bills) the product.
  ALTER TABLE connections ADD COLUMN products TEXT;
  ALTER TABLE connections ADD COLUMN transactions_cursor TEXT;
  ALTER TABLE connections ADD COLUMN transactions_synced_at INTEGER;

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- Plaid's transaction id.
    external_id TEXT NOT NULL UNIQUE,
    day TEXT NOT NULL,
    -- Plaid's sign: positive is money out of the account, negative money in.
    amount_cents INTEGER NOT NULL,
    name TEXT NOT NULL,
    merchant TEXT,
    -- Plaid's personal finance category, primary and detailed.
    category TEXT,
    category_detailed TEXT,
    pending INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX transactions_account_day ON transactions(account_id, day);

  CREATE TABLE forecast_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Yearly growth assumed for investments, in hundredths of a percent.
    investment_return_bps INTEGER NOT NULL,
    -- Monthly savings added to cash; null means the recent average from transactions.
    monthly_savings_cents INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE goals (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Null for a net-worth goal; otherwise one account's balance (or, for a debt, what's owed).
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_cents INTEGER NOT NULL,
    target_date TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX goals_user ON goals(user_id);
  `,
  // 7: a home valued from its address (RentCast's estimate). SQLite can't
  // change a CHECK in place, so the table is rebuilt with the new method.
  `
  CREATE TABLE asset_valuations_new (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    value_cents INTEGER NOT NULL,
    as_of TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('fixed', 'depreciation', 'home_index', 'address')),
    annual_rate_bps INTEGER NOT NULL DEFAULT 0,
    zip TEXT,
    updated_at INTEGER NOT NULL,
    -- For method address: what was entered, and the last estimate's range and outcome.
    address TEXT,
    estimate_low_cents INTEGER,
    estimate_high_cents INTEGER,
    estimate_attempt_at INTEGER,
    estimate_error TEXT
  );
  INSERT INTO asset_valuations_new (account_id, value_cents, as_of, method, annual_rate_bps, zip, updated_at)
    SELECT account_id, value_cents, as_of, method, annual_rate_bps, zip, updated_at FROM asset_valuations;
  DROP TABLE asset_valuations;
  ALTER TABLE asset_valuations_new RENAME TO asset_valuations;
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
