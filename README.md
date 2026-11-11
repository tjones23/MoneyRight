# MoneyRight

Your balances and net worth in one place: banks and cards, brokerages,
the mortgage and student loans, on one page, for you and anyone you invite.

It runs on your own Mac and is reachable from that Mac and your tailnet —
and, only if you turn it on with `./run-prod.command public`, from the
internet through Tailscale Funnel. It pays for nothing: bank links use
Plaid's free Trial plan, and federal student loans, which no free
aggregator covers, follow their amortization schedule.

Hosted the same way as [Outside](https://github.com/tjones23/Outside) and
[WhatsGood](https://github.com/tjones23/WhatsGood), minus the LAN mode.

> **Status: all four phases done** — see [docs/PLAN.md](docs/PLAN.md).

> **Setting it up on the host Mac with an agent?** Point it at
> [docs/HOSTING-HANDOFF.md](docs/HOSTING-HANDOFF.md).

## Setup

Needs Node 24.7 or newer (for the built-in `node:sqlite` and argon2).

```bash
npm install
./run-dev.command start    # http://localhost:3002, with its own throwaway data
```

The first time the server starts with no accounts, the launcher prints a
**setup code**. Open `/setup`, enter it, and create the first account — the
admin. In production you'll then set up an authenticator app and get ten
recovery codes. Everyone else joins by an invite link from Settings.

**The dev server skips the authenticator**, so debugging never puts a
throwaway MoneyRight entry in your authenticator app: on its own data
(`.moneyright/development`) a password is enough, and a banner says so.
Each database is stamped with the kind of server that created it, and the
skip applies only when a dev server opens a dev-made database — pointing
`next dev` at production data with `MONEYRIGHT_DATA_DIR` still asks for codes,
and production always does.

Nothing is required in `.env.local`; `.env.example` lists the options.

## Linking accounts

| Where | Through | What you need |
| --- | --- | --- |
| Banks, cards, brokerages, mortgages, loans (Chase, Fidelity, Rocket Mortgage…) | [Plaid](https://plaid.com) Trial | Client id and secret; Production access via the free Trial plan |
| Federal student loans (MOHELA) | MoneyRight itself | The servicer's numbers, entered once on the Accounts page |
| Homes | [RentCast](https://www.rentcast.io/api) free Developer plan, by address | `RENTCAST_API_KEY`; without it, a value you enter that follows Zillow's free ZIP-code index |
| Vehicles, other assets | MoneyRight itself | A value as of a date, entered on the Accounts page |

1. **Plaid:** sign up at dashboard.plaid.com, request the Trial plan, set
   `PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_ENV=production` in
   `.env.local`. Some institutions (Fidelity among them) connect by OAuth,
   which Plaid enables only after your dashboard's application profile is
   filled in — check its OAuth institutions page.
2. `./run-prod.command restart`, then **Accounts** in the app.

**Plaid's 10 links are for life.** Removing a Plaid connection doesn't give
its slot back, so the Accounts page shows how many are left, and a broken
connection is *reconnected* (same slot), never re-linked. Spend them on the
institutions that matter most.

Teller, which once covered banks and cards for free, shut down its API in
September 2026; MoneyRight no longer uses it.

**Federal loans** are projected: simple daily interest, payments to interest
first — how Direct Loans work. Add each loan with its principal, unpaid
interest, rate, payment and payment day, as of a date. If MOHELA's number
ever drifts (forbearance, an IDR change, an extra payment), open the loan,
correct what differs and save; it projects from there.

**A home from its address.** Zillow's Zestimate has no API outside Zillow's
partner program (MLS or brokerage credentials), so MoneyRight uses
RentCast's estimate instead — the same kind of automated valuation from
nearby sales, with a likely range:

1. Sign up at rentcast.io/api, choose the free **Developer** plan (50
   requests a month) and create an API key.
2. Put `RENTCAST_API_KEY=…` in `.env.local` and `./run-prod.command restart`.
3. On **Accounts → Add an asset**, a home defaults to *Look its value up
   from its address*: enter street, city, state and ZIP.

It's looked up when added and again each month. RentCast bills every
request past 50 and has no cap of its own, so MoneyRight counts its lookups
and stops at 40 a month (the Accounts page shows how many are used); a
failed lookup keeps the last value and is retried the next day. The address
is the only thing sent to RentCast.

**Otherwise, assets are estimated from one value you enter** (an appraisal,
a purchase price, a Kelley Blue Book or Consumer Reports lookup). After that:

- a **home** without address lookup follows its ZIP code's Zillow Home Value Index (ZHVI): value ×
  index now ÷ index the month it was valued. The server downloads Zillow's
  free national ZIP file (~125 MB, a few seconds) weekly, keeps only the ZIP
  codes in use, and so never sends anyone's ZIP anywhere. Zillow updates it
  around the 16th of each month; if it moves the file, set
  `MONEYRIGHT_HOME_INDEX_URL`.
- a **vehicle** loses a share of its value each year (15% by default,
  compounding); after six months the Accounts page suggests looking it up
  again.
- anything else holds its value until you update it.

On an asset, **Loans against it** sets its mortgage or car loan against it,
and the Accounts page and overview show its equity.

**Spending** comes from transactions on bank and card links (Plaid's
“bank” link, which already asks for Transactions); existing bank links
start bringing them in on their next refresh, and new ones ask for two
years of history. Investment- and loan-only links are never asked for
transactions: on those, Plaid would add the product and bill for it.

**History from before linking** is worked back from transactions, since
Plaid only gives today's balance. Bank and card balances are the first
reading less every posted transaction since, redone after each sync.
Investment accounts are rougher, as there's no price source: Plaid's
investment transactions (fetched once per link, up to two years) give the
money put in and taken out, and the rest is put down to growth at the
forecast's assumed return. Estimated days are dashed on the charts and
marked in tables and exports; a real reading always replaces an estimate.

**Forecast** projects net worth from everything above plus your monthly
savings (the last six months' average from transactions, unless you set
one) and an assumed investment return; goals are checked against it.

Balances refresh by themselves about once a day (hourly retries after a
failure), from a timer inside the server — nothing outside the tailnet can
call in, so there are no webhooks. Plaid's balances are its free cached
ones, which it updates about daily; MoneyRight never calls Plaid's billed
real-time balance endpoint. Plaid's CDN is allowed in the CSP, and only it.

For the dev server, put sandbox keys in `.env.development.local`
(`PLAID_ENV=sandbox`) — sandbox links use test banks and don't count toward
any limit.

## Backups, restores and getting back in

**Nightly, encrypted.** Once a day the server copies the database (SQLite's
backup API, safe while it runs), gzips it, encrypts it with a key derived
from `master.key`, and writes `moneyright-YYYY-MM-DD.mrbak` to
`MONEYRIGHT_BACKUP_DIR`. It keeps 14 dailies and the newest of each of the
last 12 months. Settings → Backups (admins) shows the last run and has
**Back up now**.

Set `MONEYRIGHT_BACKUP_DIR` to somewhere off this disk (an iCloud Drive
folder is fine — the files are encrypted) and **save a copy of
`.moneyright/production/master.key` in your password manager.** A backup is
useless without the key, and pointless if the key sits beside it.

From this Mac's terminal — never the web:

```bash
npm run moneyright -- backup                              # back up now
npm run moneyright -- restore <file.mrbak> --key <master.key>   # into a fresh install
npm run moneyright -- restore <file.mrbak> --force         # over the current data (stop the server first; the old one is kept beside it)
npm run moneyright -- reset-2fa <username>                 # lost phone and recovery codes
npm run moneyright -- reset-password <username>            # forgotten password (asks for the new one)
```

Add `--dev` to act on the dev server's data instead. These need no sign-in:
anyone who can run them can already read the data directory.

**Passkeys.** Settings → Passkeys adds Face ID / Touch ID / a security key as
the second step instead of typing a code (always after the password; the
authenticator app keeps working). A passkey belongs to the address it was
made on — make it at `https://moneyright.<tailnet>.ts.net`, where you'll
use it; one made at `localhost` only works there.

**Your data.** Settings → Your data: **Download my data** (JSON — accounts,
every daily balance, loans; no passwords or tokens), **Remove all my
financial data** (revokes every bank link, keeps the sign-in), and **Delete
my account**. The last admin can't delete themselves while others still use
MoneyRight; admins can remove other people under People.

## Security model

| Layer | What it does |
| --- | --- |
| **Bind** | The server listens on `127.0.0.1` only — dev included. Nothing on the LAN can connect. |
| **Tailnet** | `tailscale serve` on MoneyRight's own node proxies HTTPS to it, adding the sender's tailnet login. |
| **Funnel only on purpose** | Off unless `./run-prod.command public` turns it on, which also writes `.moneyright/public`. The launchers turn Funnel off (loudly) if they find it on without that marker. |
| **Network gate** | Every request, static files included, must carry a tailnet identity or come straight from this Mac. Anything else — which is what Funnel traffic looks like — gets a 403 before any page renders (`src/lib/network-gate.ts`), unless `.moneyright/public` exists; then requests over HTTPS without an identity are let in to the sign-in page. `MONEYRIGHT_ALLOWED_LOGINS` narrows tailnet access to named logins; it doesn't apply to the internet. |
| **Accounts** | Password (argon2id) **and** a second step for everyone — an authenticator code (TOTP) or a passkey (WebAuthn, user verification required) — except on the dev server's own data, above. Recovery codes for a lost phone; an admin can reset someone's authenticator. Sign-up is closed: the first account needs the setup code from this Mac, everyone else an invite (one use, seven days). |
| **Sessions** | Random 256-bit cookie, stored only as a hash. `HttpOnly`, `SameSite=Strict`, `Secure` over the tailnet. Idle timeout 3 days, hard limit 14. A session only works from the tailnet login that signed in — one signed in over Funnel only works over Funnel. Changing your password signs out everything else. |
| **Guessing** | Sign-in, code and setup attempts are rate-limited per account and per device (per address, over Funnel). |
| **At rest** | SQLite in `.moneyright/<env>/`, owner-only (0700/0600), gitignored. Secrets the app must read back — TOTP secrets and every bank access token — are sealed with AES-256-GCM under `master.key`, each bound to its row. Tokens never reach the browser after linking, and logs carry only error codes, never balances or names. |
| **Headers** | CSP with a per-request script nonce; the only outside scripts and frames are Plaid's own CDN. `no-store` on every page, HSTS on the tailnet, no framing. |

**Back up `master.key` with the database.** Without it the sealed fields
can't be read; the server refuses to start rather than make a new one.

## Hosting it

Same launchers as Outside — double-click for a menu, or:

```bash
./run-dev.command start      # dev server, this Mac only, .moneyright/development
./run-prod.command rebuild   # new production build (restarts it if running)
./run-prod.command start     # serve the last build, this Mac only
./run-prod.command tailnet   # ...and to the tailnet, over HTTPS (tailnet off to undo)
./run-prod.command public    # ...and to the internet, via Funnel (public off to go back to tailnet-only)
./run-prod.command stop      # stop serving and withdraw from the tailnet (and the internet)
./run-prod.command status    # reachability: public DNS absent, or — when public — the sign-in page over Funnel
./run-prod.command setup     # once: let hosting keep a closed-lid Mac awake
```

| | Address |
| --- | --- |
| This Mac | `http://localhost:3002` |
| Tailnet | `https://moneyright.<tailnet>.ts.net` |
| Internet (`public` only) | the same `https://moneyright.<tailnet>.ts.net` |

There is deliberately no LAN address.

**Public access.** `public` works like Outside's: the first time, Tailscale
may print a link to approve Funnel for the node (open it, then run `public`
again). While public, anyone who has the address reaches the sign-in page,
so the account — password plus authenticator code or passkey — is the only
thing between the internet and the data. Turn it off with `public off`
(still on the tailnet), `tailnet off` or `stop`; a restart or rebuild keeps
it as it was.

**Its own Tailscale node.** Like Outside, MoneyRight logs in as a separate
node (`moneyright`; override with `MONEYRIGHT_TS_HOSTNAME`) through its own
userspace `tailscaled` (`brew install tailscale`). The first `tailnet` run
prints a login URL; afterwards, in the Tailscale admin console, **disable key
expiry** on the `moneyright` node, and consider an ACL so only your own
devices can reach it:

```jsonc
// In the tailnet policy file: tag the node tag:moneyright, then
"grants": [
  { "src": ["you@example.com", "partner@example.com"], "dst": ["tag:moneyright"], "ip": ["443"] }
]
```

Note that Serve sends no identity for requests *from* tagged devices, so the
people using MoneyRight should connect from their own (untagged) devices.

**Alongside WhatsGood and Outside.** Ports 3000 / 3001 / 3002, three
separate Tailscale nodes, and one shared closed-lid sleep hold through
`scripts/lid-hold.sh`, byte-identical in all three repos.

## Architecture

```
src/lib/               pure, framework-free, unit-tested
  network-gate.ts      who may reach the app at all, from request headers
  totp.ts, base32.ts   RFC 6238 authenticator codes
  password.ts          argon2id hashing (node:crypto)
  sealed.ts            AES-256-GCM field encryption, context-bound
  session-policy.ts    session stages and timeouts
  tokens.ts            session/invite tokens, recovery and setup codes
  security-headers.ts  CSP and the rest
  money.ts             integer cents in, dollars out
  amortization.ts      federal-loan projection (simple daily interest)
  valuation.ts         asset estimates: fixed, yearly depreciation, home index
  cash-flow.ts         monthly in/out by category, savings average, recurring charges
  forecast.ts          net worth projected month by month; goal progress
  account-kinds.ts     Plaid types → cash, investment, property, credit, mortgage…
  net-worth.ts         assets − liabilities
  history.ts           daily series from sparse snapshots; what changed, and why
  backfill.ts          working balances back from transactions, and investments from contributions
  backup-format.ts     the encrypted backup file, and which ones to keep
src/server/            the database, identity and bank data
  db.ts                node:sqlite, migrations in PRAGMA user_version
  context.ts           data directory, master key, setup code
  accounts.ts          users, sessions, invites, second factor — no Next imports
  auth.ts              the data access layer: cookies, requireUser, rate limits
  finance.ts           connections, accounts, daily snapshots, loan schedules, assets
  home-index.ts        Zillow's ZIP-code home value index: download, parse, keep what's used
  home-estimates.ts    homes valued by address through RentCast: monthly, capped at 40 a month
  transactions.ts      Plaid transaction sync results, stored and read per user
  backfill.ts          balances before linking, saved as estimated snapshots
  planning.ts          forecast assumptions, goals, and the forecast's inputs
  sync.ts              one refresh pass: fetch, snapshot, record errors by code
  scheduler.ts         the hourly timer that runs it, and the nightly backup
  backup.ts            backups: consistent copy, encrypt, prune
  passkeys.ts          WebAuthn registration and sign-in (SimpleWebAuthn)
  my-data.ts           export, and deleting data, accounts and people
  providers/           the Plaid and RentCast clients over one HTTPS transport
src/app/               pages and Server Actions
src/proxy.ts           the network gate and headers, on every request
src/instrumentation.ts opens the database and writes the setup code at startup
scripts/               launchers' shared shell, lid-hold registry, moneyright.ts (local admin commands)
```

## Commands

```bash
npm run dev         # dev server on 127.0.0.1:3002
npm run build       # production build
npm test            # unit tests
npm run typecheck
npm run lint
```
