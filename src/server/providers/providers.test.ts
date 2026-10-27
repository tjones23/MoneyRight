import { describe, expect, it } from "vitest";
import { PlaidClient, plaidError, toLinkedAccount } from "./plaid";
import type { HttpRequest, Transport } from "./http";

function recording(response: { status: number; body: string }) {
  const seen: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    return response;
  };
  return { seen, transport };
}

describe("Plaid", () => {
  const config = { clientId: "client", secret: "secret", environment: "sandbox" as const };

  it("asks for products on a new link and none in update mode", async () => {
    const { seen, transport } = recording({ status: 200, body: JSON.stringify({ link_token: "link-1" }) });
    const plaid = new PlaidClient(config, transport);
    expect(await plaid.createLinkToken({ userId: 3, purpose: "liabilities" })).toBe("link-1");
    await plaid.createLinkToken({ userId: 3, accessToken: "access-1" });
    const [first, second] = seen.map((r) => JSON.parse(r.body!));
    expect(seen[0].url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(seen[0].headers!["PLAID-SECRET"]).toBe("secret");
    expect(first).toMatchObject({ products: ["liabilities"], user: { client_user_id: "moneyright-user-3" } });
    expect(second.products).toBeUndefined();
    expect(second.access_token).toBe("access-1");
  });

  it("uses the free cached /accounts/get, never the billed balance endpoint", async () => {
    const { seen, transport } = recording({ status: 200, body: JSON.stringify({ accounts: [], item: {} }) });
    await new PlaidClient(config, transport).getAccounts("access-1");
    expect(seen[0].url).toBe("https://sandbox.plaid.com/accounts/get");
  });

  it("knows which errors need the person to sign in again", () => {
    expect(plaidError(400, { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" }).needsReconnect).toBe(true);
    expect(plaidError(400, { error_type: "ITEM_ERROR", error_code: "PRODUCT_NOT_READY" })).toMatchObject({ needsReconnect: false, transient: true });
  });

  it("maps accounts, preferring the friendly name", () => {
    const account = toLinkedAccount({
      account_id: "acc",
      name: "Fidelity Brokerage",
      official_name: "INDIVIDUAL - TOD",
      mask: "1234",
      type: "investment",
      subtype: "brokerage",
      balances: { current: 1, available: null, iso_currency_code: "USD" },
    });
    expect(account).toMatchObject({ name: "Fidelity Brokerage", kind: "investment", mask: "1234" });
  });
});
