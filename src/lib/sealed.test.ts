import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { open, seal } from "./sealed";

const key = randomBytes(32);

describe("seal / open", () => {
  it("round-trips", () => {
    expect(open(key, seal(key, "secret value", "ctx"), "ctx").toString()).toBe("secret value");
  });

  it("never seals the same value the same way twice", () => {
    expect(seal(key, "x", "ctx")).not.toBe(seal(key, "x", "ctx"));
  });

  it("refuses another context, another key, or a tampered value", () => {
    const sealed = seal(key, "secret", "totp:1");
    expect(() => open(key, sealed, "totp:2")).toThrow();
    expect(() => open(randomBytes(32), sealed, "totp:1")).toThrow();
    const raw = Buffer.from(sealed.slice(3), "base64url");
    raw[raw.length - 1] ^= 1;
    expect(() => open(key, `v1.${raw.toString("base64url")}`, "totp:1")).toThrow();
  });

  it("refuses an unknown format and a wrong-sized key", () => {
    expect(() => open(key, "v2.abc", "ctx")).toThrow();
    expect(() => seal(randomBytes(16), "x", "ctx")).toThrow();
  });
});
