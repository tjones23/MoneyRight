import { createHmac, createPublicKey, verify } from "node:crypto";
import { parseJson, ProviderError, type Transport } from "./http";
import type { TellerConfig } from "./config";
import { tellerKind } from "@/lib/account-kinds";
import { parseDecimalToCents } from "@/lib/money";
import type { LinkedAccount } from "../finance";

/**
 * Teller (https://teller.io/docs/api): banks and credit cards. Free for
 * independent developers up to 100 live enrollments. Every request carries
 * this app's client certificate (mTLS) and the person's access token as the
 * HTTP Basic username.
 */

const BASE = "https://api.teller.io";

export interface TellerAccount {
  id: string;
  enrollment_id: string;
  name: string;
  type: string;
  subtype: string;
  last_four: string | null;
  currency: string;
  status: "open" | "closed";
  institution: { id: string; name: string };
}

export interface TellerBalance {
  account_id: string;
  ledger: string | null;
  available: string | null;
}

export class TellerClient {
  constructor(
    private readonly config: TellerConfig,
    private readonly transport: Transport,
  ) {}

  private async get<T>(path: string, accessToken: string): Promise<T> {
    return this.call<T>("GET", path, accessToken);
  }

  private async call<T>(method: "GET" | "DELETE", path: string, accessToken: string): Promise<T> {
    const res = await this.transport({
      method,
      url: BASE + path,
      headers: { Authorization: `Basic ${Buffer.from(`${accessToken}:`).toString("base64")}` },
      certificate: this.config.certificate,
      privateKey: this.config.privateKey,
    });
    if (res.status >= 200 && res.status < 300) return (res.body ? parseJson(res.body) : null) as T;
    throw tellerError(res.status, res.body);
  }

  listAccounts(accessToken: string): Promise<TellerAccount[]> {
    return this.get("/accounts", accessToken);
  }

  balances(accessToken: string, accountId: string): Promise<TellerBalance> {
    return this.get(`/accounts/${encodeURIComponent(accountId)}/balances`, accessToken);
  }

  /** Revokes this app's access to every account in the enrollment. */
  async removeEnrollment(accessToken: string): Promise<void> {
    await this.call("DELETE", "/accounts", accessToken);
  }
}

export function tellerError(status: number, body: string): ProviderError {
  const code = (parseJson(body) as { error?: { code?: string } } | null)?.error?.code ?? `http_${status}`;
  // A disconnected enrollment is a 404 whose code starts with enrollment.disconnected;
  // 403 is a revoked token — both are fixed by signing in again.
  const needsReconnect = code.startsWith("enrollment.disconnected") || status === 403;
  const transient = status === 429 || status === 502 || status >= 500 || status === 0;
  return new ProviderError("teller", status, code, needsReconnect, transient);
}

export function toLinkedAccount(a: TellerAccount): LinkedAccount {
  return {
    externalId: a.id,
    name: a.name,
    kind: tellerKind(a.type),
    subtype: a.subtype ?? null,
    mask: a.last_four ?? null,
    currency: a.currency || "USD",
  };
}

/** Ledger is the balance (owed, for a card); available is what can be spent now. */
export function tellerBalanceCents(b: TellerBalance): { balance: number | null; available: number | null } {
  const ledger = parseDecimalToCents(b.ledger);
  const available = parseDecimalToCents(b.available);
  return { balance: ledger ?? available, available };
}

// ---------------------------------------------------------------------------
// Verifying what Teller Connect hands the browser
//
// Connect returns the access token to the browser, which posts it here. With
// a nonce made on the server and the dashboard's token signing key, Teller's
// ED25519 signatures prove the token really came from Teller for this
// session — a page can't slip in a token from elsewhere.
// ---------------------------------------------------------------------------

/** A nonce tied to this sign-in session, so nothing has to be stored. */
export function tellerNonce(key: Buffer, sessionIdHash: string): string {
  return createHmac("sha256", key).update(`teller-nonce:${sessionIdHash}`).digest("base64url");
}

function signingPublicKey(value: string) {
  if (value.includes("BEGIN")) return createPublicKey(value);
  const raw = Buffer.from(value, "base64");
  // A bare 32-byte key, or SPKI DER.
  return raw.length === 32
    ? createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" })
    : createPublicKey({ key: raw, format: "der", type: "spki" });
}

export function verifyTellerSignatures(input: {
  signingKey: string;
  signatures: string[];
  nonce: string;
  accessToken: string;
  userId: string;
  enrollmentId: string;
  environment: string;
}): boolean {
  const key = signingPublicKey(input.signingKey);
  const message = Buffer.from(
    [input.nonce, input.accessToken, input.userId, input.enrollmentId, input.environment].join("."),
  );
  return input.signatures.some((sig) => {
    try {
      return verify(null, message, key, Buffer.from(sig, "base64"));
    } catch {
      return false;
    }
  });
}
