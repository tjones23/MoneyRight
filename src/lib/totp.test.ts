import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "./base32";
import { hotp, otpauthUri, totp, verifyTotp } from "./totp";

// RFC 6238 appendix B's SHA-1 secret; its 8-digit codes end in our 6 digits.
const SECRET = new TextEncoder().encode("12345678901234567890");

describe("base32", () => {
  it("round-trips, and reads what people type", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 7, 9]);
    const text = base32Encode(bytes);
    expect(base32Decode(text)).toEqual(bytes);
    expect(base32Decode(text.toLowerCase().replace(/(.{4})/g, "$1 "))).toEqual(bytes);
  });

  it("matches RFC 4648", () => {
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
  });

  it("rejects non-base32", () => {
    expect(base32Decode("MZXW1")).toBeNull();
  });
});

describe("totp", () => {
  it("matches RFC 4226 HOTP vectors", () => {
    expect(hotp(SECRET, 0)).toBe("755224");
    expect(hotp(SECRET, 9)).toBe("520489");
  });

  it("matches RFC 6238 test vectors", () => {
    expect(totp(SECRET, 59_000)).toBe("287082");
    expect(totp(SECRET, 1111111109_000)).toBe("081804");
    expect(totp(SECRET, 20000000000_000)).toBe("353130");
  });

  it("accepts a step either side, and no further", () => {
    const now = 1111111109_000;
    expect(verifyTotp(SECRET, totp(SECRET, now - 30_000), now, null)).not.toBeNull();
    expect(verifyTotp(SECRET, totp(SECRET, now + 30_000), now, null)).not.toBeNull();
    expect(verifyTotp(SECRET, totp(SECRET, now - 90_000), now, null)).toBeNull();
  });

  it("refuses a code at or before the last one used", () => {
    const now = 1111111109_000;
    const counter = verifyTotp(SECRET, totp(SECRET, now), now, null);
    expect(counter).not.toBeNull();
    expect(verifyTotp(SECRET, totp(SECRET, now), now, counter)).toBeNull();
  });

  it("ignores spaces and rejects anything not six digits", () => {
    const now = 59_000;
    expect(verifyTotp(SECRET, "287 082", now, null)).not.toBeNull();
    expect(verifyTotp(SECRET, "28708", now, null)).toBeNull();
    expect(verifyTotp(SECRET, "abcdef", now, null)).toBeNull();
  });

  it("builds an otpauth URI authenticator apps accept", () => {
    const uri = otpauthUri(SECRET, "alex");
    expect(uri).toMatch(/^otpauth:\/\/totp\/MoneyRight%3Aalex\?/);
    expect(new URL(uri).searchParams.get("secret")).toBe(base32Encode(SECRET));
    expect(new URL(uri).searchParams.get("issuer")).toBe("MoneyRight");
  });
});
