import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { TrendChart } from "@/components/TrendChart";
import { AddGoalForm, AssumptionsForm } from "@/components/PlanForms";
import { deleteGoalAction } from "@/app/actions/planning";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { listAccounts } from "@/server/finance";
import { forecastAccounts, forecastSettings, listGoals, measuredSavings } from "@/server/planning";
import { isLiability, KIND_LABEL, KIND_ORDER } from "@/lib/account-kinds";
import { forecast, goalProgress } from "@/lib/forecast";
import { todayKey } from "@/lib/local-date";
import { formatCents, formatChange } from "@/lib/money";

export const metadata: Metadata = { title: "Forecast" };

const HORIZONS = { "1y": 12, "5y": 60, "10y": 120, "30y": 360 } as const;
type Horizon = keyof typeof HORIZONS;
/** Goals are checked against the longest horizon, whatever the chart shows. */
const GOAL_MONTHS = HORIZONS["30y"];

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function formatDay(day: string) {
  return dayFormat.format(new Date(`${day}T12:00:00Z`));
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

/** Net worth projected forward from what MoneyRight knows, and whether goals get reached. */
export default async function ForecastPage({ searchParams }: PageProps<"/forecast">) {
  const { user } = await requireUser();
  const { db } = appContext();
  const today = todayKey();
  const asked = (await searchParams).horizon;
  const horizon: Horizon = typeof asked === "string" && asked in HORIZONS ? (asked as Horizon) : "10y";
  const months = HORIZONS[horizon];

  const settings = forecastSettings(db, user.id);
  const measured = measuredSavings(db, user.id, today);
  const savings = settings.monthlySavingsCents ?? measured ?? 0;
  const inputs = forecastAccounts(db, user.id, today);
  const f = forecast(inputs, { investmentReturnBps: settings.investmentReturnBps, monthlySavingsCents: savings }, today, GOAL_MONTHS);
  const end = months;
  const accounts = listAccounts(db, user.id).filter((a) => !a.gone);
  const kinds = new Map(accounts.map((a) => [a.id, a.kind]));
  const goals = listGoals(db, user.id);
  const names = new Map(accounts.map((a) => [a.id, a.name]));

  // Today and at the horizon, by kind, for what's counted.
  const byKind = KIND_ORDER.map((kind) => {
    const counted = inputs.filter((a) => a.kind === kind && a.includeInNetWorth && f.byAccount.has(a.id));
    const sum = (k: number) => counted.reduce((n, a) => n + f.byAccount.get(a.id)![k], 0);
    return { kind, count: counted.length, now: sum(0), then: sum(end) };
  }).filter((k) => k.count > 0);

  const points = f.days.slice(0, end + 1).map((day, k) => ({ day, cents: f.netWorthCents[k] }));

  return (
    <>
      <SiteHeader user={user} />
      <PageBody
        title="Forecast"
        subtitle="Where net worth is headed if things carry on as they are: loans paid on schedule, homes and investments growing at their rates, cars depreciating, and your savings adding up. A direction, not a promise."
      >
        <section className="rounded-2xl border border-line bg-surface p-6">
          <p className="text-sm text-muted">In {formatDay(f.days[end])}</p>
          <p className="mt-1 text-5xl font-bold tracking-tight">{formatCents(f.netWorthCents[end], { whole: true })}</p>
          <p className="mt-2 text-sm">
            <span className={`font-medium ${f.netWorthCents[end] >= f.netWorthCents[0] ? "text-good" : "text-danger"}`}>
              {formatChange(f.netWorthCents[end] - f.netWorthCents[0])}
            </span>{" "}
            <span className="text-muted">from {formatCents(f.netWorthCents[0], { whole: true })} today</span>
          </p>
        </section>

        <section className="space-y-4 rounded-2xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Projected net worth</h2>
            <nav className="flex gap-1 text-sm">
              {(Object.keys(HORIZONS) as Horizon[]).map((h) => (
                <Link
                  key={h}
                  href={`/forecast?horizon=${h}`}
                  className={`rounded-full px-3 py-1 ${h === horizon ? "bg-surface-2 font-medium" : "text-muted hover:text-text"}`}
                >
                  {h.replace("y", h === "1y" ? " year" : " years")}
                </Link>
              ))}
            </nav>
          </div>
          <TrendChart label="Projected net worth" points={points} />
        </section>

        <Section title="What moves it" subtitle={`Today and in ${formatDay(f.days[end])}, for what's counted in net worth.`}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-normal" />
                <th className="pb-2 text-right font-normal">Today</th>
                <th className="pb-2 text-right font-normal">{formatDay(f.days[end])}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {byKind.map((k) => {
                const sign = isLiability(k.kind) ? "−" : "";
                return (
                  <tr key={k.kind}>
                    <td className="py-2">{KIND_LABEL[k.kind]}</td>
                    <td className="py-2 text-right tabular-nums">
                      {sign}
                      {formatCents(k.now, { whole: true })}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {sign}
                      {formatCents(k.then, { whole: true })}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td className="py-2">Savings added up</td>
                <td className="py-2 text-right tabular-nums">—</td>
                <td className="py-2 text-right tabular-nums">{formatChange(savings * end)}</td>
              </tr>
            </tbody>
          </table>
        </Section>

        <Section title="Goals" subtitle="Each checked against the forecast up to thirty years out.">
          <div className="space-y-6">
            {goals.length > 0 && (
              <ul className="divide-y divide-line-soft text-sm">
                {goals.map((goal) => {
                  const p = goalProgress(goal, f, kinds);
                  const of = goal.accountId === null ? "Net worth" : (names.get(goal.accountId) ?? "Account");
                  const verb = p.direction === "down" ? (goal.targetCents === 0 ? "paid off" : `down to ${formatCents(goal.targetCents, { whole: true })}`) : formatCents(goal.targetCents, { whole: true });
                  let outlook: React.ReactNode;
                  if (p.currentCents === null) outlook = <span className="text-muted">No balance to project yet.</span>;
                  else if (p.reached) outlook = <span className="text-good">Reached.</span>;
                  else if (!p.projectedDay) outlook = <span className="text-danger">Not reached within thirty years at this pace.</span>;
                  else
                    outlook = (
                      <span className={p.onTrack === false ? "text-danger" : p.onTrack ? "text-good" : ""}>
                        Projected {formatDay(p.projectedDay)}
                        {p.onTrack === true && " — on track"}
                        {p.onTrack === false && goal.targetDate && ` — after ${formatDay(goal.targetDate)}`}
                      </span>
                    );
                  return (
                    <li key={goal.id} className="flex items-start gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{goal.name}</p>
                        <p className="text-xs text-muted">
                          {of}: {verb}
                          {goal.targetDate && ` by ${formatDay(goal.targetDate)}`}
                          {p.currentCents !== null && ` · now ${formatCents(p.currentCents, { whole: true })}`}
                        </p>
                        <p className="mt-1 text-xs">{outlook}</p>
                      </div>
                      <form action={deleteGoalAction}>
                        <input type="hidden" name="goalId" value={goal.id} />
                        <button type="submit" className="text-xs text-muted underline hover:text-danger">
                          Remove
                        </button>
                      </form>
                    </li>
                  );
                })}
              </ul>
            )}
            <details open={goals.length === 0}>
              <summary className="cursor-pointer text-sm font-medium">Add a goal</summary>
              <div className="mt-3">
                <AddGoalForm accounts={accounts.map((a) => ({ id: a.id, label: `${a.name} · ${KIND_LABEL[a.kind]}` }))} />
              </div>
            </details>
          </div>
        </Section>

        <Section
          title="Assumptions"
          subtitle={`Saving ${formatChange(savings)} a month${
            settings.monthlySavingsCents === null ? (measured === null ? " (no transactions to measure yet)" : " — your recent average") : " — as you set it"
          }; investments growing ${(settings.investmentReturnBps / 100).toFixed(1)}% a year. Linked loans keep paying down at their last 90 days' pace; a home follows its ZIP's last five years, capped at 8% either way.`}
        >
          <AssumptionsForm
            investmentReturn={(settings.investmentReturnBps / 100).toFixed(1)}
            monthlySavings={settings.monthlySavingsCents === null ? "" : (settings.monthlySavingsCents / 100).toFixed(2)}
            measured={measured === null ? null : formatChange(measured)}
          />
        </Section>
      </PageBody>
    </>
  );
}
