import { createHash } from "node:crypto";
import type { PublicKey } from "./registrations.ts";

// Crockford's base32 alphabet, which leaves out I, L, O and U so a code read
// aloud or retyped is hard to get wrong.
// cspell:disable-next-line
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// registrationCode derives the code the operator matches before approving a
// key: the first 50 bits of SHA-256 over the raw public key, in Crockford
// base32, grouped XXXXX-XXXXX. The agent bridge and the server both compute it,
// so matching codes mean the approved registration carries the agent's key.
//
// This module uses node:crypto, so it has its own entry point and stays out of
// the web bundle.
export function registrationCode(key: PublicKey): string {
  const digest = createHash("sha256").update(Buffer.from(key, "base64url")).digest();
  let bits = 0n;
  for (const byte of digest.subarray(0, 7)) {
    bits = (bits << 8n) | BigInt(byte);
  }
  bits >>= 6n; // keep the first 50 of these 56 bits
  let code = "";
  for (let shift = 45n; shift >= 0n; shift -= 5n) {
    code += alphabet[Number((bits >> shift) & 31n)];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
