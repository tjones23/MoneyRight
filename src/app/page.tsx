import Link from "next/link";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { HistoryTable, RangeFilter } from "@/components/History";
import { TrendChart } from "@/components/TrendChart";
import { firstBalanceDay, listAccounts, listConnections, snapshots } from "@/server/finance";
import { isLiability, KIND_LABEL } from "@/lib/account-kinds";
import { changes, netWorthSeries, parseRange, rangeStart } from "@/lib/history";
import { daysBetween, todayKey } from "@/lib/local-date";
import { formatCents, formatChange } from "@/lib/money";
import { groupByKind, netWorth } from "@/lib/net-worth";

/** The overview: net worth and its trend, what moved it, then every account by kind. */

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

export default async function OverviewPage({ searchParams }: PageProps<"/">) {
  const { user } = await requireUser();
  const { db } = appContext();
  const today = todayKey();
  const range = parseRange((await searchParams).range);
  const everyAccount = listAccounts(db, user.id);
  const accounts = everyAccount.filter((a) => !a.gone);
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
  const from = rangeStart(range, today, firstBalanceDay(db, user.id));
  const history = snapshots(db, user.id, today);
  const series = netWorthSeries(everyAccount, history, from, today);
  const moved = daysBetween(from, today) > 0 ? changes(everyAccount, history, from, today) : null;
  const names = new Map(everyAccount.map((a) => [a.id, a]));
  const movers = moved?.accounts.filter((c) => c.effectCents !== 0).slice(0, 8) ?? [];

  return (
    <>
      <SiteHeader user={user} />
      <PageBody title="Net worth">
        <section className="rounded-2xl border border-line bg-surface p-6">
          <p className="text-5xl font-bold tracking-tight">{formatCents(total.netWorthCents, { whole: true })}</p>
          {moved && (
            <p className="mt-2 text-sm">
              <span className={`font-medium ${moved.changeCents >= 0 ? "text-good" : "text-danger"}`}>
                {moved.changeCents >= 0 ? "▲" : "▼"} {formatChange(moved.changeCents)}
              </span>{" "}
              <span className="text-muted">since {formatDay(from)}</span>
              {moved.addedCents !== 0 && (
                <span className="text-muted"> · {formatChange(moved.addedCents)} from accounts added</span>
              )}
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

        <section className="space-y-4 rounded-2xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Net worth over time</h2>
            <RangeFilter range={range} basePath="/" />
          </div>
          <TrendChart label="Net worth" points={series.map((p) => ({ day: p.day, cents: p.netWorthCents }))} />
          <HistoryTable label="Net worth" rows={series.map((p) => ({ day: p.day, cents: p.netWorthCents }))} />
        </section>

        {movers.length > 0 && (
          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="text-lg font-semibold">What changed</h2>
            <p className="mt-1 text-sm text-muted">Since {formatDay(from)}, by effect on net worth — a loan paid down counts as a gain.</p>
            <ul className="mt-3 divide-y divide-line-soft text-sm">
              {movers.map((c) => {
                const a = names.get(c.accountId)!;
                return (
                  <li key={c.accountId} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <Link href={`/accounts/${a.id}`} className="hover:underline">
                        {a.name}
                      </Link>
                      <p className="text-xs text-muted">
                        {a.institutionName}
                        {c.status === "added" && " · added in this period"}
                        {c.status === "removed" && " · no longer reported"}
                      </p>
                    </div>
                    <span className={`tabular-nums ${c.effectCents > 0 ? "text-good" : "text-danger"}`}>
                      {c.effectCents > 0 ? "▲" : "▼"} {formatChange(c.effectCents)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

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
                          <Link href={`/accounts/${a.id}`} className="hover:underline">
                            {a.name}
                          </Link>
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
