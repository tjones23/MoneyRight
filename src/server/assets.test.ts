import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { createFirstAdmin, createInvite, redeemInvite, type Ctx } from "./accounts";
import { addAsset, deleteAsset, listAccounts, listAssets, snapshots, updateAsset, type AssetDetails } from "./finance";
import { homeIndex, homeIndexDue, homeIndexStatus, parseCsvLine, readZhvi, HOME_INDEX_EVERY_MS } from "./home-index";
import { syncAssets, syncHomeIndex } from "./sync";
import { exportUserData } from "./my-data";

const T0 = Date.UTC(2026, 9, 26, 18);
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

const house: AssetDetails = {
  name: "House",
  kind: "property",
  valuation: { valueCents: 400_000_00, asOf: "2026-06-15", method: "home_index", annualRateBps: 0, zip: "02134" },
};
const car: AssetDetails = {
  name: "RAV4",
  kind: "vehicle",
  valuation: { valueCents: 24_000_00, asOf: "2026-10-26", method: "depreciation", annualRateBps: 1500, zip: null },
};

const CSV = [
  'RegionID,SizeRank,RegionName,RegionType,StateName,State,City,Metro,CountyName,2026-05-31,2026-06-30,2026-09-30',
  '1,0,77494,zip,TX,TX,Katy,"Houston-The Woodlands-Sugar Land, TX",Fort Bend County,300000,301000,302000',
  '2,1,02134,zip,MA,MA,Boston,"Boston-Cambridge-Newton, MA-NH",Suffolk County,,800000,820000',
];

async function* lines(rows: string[]) {
  yield* rows;
}

describe("the ZHVI file", () => {
  it("parses quoted fields", () => {
    expect(parseCsvLine('a,"b, c","say ""hi""",')).toEqual(["a", "b, c", 'say "hi"', ""]);
  });

  it("keeps only the wanted ZIPs, skipping empty months", async () => {
    const found = await readZhvi(lines(CSV), new Set(["02134"]));
    expect([...found.keys()]).toEqual(["02134"]);
    expect(found.get("02134")).toEqual([
      { month: "2026-06", value: 800000 },
      { month: "2026-09", value: 820000 },
    ]);
  });

  it("refuses a file that isn't the index", async () => {
    await expect(readZhvi(lines(["a,b,c", "1,2,3"]), new Set(["1"]))).rejects.toThrow(/RegionName/);
  });
});

describe("assets", () => {
  it("are accounts of their own kind, estimated", () => {
    addAsset(ctx.db, alex, car, T0);
    const [account] = listAccounts(ctx.db, alex);
    expect(account).toMatchObject({ name: "RAV4", kind: "vehicle", institutionName: "Vehicle", source: "estimate" });
    expect(listAccounts(ctx.db, sam)).toEqual([]);
  });

  it("record today's estimate on each refresh", () => {
    const id = addAsset(ctx.db, alex, car, T0);
    syncAssets(ctx, T0 + 365 * DAY, alex);
    const [s] = snapshots(ctx.db, alex, "2030-01-01", id);
    expect(s.balanceCents).toBe(20_402_27); // 15% a year, compounded over 365 of 365.25 days
  });

  it("can be updated and deleted only by their owner", () => {
    const id = addAsset(ctx.db, alex, car, T0);
    expect(() => updateAsset(ctx.db, sam, id, { ...car, name: "Mine now" }, T0)).toThrow();
    deleteAsset(ctx.db, sam, id);
    expect(listAssets(ctx.db, alex)).toHaveLength(1);
    updateAsset(ctx.db, alex, id, { ...car, valuation: { ...car.valuation, valueCents: 22_000_00 } }, T0);
    expect(listAssets(ctx.db, alex)[0].valuation.valueCents).toBe(22_000_00);
    deleteAsset(ctx.db, alex, id);
    expect(listAccounts(ctx.db, alex)).toEqual([]);
  });

  it("are in the export", () => {
    addAsset(ctx.db, alex, house, T0);
    expect(exportUserData(ctx, alex).assets).toEqual([
      expect.objectContaining({ name: "House", kind: "property", zip: "02134", method: "home_index", value: 400_000 }),
    ]);
  });
});

describe("the home value index", () => {
  it("is only fetched when someone has a home on it", () => {
    addAsset(ctx.db, alex, car, T0);
    expect(homeIndexDue(ctx.db, T0)).toBe(false);
    addAsset(ctx.db, alex, house, T0);
    expect(homeIndexDue(ctx.db, T0)).toBe(true);
  });

  it("moves a home's estimate once fetched, then waits a week", async () => {
    const id = addAsset(ctx.db, alex, house, T0);
    syncAssets(ctx, T0, alex);
    expect(snapshots(ctx.db, alex, "2026-12-31", id).at(-1)?.balanceCents).toBe(400_000_00);

    let fetched = 0;
    await syncHomeIndex(ctx, T0, () => (fetched++, lines(CSV)));
    expect(fetched).toBe(1);
    expect(homeIndex(ctx.db, "02134")).toHaveLength(2);
    expect(homeIndex(ctx.db, "77494")).toEqual([]);
    expect(homeIndexStatus(ctx.db)).toMatchObject({ error: null, latestMonth: "2026-09" });
    // Valued in June at 800,000; the September reading is 820,000.
    expect(snapshots(ctx.db, alex, "2026-12-31", id).at(-1)?.balanceCents).toBe(410_000_00);

    expect(homeIndexDue(ctx.db, T0 + DAY)).toBe(false);
    expect(homeIndexDue(ctx.db, T0 + HOME_INDEX_EVERY_MS)).toBe(true);
  });

  it("records a failed download and keeps estimating", async () => {
    const id = addAsset(ctx.db, alex, house, T0);
    await syncHomeIndex(ctx, T0, () => lines(["not,the,file"]));
    expect(homeIndexStatus(ctx.db).error).toMatch(/RegionName/);
    expect(snapshots(ctx.db, alex, "2026-12-31", id).at(-1)?.balanceCents).toBe(400_000_00);
    expect(homeIndexDue(ctx.db, T0 + 60_000)).toBe(false);
  });

  it("forgets a ZIP once no home uses it", async () => {
    const id = addAsset(ctx.db, alex, house, T0);
    await syncHomeIndex(ctx, T0, () => lines(CSV));
    deleteAsset(ctx.db, alex, id);
    expect(homeIndex(ctx.db, "02134")).toEqual([]);
  });
});
