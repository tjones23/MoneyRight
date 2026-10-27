import "server-only";

/**
 * Plaid credentials, from the environment (.env.local, or
 * .env.development.local for the dev server's sandbox keys). They may be
 * missing: the page then says how to set it up instead of offering the link.
 *
 * These are this app's credentials with Plaid, shared by every MoneyRight
 * user. Each person's own bank access tokens live sealed in the database,
 * never here.
 */

export type PlaidEnvironment = "sandbox" | "production";

export interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
}

export function plaidConfig(): PlaidConfig | null {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) return null;
  return { clientId, secret, environment: process.env.PLAID_ENV === "production" ? "production" : "sandbox" };
}
