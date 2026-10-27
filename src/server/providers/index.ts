import "server-only";
import { plaidConfig } from "./config";
import { httpsTransport } from "./http";
import { PlaidClient } from "./plaid";
import type { Providers } from "../sync";

/** The configured provider clients; Plaid is null until its keys are set. */
export function providers(): Providers {
  const plaid = plaidConfig();
  return {
    plaid: plaid ? new PlaidClient(plaid, httpsTransport) : null,
  };
}
