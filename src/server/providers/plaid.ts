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

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Positive is money out of the account; negative, money in. */
  amount: number;
  iso_currency_code: string | null;
  date: string;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null;
}

export interface PlaidInvestmentTransaction {
  investment_transaction_id: string;
  account_id: string;
  date: string;
  /** Positive is cash out of the account (a buy); negative, cash in (a sale, a deposit). */
  amount: number;
  type: string;
  subtype: string | null;
  quantity: number | null;
  price: number | null;
  iso_currency_code: string | null;
}

export interface TransactionsPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  /** Transaction ids. */
  removed: string[];
  nextCursor: string;
}

/** 500 a page: 25,000 changes in one go is past two years of anyone's spending. */
const MAX_SYNC_PAGES = 50;
/** The same ceiling for investment transactions, fetched by offset. */
const MAX_INVESTMENT_PAGES = 50;

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
    else {
      const products = PRODUCTS[opts.purpose ?? "investments"];
      body.products = products;
      // The most history Plaid gives, and only settable now: it's fixed once the Item has Transactions.
      if (products.includes("transactions")) body.transactions = { days_requested: 730 };
    }
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

  /** The products the Item has. Free; says whether it already has Transactions. */
  async getItemProducts(accessToken: string): Promise<string[]> {
    const res = await this.post<{ item: { products?: string[]; billed_products?: string[] } }>("/item/get", {
      access_token: accessToken,
    });
    return [...new Set([...(res.item?.products ?? []), ...(res.item?.billed_products ?? [])])].sort();
  }

  /**
   * Every transaction change since `cursor` (null: the whole history), paged
   * to the end. If the data changes mid-way Plaid says so, and the whole loop
   * starts again from the first cursor, as its docs require.
   *
   * Only for an Item that already has Transactions: on any other, the first
   * call adds the product, and its billing.
   */
  async syncTransactions(accessToken: string, cursor: string | null): Promise<TransactionsPage> {
    for (let attempt = 0; ; attempt++) {
      const page: TransactionsPage = { added: [], modified: [], removed: [], nextCursor: cursor ?? "" };
      try {
        for (let pages = 0; ; pages++) {
          if (pages >= MAX_SYNC_PAGES) throw new ProviderError("plaid", 0, "too_many_pages", false, true);
          const body: Record<string, unknown> = { access_token: accessToken, count: 500 };
          if (page.nextCursor) body.cursor = page.nextCursor;
          const res = await this.post<{
            added: PlaidTransaction[];
            modified: PlaidTransaction[];
            removed: { transaction_id: string }[];
            next_cursor: string;
            has_more: boolean;
          }>("/transactions/sync", body);
          page.added.push(...res.added);
          page.modified.push(...res.modified);
          page.removed.push(...res.removed.map((r) => r.transaction_id));
          page.nextCursor = res.next_cursor;
          if (!res.has_more) return page;
        }
      } catch (error) {
        const restart = error instanceof ProviderError && error.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
        if (!restart || attempt >= 2) throw error;
      }
    }
  }

  /**
   * Investment transactions from `startDate` to `endDate` (Plaid keeps up to
   * 24 months), every page. Only for an Item that already has Investments.
   */
  async getInvestmentTransactions(accessToken: string, startDate: string, endDate: string): Promise<PlaidInvestmentTransaction[]> {
    const all: PlaidInvestmentTransaction[] = [];
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_INVESTMENT_PAGES) throw new ProviderError("plaid", 0, "too_many_pages", false, true);
      const res = await this.post<{ investment_transactions: PlaidInvestmentTransaction[]; total_investment_transactions: number }>(
        "/investments/transactions/get",
        { access_token: accessToken, start_date: startDate, end_date: endDate, options: { count: 500, offset: all.length } },
      );
      all.push(...res.investment_transactions);
      if (res.investment_transactions.length === 0 || all.length >= res.total_investment_transactions) return all;
    }
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
