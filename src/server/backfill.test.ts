import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { createFirstAdmin, createInvite, redeemInvite, type Ctx } from "./accounts";
import { listAccounts, recordBalance, saveConnection, snapshots } from "./finance";
import { saveForecastSettings } from "./planning";
import { syncConnection } from "./sync";
import { PlaidClient, type PlaidInvestmentTransaction, type PlaidTransaction } from "./providers/plaid";
import type { HttpRequest, Transport } from "./providers/http";

const T0 = Date.UTC(2026, 10, 9, 18);
const DAY = 86_400_000;
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

const account = (id: string, type: string, subtype: string, current: number) => ({
  account_id: id,
  name: id,
  official_name: null,
  mask: null,
  type,
  subtype,
  balances: { current, available: null, iso_currency_code: "USD" },
});

function tx(id: string, account: string, date: string, amount: number, pending = false): PlaidTransaction {
  return { transaction_id: id, account_id: account, amount, iso_currency_code: "USD", date, name: id, pending };
}

function move(account: string, date: string, type: string, subtype: string, amount: number): PlaidInvestmentTransaction {
  return { investment_transaction_id: `${account}-${date}-${subtype}`, account_id: account, date, amount, type, subtype, quantity: null, price: null, iso_currency_code: "USD" };
}

/** A fake Plaid answering by path; sync pages and investment answers are handed out in order. */
function fakePlaid(opts: {
  accounts: ReturnType<typeof account>[];
  products: string[];
  syncPages?: Record<string, unknown>[];
  investments?: (PlaidInvestmentTransaction[] | { error: string })[];
}) {
  const seen: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    const path = new URL(req.url).pathname;
    if (path === "/accounts/get") return { status: 200, body: JSON.stringify({ accounts: opts.accounts, item: { institution_name: "Bank" } }) };
    if (path === "/item/get") return { status: 200, body: JSON.stringify({ item: { products: opts.products } }) };
    if (path === "/transactions/sync") {
      const page = opts.syncPages?.shift() ?? { added: [], modified: [], removed: [], next_cursor: "c", has_more: false };
      return { status: 200, body: JSON.stringify(page) };
    }
    if (path === "/investments/transactions/get") {
      const answer = opts.investments?.shift();
      if (!answer) throw new Error("unexpected investments call");
      if ("error" in answer) return { status: 400, body: JSON.stringify({ error_type: "ITEM_ERROR", error_code: answer.error }) };
      const { offset, count } = JSON.parse(req.body!).options;
      return {
        status: 200,
        body: JSON.stringify({ investment_transactions: answer.slice(offset, offset + count), total_investment_transactions: answer.length }),
      };
    }
    return { status: 404, body: "{}" };
  };
  return { seen, providers: { plaid: new PlaidClient({ clientId: "c", secret: "s", environment: "sandbox" }, transport) } };
}

function link(userId = alex) {
  return saveConnection(ctx, { userId, provider: "plaid", externalId: `item-${userId}`, institutionName: "Bank", accessToken: "tok" }, T0);
}

function history(userId: number, name: string) {
  const id = listAccounts(ctx.db, userId).find((a) => a.name === name)!.id;
  return snapshots(ctx.db, userId, "2099-01-01", id).map((s) => [s.day, s.balanceCents, s.estimated]);
}

describe("bank and card backfill", () => {
  it("works balances back from posted transactions, before the first reading only", async () => {
    const { providers } = fakePlaid({
      accounts: [account("chk", "depository", "checking", 1000), account("card", "credit", "credit card", 300)],
      products: ["transactions"],
      syncPages: [
        {
          added: [
            tx("rent", "chk", "2026-11-01", 1500),
            tx("pay", "chk", "2026-10-31", -2000),
            tx("pending", "chk", "2026-11-08", 99, true),
            tx("lunch", "card", "2026-11-05", 40),
            tx("autopay", "card", "2026-11-02", -500),
          ],
          modified: [],
          removed: [],
          next_cursor: "c1",
          has_more: false,
        },
      ],
    });
    await syncConnection(ctx, providers, link(), T0);
    expect(history(alex, "chk")).toEqual([
      ["2026-10-30", 500_00, true],
      ["2026-10-31", 2500_00, true],
      ["2026-11-09", 1000_00, false],
    ]);
    expect(history(alex, "card")).toEqual([
      ["2026-11-01", 760_00, true],
      ["2026-11-04", 260_00, true],
      ["2026-11-09", 300_00, false],
    ]);
  });

  it("is redone as more history arrives, and a real reading replaces an estimate", async () => {
    const { providers } = fakePlaid({
      accounts: [account("chk", "depository", "checking", 1000)],
      products: ["transactions"],
      syncPages: [
        { added: [tx("a", "chk", "2026-11-05", 100)], modified: [], removed: [], next_cursor: "c1", has_more: false },
        { added: [tx("b", "chk", "2026-11-01", 50)], modified: [], removed: [], next_cursor: "c2", has_more: false },
      ],
    });
    const connection = link();
    await syncConnection(ctx, providers, connection, T0);
    await syncConnection(ctx, providers, connection, T0 + DAY);
    expect(history(alex, "chk")).toEqual([
      ["2026-10-31", 1150_00, true],
      ["2026-11-04", 1100_00, true],
      ["2026-11-09", 1000_00, false],
      ["2026-11-10", 1000_00, false],
    ]);
    const id = listAccounts(ctx.db, alex).find((a) => a.name === "chk")!.id;
    recordBalance(ctx.db, id, "2026-11-04", 1234_00, null, T0);
    expect(history(alex, "chk")).toContainEqual(["2026-11-04", 1234_00, false]);
    expect(snapshots(ctx.db, sam, "2099-01-01")).toEqual([]);
  });
});

describe("investment backfill", () => {
  const brokerage = account("ira", "investment", "ira", 10_000);

  it("takes off contributions and assumed growth, once, back to the earliest transaction", async () => {
    saveForecastSettings(ctx.db, alex, { investmentReturnBps: 0, monthlySavingsCents: null }, T0);
    const { seen, providers } = fakePlaid({
      accounts: [brokerage],
      products: ["investments"],
      investments: [
        [
          move("ira", "2026-11-03", "cash", "contribution", -1000),
          move("ira", "2026-11-04", "buy", "buy", 1000),
          move("ira", "2026-11-06", "cash", "dividend", -25),
        ],
      ],
    });
    const connection = link();
    await syncConnection(ctx, providers, connection, T0);
    await syncConnection(ctx, providers, connection, T0 + DAY);
    expect(seen.filter((r) => r.url.endsWith("/investments/transactions/get"))).toHaveLength(1);
    const body = JSON.parse(seen.find((r) => r.url.endsWith("/investments/transactions/get"))!.body!);
    expect(body).toMatchObject({ start_date: "2024-11-09", end_date: "2026-11-09" });
    const rows = history(alex, "ira");
    expect(rows[0]).toEqual(["2026-11-02", 9_000_00, true]);
    expect(rows.find((r) => r[0] === "2026-11-03")).toEqual(["2026-11-03", 10_000_00, true]);
    expect(rows.filter((r) => r[2])).toHaveLength(7);
    expect(rows.at(-1)).toEqual(["2026-11-10", 10_000_00, false]);
  });

  it("tries again next refresh when Plaid isn't ready", async () => {
    const { providers } = fakePlaid({
      accounts: [brokerage],
      products: ["investments"],
      investments: [{ error: "PRODUCT_NOT_READY" }, [move("ira", "2026-11-01", "cash", "deposit", -500)]],
    });
    const connection = link();
    const first = await syncConnection(ctx, providers, connection, T0);
    expect(first.status).toBe("ok");
    expect(history(alex, "ira").filter((r) => r[2])).toEqual([]);
    await syncConnection(ctx, providers, connection, T0 + DAY);
    expect(history(alex, "ira").filter((r) => r[2]).length).toBeGreaterThan(0);
  });

  it("leaves an account with no transactions alone", async () => {
    const { providers } = fakePlaid({ accounts: [brokerage], products: ["investments"], investments: [[]] });
    await syncConnection(ctx, providers, link(), T0);
    expect(history(alex, "ira")).toEqual([["2026-11-09", 10_000_00, false]]);
  });
});
