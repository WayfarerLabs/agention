import { z } from "zod";
import { cursor, maxListed, pageLimit, queryNumber, sequence } from "./bounds.ts";
import { groupRef, maxTags, tagName } from "./groups-and-tags.ts";
import { monitorState, nudgeState } from "./monitoring.ts";
import { name } from "./names.ts";
import { registrationCodePattern, registrationId } from "./registrations.ts";
import { singleLineText } from "./text.ts";

// Sessions: where each one is, as its presence, and what it reports of its
// work, as its status, which it changes through one call and the operator
// reads in its log.

// A session's presence: when its agent was last seen checking in, calling
// Agention through any route but its bridge's background ones, kept to the
// minute and absent until it first does; whether it is quiet, not seen within
// the server's quiet threshold, or never; and whether its bridge is
// connected, having made a background request within the last minute. Whether
// it is connected is absent while the session follows the rule of bridges
// that predate monitoring, which cannot report a connection: no bridge is
// connected and the agent last checked in through one of them.
export const presence = z.object({
  last_seen_at: z.string().optional(),
  quiet: z.boolean(),
  connected: z.boolean().optional(),
});
export type Presence = z.infer<typeof presence>;

// A session's state, which says what it is doing and what the operator can
// expect of it: working while it does something now and idle while it has
// nothing left to do but wait, both while it checks Agention, or, idle, while
// it waits at its prompt for the bridge's nudge, and stopped once it no
// longer does either, until something starts it again. Whether it waits on
// the operator is no state: its open asks say so.
export const workState = z
  .enum(["working", "idle", "stopped"])
  .describe(
    "working while you are doing something now, checking Agention as you go; idle while you " +
      "have nothing left to do but wait, for the operator's answers, CI or a review, and you " +
      "still check Agention, or, where register's answers is nudge, wait at your prompt for " +
      "the bridge's nudge; stopped once you stop checking Agention, so you will not see new " +
      "messages until something starts you again. stopped needs an outcome.",
  );
export type WorkState = z.infer<typeof workState>;

// Why a session stopped, which only a stopped session has.
export const workOutcome = z
  .enum(["completed", "withdrawn", "stalled"])
  .describe(
    "Why you stopped, given only with state stopped: completed when the work is done, " +
      "withdrawn when the operator called it off, stalled when you cannot go on.",
  );
export type WorkOutcome = z.infer<typeof workOutcome>;

// A session's title is bounded as a thread's is.
export const sessionTitle = singleLineText({ min: 1, max: 200 }).describe(
  "A short title for this line of work, which the operator sees beside the session's name.",
);
export const sessionGoal = singleLineText({ min: 1, max: 300 }).describe(
  "The goal you were given for this session, in one line: the operator's, or your " +
    "instructions'. Never one you infer.",
);
export const sessionPercent = z
  .number()
  .int()
  .min(0)
  .max(100)
  .describe(
    "Roughly how far toward the goal you are, 0 to 100, updated at natural points, never on " +
      "every step. A new goal clears it unless the same update gives one.",
  );
export const sessionNote = singleLineText({ min: 1, max: 300 }).describe(
  "One line on what just happened, kept with this update alone.",
);

// outcomeGoesWithStopped refuses stopped without an outcome, and an outcome
// beside any other state or none, so an outcome given alone is refused for
// that rule alone.
export function outcomeGoesWithStopped(
  value: { state?: WorkState | undefined; outcome?: WorkOutcome | undefined },
  context: z.RefinementCtx,
): void {
  if (value.state === "stopped" && value.outcome === undefined) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "a session that stops gives its outcome",
    });
  }
  if (value.outcome !== undefined && value.state !== "stopped") {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "goes only with state stopped",
    });
  }
}

// A session's update of its status. A field left out is unchanged; the note
// belongs to this update alone. An update gives at least one field, and an
// outcome goes with stopped and only with it.
export const sessionUpdateInput = z
  .object({
    state: workState.optional(),
    outcome: workOutcome.optional(),
    title: sessionTitle.optional(),
    goal: sessionGoal.optional(),
    percent: sessionPercent.optional(),
    note: sessionNote.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.state === undefined &&
      value.outcome === undefined &&
      value.title === undefined &&
      value.goal === undefined &&
      value.percent === undefined &&
      value.note === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "an update needs a state, a title, a goal, a percent or a note",
      });
    }
  })
  .superRefine(outcomeGoesWithStopped);
export type SessionUpdateInput = z.infer<typeof sessionUpdateInput>;

// What a session's write to a thread may report of its status beside it: a
// state, with the outcome beside stopped, and a note, applied as an update
// with them would be, with the write and only if it lands. A write that
// reports none of them marks an idle session working, since a session that
// writes is doing something; a stopped one stays stopped. The schemas that
// take these fields add outcomeGoesWithStopped.
export const writeStatusFields = {
  state: workState
    .optional()
    .describe(
      "Your session's state from this write on, as session_update reports it, such as idle " +
        "on the last message before you wait. A write that reports no status at all marks an " +
        "idle session working and leaves any other state as it was.",
    ),
  outcome: workOutcome.optional(),
  note: sessionNote.optional(),
};
const writeStatus = z.object(writeStatusFields);
export type WriteStatus = z.infer<typeof writeStatus>;

// A session's status: its state, the outcome it stopped with while stopped,
// and its title, goal and percent, each absent until the session gives it.
export const sessionStatus = z.object({
  state: workState,
  outcome: workOutcome.optional(),
  title: z.string().optional(),
  goal: z.string().optional(),
  percent: z.number().int().optional(),
});
export type SessionStatus = z.infer<typeof sessionStatus>;

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

// A session's presence as the operator's sessions view shows it: with its
// bridge's latest report while it is connected, absent until one reports, and
// its latest nudge, absent until its bridge first claims one.
export const sessionPresence = presence.extend({
  monitor: monitorState.optional(),
  last_nudge: nudgeState.optional(),
});
export type SessionPresence = z.infer<typeof sessionPresence>;

// A session's presence as a thread's summary shows it to the thread's
// audience, the operator: as the sessions view shows it, with the state and
// outcome the session last reported, both absent until it first reports, so
// the audience can tell why a thread is stranded, and what its terminal shows
// while its bridge is connected.
export const threadPresence = sessionPresence.extend({
  state: workState.optional(),
  outcome: workOutcome.optional(),
});
export type ThreadPresence = z.infer<typeof threadPresence>;

// A session as the operator's sessions view shows it: its presence; its
// approved registrations, each by its id and code; its status with the latest
// entry's note and when that entry was written, absent until it first reports;
// how many of its log's entries the operator has not read; how many of its
// threads the operator has not archived, how many of those hold messages the
// operator has not read, and how many are stranded; and how many asks are open
// in all its threads, and how many of those are blocking, which is what waits
// on the operator. The operator can never archive a thread holding an ask open
// to them, so their thread list shows every thread these asks are in. It also
// carries the operator's group for it, absent when it is in none, and its tags,
// in name order.
export const sessionSummary = z.object({
  session: name,
  created_at: z.string(),
  group: groupRef.optional(),
  tags: z.array(tagName).max(maxTags),
  presence: sessionPresence,
  registrations: z.array(
    z.object({ id: registrationId, code: z.string().regex(registrationCodePattern) }),
  ),
  status: sessionStatus.extend({ note: z.string().optional(), updated_at: z.string() }).optional(),
  unread_updates: sequence,
  threads: z.object({ total: sequence, unread: sequence, stranded: sequence }),
  open_asks: z.object({ count: sequence, blocking_count: sequence }),
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
