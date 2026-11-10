import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "./db";
import { AccountError, createFirstAdmin, type Ctx } from "./accounts";
import { addAsset, listAssets, recordAddressEstimate, recordBalance, snapshots, updateAsset, type AssetDetails } from "./finance";
import { homeEstimatesDue, lookUpHome, lookupProblem, refreshHomeEstimates, rentcastRequestsThisMonth, RENTCAST_MONTHLY_CAP } from "./home-estimates";
import { RentcastClient } from "./providers/rentcast";
import type { HttpRequest, Transport } from "./providers/http";

const T0 = Date.UTC(2026, 10, 9, 18);
const DAY = 86_400_000;
let ctx: Ctx;
let alex: number;

beforeEach(async () => {
  ctx = { db: openDatabase(":memory:"), key: randomBytes(32) };
  alex = await createFirstAdmin(ctx.db, { username: "alex", displayName: "Alex", password: "a long enough password" }, T0);
});

const ESTIMATE = {
  price: 512_000,
  priceRangeLow: 470_000,
  priceRangeHigh: 555_000,
  subjectProperty: { formattedAddress: "12 Elm St, Boston, MA 02134", zipCode: "02134" },
  comparables: [],
};

function rentcast(status = 200, body: unknown = ESTIMATE) {
  const seen: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    return { status, body: JSON.stringify(body) };
  };
  return { seen, client: new RentcastClient({ apiKey: "key-1" }, transport) };
}

const home: AssetDetails = {
  name: "Home",
  kind: "property",
  valuation: { valueCents: 500_000_00, asOf: "2026-10-01", method: "address", annualRateBps: 0, zip: "02134", address: "12 Elm St, Boston, MA 02134" },
};

describe("RentcastClient", () => {
  it("asks for the address's value with the key in a header", async () => {
    const { seen, client } = rentcast();
    const estimate = await client.valueEstimate("12 Elm St, Boston, MA 02134");
    expect(estimate).toEqual({
      valueCents: 512_000_00,
      lowCents: 470_000_00,
      highCents: 555_000_00,
      formattedAddress: "12 Elm St, Boston, MA 02134",
      zip: "02134",
    });
    const url = new URL(seen[0].url);
    expect(url.origin + url.pathname).toBe("https://api.rentcast.io/v1/avm/value");
    expect(url.searchParams.get("address")).toBe("12 Elm St, Boston, MA 02134");
    expect(seen[0].headers!["X-Api-Key"]).toBe("key-1");
  });

  it("explains a refused key and an unknown address", async () => {
    const refused = await rentcast(401, { status: 401, error: "auth/api-key-invalid" }).client.valueEstimate("x").catch((e) => e);
    expect(lookupProblem(refused)).toMatch(/RENTCAST_API_KEY/);
    const unknown = await rentcast(200, { price: null }).client.valueEstimate("x").catch((e) => e);
    expect(lookupProblem(unknown)).toMatch(/couldn't find that address/);
  });
});

describe("the monthly cap", () => {
  it("stops before RentCast's free 50, and starts again next month", async () => {
    const { seen, client } = rentcast();
    for (let i = 0; i < RENTCAST_MONTHLY_CAP; i++) await lookUpHome(ctx.db, client, "a, b, c 1", T0);
    await expect(lookUpHome(ctx.db, client, "a, b, c 1", T0)).rejects.toBeInstanceOf(AccountError);
    expect(seen).toHaveLength(RENTCAST_MONTHLY_CAP);
    expect(rentcastRequestsThisMonth(ctx.db, T0)).toBe(RENTCAST_MONTHLY_CAP);
    await lookUpHome(ctx.db, client, "a, b, c 1", T0 + 30 * DAY);
    expect(rentcastRequestsThisMonth(ctx.db, T0 + 30 * DAY)).toBe(1);
  });
});

describe("monthly re-estimates", () => {
  it("look up homes a month old, once a day at most when failing", async () => {
    const id = addAsset(ctx.db, alex, home, T0);
    expect(homeEstimatesDue(ctx.db, T0).map((a) => a.accountId)).toEqual([id]);
    await refreshHomeEstimates(ctx.db, rentcast(503, {}).client, T0);
    expect(listAssets(ctx.db, alex)[0].estimate?.error).toMatch(/tried again tomorrow/);
    expect(listAssets(ctx.db, alex)[0].valuation.valueCents).toBe(500_000_00);
    expect(homeEstimatesDue(ctx.db, T0 + 60_000)).toEqual([]);

    expect(await refreshHomeEstimates(ctx.db, rentcast().client, T0 + DAY)).toBe(1);
    const [asset] = listAssets(ctx.db, alex);
    expect(asset.valuation).toMatchObject({ valueCents: 512_000_00, asOf: "2026-11-10" });
    expect(asset.estimate).toMatchObject({ lowCents: 470_000_00, highCents: 555_000_00, error: null });
    expect(homeEstimatesDue(ctx.db, T0 + 2 * DAY)).toEqual([]);
  });

  it("leave other assets alone", () => {
    addAsset(ctx.db, alex, { ...home, valuation: { ...home.valuation, method: "fixed", address: null } }, T0);
    expect(homeEstimatesDue(ctx.db, T0)).toEqual([]);
  });
});

describe("assets", () => {
  it("keep their history through a rename", () => {
    const id = addAsset(ctx.db, alex, home, T0);
    recordAddressEstimate(ctx.db, id, { valueCents: 500_000_00, lowCents: null, highCents: null, zip: "02134", day: "2026-10-01" }, T0);
    recordBalance(ctx.db, id, "2026-10-15", 500_000_00, null, T0);
    updateAsset(ctx.db, alex, id, { ...home, name: "The house" }, T0, { keepHistory: true });
    expect(snapshots(ctx.db, alex, "2026-12-31", id)).toHaveLength(1);
    expect(listAssets(ctx.db, alex)[0].valuation.address).toBe("12 Elm St, Boston, MA 02134");
  });
});

describe("migration 7", () => {
  it("allows the address method, still checks it, and still cascades", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(7);
    db.exec("INSERT INTO users (id, username, display_name, password_hash, created_at, password_changed_at) VALUES (1,'a','a','x',0,0)");
    db.exec("INSERT INTO accounts (id, user_id, name, institution_name, kind, created_at) VALUES (1,1,'h','h','property',0)");
    db.exec("INSERT INTO asset_valuations (account_id, value_cents, as_of, method, address, updated_at) VALUES (1,1,'2026-01-01','address','x',0)");
    expect(() => db.exec("INSERT INTO asset_valuations (account_id, value_cents, as_of, method, updated_at) VALUES (1,1,'2026-01-01','bogus',0)")).toThrow();
    db.exec("DELETE FROM accounts WHERE id = 1");
    expect(db.prepare("SELECT COUNT(*) AS n FROM asset_valuations").get()).toEqual({ n: 0 });
  });
});
