import {
  cursor,
  name,
  pageLimit,
  queryNumber,
  registrationCodePattern,
  registrationStatus,
} from "@wayfarerlabs/agention-api";
import { z } from "zod";
import { groupId, tagList } from "./groups-and-tags.ts";

// Registrations as the operator reads and decides them: the list of them, and
// approval.

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
