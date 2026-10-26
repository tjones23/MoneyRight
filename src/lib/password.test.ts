import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "./password";

describe("passwords", () => {
  it("verifies the right password and only that", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password!")).not.toBe(await hashPassword("same password!"));
  });

  it("reads its own parameters back, and flags weaker ones", async () => {
    const hash = await hashPassword("another password");
    expect(needsRehash(hash)).toBe(false);
    expect(needsRehash(hash.replace("t=2", "t=1"))).toBe(true);
  });

  it("treats a malformed hash as a mismatch", async () => {
    expect(await verifyPassword("anything", "plaintext")).toBe(false);
  });

  it("requires a length", () => {
    expect(passwordProblem("short")).not.toBeNull();
    expect(passwordProblem("twelve chars")).toBeNull();
    expect(passwordProblem("x".repeat(257))).not.toBeNull();
  });
});
