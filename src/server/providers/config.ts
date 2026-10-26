import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Teller and Plaid credentials, from the environment (.env.local, or
 * .env.development.local for the dev server's sandbox keys). Either may be
 * missing: the page then says how to set it up instead of offering the link.
 *
 * These are this app's credentials with each provider, shared by every
 * MoneyRight user. Each person's own bank access tokens live sealed in the
 * database, never here.
 */

export type TellerEnvironment = "sandbox" | "development" | "production";
export type PlaidEnvironment = "sandbox" | "production";

export interface TellerConfig {
  applicationId: string;
  environment: TellerEnvironment;
  /** PEM. Optional only in sandbox, which Teller doesn't require mTLS for. */
  certificate: Buffer | null;
  privateKey: Buffer | null;
  /** The dashboard's token signing key; when set, Connect results are verified. */
  signingKey: string | null;
}

export interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
}

function tellerFile(envName: string, fallback: string): Buffer | null {
  const path = process.env[envName] || join(process.cwd(), ".moneyright", "teller", fallback);
  return existsSync(/*turbopackIgnore: true*/ path) ? readFileSync(/*turbopackIgnore: true*/ path) : null;
}

export function tellerConfig(): TellerConfig | null {
  const applicationId = process.env.TELLER_APPLICATION_ID;
  if (!applicationId) return null;
  const env = process.env.TELLER_ENVIRONMENT;
  const environment: TellerEnvironment = env === "sandbox" || env === "production" ? env : "development";
  const certificate = tellerFile("TELLER_CERTIFICATE_FILE", "certificate.pem");
  const privateKey = tellerFile("TELLER_PRIVATE_KEY_FILE", "private_key.pem");
  if (environment !== "sandbox" && (!certificate || !privateKey)) return null;
  return { applicationId, environment, certificate, privateKey, signingKey: process.env.TELLER_SIGNING_KEY || null };
}

/** Why Teller isn't available, for the setup hint. */
export function tellerProblem(): string | null {
  if (!process.env.TELLER_APPLICATION_ID) return "TELLER_APPLICATION_ID isn't set.";
  if (!tellerConfig()) return "Teller's certificate.pem and private_key.pem weren't found (see .env.example).";
  return null;
}

export function plaidConfig(): PlaidConfig | null {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) return null;
  return { clientId, secret, environment: process.env.PLAID_ENV === "production" ? "production" : "sandbox" };
}
