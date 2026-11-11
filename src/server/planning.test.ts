import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { createFirstAdmin, createInvite, redeemInvite, type Ctx } from "./accounts";
import { addAsset, addScheduledLoan, assetLoans, listAccounts, saveConnection, setAssetLoans } from "./finance";
import { addGoal, deleteGoal, forecastAccounts, forecastSettings, listGoals, saveForecastSettings } from "./planning";
import { listTransactions, transactionsStatus } from "./transactions";
import { syncConnection } from "./sync";
import { deleteFinancialData, exportUserData } from "./my-data";
import { PlaidClient, type PlaidTransaction } from "./providers/plaid";
import type { HttpRequest, Transport } from "./providers/http";

const T0 = Date.UTC(2026, 10, 9, 18);
let ctx: Ctx;
let alex: number;
let sam: number;

beforeEach(async () => {
  ctx = { db: openDatabase(":memory:"), key: randomBytes(32) };
  alex = await createFirstAdmin(ctx.db, { username: "alex", displayName: "Alex", password: "a long enough password" }, T0);
  sam = await redeemInvite(
    ctx.db,
    createInvite(ctx.db, alex, "", T0),
    { username: "sam", displayName: "Sam", password: "another long password" },
    T0,
  );
});

const plaidAccounts = {
  accounts: [
    { account_id: "chk", name: "Checking", official_name: null, mask: "1111", type: "depository", subtype: "checking", balances: { current: 5000, available: 5000, iso_currency_code: "USD" } },
    { account_id: "mtg", name: "Mortgage", official_name: null, mask: "2222", type: "loan", subtype: "mortgage", balances: { current: 250000, available: null, iso_currency_code: "USD" } },
  ],
  item: { institution_name: "Bank" },
};

function tx(id: string, amount: number, more: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return { transaction_id: id, account_id: "chk", amount, iso_currency_code: "USD", date: "2026-11-02", name: "COFFEE", merchant_name: "Coffee", pending: false, personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" }, ...more };
}

/** A fake Plaid answering by path; sync pages are handed out in order. */
function fakePlaid(products: string[], syncPages: (Record<string, unknown> | { error: string })[] = []) {
  const seen: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    const path = new URL(req.url).pathname;
    if (path === "/accounts/get") return { status: 200, body: JSON.stringify(plaidAccounts) };
    if (path === "/item/get") return { status: 200, body: JSON.stringify({ item: { products } }) };
    if (path === "/transactions/sync") {
      const page = syncPages.shift();
      if (!page) throw new Error("unexpected sync call");
      if ("error" in page) return { status: 400, body: JSON.stringify({ error_type: "TRANSACTIONS_ERROR", error_code: page.error }) };
      return { status: 200, body: JSON.stringify(page) };
    }
    return { status: 404, body: "{}" };
  };
  return { seen, providers: { plaid: new PlaidClient({ clientId: "c", secret: "s", environment: "sandbox" }, transport) } };
}

function link(userId = alex) {
  return saveConnection(ctx, { userId, provider: "plaid", externalId: `item-${userId}`, institutionName: "Bank", accessToken: "tok" }, T0);
}

const page = (added: PlaidTransaction[], more: Record<string, unknown> = {}) => ({ added, modified: [], removed: [], next_cursor: "c1", has_more: false, ...more });

describe("transactions", () => {
  it("are never asked for on an Item without Transactions — asking would add the product", async () => {
    const { seen, providers } = fakePlaid(["liabilities"]);
    await syncConnection(ctx, providers, link(), T0);
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual(["/accounts/get", "/item/get"]);
    expect(transactionsStatus(ctx.db, alex).connections).toBe(0);
  });

  it("are synced, changed and removed through the cursor", async () => {
    const { seen, providers } = fakePlaid(["transactions"], [
      page([tx("t1", 4.5), tx("t2", -2000, { name: "PAYROLL", merchant_name: null, personal_finance_category: { primary: "INCOME", detailed: "INCOME_WAGES" } })]),
      { added: [], modified: [tx("t1", 5.25)], removed: [{ transaction_id: "t2" }], next_cursor: "c2", has_more: false },
    ]);
    const connection = link();
    await syncConnection(ctx, providers, connection, T0);
    expect(listTransactions(ctx.db, alex).map((t) => [t.name, t.amountCents])).toEqual([["PAYROLL", -2000_00], ["COFFEE", 4_50]]);
    await syncConnection(ctx, providers, connection, T0 + 86_400_000);
    expect(listTransactions(ctx.db, alex).map((t) => [t.name, t.amountCents])).toEqual([["COFFEE", 5_25]]);
    const second = seen.filter((r) => r.url.endsWith("/transactions/sync"))[1];
    expect(JSON.parse(second.body!).cursor).toBe("c1");
    expect(listTransactions(ctx.db, sam)).toEqual([]);
  });

  it("restart from the first cursor when Plaid's data changes mid-way", async () => {
    const { seen, providers } = fakePlaid(["transactions"], [
      page([tx("t1", 1)], { has_more: true, next_cursor: "p2" }),
      { error: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" },
      page([tx("t1", 1)], { has_more: true, next_cursor: "p2" }),
      page([tx("t3", 3)]),
    ]);
    await syncConnection(ctx, providers, link(), T0);
    const cursors = seen.filter((r) => r.url.endsWith("/transactions/sync")).map((r) => JSON.parse(r.body!).cursor ?? null);
    expect(cursors).toEqual([null, "p2", null, "p2"]);
    expect(listTransactions(ctx.db, alex)).toHaveLength(2);
  });

  it("failing doesn't fail the balances", async () => {
    const { providers } = fakePlaid(["transactions"], [{ error: "INTERNAL_SERVER_ERROR" }]);
    const result = await syncConnection(ctx, providers, link(), T0);
    expect(result.status).toBe("ok");
    expect(listAccounts(ctx.db, alex).find((a) => a.name === "Checking")?.balanceCents).toBe(5000_00);
  });

  it("go with the financial data, as do goals and assumptions", async () => {
    const { providers } = fakePlaid(["transactions"], [page([tx("t1", 1)])]);
    await syncConnection(ctx, providers, link(), T0);
    addGoal(ctx.db, alex, { name: "1M", accountId: null, targetCents: 1_000_000_00, targetDate: null }, T0);
    saveForecastSettings(ctx.db, alex, { investmentReturnBps: 700, monthlySavingsCents: null }, T0);
    expect(exportUserData(ctx, alex).transactions).toHaveLength(1);
    await deleteFinancialData(ctx, { plaid: null }, alex, T0);
    expect(listTransactions(ctx.db, alex)).toEqual([]);
    expect(listGoals(ctx.db, alex)).toEqual([]);
    expect(forecastSettings(ctx.db, alex).investmentReturnBps).toBe(500);
  });
});

describe("equity", () => {
  const house = {
    name: "House",
    kind: "property" as const,
    valuation: { valueCents: 400_000_00, asOf: "2026-11-01", method: "fixed" as const, annualRateBps: 0, zip: null },
  };

  it("sets a user's own loans against their asset, moving a loan between assets", async () => {
    const { providers } = fakePlaid([]);
    await syncConnection(ctx, providers, link(), T0);
    const mortgage = listAccounts(ctx.db, alex).find((a) => a.kind === "mortgage")!.id;
    const home = addAsset(ctx.db, alex, house, T0);
    const cabin = addAsset(ctx.db, alex, { ...house, name: "Cabin" }, T0);
    setAssetLoans(ctx.db, alex, home, [mortgage]);
    expect(assetLoans(ctx.db, alex).get(home)).toEqual([mortgage]);
    setAssetLoans(ctx.db, alex, cabin, [mortgage]);
    expect(assetLoans(ctx.db, alex).get(home)).toBeUndefined();
    expect(assetLoans(ctx.db, alex).get(cabin)).toEqual([mortgage]);
  });

  it("refuses someone else's loan, a card or a cash account", async () => {
    const { providers } = fakePlaid([]);
    await syncConnection(ctx, providers, link(sam), T0);
    const samsMortgage = listAccounts(ctx.db, sam).find((a) => a.kind === "mortgage")!.id;
    const checking = listAccounts(ctx.db, sam).find((a) => a.kind === "cash")!.id;
    const home = addAsset(ctx.db, alex, house, T0);
    expect(() => setAssetLoans(ctx.db, alex, home, [samsMortgage])).toThrow(/your own loans/);
    const samsHome = addAsset(ctx.db, sam, house, T0);
    expect(() => setAssetLoans(ctx.db, sam, samsHome, [checking])).toThrow(/your own loans/);
    expect(() => setAssetLoans(ctx.db, alex, samsHome, [])).toThrow(/doesn't exist/);
  });
});

describe("goals and the forecast's inputs", () => {
  it("are the user's own", () => {
    const loan = addScheduledLoan(
      ctx.db,
      alex,
      { name: "Direct", servicer: "MOHELA", schedule: { principalCents: 10_000_00, accruedInterestCents: 0, annualRateBps: 500, monthlyPaymentCents: 200_00, paymentDay: 1, anchorDate: "2026-11-01" } },
      T0,
    );
    expect(() => addGoal(ctx.db, sam, { name: "x", accountId: loan, targetCents: 0, targetDate: null }, T0)).toThrow();
    const id = addGoal(ctx.db, alex, { name: "Pay it off", accountId: loan, targetCents: 0, targetDate: "2030-01-01" }, T0);
    deleteGoal(ctx.db, sam, id);
    expect(listGoals(ctx.db, alex)).toHaveLength(1);
    expect(forecastAccounts(ctx.db, alex, "2026-11-09")).toEqual([
      expect.objectContaining({ id: loan, kind: "student_loan", method: expect.objectContaining({ type: "schedule" }) }),
    ]);
    expect(forecastAccounts(ctx.db, sam, "2026-11-09")).toEqual([]);
  });
});
