# MoneyRight plan

A private, multi-user page for balances and an estimated net worth. Hosted
like Outside, reachable only on this Mac and the tailnet, paying for no
services. Credit scores are out of scope; manual balance entry is out.

## Data sources (all free)

| Institution | Route | Why |
| --- | --- | --- |
| Chase | Teller | Bank and card accounts; Teller's free developer tier allows 100 live connections |
| PNC | Teller | Same |
| Upgrade (Cross River) | Teller if listed, else Plaid | Unconfirmed — check each one's link screen |
| Fidelity | Plaid Trial | Teller has no investment accounts |
| Rocket Mortgage | Plaid Trial (Liabilities) | Teller has no loan accounts |
| MOHELA (federal) | Amortization schedule | Plaid dropped federal servicers; no free aggregator covers them |

Plaid's Trial plan allows **10 Items for life** — removing one doesn't free
its slot — so Plaid is kept for what Teller can't do, leaving room for
relinks. Teller requires a client certificate (mTLS), held server-side.

**MOHELA:** enter balance, rate, payment and next due date once; the app
projects the balance month by month. A correction (forbearance, an IDR
change, an extra payment) re-anchors the schedule from that date.

## Phases

1. **Foundation — done.** Scaffold from Outside; launchers with no LAN or
   Funnel; own `moneyright` node; network gate; SQLite with sealed fields;
   accounts with password + TOTP, recovery codes, invites, sessions.
2. **Linking — done.** Teller Connect and Plaid Link; access tokens sealed
   per connection; an in-process refresh (daily, hourly retry) writing daily
   balance snapshots; reconnect via update mode; the Plaid slot counter;
   the MOHELA schedule; the overview: net worth, change since 30 days ago,
   assets vs. owed, accounts by kind, staleness.
3. **History.** Net-worth trend chart from snapshots; per-account history;
   a "what changed" breakdown.
4. **Polish.** Encrypted nightly backups (database + key, kept apart);
   export and delete-my-data; a local `reset-2fa` script for a locked-out
   admin; passkeys as an optional second factor; Home Screen polish.

## Decisions made along the way

- Second factor is TOTP for everyone (works on every device, no extra
  dependency); passkeys may come in phase 4.
- No ORM: `node:sqlite` with hand-written SQL and numbered migrations.
- Dev and production keep separate data directories.
- The dev server skips the authenticator, but only on a database the dev
  server created (stamped in the `meta` table); production always requires it.
