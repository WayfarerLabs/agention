import { z } from "zod";
import { name } from "./names.ts";

// A session key's public half: the raw 32-byte Ed25519 public key in
// unpadded base64url, written canonically so each key has one spelling. The
// schema is where a key is checked; the brand marks a string that passed it.
export const publicKey = z
  .string()
  // cspell:disable-next-line
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "must be a base64url Ed25519 public key")
  .brand<"PublicKey">();
export type PublicKey = z.infer<typeof publicKey>;

// The claims of the token an agent signs with its key for every request: the
// server's canonical origin, and when the token expires, in seconds since the
// epoch. The token's header names the key as kid and the algorithm as EdDSA.
export const agentTokenClaims = z.object({ aud: z.string(), exp: z.number() });
export type AgentTokenClaims = z.infer<typeof agentTokenClaims>;

// The code the operator matches before approving: a digest of the public key,
// grouped as the agent relays it.
// cspell:disable-next-line
export const registrationCodePattern = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

// A pending registration past its expiry is expired; it can no longer be
// approved.
export const registrationStatus = z.enum(["pending", "expired", "approved", "rejected", "revoked"]);
export type RegistrationStatus = z.infer<typeof registrationStatus>;

// The agent and session names an agent proposes when it registers its key.
export const registrationSubmitInput = z.object({ agent: name, session: name });
export type RegistrationSubmitInput = z.infer<typeof registrationSubmitInput>;

// A registration's state, as the agent sees it; the granted names appear once
// it is approved.
export const registrationState = z.object({
  status: registrationStatus,
  code: z.string().regex(registrationCodePattern),
  expires_at: z.string(),
  agent: name.optional(),
  session: name.optional(),
});
export type RegistrationState = z.infer<typeof registrationState>;
