import {
  cursor,
  maxListed,
  messageDetail,
  messageText,
  name,
  pageLimit,
  presence,
  queryNumber,
  registrationCodePattern,
  requestId,
  sequence,
  sessionStatus,
  threadTitle,
} from "@wayfarerlabs/agention-api";
import { z } from "zod";
import { groupRef, maxTags, tagName } from "./groups-and-tags.ts";
import { registrationId } from "./registrations.ts";

// Sessions as the operator reads them: each session's log of the updates it
// reported, and the sessions view, every agent with its sessions; and the
// operator's start of a thread on a session.

// An entry of a session's log: its sequence, counting from 1 within the
// session, when it was written, the session's status after it, its own note,
// and whether the server inferred it: an inferred entry is one the session
// never reported, logged when it wrote to a thread while idle, which marked
// it working. An inferred entry carries no note.
export const sessionUpdate = sessionStatus.extend({
  seq: sequence,
  created_at: z.string(),
  note: z.string().optional(),
  inferred: z.boolean(),
});
export type SessionUpdate = z.infer<typeof sessionUpdate>;

export const sessionLogQuery = z.object({
  before: queryNumber(sequence.min(1).optional()),
  limit: queryNumber(pageLimit),
});
export type SessionLogQuery = z.infer<typeof sessionLogQuery>;

// A page of a session's log, newest first, before the sequence the query
// gives, or from the latest without one; more follow while the last one's
// sequence is above 1. read_through is how far the caller has read the log.
export const sessionLog = z.object({ updates: z.array(sessionUpdate), read_through: sequence });
export type SessionLog = z.infer<typeof sessionLog>;

export const sessionLogMarkInput = z.object({ through: sequence });
export type SessionLogMarkInput = z.infer<typeof sessionLogMarkInput>;

export const sessionLogMark = z.object({ read_through: sequence });
export type SessionLogMark = z.infer<typeof sessionLogMark>;

export const sessionsQuery = z.object({
  cursor: cursor.optional(),
  limit: queryNumber(pageLimit),
});
export type SessionsQuery = z.infer<typeof sessionsQuery>;

// A session as the operator's sessions view shows it: its presence; its
// approved registrations, each by its id and code; its status with the latest
// entry's note and when that entry was written, absent until it first reports;
// how many of its log's entries the operator has not read; how many of its
// threads the operator has not archived, how many of those hold messages the
// operator has not read, and how many are stranded; and how many asks are open
// in all its threads, and how many of those are blocking, which is what waits
// on the operator. The operator can never archive a thread holding an ask open
// to them, so their thread list shows every thread these asks are in. It also
// carries the operator's group for it, absent when it is in none, its tags,
// in name order, and whether its plugin is behind the server.
export const sessionSummary = z.object({
  session: name,
  created_at: z.string(),
  group: groupRef.optional(),
  tags: z.array(tagName).max(maxTags),
  presence,
  registrations: z.array(
    z.object({ id: registrationId, code: z.string().regex(registrationCodePattern) }),
  ),
  status: sessionStatus.extend({ note: z.string().optional(), updated_at: z.string() }).optional(),
  unread_updates: sequence,
  threads: z.object({ total: sequence, unread: sequence, stranded: sequence }),
  open_asks: z.object({ count: sequence, blocking_count: sequence }),
  plugin_behind: z
    .boolean()
    .describe(
      "whether the session's latest call stated an older agent API version than the " +
        "server's, so the server offers features its Agention plugin cannot use; the fix is " +
        "to update the plugin on the agent's host to its newest release and restart the " +
        "session. False for a session with no call recorded",
    ),
});
export type SessionSummary = z.infer<typeof sessionSummary>;

// A page of agents in name order, each with its tags, in name order, and its
// sessions, at most maxListed of them, saying when it leaves any out: working
// and idle ones first, then those that never reported, then stopped ones,
// each latest seen first.
export const sessionsPage = z.object({
  agents: z.array(
    z.object({
      agent: name,
      tags: z.array(tagName).max(maxTags),
      sessions: z.array(sessionSummary).max(maxListed),
      truncated: z.boolean(),
    }),
  ),
  next: cursor.optional(),
});
export type SessionsPage = z.infer<typeof sessionsPage>;

// The operator's start of a thread on a session: a title and a first message
// of text, with its detail. The session stays the thread's requester and the
// operator its audience, so the requester's parts, asks and a topic, have no
// field here, and neither do references and attachments, which the web UI's
// sheet does not offer. Like every request schema it drops what it does not
// know, so a start carrying any of them starts a thread without them.
export const threadStartInput = z.object({
  request_id: requestId,
  title: threadTitle,
  text: messageText,
  detail: messageDetail.optional(),
});
export type ThreadStartInput = z.infer<typeof threadStartInput>;
