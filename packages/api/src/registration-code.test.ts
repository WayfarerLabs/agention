import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type PublicKey, publicKey, registrationCodePattern } from "./registrations.ts";
import { registrationCode } from "./registration-code.ts";

// The same derivation written another way: digest bits as a string of 0s and 1s.
function codeFromBitString(key: string): string {
  const digest = createHash("sha256").update(Buffer.from(key, "base64url")).digest();
  const bits = [...digest].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  // cspell:disable-next-line
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let code = "";
  for (let i = 0; i < 50; i += 5) {
    code += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function newPublicKey(): PublicKey {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  return publicKey.parse(jwk.x);
}

describe("registrationCode", () => {
  it.each([
    // cspell:disable-next-line
    ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "CSM7N-BFRCA"],
    ["AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", "CC6WT-AB6RG"],
  ])("derives the code of %s", (key, code) => {
    expect(registrationCode(publicKey.parse(key))).toBe(code);
  });

  it("matches an independent derivation for generated keys", () => {
    for (let i = 0; i < 50; i++) {
      const key = newPublicKey();
      const code = registrationCode(key);
      expect(code).toMatch(registrationCodePattern);
      expect(code).toBe(codeFromBitString(key));
    }
  });
});

describe("publicKey", () => {
  it.each([
    "",
    "AAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    // cspell:disable-next-line
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
  ])("refuses the malformed key %j", (key) => {
    expect(publicKey.safeParse(key).success).toBe(false);
  });
});
