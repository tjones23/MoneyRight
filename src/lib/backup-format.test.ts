import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backupDay, backupsToKeep, decryptBackup, encryptBackup } from "./backup-format";

const key = randomBytes(32);

describe("backup files", () => {
  it("round-trip, and don't contain the plaintext", () => {
    const db = Buffer.from("SQLite format 3\0 … Total Checking 4462.23 …");
    const file = encryptBackup(key, db);
    expect(file.subarray(0, 4).toString()).toBe("MRBK");
    expect(file.includes(Buffer.from("Total Checking"))).toBe(false);
    expect(decryptBackup(key, file)).toEqual(db);
  });

  it("refuse another key, a damaged file, and anything else", () => {
    const file = encryptBackup(key, Buffer.from("data"));
    expect(() => decryptBackup(randomBytes(32), file)).toThrow(/master.key/);
    const damaged = Buffer.from(file);
    damaged[damaged.length - 1] ^= 1;
    expect(() => decryptBackup(key, damaged)).toThrow();
    expect(() => decryptBackup(key, Buffer.from("PK\u0003\u0004 a zip file, not a backup"))).toThrow(/Not a MoneyRight backup/);
  });

  it("are named by day", () => {
    expect(backupDay("moneyright-2026-10-26.mrbak")).toBe("2026-10-26");
    expect(backupDay("moneyright-2026-10-26.mrbak.partial")).toBeNull();
  });
});

describe("backupsToKeep", () => {
  it("keeps 14 dailies and the newest of each of 12 months", () => {
    const days: string[] = [];
    for (let m = 1; m <= 12; m++) for (let d = 1; d <= 28; d += 3) days.push(`2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    days.push("2025-12-31", "2025-11-30");
    const keep = backupsToKeep(days);
    const newest14 = [...days].sort().reverse().slice(0, 14);
    for (const d of newest14) expect(keep.has(d)).toBe(true);
    expect(keep.has("2026-01-28")).toBe(true); // January's newest
    expect(keep.has("2026-01-01")).toBe(false);
    expect(keep.has("2025-12-31")).toBe(false); // a 13th month
    expect(keep.size).toBe(14 + 10); // the two newest months are already among the dailies
  });
});
