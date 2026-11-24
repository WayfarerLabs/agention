import { z } from "zod";

// What an identity may do, as scopes named <resource>:<access>, so a later
// resource adds scopes without changing these. A browser session holds every
// scope, an agent's registration holds threads:write over its own session,
// and an API key holds the scopes the operator chose for it.
export const scope = z
  .enum(["threads:read", "threads:write", "sessions:read", "sessions:write", "sessions:approve"])
  .describe(
    "threads:read reads the thread list, its counts, and any thread with its messages and " +
      "its files; threads:write also starts threads, writes in them, answers asks, uploads " +
      "files to attach and removes those not yet sent, and marks threads read, unread and " +
      "archived; sessions:read reads the sessions view, a session's log, groups and tags, and " +
      "agents' registrations; " +
      "sessions:write also marks a session's log read and manages groups and tags; " +
      "sessions:approve also approves, rejects and revokes agents' registrations, and with " +
      "sessions:write gives an approved session its group and tags",
  );
export type Scope = z.infer<typeof scope>;

// Every scope, in the enum's order.
export const scopes: readonly Scope[] = scope.options;

// The scopes each scope includes besides itself: a write includes its
// resource's read, and approving registrations includes reading sessions,
// where registrations are listed. sessions:write and sessions:approve include
// neither the other.
const included: Record<Scope, readonly Scope[]> = {
  "threads:read": [],
  "threads:write": ["threads:read"],
  "sessions:read": [],
  "sessions:write": ["sessions:read"],
  "sessions:approve": ["sessions:read"],
};

// holdsScope says whether the scopes held grant the one required, directly or
// by inclusion.
export function holdsScope(held: readonly Scope[], required: Scope): boolean {
  return held.some((each) => each === required || included[each].includes(required));
}
