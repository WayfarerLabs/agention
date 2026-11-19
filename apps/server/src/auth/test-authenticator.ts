// A software passkey authenticator for the tests: it answers the server's
// WebAuthn options the way a browser and a platform authenticator would,
// with an ES256 key, "none" attestation and a signature counter.
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

const flags = { userPresent: 0x01, userVerified: 0x04, attestedData: 0x40 };

export interface Answer {
  // The origin the browser reports; a page elsewhere would report its own.
  origin?: string;
  // Whether the authenticator verified the user, by PIN or biometric.
  userVerified?: boolean;
  crossOrigin?: boolean;
}

type Options = Record<string, unknown>;

export class TestAuthenticator {
  readonly credentialId = randomBytes(16).toString("base64url");
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  rpId = "";
  userHandle: string | undefined;
  counter = 0;
  // Many passkeys keep their counter at zero; such an authenticator never
  // advances it.
  counting = true;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
  }

  #clientData(type: string, options: Options, answer: Answer, origin: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge: options.challenge,
        origin: answer.origin ?? origin,
        crossOrigin: answer.crossOrigin ?? false,
      }),
    );
  }

  #authData(extra: Uint8Array, flagBits: number): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(Buffer.from(this.rpId)), Buffer.from([flagBits]), counter, extra]);
  }

  #flags(answer: Answer): number {
    return flags.userPresent | (answer.userVerified === false ? 0 : flags.userVerified);
  }

  // create answers registration options with a new credential.
  create(options: Options, origin: string, answer: Answer = {}) {
    this.rpId = (options.rp as { id: string }).id;
    this.userHandle = (options.user as { id: string }).id;
    const jwk = this.#publicKey.export({ format: "jwk" });
    const coseKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]),
    );
    const id = Buffer.from(this.credentialId, "base64url");
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, id, coseKey]);
    const authData = this.#authData(attested, this.#flags(answer) | flags.attestedData);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, number> | Uint8Array>([
        ["fmt", "none"],
        ["attStmt", new Map<string, number>()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: this.#clientData("webauthn.create", options, answer, origin).toString(
          "base64url",
        ),
        attestationObject: Buffer.from(attestationObject).toString("base64url"),
        transports: ["internal"],
      },
    };
  }

  // get answers sign-in options with an assertion, counting the signature.
  get(options: Options, origin: string, answer: Answer = {}) {
    if (this.counting) {
      this.counter += 1;
    }
    const clientData = this.#clientData("webauthn.get", options, answer, origin);
    const authData = this.#authData(new Uint8Array(), this.#flags(answer));
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientData)]),
      this.#privateKey,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        ...(this.userHandle === undefined ? {} : { userHandle: this.userHandle }),
      },
    };
  }
}
