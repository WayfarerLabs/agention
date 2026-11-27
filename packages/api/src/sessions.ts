import { z } from "zod";
import { singleLineText } from "./text.ts";

// Sessions: where each one is, as its presence, and what it reports of its
// work, as its status, which it changes through one call and the operator
// reads in its log.

// A session's presence: when it was last seen, kept to the minute and absent
// until it first is, and whether it is quiet, not seen within the server's
// quiet threshold, or never.
export const presence = z.object({ last_seen_at: z.string().optional(), quiet: z.boolean() });
export type Presence = z.infer<typeof presence>;

// A session's state, which says what it is doing and what the operator can
// expect of it: working while it does something now and idle while it has
// nothing left to do but wait, both while it checks Agention, and stopped
// once it no longer does, until something starts it again. Whether it waits
// on the operator is no state: its open asks say so.
export const workState = z
  .enum(["working", "idle", "stopped"])
  .describe(
    "working while you are doing something now, checking Agention as you go; idle while you " +
      "have nothing left to do but wait, for the operator's answers, CI or a review, and you " +
      "still check Agention; stopped once you stop checking Agention, so you will not see new " +
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

// A session's presence as a thread's summary shows it to the thread's
// audience: with the state and outcome the session last reported, both absent
// until it first reports, so the audience can tell why a thread is stranded.
export const threadPresence = presence.extend({
  state: workState.optional(),
  outcome: workOutcome.optional(),
});
export type ThreadPresence = z.infer<typeof threadPresence>;

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
