import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Browser sessions and passkey links are 256 random bits. The holder gets the
// secret in base64url; the database keeps only the SHA-256 of that text, so a
// copy of the database opens nothing. The secret is random, so a fast hash is
// enough.

export interface Secret {
  token: string;
  hash: Buffer;
}

export function newSecret(): Secret {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

// hashOfSecret returns the hash a presented secret would be stored under.
export function hashOfSecret(token: string | undefined): Buffer | undefined {
  return token === undefined ? undefined : sha256(token);
}

function sha256(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

// sameSecret compares two secrets in time that does not depend on where they
// differ.
export function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
