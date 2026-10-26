import { describe, expect, it } from "vitest";
import { hashRecoveryCode, newRecoveryCodes, newSetupCode, newToken, normalizeSetupCode } from "./tokens";

describe("tokens", () => {
  it("makes long, distinct tokens", () => {
    expect(newToken()).toMatch(/^[\w-]{43}$/);
    expect(newToken()).not.toBe(newToken());
  });

  it("makes ten readable recovery codes, matched however they're typed", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(hashRecoveryCode(codes[0].toUpperCase().replace(/-/g, " "))).toBe(hashRecoveryCode(codes[0]));
  });

  it("makes a typeable setup code", () => {
    const code = newSetupCode();
    expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(normalizeSetupCode(code.toLowerCase())).toBe(code.replace(/-/g, ""));
  });
});
