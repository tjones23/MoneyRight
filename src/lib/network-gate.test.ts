import { describe, expect, it } from "vitest";
import { checkNetwork, forwardedClient, isLoopbackHost, parseAllowedLogins } from "./network-gate";

function headers(values: Record<string, string>) {
  const map = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => map.get(name) ?? null;
}

describe("checkNetwork", () => {
  it("lets this Mac in directly", () => {
    expect(checkNetwork(headers({ host: "localhost:3002" }), [])).toEqual({ ok: true, via: "local" });
    expect(checkNetwork(headers({ host: "127.0.0.1:3002" }), [])).toEqual({ ok: true, via: "local" });
    expect(checkNetwork(headers({ host: "[::1]:3002" }), [])).toEqual({ ok: true, via: "local" });
  });

  it("lets a tailnet member in, by the login serve vouches for", () => {
    const result = checkNetwork(
      headers({ host: "moneyright.tail1234.ts.net", "x-forwarded-for": "100.64.0.2", "tailscale-user-login": "Alex@Example.com" }),
      [],
    );
    expect(result).toEqual({ ok: true, via: "tailnet", login: "alex@example.com" });
  });

  it("refuses a proxied request with no identity — what Funnel traffic looks like", () => {
    const result = checkNetwork(headers({ host: "moneyright.tail1234.ts.net", "x-forwarded-for": "203.0.113.9" }), []);
    expect(result.ok).toBe(false);
  });

  it("lets this Mac in with the X-Forwarded-* headers Next fills in itself", () => {
    const local = headers({
      host: "127.0.0.1:3002",
      "x-forwarded-for": "::1",
      "x-forwarded-host": "127.0.0.1:3002",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "3002",
    });
    expect(checkNetwork(local, [])).toEqual({ ok: true, via: "local" });
  });

  it("refuses a loopback Host forwarded from anywhere else", () => {
    expect(checkNetwork(headers({ host: "localhost", "x-forwarded-for": "203.0.113.9" }), []).ok).toBe(false);
    expect(checkNetwork(headers({ host: "localhost", "x-forwarded-host": "moneyright.tail1234.ts.net" }), []).ok).toBe(false);
    expect(checkNetwork(headers({ host: "localhost", forwarded: "for=203.0.113.9" }), []).ok).toBe(false);
  });

  it("refuses a direct request for any other host", () => {
    expect(checkNetwork(headers({ host: "192.168.1.20:3002" }), []).ok).toBe(false);
    expect(checkNetwork(headers({}), []).ok).toBe(false);
  });

  it("lets a public request in over HTTPS only once public access is on", () => {
    const funnel = headers({
      host: "moneyright.tail1234.ts.net",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https",
    });
    expect(checkNetwork(funnel, []).ok).toBe(false);
    expect(checkNetwork(funnel, [], { allowPublic: true })).toEqual({ ok: true, via: "public", address: "203.0.113.9" });

    const plain = headers({ host: "moneyright.tail1234.ts.net", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "http" });
    expect(checkNetwork(plain, [], { allowPublic: true }).ok).toBe(false);
  });

  it("still tells this Mac and tailnet members apart with public access on", () => {
    expect(checkNetwork(headers({ host: "localhost:3002" }), [], { allowPublic: true })).toEqual({ ok: true, via: "local" });
    const member = headers({ host: "x.ts.net", "x-forwarded-proto": "https", "tailscale-user-login": "sam@example.com" });
    expect(checkNetwork(member, ["alex@example.com"], { allowPublic: true }).ok).toBe(false);
  });

  it("takes a public visitor's address from serve, not from what they sent", () => {
    expect(forwardedClient("1.2.3.4, 203.0.113.9")).toBe("203.0.113.9");
    expect(forwardedClient("203.0.113.9, 127.0.0.1")).toBe("203.0.113.9");
    expect(forwardedClient("::1")).toBeNull();
    expect(forwardedClient(null)).toBeNull();
  });

  it("applies the allowlist to tailnet logins", () => {
    const allowed = parseAllowedLogins(" Alex@example.com, sam@example.com ,");
    expect(allowed).toEqual(["alex@example.com", "sam@example.com"]);
    const from = (login: string) =>
      checkNetwork(headers({ host: "x.ts.net", "x-forwarded-for": "100.64.0.2", "tailscale-user-login": login }), allowed);
    expect(from("sam@example.com").ok).toBe(true);
    expect(from("someone@example.com").ok).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it("knows loopback from look-alikes", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.10")).toBe(false);
  });
});
