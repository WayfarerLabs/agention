import {
  type AgentTokenClaims,
  agentTokenClaims,
  type PublicKey,
  publicKey,
} from "@wayfarerlabs/agention-api";
import { compactVerify, decodeProtectedHeader, importJWK } from "jose";
import type { Database } from "../database/database.ts";
import { agentUnauthenticated, ApiError, unapprovedKey, unauthenticated } from "../errors.ts";
import { type Identity, identityForRegistration, type RequestOrigin } from "../identity.ts";
import { findRegistrationByKey } from "../store/index.ts";

// Agents authenticate every request with a token they mint themselves: a
// compact JWS signed with the session's Ed25519 key, whose header names the
// key (kid, the base64url public key) and whose claims bind it to this
// server's origin (aud) for a few minutes (exp). The server issues and stores
// no token; it checks each one against the public key it was registered with.
// Each refusal names what to fix: the key, the token or the clock.

// A token may expire at most this far ahead of the server's clock: the bridge
// asks for two minutes, which leaves two minutes of clock skew either way.
export const maxTokenLifetime = 300_000;

// keyIdOf reads the token from an Authorization header and returns the key its
// header names, after checking the shape and that it claims EdDSA.
function keyIdOf(authorization: string | undefined): { token: string; kid: PublicKey } {
  const token = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(authorization ?? "")?.[1];
  if (token === undefined) {
    throw unauthenticated("the request needs an agent token as Authorization: Bearer");
  }
  let header: { alg?: unknown; kid?: unknown };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw unauthenticated("the agent token is not a compact JWS");
  }
  if (header.alg !== "EdDSA") {
    throw unauthenticated("the agent token must be signed with EdDSA");
  }
  const kid = publicKey.safeParse(header.kid);
  if (!kid.success) {
    throw unauthenticated("the agent token's kid must be its base64url Ed25519 public key");
  }
  return { token, kid: kid.data };
}

// verifySignedBy checks the token's signature against the public key and its
// claims against the origin and the clock.
async function verifySignedBy(
  token: string,
  key: PublicKey,
  origin: string,
  now: number,
): Promise<void> {
  let payload: Uint8Array;
  try {
    const verifier = await importJWK({ kty: "OKP", crv: "Ed25519", x: key }, "EdDSA");
    ({ payload } = await compactVerify(token, verifier, { algorithms: ["EdDSA"] }));
  } catch {
    throw unauthenticated("the agent token is not signed by the key its kid names");
  }
  let claims: AgentTokenClaims;
  try {
    claims = agentTokenClaims.parse(JSON.parse(new TextDecoder().decode(payload)));
  } catch {
    throw unauthenticated("the agent token's claims need aud, a string, and exp, a number");
  }
  if (claims.aud !== origin) {
    throw unauthenticated(
      `the agent token is for another server; this server's origin is ${origin}, ` +
        "so set AGENTION_URL to it",
    );
  }
  const expires = claims.exp * 1000;
  if (!(expires > now && expires <= now + maxTokenLifetime)) {
    throw unauthenticated(
      "the agent token has expired or expires more than five minutes ahead; " +
        "check the agent machine's clock",
    );
  }
}

// verifyRegistrationToken authenticates a registration request: the token must
// be signed by the key it names, which may be one the server has never seen.
// It returns that key.
export async function verifyRegistrationToken(
  authorization: string | undefined,
  origin: string,
  now: number,
): Promise<PublicKey> {
  const { token, kid } = keyIdOf(authorization);
  await verifySignedBy(token, kid, origin, now);
  return kid;
}

// authenticateAgent authenticates a request on a session: the token's key must
// belong to an approved registration, whose session the identity reaches. The
// identity carries the request it arrived as. The
// operation's transaction confirms the registration is still approved. Its
// refusals also tell the agent to call register, which reports what the
// operator still has to do.
export async function authenticateAgent(
  db: Database,
  authorization: string | undefined,
  origin: string,
  now: number,
  request: RequestOrigin,
): Promise<{ identity: Identity; publicKey: PublicKey }> {
  try {
    const { token, kid } = keyIdOf(authorization);
    const registration = findRegistrationByKey(db, kid);
    if (registration === undefined) {
      throw unauthenticated(unapprovedKey(undefined));
    }
    await verifySignedBy(token, kid, origin, now);
    const identity =
      registration.status === "approved"
        ? identityForRegistration(db, registration.id, request)
        : undefined;
    if (identity === undefined) {
      throw unauthenticated(unapprovedKey(registration.status));
    }
    return { identity, publicKey: kid };
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthenticated") {
      throw agentUnauthenticated(error.message);
    }
    throw error;
  }
}
