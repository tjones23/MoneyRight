import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext, ensureSetupCode, readSetupCode } from "./context";
import { createFirstAdmin } from "./accounts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moneyright-test-"));
  delete process.env.MONEYRIGHT_MASTER_KEY;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createContext", () => {
  it("makes a private key and database on first run, and reuses them", () => {
    const first = createContext(dir);
    expect(statSync(join(dir, "master.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "moneyright.db")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    first.db.close();
    expect(createContext(dir).key).toEqual(first.key);
  });

  it("refuses to invent a new key for an existing database", () => {
    createContext(dir).db.close();
    rmSync(join(dir, "master.key"));
    expect(() => createContext(dir)).toThrow(/restore the key/);
  });
});

describe("setup code", () => {
  it("exists only until the first account does", async () => {
    const ctx = createContext(dir);
    const code = ensureSetupCode(ctx)!;
    expect(code).toMatch(/^[A-Z2-7-]{19}$/);
    expect(ensureSetupCode(ctx)).toBe(code);
    expect(readFileSync(join(dir, "setup-code"), "utf8").trim()).toBe(code);
    expect(statSync(join(dir, "setup-code")).mode & 0o777).toBe(0o600);

    await createFirstAdmin(ctx.db, { username: "alex", displayName: "Alex", password: "a long enough password" }, 0);
    expect(ensureSetupCode(ctx)).toBeNull();
    expect(readSetupCode(ctx)).toBeNull();
  });
});

describe("second factor", () => {
  it("is skipped only for the dev server's own database", () => {
    expect(createContext(join(dir, "dev"), "development").secondFactorRequired).toBe(false);
    expect(createContext(join(dir, "prod"), "production").secondFactorRequired).toBe(true);
  });

  it("is required when the dev server opens a production database", () => {
    createContext(join(dir, "prod"), "production").db.close();
    expect(createContext(join(dir, "prod"), "development").secondFactorRequired).toBe(true);
  });

  it("is required when production opens a dev database", () => {
    createContext(join(dir, "dev"), "development").db.close();
    expect(createContext(join(dir, "dev"), "production").secondFactorRequired).toBe(true);
  });

  it("treats an unstamped database outside the dev directory as production", () => {
    const ctx = createContext(join(dir, "old"), "development");
    ctx.db.exec("DELETE FROM meta");
    ctx.db.close();
    expect(createContext(join(dir, "old"), "development").secondFactorRequired).toBe(true);
  });
});
