import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { listTransactions, transactionsStatus } from "@/server/transactions";
import { IncomeChart, IncomeLegend, seriesColor, type IncomeChartPeriod } from "@/components/IncomeChart";
import {
  INTERVALS,
  categoryLabel,
  incomeBySource,
  isTransfer,
  monthlyFlow,
  monthsEnding,
  outsideTransfers,
  periodsEnding,
  recurringCharges,
  type IncomeGrouping,
  type IncomePeriod,
  type Interval,
} from "@/lib/cash-flow";
import { addDays, todayKey } from "@/lib/local-date";
import { formatCents, formatChange } from "@/lib/money";

export const metadata: Metadata = { title: "Spending" };

const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const shortMonth = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function utc(day: string) {
  return new Date(`${day.length === 7 ? `${day}-15` : day}T12:00:00Z`);
}

function Section({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A share of the largest, as a thin bar. */
function Bar({ share }: { share: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-surface-2">
      <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(1, Math.round(share * 100))}%` }} />
    </div>
  );
}

const weekFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weekLong = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthOnly = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

/** A period's labels for the income chart, and why it isn't whole if it isn't. */
function describePeriod(p: IncomePeriod, interval: Interval, first: string | undefined): IncomeChartPeriod {
  const start = utc(p.start);
  const yy = `'${p.start.slice(2, 4)}`;
  const quarter = `Q${p.key.slice(-1)}`;
  const [short, long] =
    interval === "week"
      ? [weekFormat.format(start), `Week of ${weekLong.format(start)}`]
      : interval === "month"
        ? [p.start.slice(5, 7) === "01" ? `Jan ${yy}` : monthOnly.format(start), monthFormat.format(start)]
        : interval === "quarter"
          ? [`${quarter} ${yy}`, `${quarter} ${p.start.slice(0, 4)} (${monthOnly.format(start)}–${monthOnly.format(utc(p.end))})`]
          : [p.key, p.key];
  const note = p.empty ? undefined : p.current ? "so far" : p.partial && first ? `from ${dayFormat.format(utc(first))}` : undefined;
  return { key: p.key, short, long, bySource: p.bySource, totalCents: p.totalCents, note, empty: p.empty };
}

/** A row of pill links, one picked. */
function Pills({ label, options }: { label: string; options: { label: string; href: string; current: boolean }[] }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <Link
          key={o.label}
          href={o.href}
          aria-current={o.current ? "true" : undefined}
          scroll={false}
          className={`rounded-full border px-3 py-1 text-xs ${
            o.current ? "border-text bg-text font-semibold text-ink" : "border-line text-muted hover:border-muted-dim"
          }`}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

/** Every column of the income chart, newest first, with what it was made of. */
function IncomeTable({ periods, sources }: { periods: IncomeChartPeriod[]; sources: { key: string; label: string }[] }) {
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer text-muted">Show as a table</summary>
      <div className="mt-3 max-h-96 overflow-y-auto rounded-lg border border-line-soft">
        <table className="w-full">
          <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Period</th>
              <th className="px-3 py-2 text-right font-medium">Money in</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {[...periods].reverse().map((p) => (
              <tr key={p.key} className="align-top">
                <td className="px-3 py-1.5">
                  {p.long}
                  {p.note && <span className="text-xs text-muted"> · {p.note}</span>}
                  <p className="text-xs text-muted">
                    {sources
                      .filter((s) => p.bySource[s.key])
                      .map((s) => `${s.label} ${formatCents(p.bySource[s.key], { whole: true })}`)
                      .join(" · ")}
                  </p>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{p.empty ? "—" : formatCents(p.totalCents, { whole: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Money in and out: this month by category, the last year by month, and what recurs. */
export default async function SpendingPage({ searchParams }: PageProps<"/spending">) {
  const { user } = await requireUser();
  const { db } = appContext();
  const today = todayKey();
  const months = monthsEnding(today, 12);
  const params = await searchParams;
  const asked = params.month;
  const month = typeof asked === "string" && months.includes(asked) ? asked : months.at(-1)!;
  const interval = INTERVALS.find((i) => i.value === params.income) ?? INTERVALS[1];
  const by: IncomeGrouping = params.by === "kind" ? "kind" : "payer";

  const status = transactionsStatus(db, user.id);
  // All of it — Plaid keeps two years — for income by quarter and year; the rest looks back about a year.
  const history = listTransactions(db, user.id);
  const outside = outsideTransfers(history);
  const since = addDays(today, -400);
  const txns = history.filter((t) => t.day >= since);
  const flows = monthlyFlow(txns, months, outside);
  const flow = flows.find((f) => f.month === month)!;
  const recurring = recurringCharges(txns, today, outside);
  const monthTxns = txns.filter((t) => t.day.startsWith(month));
  const busiest = Math.max(1, ...flows.map((f) => Math.max(f.incomeCents, f.spendingCents)));
  const biggest = Math.max(1, ...flow.byCategory.map((c) => c.cents));

  const income = incomeBySource(history, periodsEnding(today, interval.value, interval.count), today, { by, outside });
  const chartPeriods = income.periods.map((p) => describePeriod(p, interval.value, history.at(-1)?.day));
  /** This page with one choice changed and the others kept. */
  const hrefWith = (change: { month?: string; income?: Interval; by?: IncomeGrouping }) => {
    const q = new URLSearchParams();
    const m = change.month ?? month;
    if (m !== months.at(-1)) q.set("month", m);
    const i = change.income ?? interval.value;
    const b = change.by ?? by;
    if (i !== "month") q.set("income", i);
    if (b !== "payer") q.set("by", b);
    return q.size ? `/spending?${q}` : "/spending";
  };

  return (
    <>
      <SiteHeader user={user} />
      <PageBody
        title="Spending"
        subtitle="From your linked bank and card transactions. Transfers between your own accounts and card payments aren't counted — the card's purchases are. Money to or from someone else, like Venmo, Zelle or a Stripe payout, counts as money in or spending."
      >
        {status.connections === 0 ? (
          <section className="rounded-2xl border border-dashed border-line p-6 text-sm text-muted">
            <p className="font-medium text-text">No transactions yet</p>
            <p className="mt-2">
              Transactions come from bank and card links (Plaid&apos;s “bank” link). Ones already made start bringing them in on
              their next daily refresh; investment- and loan-only links don&apos;t carry them, and asking would add a product
              Plaid bills for, so MoneyRight doesn&apos;t.
            </p>
            <Link href="/accounts" className="mt-4 inline-block rounded-full bg-accent px-4 py-2 font-medium text-accent-ink">
              Accounts
            </Link>
          </section>
        ) : (
          <>
            <section className="rounded-2xl border border-line bg-surface p-6">
              <p className="text-sm text-muted">{monthFormat.format(utc(month))}</p>
              <div className="mt-3 grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-muted">In</p>
                  <p className="text-2xl font-bold tabular-nums">{formatCents(flow.incomeCents, { whole: true })}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Out</p>
                  <p className="text-2xl font-bold tabular-nums">{formatCents(flow.spendingCents, { whole: true })}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Saved</p>
                  <p className={`text-2xl font-bold tabular-nums ${flow.netCents >= 0 ? "text-good" : "text-danger"}`}>
                    {formatChange(flow.netCents)}
                  </p>
                </div>
              </div>
              {month === months.at(-1) && <p className="mt-3 text-xs text-muted">This month so far.</p>}
              {status.lastSyncedAt && (
                <p className="mt-1 text-xs text-muted">Transactions updated {when.format(status.lastSyncedAt)}.</p>
              )}
            </section>

            <Section
              title="Money in"
              subtitle={
                by === "payer"
                  ? "Where it came from, payer by payer."
                  : "Where it came from, by kind: paychecks, interest, money sent to you."
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Pills
                  label="Interval"
                  options={INTERVALS.map((i) => ({ label: i.label, href: hrefWith({ income: i.value }), current: i.value === interval.value }))}
                />
                <Pills
                  label="Group by"
                  options={[
                    { label: "By payer", href: hrefWith({ by: "payer" }), current: by === "payer" },
                    { label: "By kind", href: hrefWith({ by: "kind" }), current: by === "kind" },
                  ]}
                />
              </div>

              <div className="mt-5 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted">
                    Last {interval.count} {interval.label.toLowerCase()}
                  </p>
                  <p className="text-2xl font-bold">{formatCents(income.totalCents, { whole: true })}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Average {interval.value}</p>
                  <p className="text-2xl font-bold">
                    {income.averageCents === null ? "—" : formatCents(income.averageCents, { whole: true })}
                  </p>
                  {income.averageCents !== null && <p className="text-xs text-muted">Whole {interval.label.toLowerCase()} only.</p>}
                </div>
              </div>

              {income.sources.length > 0 && (
                <div className="mt-5">
                  <IncomeLegend sources={income.sources} />
                </div>
              )}
              <div className="mt-3">
                <IncomeChart periods={chartPeriods} sources={income.sources} label={interval.label} />
              </div>

              {income.sources.length > 0 && (
                <>
                  <table className="mt-5 w-full text-sm">
                    <thead className="text-left text-xs text-muted">
                      <tr>
                        <th className="pb-2 font-normal">{by === "payer" ? "Payer" : "Kind"}</th>
                        <th className="pb-2 text-right font-normal">Total</th>
                        <th className="pb-2 text-right font-normal">Share</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {income.sources.map((s) => (
                        <tr key={s.key}>
                          <td className="max-w-0 py-2">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(s.slot) }} aria-hidden />
                              <span className="min-w-0 truncate">{s.label}</span>
                            </div>
                            <p className="ml-[18px] text-xs text-muted">{s.detail}</p>
                          </td>
                          <td className="py-2 pl-3 text-right tabular-nums">{formatCents(s.totalCents, { whole: true })}</td>
                          <td className="w-16 py-2 text-right tabular-nums text-muted">
                            {income.totalCents > 0 ? `${Math.round((s.totalCents / income.totalCents) * 100)}%` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <IncomeTable periods={chartPeriods} sources={income.sources} />
                </>
              )}
            </Section>

            <Section title="Where it went">
              {flow.byCategory.length === 0 ? (
                <p className="text-sm text-muted">Nothing spent this month yet.</p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {flow.byCategory.map((c) => (
                    <li key={c.category}>
                      <div className="flex justify-between">
                        <span>{categoryLabel(c.category)}</span>
                        <span className="tabular-nums">{formatCents(c.cents)}</span>
                      </div>
                      <Bar share={c.cents / biggest} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="The last twelve months" subtitle="Pick a month to see its categories and transactions.">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="pb-2 font-normal">Month</th>
                    <th className="pb-2 text-right font-normal">In</th>
                    <th className="pb-2 text-right font-normal">Out</th>
                    <th className="pb-2 text-right font-normal">Saved</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {[...flows].reverse().map((f) => (
                    <tr key={f.month} className={f.month === month ? "font-medium" : ""}>
                      <td className="py-2">
                        <Link href={hrefWith({ month: f.month })} className="hover:underline">
                          {shortMonth.format(utc(f.month))}
                        </Link>
                        <div className="mt-1 w-24 sm:w-40">
                          <Bar share={f.spendingCents / busiest} />
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatCents(f.incomeCents, { whole: true })}</td>
                      <td className="py-2 text-right tabular-nums">{formatCents(f.spendingCents, { whole: true })}</td>
                      <td className={`py-2 text-right tabular-nums ${f.netCents >= 0 ? "text-good" : "text-danger"}`}>
                        {formatChange(f.netCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section
              title="Recurring"
              subtitle={
                recurring.length
                  ? `About ${formatCents(recurring.reduce((n, r) => n + r.monthlyCents, 0), { whole: true })} a month: charges that come on a steady rhythm for a steady amount, and are still coming.`
                  : undefined
              }
            >
              {recurring.length === 0 ? (
                <p className="text-sm text-muted">Nothing recurring found yet — it takes three charges to see a rhythm.</p>
              ) : (
                <ul className="divide-y divide-line-soft text-sm">
                  {recurring.map((r) => (
                    <li key={`${r.name}-${r.cadence}`} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{r.name}</p>
                        <p className="text-xs text-muted">
                          {r.cadence} · next around {dayFormat.format(utc(r.nextDay))}
                        </p>
                      </div>
                      <span className="tabular-nums">{formatCents(r.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={`Transactions · ${monthFormat.format(utc(month))}`}>
              {monthTxns.length === 0 ? (
                <p className="text-sm text-muted">None.</p>
              ) : (
                <ul className="divide-y divide-line-soft text-sm">
                  {monthTxns.map((t) => {
                    const moved = isTransfer(t) && !outside.has(t);
                    return (
                      <li key={t.id} className="flex items-center gap-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className={`truncate ${moved ? "text-muted" : ""}`}>{t.merchant || t.name}</p>
                          <p className="text-xs text-muted">
                            {dayFormat.format(utc(t.day))} · {t.accountName} · {categoryLabel(t.category ?? "OTHER")}
                            {moved && " · transfer, not counted"}
                            {outside.has(t) && (t.amountCents < 0 ? " · received, counted as money in" : " · sent, counted as spending")}
                            {t.pending && " · pending"}
                          </p>
                        </div>
                        {/* Shown the way a statement reads: money in positive. */}
                        <span className={`tabular-nums ${t.amountCents < 0 ? "text-good" : ""}`}>{formatChange(-t.amountCents)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          </>
        )}
      </PageBody>
    </>
  );
}
