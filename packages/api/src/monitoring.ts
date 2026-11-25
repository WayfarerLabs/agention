import { z } from "zod";
import { queryBoolean, queryNumber } from "./bounds.ts";
import { timestamp } from "./time.ts";

// Monitoring: what a session's bridge observes of the terminal its agent's
// host runs in, and the background connection it reports over. One bridge
// acts for a session at a time; the server keeps which in memory. What a
// bridge reports reaches only the operator, never an agent, and holds no
// text: every field is an enumeration, a boolean, a time or the name of a
// profile.

// The id a bridge draws when its reporter starts, so the server can tell the
// bridges of one session apart.
export const bridgeId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, "must be 16 to 64 of A-Z, a-z, 0-9, '_' and '-'");

// Where a session is now, as the bridge reads its terminal, in this order of
// precedence: unknown when it cannot read it or the host no longer has it; a
// permission or approval dialog; any other dialog or prompt for someone at
// the terminal; a turn in progress; at its normal input line; and waiting, at
// rest in nothing the profile recognizes.
export const monitorCondition = z.enum([
  "unknown",
  "permission_prompt",
  "other_prompt",
  "running",
  "at_prompt",
  "waiting",
]);
export type MonitorCondition = z.infer<typeof monitorCondition>;

// The conditions a session is at rest in, which alone may say what stopped it.
const atRest: readonly MonitorCondition[] = [
  "permission_prompt",
  "other_prompt",
  "at_prompt",
  "waiting",
];

// The profile a bridge reads the terminal with, by the name its registry and
// configuration give it, such as "claude-code" or "generic-strict": a
// harness's own, or a generic one for a harness without. Profiles are added
// as harnesses are, so the name is held to a shape rather than to a list,
// and is never text from the terminal.
export const monitorProfile = z
  .string()
  .max(40)
  .regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
    "must be lowercase letters, digits and single hyphens, starting with a letter",
  );
export type MonitorProfile = z.infer<typeof monitorProfile>;

// What stopped a session at rest, where its profile can tell: its account's
// usage limit, with when it resets where the host shows it; a block, the host
// refusing an action on a safety or permission rule; or an error from its
// model provider.
export const stoppedBy = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("usage_limit"), resets_at: timestamp.optional() }),
  z.object({ reason: z.literal("block") }),
  z.object({ reason: z.literal("error") }),
]);
export type StoppedBy = z.infer<typeof stoppedBy>;

// A bridge's report: whether it monitors a terminal pane at all, and while it
// does, the profile it reads it with, the session's condition and since when,
// and what stopped it, which only a condition at rest may carry; and whether
// the session can be nudged: its nudge on, its pane read, and a profile that
// can tell when the session is at its prompt, absent from a bridge older than
// the nudge, which never nudges. A report replaces the one before it.
export const monitorReport = z.discriminatedUnion("monitored", [
  z.object({ monitored: z.literal(false) }),
  z
    .object({
      monitored: z.literal(true),
      profile: monitorProfile,
      condition: monitorCondition,
      since: timestamp,
      stopped_by: stoppedBy.optional(),
      nudge: z.boolean().optional(),
    })
    .superRefine((value, context) => {
      if (value.stopped_by !== undefined && !atRest.includes(value.condition)) {
        context.addIssue({
          code: "custom",
          path: ["stopped_by"],
          message: "goes only with a condition at rest",
        });
      }
    }),
]);
export type MonitorReport = z.infer<typeof monitorReport>;

// The bridge a monitoring request comes from.
const monitorQuery = z.object({ bridge: bridgeId });

// A report's query: the bridge's id, and the report's number, which counts up
// with each report the bridge sends, so the server ignores a report that
// arrives after a later one from the same bridge.
export const monitorReportQuery = monitorQuery.extend({
  seq: queryNumber(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)),
});
export type MonitorReportQuery = z.infer<typeof monitorReportQuery>;

// The background long poll: the bridge's id; whether it claims the session,
// taking over from any other bridge, as a bridge does when it starts and
// whenever it handles a tool call after being replaced; whether the bridge
// knows already that a nudge is due, as the poll before last told it; and how
// long to wait, 25 seconds unless it says less.
export const monitorPollQuery = monitorQuery.extend({
  claim: queryBoolean(z.boolean().default(false)),
  nudge: queryBoolean(z.boolean().default(false)),
  wait: queryNumber(z.number().int().min(0).max(25).default(25)),
});
export type MonitorPollQuery = z.infer<typeof monitorPollQuery>;

// The answer of a poll or a report: whether another bridge acts for the
// session now. A replaced bridge stops polling and reporting until it next
// claims the session.
export const monitorAnswer = z.object({ replaced: z.boolean() });
export type MonitorAnswer = z.infer<typeof monitorAnswer>;

// The answer of a poll, which also says whether a nudge is due: the bridge
// should nudge its agent, and nothing more, since the reason, the threads and
// the session's presence are the operator's. A poll answers once whether one
// is due differs from what its query says the bridge knows, as it starts or
// once a report or a message wakes it, and a replaced bridge is never told
// one is.
export const monitorPollAnswer = monitorAnswer.extend({ nudge: z.boolean() });
export type MonitorPollAnswer = z.infer<typeof monitorPollAnswer>;

// The query of a nudge's claim or outcome: the bridge's id.
export const monitorNudgeQuery = monitorQuery;
export type MonitorNudgeQuery = z.infer<typeof monitorNudgeQuery>;

// A nudge's claim and its outcome, which the bridge sends for the nudge it
// tries: start, once the session is ready for it and before anything reaches
// the pane, which claims the nudge that is due; and done, once a nudge it
// claimed ends, saying whether it was sent, the message submitted at the
// agent's prompt, or abandoned at a step before or after that.
export const monitorNudge = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("start") }),
  z.object({ phase: z.literal("done"), sent: z.boolean() }),
]);
export type MonitorNudge = z.infer<typeof monitorNudge>;

// The answer of a nudge's claim or outcome: whether another bridge acts for
// the session now, and, for a claim, whether the bridge may go ahead, a nudge
// being due and now claimed. A replaced bridge never may, and an outcome
// never says it may.
export const monitorNudgeAnswer = monitorAnswer.extend({ go: z.boolean() });
export type MonitorNudgeAnswer = z.infer<typeof monitorNudgeAnswer>;

// A session's latest report as the operator sees it, its times as the server
// writes them, with whether the session can be nudged, false for a bridge
// older than the nudge.
export const monitorState = z.discriminatedUnion("monitored", [
  z.object({ monitored: z.literal(false) }),
  z.object({
    monitored: z.literal(true),
    profile: monitorProfile,
    condition: monitorCondition,
    since: z.string(),
    nudge: z.boolean(),
    stopped_by: z
      .discriminatedUnion("reason", [
        z.object({ reason: z.literal("usage_limit"), resets_at: z.string().optional() }),
        z.object({ reason: z.literal("block") }),
        z.object({ reason: z.literal("error") }),
      ])
      .optional(),
  }),
]);
export type MonitorState = z.infer<typeof monitorState>;

// A session's latest nudge as the operator sees it: when its bridge claimed
// it, by the server's clock; whether it was sent, true too while it is under
// way or where its outcome never arrived; and whether the agent has checked
// in since. A nudge sent with no check-in since is one the agent is not
// responding to.
export const nudgeState = z.object({
  at: z.string(),
  sent: z.boolean(),
  answered: z.boolean(),
});
export type NudgeState = z.infer<typeof nudgeState>;
