/**
 * Who may reach MoneyRight at all, decided from a request's headers before
 * anything else runs — the sign-in page included.
 *
 * The server only ever listens on 127.0.0.1, so a request comes from one of
 * two places:
 *
 *   - this Mac, directly, addressed to a loopback Host;
 *   - `tailscale serve`, which proxies the tailnet's HTTPS to localhost and
 *     stamps each request with the tailnet identity of whoever sent it
 *     (`Tailscale-User-Login`). Serve strips any copy of that header a
 *     client sends, so it can't be forged from the tailnet.
 *
 * Serve sends *no* identity for Funnel (public internet) traffic or for
 * tagged devices. So a request without an identity is only let in if every
 * sign says it came straight from this Mac: a loopback Host, and loopback
 * (or absent) X-Forwarded-For / X-Forwarded-Host. A Funnel request carries
 * the public name and the visitor's address, so it fails both. The launchers
 * never switch Funnel on, and switch it off if they find it — this is the
 * second lock on the same door.
 *
 * Next itself fills in any missing X-Forwarded-* headers before the proxy
 * runs (from the socket and the Host), which is why their mere presence
 * proves nothing and their values are what's checked.
 */

export type GateResult =
  | { ok: true; via: "local" }
  | { ok: true; via: "tailnet"; login: string }
  | { ok: false; reason: string };

/** Lower-cased header lookup — `Headers.get` already is; tests pass a Map. */
export type HeaderGetter = (name: string) => string | null | undefined;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

/** Parse MONEYRIGHT_ALLOWED_LOGINS. Empty means any tailnet member. */
export function parseAllowedLogins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function checkNetwork(header: HeaderGetter, allowedLogins: string[]): GateResult {
  const login = header("tailscale-user-login")?.trim().toLowerCase();
  if (login) {
    if (allowedLogins.length > 0 && !allowedLogins.includes(login)) {
      return { ok: false, reason: `tailnet login ${login} is not on MONEYRIGHT_ALLOWED_LOGINS` };
    }
    return { ok: true, via: "tailnet", login };
  }

  if (!isLoopbackHost(header("host"))) {
    return { ok: false, reason: "no tailnet identity, and not addressed to this Mac" };
  }
  const forwardedFor = header("x-forwarded-for");
  if (forwardedFor && !forwardedFor.split(",").every((ip) => LOOPBACK_ADDRESSES.has(ip.trim()))) {
    return { ok: false, reason: `no tailnet identity, forwarded for ${forwardedFor}` };
  }
  const forwardedHost = header("x-forwarded-host");
  if (forwardedHost && !isLoopbackHost(forwardedHost)) {
    return { ok: false, reason: `no tailnet identity, forwarded host ${forwardedHost}` };
  }
  if (header("forwarded")) return { ok: false, reason: "no tailnet identity, Forwarded header present" };
  return { ok: true, via: "local" };
}
