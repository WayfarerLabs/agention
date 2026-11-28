import { type PushPayload, pushPayload } from "@wayfarerlabs/agention-api";
import ece from "http_ece";
import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPush, encryptRecord, maxDataLength } from "./encryption.ts";

const b64 = (text: string) => Buffer.from(text.replaceAll(/\s/g, ""), "base64url");

// RFC 8291, section 5 and Appendix A, as published: the example's inputs and
// the body the encryption produces from them.
// cspell:disable
const example = {
  plaintext: b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
  asPublic: b64(`BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg
    Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8`),
  asPrivate: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  uaPublic: b64(`BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-
    JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4`),
  uaPrivate: b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
  authSecret: b64("BTBZMqHH6r4Tts7J_aSIgg"),
  body: b64(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`),
};
// cspell:enable

// A device: its key pair, which only it holds, and its secret.
function newDevice() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.from("0123456789abcdef");
  return { ecdh, keys: { p256dh: ecdh.getPublicKey(), auth } };
}

// decrypt decrypts a body as the device would, with http_ece, an independent
// implementation installed only for these tests and never shipped.
const decrypt = (body: Buffer, device: ReturnType<typeof newDevice>) =>
  ece.decrypt(body, {
    version: "aes128gcm",
    privateKey: device.ecdh,
    authSecret: device.keys.auth,
  });

describe("aes128gcm for Web Push", () => {
  it("encrypts RFC 8291's example byte for byte", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(example.asPrivate);
    expect(ecdh.getPublicKey()).toEqual(example.asPublic);
    const record = Buffer.concat([example.plaintext, Buffer.from([0x02])]);
    const body = encryptRecord(
      record,
      { p256dh: example.uaPublic, auth: example.authSecret },
      { ecdh, salt: example.salt },
    );
    expect(body.toString("base64url")).toBe(example.body.toString("base64url"));
  });

  it("is decrypted by an independent implementation, the RFC's example included", () => {
    const ua = createECDH("prime256v1");
    ua.setPrivateKey(example.uaPrivate);
    expect(
      ece.decrypt(example.body, {
        version: "aes128gcm",
        privateKey: ua,
        authSecret: example.authSecret,
      }),
    ).toEqual(example.plaintext);

    const device = newDevice();
    const data = Buffer.from(JSON.stringify({ title: "Ship it?", why: "blocking" }));
    expect(decrypt(encryptPush(data, device.keys), device)).toEqual(data);
  });

  it("makes every body one size, whatever it holds, with a new key and salt each time", () => {
    const device = newDevice();
    const smallest = encryptPush(Buffer.alloc(0), device.keys);
    const largest = encryptPush(Buffer.alloc(maxDataLength, 0x61), device.keys);
    expect([smallest.length, largest.length]).toEqual([1126, 1126]);
    expect(decrypt(largest, device)).toEqual(Buffer.alloc(maxDataLength, 0x61));
    const again = encryptPush(Buffer.alloc(0), device.keys);
    // The salt, then the message's public key after the record size and its
    // length.
    expect(again.subarray(0, 16)).not.toEqual(smallest.subarray(0, 16));
    expect(again.subarray(21, 86)).not.toEqual(smallest.subarray(21, 86));
  });

  it("refuses data longer than the padded record holds", () => {
    expect(() => encryptPush(Buffer.alloc(maxDataLength + 1), newDevice().keys)).toThrow();
  });
});

describe("the push payload", () => {
  it("fits the padded record with every field at its largest", () => {
    const largest: PushPayload = pushPayload.parse({
      agent: "a".repeat(63),
      session: "s".repeat(63),
      thread: Number.MAX_SAFE_INTEGER,
      title: "\u{10FFFF}".repeat(200),
      why: "blocking",
    });
    const length = Buffer.byteLength(JSON.stringify(largest));
    expect(length).toBe(1005);
    expect(length).toBeLessThanOrEqual(maxDataLength);
  });
});
