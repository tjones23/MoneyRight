import { parseJson, ProviderError, type Transport } from "./http";
import type { PlaidConfig } from "./config";
import { plaidKind } from "@/lib/account-kinds";
import { dollarsToCents } from "@/lib/money";
import type { LinkedAccount } from "../finance";

/**
 * Plaid (https://plaid.com/docs/api): banks, cards, brokerages, retirement
 * accounts, mortgages and loans. On the free Trial plan, with 10 Items for
 * life, so each link should be one worth having.
 *
 * Balances come from /accounts/get, which is free and returns what Plaid
 * last fetched (about daily, for Items with Investments, Liabilities or
 * Transactions). /accounts/balance/get, the live one, is billed per call and
 * never used.
 */

/** What the link is for, which decides the products it asks for. */
export type PlaidLinkPurpose = "investments" | "liabilities" | "bank";

const PRODUCTS: Record<PlaidLinkPurpose, string[]> = {
  investments: ["investments"],
  liabilities: ["liabilities"],
  // Transactions, not Auth: it's what keeps a bank Item's cached balances updated daily.
  bank: ["transactions"],
};

/** Plaid error codes fixed by the person signing in again through Link's update mode. */
const RECONNECT_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "MANUAL_VERIFICATION_REQUIRED",
  "INSUFFICIENT_CREDENTIALS",
  "ACCESS_NOT_GRANTED",
  "NO_ACCOUNTS",
  "ITEM_NOT_FOUND",
]);

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    iso_currency_code: string | null;
  };
}

export class PlaidClient {
  constructor(
    private readonly config: PlaidConfig,
    private readonly transport: Transport,
  ) {}

  get environment() {
    return this.config.environment;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.transport({
      method: "POST",
      url: `https://${this.config.environment}.plaid.com${path}`,
      headers: {
        "Content-Type": "application/json",
        "PLAID-CLIENT-ID": this.config.clientId,
        "PLAID-SECRET": this.config.secret,
      },
      body: JSON.stringify(body),
    });
    const json = parseJson(res.body);
    if (res.status === 200 && json) return json as T;
    throw plaidError(res.status, json);
  }

  /** A link token for a new Item, or — given an access token — update mode for an existing one. */
  async createLinkToken(opts: { userId: number; purpose?: PlaidLinkPurpose; accessToken?: string }): Promise<string> {
    const body: Record<string, unknown> = {
      client_name: "MoneyRight",
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: `moneyright-user-${opts.userId}` },
    };
    if (opts.accessToken) body.access_token = opts.accessToken;
    else body.products = PRODUCTS[opts.purpose ?? "investments"];
    const res = await this.post<{ link_token: string }>("/link/token/create", body);
    return res.link_token;
  }

  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const res = await this.post<{ access_token: string; item_id: string }>("/item/public_token/exchange", {
      public_token: publicToken,
    });
    return { accessToken: res.access_token, itemId: res.item_id };
  }

  async getAccounts(accessToken: string): Promise<{ accounts: PlaidAccount[]; institutionName: string | null }> {
    const res = await this.post<{ accounts: PlaidAccount[]; item: { institution_name?: string | null } }>(
      "/accounts/get",
      { access_token: accessToken },
    );
    return { accounts: res.accounts, institutionName: res.item?.institution_name ?? null };
  }

  /** Ends the Item. On the Trial plan this does not give back its slot. */
  async removeItem(accessToken: string): Promise<void> {
    await this.post("/item/remove", { access_token: accessToken });
  }
}

export function plaidError(status: number, json: unknown): ProviderError {
  const err = json as { error_type?: string; error_code?: string } | null;
  const code = err?.error_code ?? `http_${status}`;
  const transient =
    status === 429 || status >= 500 || status === 0 || err?.error_type === "RATE_LIMIT_EXCEEDED" ||
    code === "INSTITUTION_DOWN" || code === "INSTITUTION_NOT_RESPONDING" || code === "PRODUCT_NOT_READY";
  return new ProviderError("plaid", status, code, RECONNECT_CODES.has(code), transient);
}

export function toLinkedAccount(a: PlaidAccount): LinkedAccount {
  return {
    externalId: a.account_id,
    // `name` is what the institution shows people; `official_name` is often SHOUTED product copy.
    name: a.name || a.official_name || "Account",
    kind: plaidKind(a.type, a.subtype),
    subtype: a.subtype,
    mask: a.mask,
    currency: a.balances.iso_currency_code || "USD",
  };
}

/** `current` is the value (an investment), or what's owed (a loan or card). */
export function plaidBalanceCents(a: PlaidAccount): { balance: number | null; available: number | null } {
  return { balance: dollarsToCents(a.balances.current), available: dollarsToCents(a.balances.available) };
}
