import { NextResponse, type NextRequest } from "next/server";
import { checkNetwork, parseAllowedLogins } from "@/lib/network-gate";
import { contentSecurityPolicy, staticSecurityHeaders } from "@/lib/security-headers";

/**
 * Runs before every request: the network gate, then security headers.
 *
 * (In Next 16 this file is `proxy.ts`; `middleware.ts` is the deprecated name.)
 *
 * The gate (lib/network-gate.ts) refuses anything that didn't come from this
 * Mac or from a tailnet member, before any page — sign-in included — renders.
 * Past it, a missing session cookie is sent to sign in; whether a cookie is
 * actually good is decided next to the data, in server/auth.ts.
 */

const SESSION_COOKIE = "mr_session";

/** Reachable without a session: signing in, first-run setup, invites, icons. */
const OPEN_PATHS = [/^\/login(\/|$)/, /^\/setup$/, /^\/invite\//, /^\/icon/, /^\/apple-icon/, /^\/manifest/];

function makeNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function proxy(request: NextRequest) {
  const gate = checkNetwork(
    (name) => request.headers.get(name),
    parseAllowedLogins(process.env.MONEYRIGHT_ALLOWED_LOGINS),
  );
  if (!gate.ok) {
    console.warn(`[moneyright] refused ${request.method} ${request.nextUrl.pathname}: ${gate.reason}`);
    return new NextResponse("Not available.", { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const path = request.nextUrl.pathname;
  // Build output: gated like everything else, but cacheable and CSP-free.
  if (path.startsWith("/_next/static/") || path.startsWith("/_next/image")) return NextResponse.next();

  const https = request.headers.get("x-forwarded-proto") === "https";
  if (!request.cookies.has(SESSION_COOKIE) && !OPEN_PATHS.some((re) => re.test(path))) {
    // Built from the forwarded scheme and host: behind `tailscale serve` the
    // browser is on https://moneyright.<tailnet>.ts.net, not this server's
    // own http://127.0.0.1.
    const proto = request.headers.get("x-forwarded-proto") ?? "http";
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const response = NextResponse.redirect(`${proto}://${host}/login`, 307);
    for (const [key, value] of Object.entries(staticSecurityHeaders({ https }))) response.headers.set(key, value);
    return response;
  }

  const nonce = makeNonce();
  const csp = contentSecurityPolicy({ nonce, isDev: process.env.NODE_ENV === "development" });

  // Pass the nonce through on the request so Next stamps it onto the script
  // tags it renders; without it the page's own bootstrap would be blocked.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  for (const [key, value] of Object.entries(staticSecurityHeaders({ https }))) {
    response.headers.set(key, value);
  }
  return response;
}

// Every path, build output included: nothing is served to a request the
// gate would refuse.
export const config = {
  matcher: ["/:path*"],
};
