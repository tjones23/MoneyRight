import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TellerClient, tellerBalanceCents, tellerError, tellerNonce, verifyTellerSignatures } from "./teller";
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

describe("Teller", () => {
  const config = {
    applicationId: "app_test",
    environment: "development" as const,
    certificate: Buffer.from("CERT"),
    privateKey: Buffer.from("KEY"),
    signingKey: null,
  };

  it("sends the token as the Basic username, with the client certificate", async () => {
    const { seen, transport } = recording({ status: 200, body: "[]" });
    await new TellerClient(config, transport).listAccounts("token_abc");
    expect(seen[0].url).toBe("https://api.teller.io/accounts");
    expect(seen[0].headers!.Authorization).toBe(`Basic ${Buffer.from("token_abc:").toString("base64")}`);
    expect(seen[0].certificate?.toString()).toBe("CERT");
  });

  it("knows a disconnected enrollment from a passing failure", () => {
    const disconnected = tellerError(404, JSON.stringify({ error: { code: "enrollment.disconnected.credentials_invalid" } }));
    expect(disconnected).toMatchObject({ needsReconnect: true, transient: false });
    expect(tellerError(429, "")).toMatchObject({ needsReconnect: false, transient: true, code: "http_429" });
  });

  it("reads ledger as the balance, falling back to available", () => {
    expect(tellerBalanceCents({ account_id: "a", ledger: "28575.02", available: "28000.00" })).toEqual({ balance: 2857502, available: 2800000 });
    expect(tellerBalanceCents({ account_id: "a", ledger: null, available: "10.00" })).toEqual({ balance: 1000, available: 1000 });
  });

  it("verifies Connect's signatures, and only for the same values", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const nonce = tellerNonce(Buffer.alloc(32, 1), "session-hash");
    const values = { nonce, accessToken: "token_a", userId: "usr_1", enrollmentId: "enr_1", environment: "development" };
    const message = Buffer.from(Object.values(values).join("."));
    const signature = sign(null, message, privateKey).toString("base64");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyTellerSignatures({ ...values, signingKey: pem, signatures: ["junk", signature] })).toBe(true);
    expect(verifyTellerSignatures({ ...values, accessToken: "token_b", signingKey: pem, signatures: [signature] })).toBe(false);
    const raw = publicKey.export({ format: "jwk" }).x!;
    expect(verifyTellerSignatures({ ...values, signingKey: Buffer.from(raw, "base64url").toString("base64"), signatures: [signature] })).toBe(true);
  });

  it("ties the nonce to the session", () => {
    const key = Buffer.alloc(32, 2);
    expect(tellerNonce(key, "a")).toBe(tellerNonce(key, "a"));
    expect(tellerNonce(key, "a")).not.toBe(tellerNonce(key, "b"));
  });
});

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
