import "server-only";
import { plaidConfig, tellerConfig } from "./config";
import { httpsTransport } from "./http";
import { PlaidClient } from "./plaid";
import { TellerClient } from "./teller";
import type { Providers } from "../sync";

/** The configured provider clients; either is null until its keys are set. */
export function providers(): Providers {
  const teller = tellerConfig();
  const plaid = plaidConfig();
  return {
    teller: teller ? new TellerClient(teller, httpsTransport) : null,
    plaid: plaid ? new PlaidClient(plaid, httpsTransport) : null,
  };
}
