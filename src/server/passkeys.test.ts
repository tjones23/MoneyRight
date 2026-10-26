import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { createFirstAdmin, createSession, findSession, type Session, type User } from "./accounts";
import {
  finishAuthentication,
  finishRegistration,
  hasPasskeyFor,
  listPasskeys,
  removePasskey,
  startAuthentication,
  startRegistration,
} from "./passkeys";
import type { DatabaseSync } from "node:sqlite";

/**
 * A software authenticator — enough WebAuthn to make and use a real ES256
 * passkey — so the whole ceremony runs through SimpleWebAuthn's verification.
 */

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error("unsupported");
}

class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  private counter = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    this.publicJwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  }

  private authData(rpId: string, attested: boolean) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const parts: Buffer[] = [createHash("sha256").update(rpId).digest(), Buffer.from([0x01 | 0x04 | (attested ? 0x40 : 0)]), counter];
    if (attested) {
      const coseKey = cbor(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(this.publicJwk.x, "base64url")],
          [-3, Buffer.from(this.publicJwk.y, "base64url")],
        ]),
      );
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, coseKey);
    }
    return Buffer.concat(parts);
  }

  register(options: { challenge: string }, rp: { id: string; origin: string }) {
    const clientData = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: rp.origin, crossOrigin: false });
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(rp.id, true)]]));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key" as const,
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestationObject), transports: ["internal"] },
    };
  }

  authenticate(options: { challenge: string }, rp: { id: string; origin: string }) {
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: rp.origin, crossOrigin: false }));
    const authenticatorData = this.authData(rp.id, false);
    const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientData).digest()]), this.key);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key" as const,
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authenticatorData), signature: b64url(signature) },
    };
  }
}

const T0 = Date.UTC(2026, 9, 26, 18);
const rp = { id: "localhost", origin: "http://localhost:3002" };
let db: DatabaseSync;
let user: User;
let full: Session;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const id = await createFirstAdmin(db, { username: "alex", displayName: "Alex", password: "a long enough password" }, T0);
  const token = createSession(db, id, "full", { userAgent: null, tailnetLogin: null }, T0);
  ({ session: full, user } = findSession(db, token, null, T0)!);
});

function signingInSession() {
  const token = createSession(db, user.id, "password", { userAgent: null, tailnetLogin: null }, T0);
  return findSession(db, token, null, T0)!.session;
}

async function enrolled() {
  const device = new SoftAuthenticator();
  const options = await startRegistration(db, full, user, rp, T0);
  await finishRegistration(db, full, user, device.register(options, rp) as never, rp, "Test key", T0);
  return device;
}

describe("passkeys, end to end", () => {
  it("register, then sign in, advancing the counter", async () => {
    const device = await enrolled();
    expect(listPasskeys(db, user.id).map((p) => [p.name, p.rpId])).toEqual([["Test key", "localhost"]]);
    expect(hasPasskeyFor(db, user.id, "localhost")).toBe(true);
    expect(hasPasskeyFor(db, user.id, "moneyright.example.ts.net")).toBe(false);

    const session = signingInSession();
    const options = (await startAuthentication(db, session, rp, T0))!;
    expect(await finishAuthentication(db, session, device.authenticate(options, rp) as never, rp, T0)).toBe(true);
    expect(listPasskeys(db, user.id)[0].lastUsedAt).toBe(T0);
  });

  it("refuse a replayed assertion — the challenge is spent", async () => {
    const device = await enrolled();
    const session = signingInSession();
    const options = (await startAuthentication(db, session, rp, T0))!;
    const assertion = device.authenticate(options, rp);
    expect(await finishAuthentication(db, session, assertion as never, rp, T0)).toBe(true);
    expect(await finishAuthentication(db, session, assertion as never, rp, T0)).toBe(false);
  });

  it("refuse another origin, and another device", async () => {
    const device = await enrolled();
    let session = signingInSession();
    let options = (await startAuthentication(db, session, rp, T0))!;
    const phished = device.authenticate(options, { id: "localhost", origin: "https://evil.example" });
    expect(await finishAuthentication(db, session, phished as never, rp, T0)).toBe(false);

    session = signingInSession();
    options = (await startAuthentication(db, session, rp, T0))!;
    const stranger = new SoftAuthenticator().authenticate(options, rp);
    expect(await finishAuthentication(db, session, stranger as never, rp, T0)).toBe(false);
  });

  it("aren't offered at another address, and can be removed", async () => {
    await enrolled();
    const session = signingInSession();
    expect(await startAuthentication(db, session, { id: "moneyright.example.ts.net", origin: "https://moneyright.example.ts.net" }, T0)).toBeNull();
    removePasskey(db, user.id, listPasskeys(db, user.id)[0].id, T0);
    expect(listPasskeys(db, user.id)).toEqual([]);
  });

  it("can't be added twice", async () => {
    const device = new SoftAuthenticator();
    let options = await startRegistration(db, full, user, rp, T0);
    await finishRegistration(db, full, user, device.register(options, rp) as never, rp, "One", T0);
    options = await startRegistration(db, full, user, rp, T0);
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([b64url(device.credentialId)]);
    await expect(finishRegistration(db, full, user, device.register(options, rp) as never, rp, "Two", T0)).rejects.toThrow(/already/);
  });
});

