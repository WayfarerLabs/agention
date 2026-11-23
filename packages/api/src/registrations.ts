import { z } from "zod";
import { cursor, pageLimit, queryNumber } from "./bounds.ts";
import { groupId, tagList } from "./groups-and-tags.ts";
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

// Registrations are numbered from 1, and the operator's routes name them by
// that number.
export const registrationId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const registrationsQuery = z.object({
  status: registrationStatus.optional(),
  cursor: cursor.optional(),
  limit: queryNumber(pageLimit),
});
export type RegistrationsQuery = z.infer<typeof registrationsQuery>;

// A registration as the operator sees it. decided_at is when it was approved
// or rejected, and revoked_at when an approved one was revoked; granted names
// the session it was approved for, and whether that session still has an
// approved credential.
export const registration = z.object({
  id: registrationId,
  code: z.string().regex(registrationCodePattern),
  status: registrationStatus,
  proposed_agent: name,
  proposed_session: name,
  created_at: z.string(),
  expires_at: z.string(),
  decided_at: z.string().optional(),
  revoked_at: z.string().optional(),
  granted: z.object({ agent: name, session: name, credential_active: z.boolean() }).optional(),
});
export type Registration = z.infer<typeof registration>;

export const registrationsPage = z.object({
  registrations: z.array(registration),
  next: cursor.optional(),
});
export type RegistrationsPage = z.infer<typeof registrationsPage>;

// Approval names the agent and session to grant, which may differ from the
// proposed ones, and says whether each already exists, so granting an existing
// session's history is always deliberate. It may also put the session in a
// group and set its tags, with the approval, which need sessions:write too.
export const approveInput = z.object({
  agent: z.object({
    name,
    existing: z
      .boolean()
      .describe(
        "whether the agent named already exists: true grants that agent, false creates " +
          "it; a mismatch is refused as invalid_input on agent.name",
      ),
  }),
  session: z.object({
    name,
    existing: z
      .boolean()
      .describe(
        "whether the agent's session named already exists: true grants that session, " +
          "false creates it; a mismatch is refused as invalid_input on session.name. " +
          "Approving onto an existing session grants the new key that session's whole " +
          "history, every thread and message in it",
      ),
    group: groupId
      .nullable()
      .optional()
      .describe(
        "The id of an existing group to put the session in, or null for none, as the approval " +
          "grants it; left out, the session's group is unchanged. Needs sessions:write",
      ),
    tags: tagList
      .optional()
      .describe(
        "The session's tags, the whole set, as the approval grants it; a name no tag has " +
          "creates that tag. Left out, the session's tags are unchanged. Needs sessions:write",
      ),
  }),
});
export type ApproveInput = z.infer<typeof approveInput>;

export const registrationResult = z.object({ registration });
export type RegistrationResult = z.infer<typeof registrationResult>;
