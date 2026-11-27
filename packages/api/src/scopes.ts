import { z } from "zod";

// What an identity may do, as scopes named <resource>:<access>, so a later
// resource adds scopes without changing these. A browser session holds every
// scope, an agent's registration holds threads:write over its own session,
// and an API key holds the scopes the operator chose for it.
export const scope = z.enum([
  "threads:read",
  "threads:write",
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "saved-views:read",
  "saved-views:write",
]);
export type Scope = z.infer<typeof scope>;

// Every scope, in the enum's order.
export const scopes: readonly Scope[] = scope.options;

// What each scope lets its holder do, beside the scopes it includes: the one
// place each grant is written, which the API key form shows and the API
// reference lists with its API key scheme, through scopeDescription.
const scopeGrants: Record<Scope, string> = {
  "threads:read":
    "Read the thread list and its counts, any thread with its messages and files, and wait " +
    "for new messages.",
  "threads:write":
    "Also start threads, write in them, answer asks, upload files to attach and remove those " +
    "not yet sent, and mark threads read, unread, or archived.",
  "sessions:read":
    "Read the sessions view with its agents, groups, and tags, each session's log, and " +
    "agents' registrations.",
  "sessions:write":
    "Also mark a session's log read, and manage groups and tags, a tag's rename reaching the " +
    "saved views that name it.",
  "sessions:approve":
    "Also approve, reject, and revoke agents' registrations, and, with sessions:write too, set " +
    "the group and tags of a session it approves: whoever holds the key can let any agent it " +
    "chooses in.",
  "saved-views:read": "Read the saved views, each with its thread list.",
  "saved-views:write": "Also save, rename, replace, and remove saved views.",
};

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
  "saved-views:read": [],
  "saved-views:write": ["saved-views:read"],
};

// scopeDescription says what a scope grants, and the scopes it includes.
export function scopeDescription(granting: Scope): string {
  const includes = included[granting];
  return includes.length === 0
    ? scopeGrants[granting]
    : `${scopeGrants[granting]} Includes ${includes.join(", ")}.`;
}

// holdsScope says whether the scopes held grant the one required, directly or
// by inclusion.
export function holdsScope(held: readonly Scope[], required: Scope): boolean {
  return held.some((each) => each === required || included[each].includes(required));
}
