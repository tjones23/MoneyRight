import "server-only";
import { plaidConfig } from "./config";
import { httpsTransport } from "./http";
import { PlaidClient } from "./plaid";
import { RentcastClient, rentcastConfig } from "./rentcast";
import type { Providers } from "../sync";

/** The configured provider clients; each is null until its keys are set. */
export function providers(): Providers {
  const plaid = plaidConfig();
  const rentcast = rentcastConfig();
  return {
    plaid: plaid ? new PlaidClient(plaid, httpsTransport) : null,
    rentcast: rentcast ? new RentcastClient(rentcast, httpsTransport) : null,
  };
}
