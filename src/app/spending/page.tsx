import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { listTransactions, transactionsStatus } from "@/server/transactions";
import { categoryLabel, isTransfer, monthlyFlow, monthsEnding, recurringCharges } from "@/lib/cash-flow";
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

/** Money in and out: this month by category, the last year by month, and what recurs. */
export default async function SpendingPage({ searchParams }: PageProps<"/spending">) {
  const { user } = await requireUser();
  const { db } = appContext();
  const today = todayKey();
  const months = monthsEnding(today, 12);
  const asked = (await searchParams).month;
  const month = typeof asked === "string" && months.includes(asked) ? asked : months.at(-1)!;

  const status = transactionsStatus(db, user.id);
  const txns = listTransactions(db, user.id, { from: addDays(today, -400) });
  const flows = monthlyFlow(txns, months);
  const flow = flows.find((f) => f.month === month)!;
  const recurring = recurringCharges(txns, today);
  const monthTxns = txns.filter((t) => t.day.startsWith(month));
  const busiest = Math.max(1, ...flows.map((f) => Math.max(f.incomeCents, f.spendingCents)));
  const biggest = Math.max(1, ...flow.byCategory.map((c) => c.cents));

  return (
    <>
      <SiteHeader user={user} />
      <PageBody
        title="Spending"
        subtitle="From your linked bank and card transactions. Transfers between your own accounts and card payments aren't counted — the card's purchases are."
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
                        <Link href={`/spending?month=${f.month}`} className="hover:underline">
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
                  {monthTxns.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className={`truncate ${isTransfer(t) ? "text-muted" : ""}`}>{t.merchant || t.name}</p>
                        <p className="text-xs text-muted">
                          {dayFormat.format(utc(t.day))} · {t.accountName} · {categoryLabel(t.category ?? "OTHER")}
                          {isTransfer(t) && " · transfer, not counted"}
                          {t.pending && " · pending"}
                        </p>
                      </div>
                      {/* Shown the way a statement reads: money in positive. */}
                      <span className={`tabular-nums ${t.amountCents < 0 ? "text-good" : ""}`}>{formatChange(-t.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </PageBody>
    </>
  );
}
