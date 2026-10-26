import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { createFirstAdmin, createInvite, redeemInvite, type Ctx } from "./accounts";
import {
  addScheduledLoan,
  connectionToken,
  connectionsDue,
  countPlaidItem,
  deleteAccount,
  deleteConnection,
  getConnection,
  listAccounts,
  listScheduledLoans,
  plaidItemsUsed,
  recordAttempt,
  recordBalance,
  saveConnection,
  saveLinkedAccounts,
  setIncludeInNetWorth,
  snapshots,
  updateScheduledLoan,
} from "./finance";
import { syncConnection, syncDue, syncScheduledLoans, type Providers } from "./sync";
import { TellerClient } from "./providers/teller";
import { PlaidClient } from "./providers/plaid";
import type { Transport } from "./providers/http";

const T0 = Date.UTC(2026, 9, 26, 18);
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

function link(userId = alex, externalId = "enr_1") {
  return saveConnection(
    ctx,
    { userId, provider: "teller", externalId, institutionName: "Chase", accessToken: "token_secret" },
    T0,
  );
}

const checking = { externalId: "acc_1", name: "Checking", kind: "cash" as const, subtype: "checking", mask: "1234", currency: "USD" };
const card = { externalId: "acc_2", name: "Sapphire", kind: "credit" as const, subtype: "credit_card", mask: "9876", currency: "USD" };

describe("connections", () => {
  it("seal the token, and open it only for the same connection", () => {
    const c = link();
    const row = ctx.db.prepare("SELECT access_token FROM connections").get() as { access_token: string };
    expect(row.access_token).not.toContain("token_secret");
    expect(connectionToken(ctx, c)).toBe("token_secret");
  });

  it("are scoped to their owner", () => {
    const c = link();
    expect(getConnection(ctx.db, sam, c.id)).toBeNull();
    deleteConnection(ctx.db, sam, c.id);
    expect(getConnection(ctx.db, alex, c.id)).not.toBeNull();
  });

  it("can't be claimed by a second person", () => {
    link(alex);
    expect(() => link(sam)).toThrow(/someone else/);
  });

  it("are due daily, or hourly after a passing failure", () => {
    const c = link();
    expect(connectionsDue(ctx.db, T0, T0).map((x) => x.id)).toEqual([c.id]);
    recordAttempt(ctx.db, c.id, { status: "ok" }, T0);
    expect(connectionsDue(ctx.db, T0, T0)).toEqual([]);
    recordAttempt(ctx.db, c.id, { status: "error", code: "http_502" }, T0);
    expect(connectionsDue(ctx.db, T0 - 1, T0 + 1).map((x) => x.id)).toEqual([c.id]);
  });
});

describe("accounts and balances", () => {
  it("mark an account gone when the provider stops reporting it", () => {
    const c = link();
    saveLinkedAccounts(ctx.db, c, [checking, card], T0);
    saveLinkedAccounts(ctx.db, c, [checking], T0);
    const accounts = listAccounts(ctx.db, alex);
    expect(accounts.find((a) => a.name === "Sapphire")?.gone).toBe(true);
    expect(accounts.find((a) => a.name === "Checking")?.gone).toBe(false);
  });

  it("keep one snapshot a day, the latest winning", () => {
    const c = link();
    const ids = saveLinkedAccounts(ctx.db, c, [checking], T0);
    const id = ids.get("acc_1")!;
    recordBalance(ctx.db, id, "2026-10-01", 100_00, null, T0);
    recordBalance(ctx.db, id, "2026-10-26", 150_00, null, T0);
    recordBalance(ctx.db, id, "2026-10-26", 175_00, null, T0 + 1);
    expect(listAccounts(ctx.db, alex)[0]).toMatchObject({ balanceCents: 175_00, balanceDay: "2026-10-26" });
    expect(snapshots(ctx.db, alex, "2026-10-15").map((s) => s.balanceCents)).toEqual([100_00]);
    expect(snapshots(ctx.db, sam, "2026-10-26")).toEqual([]);
  });

  it("only change for their owner", () => {
    const ids = saveLinkedAccounts(ctx.db, link(), [checking], T0);
    setIncludeInNetWorth(ctx.db, sam, ids.get("acc_1")!, false);
    expect(listAccounts(ctx.db, alex)[0].includeInNetWorth).toBe(true);
    expect(listAccounts(ctx.db, sam)).toEqual([]);
  });

  it("can't delete a live linked account, only a gone one", () => {
    const c = link();
    const ids = saveLinkedAccounts(ctx.db, c, [checking, card], T0);
    expect(() => deleteAccount(ctx.db, alex, ids.get("acc_1")!)).toThrow(/next refresh/);
    saveLinkedAccounts(ctx.db, c, [checking], T0);
    deleteAccount(ctx.db, alex, ids.get("acc_2")!);
    expect(listAccounts(ctx.db, alex)).toHaveLength(1);
  });
});

describe("Plaid's item counter", () => {
  it("counts up and never down", () => {
    expect(plaidItemsUsed(ctx.db)).toBe(0);
    countPlaidItem(ctx.db);
    countPlaidItem(ctx.db);
    expect(plaidItemsUsed(ctx.db)).toBe(2);
  });
});

describe("scheduled loans", () => {
  const schedule = {
    principalCents: 10_000_00,
    accruedInterestCents: 0,
    annualRateBps: 600,
    monthlyPaymentCents: 200_00,
    paymentDay: 15,
    anchorDate: "2026-01-15",
  };

  it("project into today's snapshot, and re-anchor", () => {
    const id = addScheduledLoan(ctx.db, alex, { name: "Direct Unsub", servicer: "MOHELA", schedule }, T0);
    syncScheduledLoans(ctx, T0, alex);
    const projected = listAccounts(ctx.db, alex)[0];
    expect(projected).toMatchObject({ source: "schedule", kind: "student_loan" });
    expect(projected.balanceCents!).toBeLessThan(10_000_00);

    updateScheduledLoan(ctx.db, alex, id, { name: "Direct Unsub", servicer: "MOHELA", schedule: { ...schedule, principalCents: 5_000_00, anchorDate: "2026-10-26" } }, T0);
    expect(listAccounts(ctx.db, alex)[0].balanceCents).toBeNull(); // today's old projection dropped
    syncScheduledLoans(ctx, T0, alex);
    expect(listAccounts(ctx.db, alex)[0].balanceCents).toBe(5_000_00);
    expect(() => updateScheduledLoan(ctx.db, sam, id, { name: "x", servicer: "y", schedule }, T0)).toThrow();
    expect(listScheduledLoans(ctx.db, sam)).toEqual([]);
  });
});

describe("sync", () => {
  function tellerFake(routes: Record<string, { status: number; body: unknown }>): Providers {
    const transport: Transport = async (req) => {
      const path = new URL(req.url).pathname;
      const route = routes[path] ?? { status: 404, body: { error: { code: "not_found" } } };
      return { status: route.status, body: JSON.stringify(route.body) };
    };
    const config = { applicationId: "app", environment: "sandbox" as const, certificate: null, privateKey: null, signingKey: null };
    return { teller: new TellerClient(config, transport), plaid: null };
  }

  const tellerAccount = (id: string, type: string, status = "open") => ({
    id,
    enrollment_id: "enr_1",
    name: id,
    type,
    subtype: type === "credit" ? "credit_card" : "checking",
    last_four: "0001",
    currency: "USD",
    status,
    institution: { id: "chase", name: "Chase" },
  });

  it("writes today's balance for each open account", async () => {
    const providers = tellerFake({
      "/accounts": { status: 200, body: [tellerAccount("acc_1", "depository"), tellerAccount("acc_2", "credit"), tellerAccount("acc_3", "depository", "closed")] },
      "/accounts/acc_1/balances": { status: 200, body: { account_id: "acc_1", ledger: "1000.50", available: "900.00" } },
      "/accounts/acc_2/balances": { status: 200, body: { account_id: "acc_2", ledger: "250.00", available: null } },
    });
    const result = await syncConnection(ctx, providers, link(), T0);
    expect(result).toEqual({ status: "ok", code: null, accounts: 2 });
    const accounts = listAccounts(ctx.db, alex);
    expect(accounts.map((a) => [a.name, a.kind, a.balanceCents])).toEqual([
      ["acc_1", "cash", 1000_50],
      ["acc_2", "credit", 250_00],
    ]);
  });

  it("marks a disconnected enrollment for reconnecting, and doesn't throw", async () => {
    const providers = tellerFake({
      "/accounts": { status: 404, body: { error: { code: "enrollment.disconnected.user_action.mfa_required" } } },
    });
    const c = link();
    expect(await syncConnection(ctx, providers, c, T0)).toMatchObject({ status: "reconnect" });
    expect(getConnection(ctx.db, alex, c.id)).toMatchObject({ status: "reconnect", statusCode: "enrollment.disconnected.user_action.mfa_required" });
  });

  it("records a missing provider as a passing error", async () => {
    const c = saveConnection(ctx, { userId: alex, provider: "plaid", externalId: "item", institutionName: "Fidelity", accessToken: "a" }, T0);
    expect(await syncDue(ctx, { teller: null, plaid: null }, T0)).toBe(1);
    expect(getConnection(ctx.db, alex, c.id)).toMatchObject({ status: "error", statusCode: "not_configured" });
  });

  it("reads Plaid's cached balances", async () => {
    const transport: Transport = async () => ({
      status: 200,
      body: JSON.stringify({
        accounts: [
          { account_id: "p1", name: "Brokerage", official_name: null, mask: "11", type: "investment", subtype: "brokerage", balances: { current: 50123.45, available: null, iso_currency_code: "USD" } },
          { account_id: "p2", name: "Mortgage", official_name: null, mask: "22", type: "loan", subtype: "mortgage", balances: { current: 301000, available: null, iso_currency_code: "USD" } },
        ],
        item: { institution_name: "Fidelity" },
      }),
    });
    const plaid = new PlaidClient({ clientId: "c", secret: "s", environment: "sandbox" }, transport);
    const c = saveConnection(ctx, { userId: alex, provider: "plaid", externalId: "item", institutionName: "Fidelity", accessToken: "a" }, T0);
    await syncConnection(ctx, { teller: null, plaid }, c, T0);
    expect(listAccounts(ctx.db, alex).map((a) => [a.kind, a.balanceCents])).toEqual([
      ["investment", 50123_45],
      ["mortgage", 301000_00],
    ]);
  });
});
