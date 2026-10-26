# MoneyRight

Your balances and net worth in one place: banks and cards, brokerages,
the mortgage and student loans, on one page, for you and anyone you invite.

It runs on your own Mac and is reachable only from that Mac and your
tailnet — never the public internet. It pays for nothing: bank links use
free developer tiers (Teller, Plaid's Trial plan), and federal student loans,
which no free aggregator covers, follow their amortization schedule.

Hosted the same way as [Outside](https://github.com/tjones23/Outside) and
[WhatsGood](https://github.com/tjones23/WhatsGood), minus everything that
would make it public.

> **Status: phase 1 of 4.** Accounts, sign-in and tailnet-only hosting are
> done. Linking accounts comes next — see [docs/PLAN.md](docs/PLAN.md).

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

## Security model

| Layer | What it does |
| --- | --- |
| **Bind** | The server listens on `127.0.0.1` only — dev included. Nothing on the LAN can connect. |
| **Tailnet** | `tailscale serve` on MoneyRight's own node proxies HTTPS to it, adding the sender's tailnet login. |
| **No Funnel** | The launchers have no `public` command, and turn Funnel off (loudly) if they ever find it on. |
| **Network gate** | Every request, static files included, must carry a tailnet identity or come straight from this Mac. Anything else — which is what Funnel traffic would look like — gets a 403 before any page renders (`src/lib/network-gate.ts`). `MONEYRIGHT_ALLOWED_LOGINS` narrows it to named tailnet logins. |
| **Accounts** | Password (argon2id) **and** an authenticator code (TOTP) for everyone (except on the dev server's own data, above). Recovery codes for a lost phone; an admin can reset someone's authenticator. Sign-up is closed: the first account needs the setup code from this Mac, everyone else an invite (one use, seven days). |
| **Sessions** | Random 256-bit cookie, stored only as a hash. `HttpOnly`, `SameSite=Strict`, `Secure` over the tailnet. Idle timeout 3 days, hard limit 14. A session only works from the tailnet login that signed in. Changing your password signs out everything else. |
| **Guessing** | Sign-in, code and setup attempts are rate-limited per account and per device. |
| **At rest** | SQLite in `.moneyright/<env>/`, owner-only (0700/0600), gitignored. Secrets the app must read back (TOTP secrets now, bank tokens later) are sealed with AES-256-GCM under `master.key`. FileVault covers the rest. |
| **Headers** | Strict CSP with a per-request nonce, nothing loaded from anywhere but itself, `no-store` on every page, HSTS on the tailnet, no framing. |

**Back up `master.key` with the database.** Without it the sealed fields
can't be read; the server refuses to start rather than make a new one.

## Hosting it

Same launchers as Outside — double-click for a menu, or:

```bash
./run-dev.command start      # dev server, this Mac only, .moneyright/development
./run-prod.command rebuild   # new production build (restarts it if running)
./run-prod.command start     # serve the last build, this Mac only
./run-prod.command tailnet   # ...and to the tailnet, over HTTPS (tailnet off to undo)
./run-prod.command stop      # stop serving and withdraw from the tailnet
./run-prod.command status    # includes a check that it is *not* on public DNS
./run-prod.command setup     # once: let hosting keep a closed-lid Mac awake
```

| | Address |
| --- | --- |
| This Mac | `http://localhost:3002` |
| Tailnet | `https://moneyright.<tailnet>.ts.net` |

There is deliberately no LAN address and no public address.

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
src/server/            the database and everything about identity
  db.ts                node:sqlite, migrations in PRAGMA user_version
  context.ts           data directory, master key, setup code
  accounts.ts          users, sessions, invites, second factor — no Next imports
  auth.ts              the data access layer: cookies, requireUser, rate limits
src/app/               pages and Server Actions
src/proxy.ts           the network gate and headers, on every request
src/instrumentation.ts opens the database and writes the setup code at startup
scripts/               launchers' shared shell, lid-hold registry
```

## Commands

```bash
npm run dev         # dev server on 127.0.0.1:3002
npm run build       # production build
npm test            # unit tests
npm run typecheck
npm run lint
```
