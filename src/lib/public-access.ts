import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Whether the network gate lets in requests from the public internet.
 *
 * On only while `.moneyright/public` exists, which `run-prod.command public`
 * writes as it turns Funnel on, and `public off`, `tailnet off` and `stop`
 * remove. Read on every request, so switching it needs no restart. Never on
 * the dev server.
 */
export function publicAccessEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  return existsSync(/*turbopackIgnore: true*/ join(process.cwd(), ".moneyright", "public"));
}
