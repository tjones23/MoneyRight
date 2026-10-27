/**
 * Response security headers, adapted from Outside.
 *
 * Built here rather than in `next.config.ts` because the Content-Security-Policy
 * carries a per-request nonce, which a static config can't produce.
 *
 * Stricter than Outside's: MoneyRight loads nothing from anywhere but itself
 * except the bank-linking widget below — no map tiles, no remote images
 * — and it has no plain-HTTP LAN address, so HSTS is safe whenever the
 * request arrived over HTTPS (the tailnet).
 */

/**
 * Plaid Link: a script from Plaid's CDN that opens an iframe on its own
 * origin, where the person signs in to their bank. Plaid requires loading
 * the script from them, not bundling it.
 */
export const LINK_SCRIPT_HOSTS = ["https://cdn.plaid.com"] as const;
export const LINK_FRAME_HOSTS = ["https://cdn.plaid.com"] as const;
export const LINK_CONNECT_HOSTS = ["https://production.plaid.com", "https://sandbox.plaid.com"] as const;

export interface HeaderOptions {
  /** Per-request nonce, base64. */
  nonce: string;
  /** Development needs `unsafe-eval`; React uses it for better error stacks. */
  isDev: boolean;
}

/**
 * React's streaming renderer can emit one fixed inline script —
 * `requestAnimationFrame(function(){$RT=performance.now()})`, a timing mark
 * for revealing Suspense boundaries — allowed by its hash in case it's ever
 * written before the nonce is known. Same value as Outside's.
 */
const REACT_TIMING_HASH = "'sha256-7mu4H06fwDCjmnxxr/xNHyuQC6pLTHr4M2E4jXw5WZs='";

export function contentSecurityPolicy({ nonce, isDev }: HeaderOptions): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${REACT_TIMING_HASH} ${LINK_SCRIPT_HOSTS.join(" ")}${isDev ? " 'unsafe-eval'" : ""}`,
    /*
     * Styles may be inline: Plaid Link injects its own overlay styles
     * without our nonce (as does Next's dev overlay). Inline CSS can't run
     * script — scripts above still need the nonce or the vendor host.
     */
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    // data: for the TOTP enrollment QR code, rendered on the server.
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${LINK_CONNECT_HOSTS.join(" ")}`,
    `frame-src ${LINK_FRAME_HOSTS.join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers that don't depend on a nonce. */
export function staticSecurityHeaders({ https }: { https: boolean }): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Balances must never sit in a shared or on-disk cache.
    "Cache-Control": "no-store",
    ...(https ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };
}
