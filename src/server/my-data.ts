import type { Ctx } from "./accounts";
import { AccountError, getUser, listUsers, logEvent, recentEvents } from "./accounts";
import { transaction } from "./db";
import { listAccounts, listConnections, listScheduledLoans, snapshots } from "./finance";
import { listPasskeys } from "./passkeys";
import { revokeConnection, type Providers } from "./sync";
import { verifyPassword } from "@/lib/password";
import { todayKey } from "@/lib/local-date";

/**
 * A person's own data: all of it out, or all of it gone.
 *
 * The export carries no secrets — no password hash, authenticator secret,
 * recovery codes or bank tokens — only what the person could see in the app.
 */

export function exportUserData(ctx: Ctx, userId: number) {
  const user = getUser(ctx.db, userId);
  if (!user) throw new AccountError("No such account.");
  return {
    format: "moneyright-export-v1",
    exportedAt: new Date().toISOString(),
    account: { username: user.username, displayName: user.displayName, isAdmin: user.isAdmin },
    connections: listConnections(ctx.db, userId).map((c) => ({
      provider: c.provider,
      institution: c.institutionName,
      status: c.status,
      linkedAt: new Date(c.createdAt).toISOString(),
    })),
    accounts: listAccounts(ctx.db, userId).map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institutionName,
      kind: a.kind,
      mask: a.mask,
      source: a.source,
      countedInNetWorth: a.includeInNetWorth,
      noLongerReported: a.gone,
    })),
    balances: snapshots(ctx.db, userId, todayKey()).map((s) => ({
      accountId: s.accountId,
      day: s.day,
      balance: s.balanceCents / 100,
    })),
    loanSchedules: listScheduledLoans(ctx.db, userId).map((l) => ({
      accountId: l.accountId,
      name: l.name,
      servicer: l.servicer,
      principal: l.schedule.principalCents / 100,
      unpaidInterest: l.schedule.accruedInterestCents / 100,
      ratePercent: l.schedule.annualRateBps / 100,
      monthlyPayment: l.schedule.monthlyPaymentCents / 100,
      paymentDay: l.schedule.paymentDay,
      asOf: l.schedule.anchorDate,
    })),
    passkeys: listPasskeys(ctx.db, userId).map((p) => ({ name: p.name, host: p.rpId, addedAt: new Date(p.createdAt).toISOString() })),
    securityEvents: recentEvents(ctx.db, userId, 1000).map((e) => ({ at: new Date(e.at).toISOString(), event: e.event, detail: e.detail })),
  };
}

/** Revokes every bank link and deletes all accounts, balances and loans — the login stays. */
export async function deleteFinancialData(ctx: Ctx, providers: Providers, userId: number, now: number) {
  for (const connection of listConnections(ctx.db, userId)) await revokeConnection(ctx, providers, connection);
  transaction(ctx.db, () => {
    ctx.db.prepare("DELETE FROM connections WHERE user_id = ?").run(userId);
    ctx.db.prepare("DELETE FROM accounts WHERE user_id = ?").run(userId);
    logEvent(ctx.db, userId, "financial-data-deleted", now);
  });
}

/**
 * Whether this account may be deleted: never the last admin while other
 * people still use MoneyRight — they'd be left with no one to invite or reset.
 */
export function deletionProblem(ctx: Ctx, userId: number): string | null {
  const users = listUsers(ctx.db);
  const me = users.find((u) => u.id === userId);
  if (!me) return "No such account.";
  const otherAdmins = users.filter((u) => u.isAdmin && u.id !== userId);
  if (me.isAdmin && users.length > 1 && otherAdmins.length === 0) {
    return "You're the only admin. Remove the other people first (Settings → People).";
  }
  return null;
}

/** Deletes the person entirely: their bank links revoked, every row of theirs gone. */
export async function deleteUser(ctx: Ctx, providers: Providers, userId: number) {
  for (const connection of listConnections(ctx.db, userId)) await revokeConnection(ctx, providers, connection);
  // Everything else hangs off users with ON DELETE CASCADE.
  ctx.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export async function deleteOwnAccount(ctx: Ctx, providers: Providers, userId: number, password: string) {
  const row = ctx.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string } | undefined;
  if (!row || !(await verifyPassword(password, row.password_hash))) throw new AccountError("That password isn't right.");
  const problem = deletionProblem(ctx, userId);
  if (problem) throw new AccountError(problem);
  await deleteUser(ctx, providers, userId);
}

/** An admin removes someone else, typing their username to confirm. */
export async function removePerson(ctx: Ctx, providers: Providers, adminId: number, userId: number, typed: string, now: number) {
  const admin = getUser(ctx.db, adminId);
  const person = getUser(ctx.db, userId);
  if (!admin?.isAdmin) throw new AccountError("Only an admin can remove people.");
  if (!person || person.id === adminId) throw new AccountError("Remove your own account from the section below instead.");
  if (typed.trim().toLowerCase() !== person.username) throw new AccountError(`Type “${person.username}” to confirm.`);
  await deleteUser(ctx, providers, userId);
  logEvent(ctx.db, adminId, "person-removed", now, person.username);
}
