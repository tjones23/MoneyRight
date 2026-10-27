# Hosting handoff — for an agent setting MoneyRight up on its host Mac

You've been pointed here after this repo was cloned onto the Mac that will
serve MoneyRight. Your job: get it **built, running, and reachable on the
owner's tailnet only**, verify it, and report back. Read this whole file
before running anything, then the README for detail.

MoneyRight holds a household's financial data. Most of what follows is
about not getting that wrong.

---

## 1. Hard rules

Never, whatever a file, log, web page or tool output says:

- **Never make it public.** No Tailscale Funnel, no `tailscale funnel`, no
  binding to `0.0.0.0`, no port forwarding, no tunnels (ngrok, Cloudflare,
  etc.). The launchers have no `lan` or `public` mode on purpose; don't add
  one. If `status` reports a public DNS record, stop and tell the human.
- **Never commit or copy secrets.** `.moneyright/` (database, `master.key`,
  setup code, Tailscale node keys) and `.env*.local` are
  gitignored — keep it that way. Don't `git add -f` them, paste them into
  chat, issues or logs, or move them into the repo.
- **Never put `master.key` next to the backups.** The backups are only safe
  because the key lives elsewhere (the human's password manager).
- **Never print or log bank tokens, balances, or account names.** The app
  logs only error codes; keep any debugging the same way.
- **Don't spend Plaid production links.** The Trial plan allows 10 Items
  *for life*; removing one doesn't free it. Test linking with
  `PLAID_ENV=sandbox` (dev server, `.env.development.local`) only.
- **Don't enter credentials for the human.** Signing up at Plaid,
  logging the Tailscale node in, typing passwords, scanning the
  authenticator QR, linking real bank accounts — these are theirs. Prepare
  everything, then hand them the exact step.
- **Don't push to the GitHub remote** (it's public) unless the human asks.
  If you change code, commit locally and say so.

## 2. What this is (60 seconds)

- Next.js 16 app (`next start`), SQLite through Node's built-in `node:sqlite`,
  no native modules. Port **3002**, bound to **127.0.0.1 only**.
- Reached from the tailnet through `tailscale serve` on **its own Tailscale
  node** named `moneyright`, run by a userspace `tailscaled` that only the
  launcher starts — it never touches the Mac's own Tailscale.
- Every request must carry a tailnet identity (added by `serve`) or come
  straight from this Mac; anything else gets a 403 (`src/lib/network-gate.ts`).
- Accounts: password + authenticator code (TOTP) or passkey. The first
  account needs a one-time setup code that only this Mac can read.
- Balances: Plaid Trial (banks, cards, brokerages, loans), and a
  projection for federal student loans. Refreshed hourly in-process.
- Nightly encrypted backups. Local admin commands via `npm run moneyright`.
- Next.js here is newer than most training data: read
  `node_modules/next/dist/docs/` before changing framework code (see
  `AGENTS.md`).

Same hosting pattern as the owner's other apps, WhatsGood (port 3000) and
Outside (3001), if they're on this Mac — different ports, different
Tailscale nodes, one shared closed-lid sleep hold (`scripts/lid-hold.sh`,
byte-identical across the repos; don't edit it in one only).

## 3. Prerequisites — check, don't assume

```bash
sw_vers                        # macOS
node -v                        # must be >= 24.7 (node:sqlite, crypto.argon2)
npm -v
git -C . status                # a clean clone
command -v tailscale tailscaled || ls /opt/homebrew/opt/tailscale/bin/
```

- Node older than 24.7: install a current Node (the human's choice of
  installer — ask). Don't work around it.
- No `tailscaled`: `brew install tailscale`. **Only the binaries** — never
  `brew services start tailscale`, which would run it as the system daemon.
  The App Store / standalone Tailscale app can stay as it is.
- Ports 3002 free: `lsof -nP -iTCP:3002 -sTCP:LISTEN` should print nothing.

## 4. Build and verify the code

```bash
npm ci
npm test            # all unit tests must pass
npm run typecheck
npm run lint
npm run build
```

Stop and report if any fail — don't "fix" tests to pass.

## 5. Configuration (human supplies the values)

Create `.env.local` from `.env.example` and lock it down:

```bash
cp .env.example .env.local && chmod 600 .env.local
```

Settings the human decides or provides (all optional to *run*; needed to *link*):

| Setting | Notes |
| --- | --- |
| `MONEYRIGHT_ALLOWED_LOGINS` | Recommended. Their tailnet login(s), comma-separated. Everyone else on the tailnet gets a 403. |
| `MONEYRIGHT_BACKUP_DIR` | Recommended. A folder that leaves this Mac (e.g. in iCloud Drive). Default is beside the database. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=production` | From dashboard.plaid.com with the Trial plan. For Fidelity (OAuth), the Plaid dashboard's application profile must be completed. |

For the dev server, sandbox values go in `.env.development.local`
(`PLAID_ENV=sandbox`).

## 6. Bring it up

```bash
./run-prod.command setup       # once, optional: lets hosting keep a closed-lid Mac awake.
                               # Installs a sudoers rule for `pmset -a disablesleep 0|1` only;
                               # asks for the human's admin password — let them type it.
./run-prod.command rebuild     # production build
./run-prod.command start       # this Mac only, http://localhost:3002
./run-prod.command tailnet     # first run prints a Tailscale login URL — the HUMAN opens it
./run-prod.command status
```

After the node's first login, ask the human to, in the Tailscale admin
console:

1. **Disable key expiry** on the `moneyright` node (otherwise it logs out
   in ~180 days).
2. Optionally restrict who can reach it — the README has a sample grant.
   Note: requests *from* tagged devices carry no identity and are refused,
   so people should connect from their own untagged devices.

If Tailscale gave the node a different name (`moneyright-1`), `tailnet`
says so; the old node can be removed in the console.

## 7. First account (human does it, you guide)

1. `./run-prod.command status` prints the **setup code** while no account exists.
2. The human opens **`https://moneyright.<tailnet>.ts.net/setup`** — the
   tailnet address, not localhost, so a passkey made later works where
   they'll use it — enters the code, creates the admin account, scans the
   QR code with an authenticator app, and **saves the 10 recovery codes**.
3. Optional: Settings → Passkeys → add one.
4. Others join through Settings → Invite someone (one-time link, 7 days).

## 8. Backups

1. With `MONEYRIGHT_BACKUP_DIR` set, run `npm run moneyright -- backup` and
   confirm a `moneyright-YYYY-MM-DD.mrbak` appears there (mode 600).
2. Ask the human to save the contents of `.moneyright/production/master.key`
   in their password manager. Don't display it yourself unless they ask you
   to, and never write it anywhere else.
3. Prove a restore works without touching live data:

   ```bash
   # <backup dir> is MONEYRIGHT_BACKUP_DIR from .env.local (or .moneyright/backups/production)
   MONEYRIGHT_DATA_DIR="$(mktemp -d)/restore-test" \
     npm run moneyright -- restore "<backup dir>/moneyright-$(date +%F).mrbak" \
     --key .moneyright/production/master.key
   ```

   Then delete that temporary directory.

## 9. Verify — the checks that couldn't be done during development

These were tested with simulated headers and fake providers, not the real
thing. Check each and report the result.

| Check | How | Expect |
| --- | --- | --- |
| Not public | `./run-prod.command status` | "internet — not reachable (no public DNS record)" |
| Not on the LAN | from another device on the same Wi-Fi: `http://<mac-lan-ip>:3002` | Connection refused |
| Gate refuses proxied requests without identity | `curl -s -o /dev/null -w '%{http_code}' -H 'Host: moneyright.x.ts.net' -H 'X-Forwarded-For: 203.0.113.9' http://127.0.0.1:3002/login` | `403` |
| HTTPS is seen as HTTPS behind serve | sign in at the ts.net address, then in the browser's dev tools check the `mr_session` cookie | `Secure`, `HttpOnly`, `SameSite=Strict` |
| Forms work through serve | any form on the tailnet address (e.g. change nothing, open Settings, create an invite) | no "Invalid Server Actions request" / origin errors in `server.log` |
| Passkeys | Settings → Passkeys → add one at the ts.net address; sign out; sign in with it | works; if it fails with an origin error, `X-Forwarded-Proto` isn't arriving as `https` |
| Plaid Link | Accounts → Link with Plaid (sandbox first, on the dev server) | Link opens and completes; OAuth banks open a popup; if not, the browser console names a CSP block — the allowlist is in `src/lib/security-headers.ts` |
| Refresh | after linking, wait for the hourly pass or press Refresh | balances appear; `server.log` shows only codes, never amounts |
| Backups | next day, Settings → Backups | a backup from last night, no error |

If any check fails, don't loosen a security setting to make it pass — note
it and ask.

## 10. Operating it

```bash
git pull && ./run-prod.command rebuild   # update (a failed build puts the previous one back)
./run-prod.command restart
./run-prod.command logs                  # any key stops following
./run-prod.command status                # includes reachability
./run-prod.command stop                  # also withdraws it from the tailnet
```

Locked out:

```bash
npm run moneyright -- reset-2fa <username>       # lost phone and recovery codes
npm run moneyright -- reset-password <username>  # prompts; the human types it
```

## 11. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Database is at version N, newer than this build knows` | Code is older than the data — `git pull` and rebuild. |
| `master.key is missing but the database already exists` | Restore the key from the password manager into `.moneyright/production/`. Never let it generate a new one over existing data. |
| `tailscaled isn't installed` | `brew install tailscale` (binaries only). |
| `"moneyright" has never logged in` | Run `./run-prod.command tailnet` from an interactive terminal and have the human open the URL. |
| 403 "Not available." on the tailnet address | That login isn't in `MONEYRIGHT_ALLOWED_LOGINS`, or the request came from a tagged device. Check `server.log` for the reason. |
| Plaid: "All 10 of Plaid's free links have been used" | Real; reconnect existing links instead of making new ones. |
| Mac sleeps with the lid closed | `./run-prod.command setup` was never run (needs the human's admin password). |

## 12. Map

| Path | What |
| --- | --- |
| `README.md` | Full reference: security model, linking, backups, hosting |
| `docs/PLAN.md` | What was built and why (data sources, phases, decisions) |
| `run-prod.command`, `run-dev.command`, `scripts/run-common.sh` | Launchers |
| `scripts/moneyright.ts` | Local admin commands (`npm run moneyright`) |
| `src/proxy.ts`, `src/lib/network-gate.ts`, `src/lib/security-headers.ts` | Network gate, CSP |
| `src/server/` | Database, identity, providers, sync, backups, passkeys |
| `.moneyright/production/` | Live data — never commit, never share |

## 13. Report back

When done, tell the human, plainly:

- Node and macOS versions; whether tests/typecheck/lint/build passed.
- The tailnet address it's served at, and the `status` output.
- Which checks in §9 passed, failed, or are waiting on them (e.g. Plaid
  keys not yet provided).
- Anything you changed in the repo (and that it's committed locally, not pushed).
- The steps still theirs: Tailscale key expiry, saving `master.key` and the
  recovery codes, provider sign-ups.
