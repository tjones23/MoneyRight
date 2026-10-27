import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "./context";
import { createFirstAdmin, createInvite, createSession, findSession, listUsers, redeemInvite } from "./accounts";
import { addScheduledLoan, listAccounts, recordBalance, saveConnection, saveLinkedAccounts } from "./finance";
import { deleteFinancialData, deleteOwnAccount, exportUserData, removePerson } from "./my-data";
import { listBackups, makeBackup } from "./backup";
import { finishRegistration, startAuthentication, startRegistration } from "./passkeys";
import { decryptBackup } from "@/lib/backup-format";

const T0 = Date.UTC(2026, 9, 26, 18);
const none = { plaid: null };
let dir: string;
let ctx: AppContext;
let alex: number;
let sam: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "moneyright-mydata-"));
  delete process.env.MONEYRIGHT_BACKUP_DIR;
  ctx = createContext(join(dir, "production"), "production");
  alex = await createFirstAdmin(ctx.db, { username: "alex", displayName: "Alex", password: "a long enough password" }, T0);
  sam = await redeemInvite(ctx.db, createInvite(ctx.db, alex, "", T0), { username: "sam", displayName: "Sam", password: "another long password" }, T0);
  const c = saveConnection(ctx, { userId: alex, provider: "plaid", externalId: "item_1", institutionName: "Chase", accessToken: "token_secret_value" }, T0);
  const ids = saveLinkedAccounts(ctx.db, c, [{ externalId: "a1", name: "Checking", kind: "cash", subtype: null, mask: "1234", currency: "USD" }], T0);
  recordBalance(ctx.db, ids.get("a1")!, "2026-10-26", 1234_56, null, T0);
  addScheduledLoan(ctx.db, alex, { name: "Direct Unsub", servicer: "MOHELA", schedule: { principalCents: 100_00, accruedInterestCents: 0, annualRateBps: 500, monthlyPaymentCents: 10_00, paymentDay: 1, anchorDate: "2026-10-01" } }, T0);
});
afterEach(() => {
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("export", () => {
  it("has the person's data and none of their secrets", () => {
    const data = exportUserData(ctx, alex);
    expect(data.accounts.map((a) => a.name).sort()).toEqual(["Checking", "Direct Unsub"]);
    expect(data.balances).toContainEqual({ accountId: data.accounts.find((a) => a.name === "Checking")!.id, day: "2026-10-26", balance: 1234.56 });
    expect(data.loanSchedules[0]).toMatchObject({ servicer: "MOHELA", ratePercent: 5 });
    const text = JSON.stringify(data);
    expect(text).not.toContain("token_secret_value");
    expect(text).not.toMatch(/argon2|password_hash|totp/i);
    expect(JSON.stringify(exportUserData(ctx, sam).accounts)).toBe("[]");
  });
});

describe("deleting", () => {
  it("financial data keeps the login", async () => {
    await deleteFinancialData(ctx, none, alex, T0);
    expect(listAccounts(ctx.db, alex)).toEqual([]);
    expect(listUsers(ctx.db).map((u) => u.username)).toEqual(["alex", "sam"]);
  });

  it("an account needs the password, and never strands people without an admin", async () => {
    await expect(deleteOwnAccount(ctx, none, alex, "wrong password!!")).rejects.toThrow(/password/);
    await expect(deleteOwnAccount(ctx, none, alex, "a long enough password")).rejects.toThrow(/only admin/);
    await deleteOwnAccount(ctx, none, sam, "another long password");
    await deleteOwnAccount(ctx, none, alex, "a long enough password");
    expect(listUsers(ctx.db)).toEqual([]);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM balance_snapshots").get()).toEqual({ n: 0 });
  });

  it("someone else takes an admin and their username typed out", async () => {
    await expect(removePerson(ctx, none, sam, alex, "alex", T0)).rejects.toThrow(/admin/);
    await expect(removePerson(ctx, none, alex, sam, "nope", T0)).rejects.toThrow(/Type/);
    await removePerson(ctx, none, alex, sam, "SAM", T0);
    expect(listUsers(ctx.db).map((u) => u.username)).toEqual(["alex"]);
  });
});

describe("backups", () => {
  it("are encrypted copies that restore to the same database", async () => {
    const path = await makeBackup(ctx, T0);
    expect(path).toContain(join(dir, "backups", "production"));
    const restored = join(dir, "restored.db");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(restored, decryptBackup(ctx.key, readFileSync(path)));
    const db = new DatabaseSync(restored);
    expect(db.prepare("SELECT username FROM users ORDER BY id").all().map((r) => r.username)).toEqual(["alex", "sam"]);
    db.close();
    expect(listBackups(ctx)).toHaveLength(1);
    // The plain copy never outlives the backup.
    expect(readdirSync(join(dir, "production")).filter((n) => n.startsWith(".backup-"))).toEqual([]);
  });

  it("replace the same day's, and go where MONEYRIGHT_BACKUP_DIR says", async () => {
    process.env.MONEYRIGHT_BACKUP_DIR = join(dir, "elsewhere");
    await makeBackup(ctx, T0);
    await makeBackup(ctx, T0 + 1000);
    expect(readdirSync(join(dir, "elsewhere"))).toEqual(["moneyright-2026-10-26.mrbak"]);
    delete process.env.MONEYRIGHT_BACKUP_DIR;
  });
});

describe("passkeys", () => {
  const rp = { id: "localhost", origin: "http://localhost:3002" };

  it("offer nothing to sign in with until one exists", async () => {
    const token = createSession(ctx.db, alex, "password", { userAgent: null, tailnetLogin: null }, T0);
    const { session } = findSession(ctx.db, token, null, T0)!;
    expect(await startAuthentication(ctx.db, session, rp, T0)).toBeNull();
  });

  it("refuse a registration whose challenge has expired", async () => {
    const token = createSession(ctx.db, alex, "full", { userAgent: null, tailnetLogin: null }, T0);
    const { session, user } = findSession(ctx.db, token, null, T0)!;
    const options = await startRegistration(ctx.db, session, user, rp, T0);
    expect(options.rp.id).toBe("localhost");
    const fake = { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "", attestationObject: "" }, clientExtensionResults: {} };
    await expect(
      finishRegistration(ctx.db, session, user, fake as never, rp, "Phone", T0 + 6 * 60_000),
    ).rejects.toThrow(/too long/);
  });

  it("refuse a forged registration, and spend the challenge", async () => {
    const token = createSession(ctx.db, alex, "full", { userAgent: null, tailnetLogin: null }, T0);
    const { session, user } = findSession(ctx.db, token, null, T0)!;
    await startRegistration(ctx.db, session, user, rp, T0);
    const fake = { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "AA" }, clientExtensionResults: {} };
    await expect(finishRegistration(ctx.db, session, user, fake as never, rp, "Phone", T0)).rejects.toThrow(/couldn't be verified/);
    await expect(finishRegistration(ctx.db, session, user, fake as never, rp, "Phone", T0)).rejects.toThrow(/too long/);
  });
});
