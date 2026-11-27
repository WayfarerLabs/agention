import { SignJWT } from "jose";
import { createECDH, createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Database } from "../database/database.ts";

// The server's push key (VAPID, RFC 8292): a P-256 key pair whose public half
// every device subscribes with and whose private half signs the token that
// identifies the server to a push service. The first agention serve that
// finds none makes it and keeps it in the instance row, so a backup carries
// it and a restore keeps every subscription working; it never changes after,
// which the database enforces. The private key never leaves the server and is
// never logged.

export interface PushKey {
  // The private key, for signing tokens.
  privateKey: KeyObject;
  // The public key, the 65-octet uncompressed point, base64url, which a
  // browser subscribes with and every token names.
  publicKey: string;
}

// settlePushKey reads the server's push key, storing a new one first when
// none is, as the server's name is stored: of starts racing, the first to
// store its key keeps it.
export function settlePushKey(db: Database): PushKey {
  const candidate = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    format: "jwk",
  }).d;
  if (candidate === undefined) {
    throw new Error("a new P-256 key has no private scalar");
  }
  const row = db.transaction(
    () =>
      db
        .prepare(
          `UPDATE instance SET vapid_private_key = coalesce(vapid_private_key, ?)
           WHERE id = 1 RETURNING vapid_private_key`,
        )
        .get(Buffer.from(candidate, "base64url")) as { vapid_private_key: Uint8Array },
  );
  return pushKeyOf(row.vapid_private_key);
}

// pushKeyOf derives the key pair from the stored private scalar. The row is
// persisted state, so a scalar that is not a P-256 private key fails here,
// with a message that names no key material.
function pushKeyOf(scalar: Uint8Array): PushKey {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(scalar);
    const point = ecdh.getPublicKey();
    const privateKey = createPrivateKey({
      key: {
        kty: "EC",
        crv: "P-256",
        d: Buffer.from(scalar).toString("base64url"),
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    return { privateKey, publicKey: point.toString("base64url") };
  } catch {
    throw new Error("the server's stored push key is not a P-256 private key");
  }
}

// The subject every token names: the project's address, so it names neither
// the operator nor the server's host. Apple requires an https: URL.
export const vapidSubject = "https://github.com/WayfarerLabs/agention";

const hour = 60 * 60 * 1000;

// A token lasts 12 hours and is reused until an hour before it expires, so a
// push service never sees a new one more often than once an hour, as Apple
// asks, nor one about to expire.
export const tokenLifetime = 12 * hour;
const reuseFor = tokenLifetime - hour;

// VapidTokens signs the Authorization header a push service's origin takes,
// and keeps each in memory while it may be reused. It keeps the signing's
// promise, so two sends to one push service at once sign once; a signing
// that fails is forgotten.
export class VapidTokens {
  readonly #key: PushKey;
  readonly #clock: () => number;
  readonly #cache = new Map<string, { authorization: Promise<string>; renewAt: number }>();

  constructor(key: PushKey, clock: () => number) {
    this.#key = key;
    this.#clock = clock;
  }

  // authorization answers the header for a push service's origin.
  authorization(audience: string): Promise<string> {
    const now = this.#clock();
    const cached = this.#cache.get(audience);
    if (cached !== undefined && now < cached.renewAt) {
      return cached.authorization;
    }
    const authorization = new SignJWT({ sub: vapidSubject })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setAudience(audience)
      .setExpirationTime(Math.floor((now + tokenLifetime) / 1000))
      .sign(this.#key.privateKey)
      .then((jwt) => `vapid t=${jwt}, k=${this.#key.publicKey}`);
    const entry = { authorization, renewAt: now + reuseFor };
    this.#cache.set(audience, entry);
    authorization.catch(() => {
      if (this.#cache.get(audience) === entry) {
        this.#cache.delete(audience);
      }
    });
    return authorization;
  }
}
