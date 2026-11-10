import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, SiteHeader } from "@/components/SiteHeader";
import { PlaidLinkForm, PlaidReconnectButton, RefreshButton } from "@/components/LinkButtons";
import { AddLoanForm, EditLoanForm, type LoanDefaults } from "@/components/LoanForms";
import { AddAssetForm, EditAssetForm, type AssetDefaults } from "@/components/AssetForms";
import { AssetLoansForm } from "@/components/PlanForms";
import { Disclosure } from "@/components/ui/forms";
import { rentcastRequestsThisMonth, RENTCAST_MONTHLY_CAP } from "@/server/home-estimates";
import { rentcastConfig } from "@/server/providers/rentcast";
import { requireUser } from "@/server/auth";
import { appContext } from "@/server/context";
import { homeIndex, homeIndexStatus } from "@/server/home-index";
import {
  assetLoans,
  listAccounts,
  listAssets,
  securableLoans,
  listConnections,
  listScheduledLoans,
  PLAID_TRIAL_ITEMS,
  plaidItemsUsed,
  type AccountView,
  type AddressEstimate,
  type Connection,
} from "@/server/finance";
import { plaidConfig } from "@/server/providers/config";
import { deleteLoanAction } from "@/app/actions/loans";
import { deleteAssetAction } from "@/app/actions/assets";
import { removeConnectionAction, setIncludeAction } from "@/app/actions/linking";
import { KIND_LABEL } from "@/lib/account-kinds";
import { projectLoan } from "@/lib/amortization";
import { daysBetween, todayKey } from "@/lib/local-date";
import { formatCents } from "@/lib/money";
import { DEFAULT_VEHICLE_DEPRECIATION_BPS, estimateAsset, indexAt, type AssetValuation, type IndexPoint } from "@/lib/valuation";

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

const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function monthName(month: string) {
  return monthFormat.format(new Date(`${month}-15T12:00:00Z`));
}

/** A value looked up by hand goes stale; after this long, suggest checking again. */
const RECHECK_AFTER_DAYS = 180;

/** How an asset's estimate is moving, in a line. */
function valuationText(v: AssetValuation, index: IndexPoint[], today: string, estimate: AddressEstimate | null): string {
  const since = `from ${formatCents(v.valueCents, { whole: true })} on ${v.asOf}`;
  if (v.method === "address") {
    const range =
      estimate?.lowCents && estimate.highCents
        ? ` · likely ${formatCents(estimate.lowCents, { whole: true })}–${formatCents(estimate.highCents, { whole: true })}`
        : "";
    return `${v.address} · RentCast estimate as of ${v.asOf}${range}`;
  }
  if (v.method === "depreciation") return `Loses ${(v.annualRateBps / 100).toFixed(1)}% a year, ${since}`;
  if (v.method === "fixed") return `Held at the value you entered on ${v.asOf}`;
  const now = indexAt(index, today);
  if (!now) return `Waiting for ZIP ${v.zip}'s home values — held ${since} until then`;
  const typical = formatCents(Math.round(now.value) * 100, { whole: true });
  return `Follows ZIP ${v.zip}'s home values ${since} · typical home there ${typical} (Zillow, ${monthName(now.month)})`;
}

export default async function AccountsPage() {
  const { user } = await requireUser();
  const ctx = appContext();
  const plaid = plaidConfig();
  const addressLookup = rentcastConfig() !== null;
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
  const assets = listAssets(ctx.db, user.id);
  const indexes = new Map<string, IndexPoint[]>();
  for (const a of assets) {
    const zip = a.valuation.zip;
    if (a.valuation.method === "home_index" && zip && !indexes.has(zip)) indexes.set(zip, homeIndex(ctx.db, zip));
  }
  const indexStatus = assets.some((a) => a.valuation.method === "home_index") ? homeIndexStatus(ctx.db) : null;
  const loansFor = assetLoans(ctx.db, user.id);
  const securable = securableLoans(ctx.db, user.id);
  const securedBy = new Map<number, number>();
  for (const [assetId, loanIds] of loansFor) for (const id of loanIds) securedBy.set(id, assetId);
  const assetName = new Map(assets.map((a) => [a.accountId, a.name]));

  return (
    <>
      <SiteHeader user={user} />
      <PageBody title="Accounts" subtitle="Link banks, cards, brokerages and loans, and add what you own. Balances refresh about once a day.">
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
            <Disclosure summary="Add a loan" initiallyOpen={loans.length === 0}>
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
            </Disclosure>
          </div>
        </Section>

        <Section
          title="Homes, vehicles and other assets"
          subtitle={
            addressLookup
              ? "A home is valued from its address — RentCast's estimate from nearby sales, re-checked monthly. A vehicle starts from a value you look up (Kelley Blue Book, Edmunds or Consumer Reports) and depreciates yearly until you update it."
              : "Enter a value once — an appraisal, a purchase price, a Kelley Blue Book or Consumer Reports lookup — and MoneyRight moves it along: a home with its ZIP code's home values, a vehicle by yearly depreciation. Update it whenever you check a fresher number."
          }
        >
          <div className="space-y-6">
            {indexStatus?.error && (
              <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                The last home-value download failed ({indexStatus.error}) — estimates use the readings already kept, and it&apos;s
                retried every few hours.
              </p>
            )}
            {assets.map((asset) => {
              const v = asset.valuation;
              const index = (v.zip && indexes.get(v.zip)) || [];
              const estimate = estimateAsset(v, today, index);
              const account = accounts.find((a) => a.id === asset.accountId);
              const mine = new Set(loansFor.get(asset.accountId) ?? []);
              const owedAgainst = securable.filter((l) => mine.has(l.id));
              const owed = owedAgainst.reduce((n, l) => n + (l.balanceCents ?? 0), 0);
              const stale = v.method !== "home_index" && v.method !== "address" && daysBetween(v.asOf, today) > RECHECK_AFTER_DAYS;
              const defaults: AssetDefaults = {
                accountId: asset.accountId,
                name: asset.name,
                kind: asset.kind,
                value: dollars(estimate.valueCents),
                asOf: today,
                method: v.method,
                rate: v.method === "depreciation" ? (v.annualRateBps / 100).toFixed(1) : (DEFAULT_VEHICLE_DEPRECIATION_BPS / 100).toFixed(1),
                zip: v.zip ?? "",
                address: v.address ?? "",
              };
              return (
                <div key={asset.accountId} className="rounded-xl border border-line-soft p-4">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        <Link href={`/accounts/${asset.accountId}`} className="hover:underline">
                          {asset.name}
                        </Link>{" "}
                        <span className="text-sm text-muted">· {KIND_LABEL[asset.kind]}</span>
                      </p>
                      <p className="text-xs text-muted">
                        {valuationText(v, index, today, asset.estimate)}
                        {stale && " · worth looking up again"}
                      </p>
                      {asset.estimate?.error && <p className="mt-1 text-xs text-danger">Last lookup: {asset.estimate.error}</p>}
                      {owedAgainst.length > 0 && (
                        <p className="mt-1 text-xs">
                          <span className="text-muted">
                            Less {owedAgainst.map((l) => l.name).join(" and ")} ({formatCents(owed)}):
                          </span>{" "}
                          <span className="font-medium">{formatCents(estimate.valueCents - owed)} equity</span>
                          {estimate.valueCents > 0 && (
                            <span className="text-muted"> · {Math.round((owed / estimate.valueCents) * 100)}% borrowed</span>
                          )}
                        </p>
                      )}
                    </div>
                    <span className="tabular-nums">{formatCents(estimate.valueCents)}</span>
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
                    <summary className="cursor-pointer text-muted">Have a fresher value? Update it</summary>
                    <div className="mt-3 space-y-3">
                      <p className="text-xs text-muted">
                        {v.method === "address"
                          ? "Change the address to look it up again; it's re-checked monthly on its own."
                          : "Pre-filled with today's estimate — change what you know better."}
                      </p>
                      <EditAssetForm defaults={defaults} addressLookup={addressLookup} />
                      {securable.length > 0 && (
                        <div className="border-t border-line-soft pt-3">
                          <AssetLoansForm
                            accountId={asset.accountId}
                            loans={securable.map((l) => {
                              const other = securedBy.get(l.id);
                              return {
                                id: l.id,
                                label: `${l.name} · ${l.institutionName}${l.balanceCents === null ? "" : ` · ${formatCents(l.balanceCents)}`}`,
                                checked: mine.has(l.id),
                                elsewhere: other !== undefined && other !== asset.accountId ? (assetName.get(other) ?? null) : null,
                              };
                            })}
                          />
                        </div>
                      )}
                      <form action={deleteAssetAction}>
                        <input type="hidden" name="accountId" value={asset.accountId} />
                        <button type="submit" className="text-xs text-danger underline">
                          Delete this asset
                        </button>
                      </form>
                    </div>
                  </details>
                </div>
              );
            })}
            <Disclosure summary="Add an asset" initiallyOpen={assets.length === 0}>
              <p className="mt-2 text-xs text-muted">
                A mortgage or car loan is linked separately, then set against it for its equity; this is only what the thing
                itself is worth.
              </p>
              {!addressLookup && (
                <p className="mt-2 text-xs text-muted">
                  To value a home from just its address, set RENTCAST_API_KEY (a free RentCast key — see the README).
                </p>
              )}
              <div className="mt-3">
                <AddAssetForm
                  addressLookup={addressLookup}
                  defaults={{
                    name: "",
                    kind: "property",
                    value: "",
                    asOf: today,
                    method: addressLookup ? "address" : "home_index",
                    rate: (DEFAULT_VEHICLE_DEPRECIATION_BPS / 100).toFixed(1),
                    zip: "",
                    address: "",
                  }}
                />
              </div>
            </Disclosure>
            {(indexStatus || assets.some((a) => a.valuation.method === "address")) && (
              <p className="text-xs text-muted">
                {assets.some((a) => a.valuation.method === "address") &&
                  `Values from an address: RentCast, re-checked monthly (${rentcastRequestsThisMonth(ctx.db)} of ${RENTCAST_MONTHLY_CAP} lookups used this month). `}
                {indexStatus && (
                  <>
                    ZIP home values: Zillow Home Value Index (ZHVI), from Zillow&apos;s free research data
                    {indexStatus.latestMonth && `, through ${monthName(indexStatus.latestMonth)}`}; the whole national file is
                    downloaded, so no ZIP code is sent anywhere.
                  </>
                )}
              </p>
            )}
          </div>
        </Section>
      </PageBody>
    </>
  );
}
