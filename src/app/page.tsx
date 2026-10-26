import Link from "next/link";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { balancesOn, firstBalanceDay, listAccounts, listConnections } from "@/server/finance";
import { isLiability, KIND_LABEL } from "@/lib/account-kinds";
import { addDays, daysBetween, todayKey } from "@/lib/local-date";
import { formatCents, formatChange } from "@/lib/money";
import { groupByKind, netWorth } from "@/lib/net-worth";

/** The overview: net worth, then every account by kind. */

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function formatDay(key: string) {
  return dayFormat.format(new Date(`${key}T12:00:00Z`));
}

function staleness(day: string | null, today: string): string | null {
  if (!day) return "no balance yet";
  const age = daysBetween(day, today);
  if (age <= 1) return null;
  return `as of ${formatDay(day)}`;
}

export default async function OverviewPage() {
  const { user } = await requireUser();
  const { db } = appContext();
  const today = todayKey();
  const accounts = listAccounts(db, user.id).filter((a) => !a.gone);
  const connections = listConnections(db, user.id);
  const broken = connections.filter((c) => c.status === "reconnect");

  if (accounts.length === 0) {
    return (
      <>
        <SiteHeader user={user} />
        <PageBody title={`Hi, ${user.displayName}`} subtitle="Your balances and net worth will live here.">
          <section className="rounded-2xl border border-dashed border-line p-6 text-sm text-muted">
            <p className="font-medium text-text">No accounts yet</p>
            <p className="mt-2">Link your banks, cards, brokerages and loans, and add your federal student loans.</p>
            <Link href="/accounts" className="mt-4 inline-block rounded-full bg-accent px-4 py-2 font-medium text-accent-ink">
              Add accounts
            </Link>
          </section>
        </PageBody>
      </>
    );
  }

  const total = netWorth(accounts);
  // Change over 30 days, or since the first balance if that's more recent.
  const first = firstBalanceDay(db, user.id);
  const since = first && daysBetween(first, today) > 0 ? (daysBetween(first, today) >= 30 ? addDays(today, -30) : first) : null;
  const then = since ? netWorth(balancesOn(db, user.id, since)) : null;

  return (
    <>
      <SiteHeader user={user} />
      <PageBody title="Net worth">
        <section className="rounded-2xl border border-line bg-surface p-6">
          <p className="text-4xl font-bold tracking-tight tabular-nums sm:text-5xl">{formatCents(total.netWorthCents, { whole: true })}</p>
          {then && (
            <p className={`mt-2 text-sm tabular-nums ${total.netWorthCents >= then.netWorthCents ? "text-good" : "text-danger"}`}>
              {formatChange(total.netWorthCents - then.netWorthCents)}{" "}
              <span className="text-muted">since {formatDay(since!)}</span>
            </p>
          )}
          <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted">Assets</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">{formatCents(total.assetsCents, { whole: true })}</dd>
            </div>
            <div>
              <dt className="text-muted">Owed</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">{formatCents(total.liabilitiesCents, { whole: true })}</dd>
            </div>
          </dl>
          {total.missing > 0 && (
            <p className="mt-4 text-xs text-muted">
              {total.missing} account{total.missing === 1 ? " has" : "s have"} no balance yet and {total.missing === 1 ? "isn't" : "aren't"} in the total.
            </p>
          )}
        </section>

        {broken.length > 0 && (
          <Link
            href="/accounts"
            className="block rounded-2xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger hover:bg-danger/15"
          >
            {broken.map((c) => c.institutionName).join(", ")} {broken.length === 1 ? "needs" : "need"} you to sign in again —
            their balances are frozen until then. Reconnect →
          </Link>
        )}

        {groupByKind(accounts).map((group) => {
          const counted = group.items.filter((a) => a.includeInNetWorth && a.balanceCents !== null);
          const sum = counted.reduce((n, a) => n + a.balanceCents!, 0);
          return (
            <section key={group.kind} className="rounded-2xl border border-line bg-surface p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-semibold">{KIND_LABEL[group.kind]}</h2>
                <span className="tabular-nums text-muted">
                  {isLiability(group.kind) ? "−" : ""}
                  {formatCents(sum)}
                </span>
              </div>
              <ul className="mt-3 divide-y divide-line-soft text-sm">
                {group.items.map((a) => {
                  const note = staleness(a.balanceDay, today);
                  return (
                    <li key={a.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className={a.includeInNetWorth ? "" : "text-muted"}>
                          {a.name}
                          {a.mask && <span className="text-muted"> ··{a.mask}</span>}
                        </p>
                        <p className="text-xs text-muted">
                          {a.institutionName}
                          {a.source === "schedule" && " · projected"}
                          {!a.includeInNetWorth && " · not counted"}
                          {note && ` · ${note}`}
                        </p>
                      </div>
                      <span className="tabular-nums">{a.balanceCents === null ? "—" : formatCents(a.balanceCents)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </PageBody>
    </>
  );
}
