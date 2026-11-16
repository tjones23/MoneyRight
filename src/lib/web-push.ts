import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type ECDH } from "node:crypto";

/**
 * Web Push, by hand: the message encryption of RFC 8291 (aes128gcm, RFC 8188)
 * and the VAPID sender identity of RFC 8292. Small enough not to need a
 * dependency, and like totp.ts it takes everything as arguments, so it's
 * deterministic to test.
 *
 * The push service (Apple's, Google's, Mozilla's) only ever sees ciphertext:
 * the message is encrypted to keys the phone's browser made, and only it can
 * open it.
 */

export interface VapidKeys {
  /** Uncompressed P-256 point, 65 bytes, base64url — what the browser subscribes with. */
  publicKey: string;
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
}

export interface PushSubscriptionKeys {
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** Its 16-byte auth secret, base64url. */
  auth: string;
}

export function newVapidKeys(): VapidKeys {
  const ecdh = freshKeys();
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: ecdh.getPrivateKey().toString("base64url") };
}

/**
 * The push services browsers use. A subscription naming any other host is
 * refused, so a forged one can't make this server send requests elsewhere.
 */
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^jmt17\.google\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.port && !url.username && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

export function validSubscriptionKeys(keys: PushSubscriptionKeys): boolean {
  try {
    const pub = Buffer.from(keys.p256dh, "base64url");
    const auth = Buffer.from(keys.auth, "base64url");
    return pub.length === 65 && pub[0] === 0x04 && auth.length === 16;
  } catch {
    return false;
  }
}

function vapidPrivateKey(keys: VapidKeys) {
  const pub = Buffer.from(keys.publicKey, "base64url");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

/**
 * The `Authorization` header for one push service: an ES256 JWT naming it as
 * the audience, signed with the VAPID key the subscription was made against.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64({ typ: "JWT", alg: "ES256" })}.${b64({
    aud: new URL(endpoint).origin,
    // Services cap this at 24 hours.
    exp: Math.floor(nowMs / 1000) + 12 * 60 * 60,
    sub: subject,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: vapidPrivateKey(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

function freshKeys(): ECDH {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh;
}

/** Record size; one record holds any message this app sends. */
const RECORD_SIZE = 4096;

/**
 * The encrypted body (RFC 8291 §4). `salt` and `serverKeys` are fresh per
 * message; they're arguments only so a test can pin them.
 */
export function encryptPayload(
  plaintext: string,
  subscription: PushSubscriptionKeys,
  salt: Buffer = randomBytes(16),
  serverKeys: ECDH = freshKeys(),
): Buffer {
  const uaPublic = Buffer.from(subscription.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.auth, "base64url");
  const asPublic = serverKeys.getPublicKey();
  const shared = serverKeys.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  // One record, so it's also the last: the 0x02 delimiter, no padding.
  const record = Buffer.concat([Buffer.from(plaintext, "utf8"), Buffer.from([0x02])]);
  if (record.length + 16 > RECORD_SIZE) throw new Error("Push message too long");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}
