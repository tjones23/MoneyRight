import type { NextConfig } from "next";

/**
 * MoneyRight has no shared upstream data to cache — everything on a page
 * belongs to whoever is signed in — so unlike Outside it leaves Cache
 * Components off and every page renders per request.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
