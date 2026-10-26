import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { HistoryTable, RangeFilter } from "@/components/History";
import { TrendChart } from "@/components/TrendChart";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { getAccount, snapshots } from "@/server/finance";
import { isLiability, KIND_LABEL } from "@/lib/account-kinds";
import { accountSeries, parseRange, rangeStart } from "@/lib/history";
import { daysBetween, todayKey } from "@/lib/local-date";
import { formatCents, formatChange } from "@/lib/money";

export const metadata: Metadata = { title: "Account" };

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** One account's balance over time. */
export default async function AccountPage({ params, searchParams }: PageProps<"/accounts/[id]">) {
  const { user } = await requireUser();
  const { id } = await params;
  const accountId = Number(id);
  if (!Number.isInteger(accountId)) notFound();
  const { db } = appContext();
  // Scoped to the signed-in user: another person's id is simply not found.
  const account = getAccount(db, user.id, accountId);
  if (!account) notFound();

  const today = todayKey();
  const range = parseRange((await searchParams).range);
  const history = snapshots(db, user.id, today, account.id);
  const from = rangeStart(range, today, history[0]?.day ?? null);
  const series = accountSeries(history, from, today);
  const owed = isLiability(account.kind);
  const firstKnown = series.find((p) => p.balanceCents !== null);
  const delta =
    firstKnown && account.balanceCents !== null && daysBetween(firstKnown.day, today) > 0
      ? account.balanceCents - firstKnown.balanceCents!
      : null;
  const label = owed ? "Owed" : "Balance";
  const source = account.source === "schedule" ? "Projected from its schedule" : account.source === "teller" ? "Through Teller" : "Through Plaid";

  return (
    <>
      <SiteHeader user={user} />
      <PageBody
        title={account.name}
        subtitle={`${account.institutionName}${account.mask ? ` ··${account.mask}` : ""} · ${KIND_LABEL[account.kind]} · ${source}`}
      >
        <section className="rounded-2xl border border-line bg-surface p-6">
          <p className="text-sm text-muted">{label}</p>
          <p className="mt-1 text-5xl font-bold tracking-tight">
            {account.balanceCents === null ? "—" : formatCents(account.balanceCents)}
          </p>
          {delta !== null && firstKnown && (
            <p className="mt-2 text-sm">
              {/* For a debt, going down is the good direction. */}
              <span className={`font-medium ${(owed ? -delta : delta) >= 0 ? "text-good" : "text-danger"}`}>
                {delta >= 0 ? "▲" : "▼"} {formatChange(delta)}
              </span>{" "}
              <span className="text-muted">since {dayFormat.format(new Date(`${firstKnown.day}T12:00:00Z`))}</span>
            </p>
          )}
          {account.gone && <p className="mt-3 text-sm text-muted">The bank no longer reports this account; its history is kept.</p>}
          {!account.includeInNetWorth && <p className="mt-3 text-sm text-muted">Not counted in net worth.</p>}
        </section>

        <section className="space-y-4 rounded-2xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{label} over time</h2>
            <RangeFilter range={range} basePath={`/accounts/${account.id}`} />
          </div>
          <TrendChart label={label} points={series.map((p) => ({ day: p.day, cents: p.balanceCents }))} />
          <HistoryTable label={label} rows={series.map((p) => ({ day: p.day, cents: p.balanceCents }))} />
        </section>

        <p className="text-sm">
          <Link href="/accounts" className="text-muted hover:text-text">
            ← Manage accounts
          </Link>
        </p>
      </PageBody>
    </>
  );
}
