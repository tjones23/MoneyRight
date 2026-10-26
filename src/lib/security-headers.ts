/**
 * Response security headers, adapted from Outside.
 *
 * Built here rather than in `next.config.ts` because the Content-Security-Policy
 * carries a per-request nonce, which a static config can't produce.
 *
 * Stricter than Outside's: MoneyRight loads nothing from anywhere but itself
 * — no map tiles, no remote images — and it has no plain-HTTP LAN address,
 * so HSTS is safe whenever the request arrived over HTTPS (the tailnet).
 */

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
    `script-src 'self' 'nonce-${nonce}' ${REACT_TIMING_HASH}${isDev ? " 'unsafe-eval'" : ""}`,
    // Next's dev overlay injects un-nonced <style> elements; see Outside's notes.
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    // data: for the TOTP enrollment QR code, rendered on the server.
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
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
