import { importJWK, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Fixture } from "../store/test-fixture.ts";
import { settlePushKey, tokenLifetime, VapidTokens, vapidSubject } from "./vapid.ts";

// The server's push key and the tokens it signs with it.

let fixture: Fixture;

beforeEach(() => {
  fixture = new Fixture();
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.close();
});

const hour = 60 * 60 * 1000;
const audience = "https://fcm.googleapis.com";

// The claims of the token a header carries, verified against the public key
// the header names.
async function verified(header: string) {
  const [, token, key] = /^vapid t=([^,]+), k=([\w-]+)$/.exec(header) ?? [];
  const point = Buffer.from(key ?? "", "base64url");
  const publicKey = await importJWK(
    {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    "ES256",
  );
  return (await jwtVerify(token ?? "", publicKey, { currentDate: new Date(fixture.now) })).payload;
}

it("is made once and kept, and never changes after", () => {
  const first = settlePushKey(fixture.db);
  expect(settlePushKey(fixture.db).publicKey).toBe(first.publicKey);
  expect(Buffer.from(first.publicKey, "base64url")).toHaveLength(65);
  expect(() =>
    fixture.db.prepare("UPDATE instance SET vapid_private_key = randomblob(32)").run(),
  ).toThrow(/never changes/);
});

it("signs a token for a push service, naming the project and expiring in 12 hours", async () => {
  const key = settlePushKey(fixture.db);
  const header = await new VapidTokens(key, () => fixture.now).authorization(audience);
  expect(header.endsWith(`k=${key.publicKey}`)).toBe(true);
  expect(await verified(header)).toEqual({
    aud: audience,
    exp: Math.floor((fixture.now + tokenLifetime) / 1000),
    sub: vapidSubject,
  });
});

it("reuses a token for 11 hours, signing once for sends at once", async () => {
  const tokens = new VapidTokens(settlePushKey(fixture.db), () => fixture.now);
  const [one, other] = await Promise.all([
    tokens.authorization(audience),
    tokens.authorization(audience),
  ]);
  expect(other).toBe(one);
  expect(await tokens.authorization("https://web.push.apple.com")).not.toBe(one);
  fixture.advance(11 * hour - 1);
  expect(await tokens.authorization(audience)).toBe(one);
  fixture.advance(1);
  expect(await tokens.authorization(audience)).not.toBe(one);
});

it("forgets a signing that fails, so the next send signs again", async () => {
  const tokens = new VapidTokens(settlePushKey(fixture.db), () => fixture.now);
  vi.spyOn(SignJWT.prototype, "sign").mockRejectedValueOnce(new Error("signing failed"));
  await expect(tokens.authorization(audience)).rejects.toThrow("signing failed");
  expect(await verified(await tokens.authorization(audience))).toMatchObject({ aud: audience });
});
