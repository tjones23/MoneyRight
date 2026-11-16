import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";

/**
 * For tests only: the receiving browser's half of RFC 8291, to check that
 * what the server sends opens with the subscriber's keys.
 */
export function decryptPayload(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const uaPublic = ua.getPublicKey();
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  if (record[record.length - 1] !== 0x02) throw new Error("Not a last record");
  return record.subarray(0, record.length - 1).toString("utf8");
}
