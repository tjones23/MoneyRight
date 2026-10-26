import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  cookieMaxAgeSeconds,
  isExpired,
  normalizeUsername,
  usernameProblem,
} from "./session-policy";

describe("session expiry", () => {
  const start = 1_000_000;

  it("expires after the stage's idle timeout", () => {
    const s = { stage: "password" as const, createdAt: start, lastSeenAt: start };
    expect(isExpired(s, start + IDLE_TIMEOUT_MS.password - 1)).toBe(false);
    expect(isExpired(s, start + IDLE_TIMEOUT_MS.password + 1)).toBe(true);
  });

  it("expires at the absolute limit however active", () => {
    const now = start + ABSOLUTE_TIMEOUT_MS + 1;
    expect(isExpired({ stage: "full", createdAt: start, lastSeenAt: now - 1000 }, now)).toBe(true);
  });

  it("never gives the cookie longer than the session", () => {
    const s = { stage: "full" as const, createdAt: start, lastSeenAt: start };
    expect(cookieMaxAgeSeconds(s, start)).toBe(IDLE_TIMEOUT_MS.full / 1000);
    const late = start + ABSOLUTE_TIMEOUT_MS - 60_000;
    expect(cookieMaxAgeSeconds(s, late)).toBe(60);
  });
});

describe("usernames", () => {
  it("normalizes and validates", () => {
    expect(normalizeUsername("  Alex ")).toBe("alex");
    expect(usernameProblem("alex")).toBeNull();
    expect(usernameProblem("to")).not.toBeNull();
    expect(usernameProblem("alex river")).not.toBeNull();
  });
});
