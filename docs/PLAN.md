# MoneyRight plan

A private, multi-user page for balances and an estimated net worth. Hosted
like Outside, reachable only on this Mac and the tailnet, paying for no
services. Credit scores are out of scope; manual balance entry is out.

## Data sources (all free)

| Institution | Route | Why |
| --- | --- | --- |
| Chase | Plaid Trial (Transactions) | Bank and card accounts |
| PNC | Plaid Trial (Transactions) | Same |
| Upgrade (Cross River) | Plaid Trial, if listed | Unconfirmed — check the link screen |
| Fidelity | Plaid Trial (Investments) | |
| Rocket Mortgage | Plaid Trial (Liabilities) | |
| MOHELA (federal) | Amortization schedule | Plaid dropped federal servicers; no free aggregator covers them |

Plaid's Trial plan allows **10 Items for life** — removing one doesn't free
its slot — so links are spent on what matters most.

Banks and cards first went through Teller's free developer tier. Teller shut
down its API in September 2026, so it was removed and Plaid now covers
everything linked.

**MOHELA:** enter balance, rate, payment and next due date once; the app
projects the balance month by month. A correction (forbearance, an IDR
change, an extra payment) re-anchors the schedule from that date.

## Phases

1. **Foundation — done.** Scaffold from Outside; launchers with no LAN or
   Funnel; own `moneyright` node; network gate; SQLite with sealed fields;
   accounts with password + TOTP, recovery codes, invites, sessions.
2. **Linking — done.** Plaid Link (and Teller Connect, until Teller shut
   down); access tokens sealed per connection; an in-process refresh
   (daily, hourly retry) writing daily balance snapshots; reconnect via
   update mode; the Plaid slot counter; the MOHELA schedule; the overview:
   net worth, change since 30 days ago, assets vs. owed, accounts by kind,
   staleness.
3. **History — done.** Net-worth trend chart (30 days / 90 days / 1 year /
   all) with a crosshair tooltip and a table view; per-account history pages;
   "what changed", which keeps newly linked accounts apart from real change
   so linking a brokerage doesn't read as a gain.
4. **Polish — done.** Encrypted nightly backups (14 daily, 12 monthly),
   restorable only with master.key, which is kept apart; `npm run
   moneyright` for backup / restore / reset-2fa / reset-password on this
   Mac; export, remove-financial-data, delete-account and remove-person;
   passkeys as an alternative second step.

## Decisions made along the way

- Every account has TOTP; passkeys are an optional alternative for the
  second step, never a replacement for the password.
- No ORM: `node:sqlite` with hand-written SQL and numbered migrations.
- Dev and production keep separate data directories.
- The dev server skips the authenticator, but only on a database the dev
  server created (stamped in the `meta` table); production always requires it.
