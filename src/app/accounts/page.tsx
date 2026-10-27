import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { PlaidLinkForm, PlaidReconnectButton, RefreshButton } from "@/components/LinkButtons";
import { AddLoanForm, EditLoanForm, type LoanDefaults } from "@/components/LoanForms";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import {
  listAccounts,
  listConnections,
  listScheduledLoans,
  PLAID_TRIAL_ITEMS,
  plaidItemsUsed,
  type AccountView,
  type Connection,
} from "@/server/finance";
import { plaidConfig } from "@/server/providers/config";
import { deleteLoanAction } from "@/app/actions/loans";
import { removeConnectionAction, setIncludeAction } from "@/app/actions/linking";
import { KIND_LABEL } from "@/lib/account-kinds";
import { projectLoan } from "@/lib/amortization";
import { todayKey } from "@/lib/local-date";
import { formatCents } from "@/lib/money";

export const metadata: Metadata = { title: "Accounts" };

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function Section({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SetupHint({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">{children}</p>;
}

/** Plain-language status for a provider error code. */
function statusText(c: Connection): string {
  if (c.status === "reconnect") return "Needs you to sign in to the bank again";
  if (c.status === "error") return `Last refresh failed (${c.statusCode}) — retrying hourly`;
  return c.lastSyncedAt ? `Updated ${when.format(c.lastSyncedAt)}` : "Not refreshed yet";
}

function dollars(cents: number) {
  return (cents / 100).toFixed(2);
}

export default async function AccountsPage() {
  const { user } = await requireUser();
  const ctx = appContext();
  const plaid = plaidConfig();
  const connections = listConnections(ctx.db, user.id);
  const accounts = listAccounts(ctx.db, user.id);
  const loans = listScheduledLoans(ctx.db, user.id);
  const today = todayKey();
  const used = plaidItemsUsed(ctx.db);
  const slotsLeft = plaid?.environment === "production" ? Math.max(0, PLAID_TRIAL_ITEMS - used) : null;

  const byConnection = new Map<number, AccountView[]>();
  for (const a of accounts) {
    if (a.connectionId === null) continue;
    byConnection.set(a.connectionId, [...(byConnection.get(a.connectionId) ?? []), a]);
  }
  const loanAccounts = new Map(accounts.filter((a) => a.source === "schedule").map((a) => [a.id, a]));

  return (
    <>
      <SiteHeader user={user} />
      <PageBody title="Accounts" subtitle="Link banks, cards, brokerages and loans. Balances refresh about once a day.">
        <Section
          title="Link an account"
          subtitle={
            slotsLeft === null
              ? "Through Plaid — banks, cards, brokerages and loans."
              : `Through Plaid — ${slotsLeft} of ${PLAID_TRIAL_ITEMS} free links left. A link is used up for good, even if removed, so reconnect rather than re-link.`
          }
        >
          {plaid ? (
            <PlaidLinkForm slotsLeft={slotsLeft} />
          ) : (
            <SetupHint>Plaid isn&apos;t set up yet: set PLAID_CLIENT_ID and PLAID_SECRET. See the README&apos;s “Linking accounts”.</SetupHint>
          )}
        </Section>

        {connections.map((c) => (
          <Section
            key={c.id}
            title={c.institutionName}
            subtitle={
              <>
                Plaid · {statusText(c)}
              </>
            }
          >
            <ul className="divide-y divide-line-soft text-sm">
              {(byConnection.get(c.id) ?? []).map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className={a.gone ? "text-muted line-through" : ""}>
                      <Link href={`/accounts/${a.id}`} className="hover:underline">
                        {a.name}
                      </Link>
                      {a.mask && <span className="text-muted"> ··{a.mask}</span>}
                    </p>
                    <p className="text-xs text-muted">
                      {KIND_LABEL[a.kind]}
                      {a.gone && " · no longer reported"}
                    </p>
                  </div>
                  <span className="tabular-nums">{a.balanceCents === null ? "—" : formatCents(a.balanceCents)}</span>
                  <form action={setIncludeAction}>
                    <input type="hidden" name="accountId" value={a.id} />
                    <input type="hidden" name="include" value={a.includeInNetWorth ? "0" : "1"} />
                    <button type="submit" className="rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:border-muted-dim">
                      {a.includeInNetWorth ? "Counted" : "Not counted"}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap items-start gap-3">
              {c.status === "reconnect" && <PlaidReconnectButton connectionId={c.id} />}
              <RefreshButton connectionId={c.id} />
              <form action={removeConnectionAction}>
                <input type="hidden" name="connectionId" value={c.id} />
                <button type="submit" className="rounded-full border border-danger/50 px-3 py-1 text-xs text-danger hover:bg-danger/10">
                  Remove (uses up its Plaid link)
                </button>
              </form>
            </div>
          </Section>
        ))}

        <Section
          title="Federal student loans"
          subtitle="No free service links federal servicers like MOHELA, so MoneyRight works the balance out: daily simple interest, payments to interest first. Enter the servicer's numbers once; update them only if something changes."
        >
          <div className="space-y-6">
            {loans.map((loan) => {
              const position = projectLoan(loan.schedule, today);
              const defaults: LoanDefaults = {
                accountId: loan.accountId,
                name: loan.name,
                servicer: loan.servicer,
                principal: dollars(position.principalCents),
                interest: dollars(position.accruedInterestCents),
                rate: (loan.schedule.annualRateBps / 100).toFixed(2),
                payment: dollars(loan.schedule.monthlyPaymentCents),
                paymentDay: String(loan.schedule.paymentDay),
                anchorDate: today,
              };
              const account = loanAccounts.get(loan.accountId);
              return (
                <div key={loan.accountId} className="rounded-xl border border-line-soft p-4">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        <Link href={`/accounts/${loan.accountId}`} className="hover:underline">
                          {loan.name}
                        </Link>{" "}
                        <span className="text-sm text-muted">· {loan.servicer}</span>
                      </p>
                      <p className="text-xs text-muted">
                        {(loan.schedule.annualRateBps / 100).toFixed(2)}% · {formatCents(loan.schedule.monthlyPaymentCents)}/mo
                        on day {loan.schedule.paymentDay} · projected from {loan.schedule.anchorDate}
                        {position.paidOff && " · paid off"}
                      </p>
                    </div>
                    <span className="tabular-nums">{formatCents(position.balanceCents)}</span>
                    {account && (
                      <form action={setIncludeAction}>
                        <input type="hidden" name="accountId" value={account.id} />
                        <input type="hidden" name="include" value={account.includeInNetWorth ? "0" : "1"} />
                        <button type="submit" className="rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:border-muted-dim">
                          {account.includeInNetWorth ? "Counted" : "Not counted"}
                        </button>
                      </form>
                    )}
                  </div>
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-muted">Doesn&apos;t match the servicer? Update it</summary>
                    <div className="mt-3 space-y-3">
                      <p className="text-xs text-muted">Pre-filled with today&apos;s projection — change what differs from MOHELA&apos;s site.</p>
                      <EditLoanForm defaults={defaults} />
                      <form action={deleteLoanAction}>
                        <input type="hidden" name="accountId" value={loan.accountId} />
                        <button type="submit" className="text-xs text-danger underline">
                          Delete this loan
                        </button>
                      </form>
                    </div>
                  </details>
                </div>
              );
            })}
            <details open={loans.length === 0}>
              <summary className="cursor-pointer text-sm font-medium">Add a loan</summary>
              <p className="mt-2 text-xs text-muted">
                One entry per loan if their rates differ — MOHELA lists each loan separately.
              </p>
              <div className="mt-3">
                <AddLoanForm
                  defaults={{
                    name: "",
                    servicer: "MOHELA",
                    principal: "",
                    interest: "",
                    rate: "",
                    payment: "",
                    paymentDay: "1",
                    anchorDate: today,
                  }}
                />
              </div>
            </details>
          </div>
        </Section>
      </PageBody>
    </>
  );
}
