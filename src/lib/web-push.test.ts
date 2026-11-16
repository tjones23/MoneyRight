import { createECDH, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPayload } from "./web-push.fixtures";
import { encryptPayload, isPushEndpoint, newVapidKeys, validSubscriptionKeys, vapidAuthorization } from "./web-push";

describe("encryptPayload", () => {
  it("matches RFC 8291's worked example", () => {
    const serverKeys = createECDH("prime256v1");
    serverKeys.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
    const body = encryptPayload(
      "When I grow up, I want to be a watermelon",
      {
        p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
      serverKeys,
    );
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("opens with the subscriber's keys, and differs every time", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
    const message = JSON.stringify({ title: "Sign in to MoneyRight?", url: "/approve/abc" });
    const a = encryptPayload(message, keys);
    const b = encryptPayload(message, keys);
    expect(a.equals(b)).toBe(false);
    expect(decryptPayload(a, ua.getPrivateKey(), auth)).toBe(message);
  });
});

describe("vapidAuthorization", () => {
  it("is an ES256 JWT for the push service's origin, verifiable with the public key", () => {
    const keys = newVapidKeys();
    const now = Date.UTC(2026, 10, 16);
    const header = vapidAuthorization("https://web.push.apple.com/QGuQyavX", keys, "https://moneyright.example.ts.net", now);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(match[2]).toBe(keys.publicKey);
    const [h, p, sig] = match[1].split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims).toEqual({ aud: "https://web.push.apple.com", exp: now / 1000 + 43200, sub: "https://moneyright.example.ts.net" });
    const pub = Buffer.from(keys.publicKey, "base64url");
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
      format: "jwk",
    });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
  });
});

describe("subscription checks", () => {
  it("accepts only the browsers' push services, over https", () => {
    expect(isPushEndpoint("https://web.push.apple.com/QGuQyavXutnMfa")).toBe(true);
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("https://wns2-bl2p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushEndpoint("http://web.push.apple.com/x")).toBe(false);
    expect(isPushEndpoint("https://web.push.apple.com.evil.example/x")).toBe(false);
    expect(isPushEndpoint("https://127.0.0.1/x")).toBe(false);
    expect(isPushEndpoint("https://web.push.apple.com:8443/x")).toBe(false);
    expect(isPushEndpoint("not a url")).toBe(false);
  });

  it("wants a P-256 point and a 16-byte secret", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const p256dh = ua.getPublicKey().toString("base64url");
    expect(validSubscriptionKeys({ p256dh, auth: Buffer.alloc(16).toString("base64url") })).toBe(true);
    expect(validSubscriptionKeys({ p256dh, auth: Buffer.alloc(8).toString("base64url") })).toBe(false);
    expect(validSubscriptionKeys({ p256dh: "AAAA", auth: Buffer.alloc(16).toString("base64url") })).toBe(false);
  });
});
