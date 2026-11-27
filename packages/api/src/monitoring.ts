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
export const monitorCondition = z
  .enum(["unknown", "permission_prompt", "other_prompt", "running", "at_prompt", "waiting"])
  .describe(
    "Where the session is, as its bridge reads its terminal, in this order of precedence: " +
      "unknown when the bridge cannot read it; permission_prompt at a permission or approval " +
      "dialog; other_prompt at any other dialog or prompt for someone at the terminal; running " +
      "in a turn; at_prompt at its normal input line; waiting at rest in nothing its profile " +
      "recognizes.",
  );
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
  )
  .describe("The profile the bridge reads the terminal with, such as claude-code.");
export type MonitorProfile = z.infer<typeof monitorProfile>;

// What stopped a session at rest, where its profile can tell: its account's
// usage limit, with when it resets where the host shows it; a block, the host
// refusing an action on a safety or permission rule; or an error from its
// model provider.
const stoppedByDescription =
  "What stopped the session at rest, where its profile can tell: usage_limit, its account's " +
  "usage limit, resetting at resets_at where the host shows it; block, the host refusing an " +
  "action on a safety or permission rule; or error, an error from its model provider.";
export const stoppedBy = z
  .discriminatedUnion("reason", [
    z.object({ reason: z.literal("usage_limit"), resets_at: timestamp.optional() }),
    z.object({ reason: z.literal("block") }),
    z.object({ reason: z.literal("error") }),
  ])
  .describe(stoppedByDescription);
export type StoppedBy = z.infer<typeof stoppedBy>;

// Why a bridge cannot monitor its session's terminal or nudge its agent, one
// of a fixed list: the nudge off (nudge_off) or of a type the bridge does not
// know (unknown_nudge_type); no tmux socket configured (no_socket); a pane it
// cannot read (pane_unreachable), or one that is not the session's alone
// (not_one_pane); a profile name it does not know (unknown_profile), or a
// generic profile, which never nudges (generic_profile); nudge text left at
// the prompt, which holds the nudge off until it is cleared
// (nudge_text_left); and a server that refused its nudges as invalid
// (claims_refused). A bridge reports the one that matters most, from the
// first: what keeps it from the pane before what keeps it from nudging.
export const monitorReason = z
  .enum([
    "no_socket",
    "pane_unreachable",
    "not_one_pane",
    "unknown_profile",
    "unknown_nudge_type",
    "nudge_off",
    "generic_profile",
    "claims_refused",
    "nudge_text_left",
  ])
  .describe(
    "Why the bridge cannot monitor the session's terminal or nudge its agent: no_socket, no " +
      "tmux socket configured; pane_unreachable, the pane cannot be read; not_one_pane, the " +
      "tmux server holds more than one pane or one that is not the session's; unknown_profile, " +
      "a harness profile the bridge does not know; unknown_nudge_type, a nudge type it does not " +
      "know; nudge_off, no nudge type configured; generic_profile, a generic profile, which " +
      "never nudges; claims_refused, the server refused its nudges as invalid; nudge_text_left, " +
      "nudge text left at the prompt, which holds the nudge off until it is cleared.",
  );
export type MonitorReason = z.infer<typeof monitorReason>;

// Why a bridge cannot monitor or nudge, and since when, by the bridge's
// clock.
export const monitorUnable = z.object({ reason: monitorReason, since: timestamp });
export type MonitorUnable = z.infer<typeof monitorUnable>;

// A bridge's report: whether it monitors a terminal pane at all, and while it
// does, the profile it reads it with, the session's condition and since when,
// and what stopped it, which only a condition at rest may carry; whether the
// session can be nudged: its nudge on, its pane read, and a profile that can
// tell when the session is at its prompt, absent from a bridge older than the
// nudge, which never nudges; and, either way, why it cannot monitor or nudge,
// where it cannot, as it finds now. A report replaces the one before it.
export const monitorReport = z.discriminatedUnion("monitored", [
  z.object({ monitored: z.literal(false), unable: monitorUnable.optional() }),
  z
    .object({
      monitored: z.literal(true),
      profile: monitorProfile,
      condition: monitorCondition,
      since: timestamp,
      stopped_by: stoppedBy.optional(),
      nudge: z.boolean().optional(),
      unable: monitorUnable.optional(),
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

// A nudge attempt's id, which the bridge draws at random for each attempt and
// puts in the texts it types, so the harness's transcript names the attempt
// that woke the agent.
export const nudgeId = z
  .string()
  .regex(/^[0-9a-f]{12}$/, "must be 12 lowercase hex digits")
  .describe("The nudge attempt's id, which its texts in the terminal carry.");

// How a nudge attempt ended: deferred, nothing of it left in the terminal, so
// it is no nudge and the bridge tries again; stopped by someone at the
// terminal; failed; or sent, the agent's host having taken the message.
export const nudgeOutcome = z.enum(["deferred", "stopped", "failed", "sent"]);
export type NudgeOutcome = z.infer<typeof nudgeOutcome>;

// A nudge's claim and its outcome, which the bridge sends for the attempt it
// makes, by the attempt's id: start, once the session is ready for it and
// before anything reaches the pane, which claims the nudge that is due; and
// done, once an attempt it claimed, or may have, ends, with how.
export const monitorNudge = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("start"), id: nudgeId }),
  z.object({ phase: z.literal("done"), id: nudgeId, outcome: nudgeOutcome }),
]);
export type MonitorNudge = z.infer<typeof monitorNudge>;

// The answer of a nudge's claim or outcome: whether another bridge acts for
// the session now, and, for a claim, whether the bridge may go ahead, a nudge
// being due and now claimed. A replaced bridge never may, and an outcome
// never says it may.
export const monitorNudgeAnswer = monitorAnswer.extend({ go: z.boolean() });
export type MonitorNudgeAnswer = z.infer<typeof monitorNudgeAnswer>;

// Why a session's bridge cannot monitor or nudge, as the operator sees it.
const unableState = z
  .object({
    reason: monitorReason,
    since: z.string().describe("Since when, by the bridge's clock."),
  })
  .optional()
  .describe(
    "Why the bridge cannot monitor the session's terminal or nudge its agent, where it cannot, " +
      "and since when; absent where it can, and from a bridge older than the nudge.",
  );

// A session's latest report as the operator sees it, its times as the server
// writes them, with whether the session can be nudged, false for a bridge
// older than the nudge, and why it cannot monitor or nudge, where it cannot.
export const monitorState = z.discriminatedUnion("monitored", [
  z.object({ monitored: z.literal(false), unable: unableState }),
  z.object({
    monitored: z.literal(true),
    profile: monitorProfile,
    condition: monitorCondition,
    since: z.string().describe("When the session came to its condition."),
    nudge: z
      .boolean()
      .describe(
        "Whether the bridge can nudge the agent at its prompt; false for a bridge older than the nudge.",
      ),
    stopped_by: z
      .discriminatedUnion("reason", [
        z.object({ reason: z.literal("usage_limit"), resets_at: z.string().optional() }),
        z.object({ reason: z.literal("block") }),
        z.object({ reason: z.literal("error") }),
      ])
      .optional()
      .describe(stoppedByDescription),
    unable: unableState,
  }),
]);
export type MonitorState = z.infer<typeof monitorState>;

// A session's latest nudge as the operator sees it: when its bridge claimed
// it, by the server's clock; its attempt's id; how it ended, sent too while it
// is under way or where its outcome never arrived, since an attempt deferred
// is no nudge; and whether the agent has checked in since. A nudge sent with
// no check-in since is one the agent is not responding to.
export const nudgeState = z.object({
  at: z.string().describe("When the bridge claimed the nudge, by the server's clock."),
  id: nudgeId,
  outcome: nudgeOutcome
    .exclude(["deferred"])
    .describe(
      "How the nudge ended: sent, the agent's host took the message, which it also reads while " +
        "the nudge is under way or where its outcome never came; stopped by someone at the " +
        "terminal; or failed.",
    ),
  answered: z
    .boolean()
    .describe(
      "Whether the agent has checked in since. A sent nudge not answered is one the agent is not " +
        "responding to.",
    ),
});
export type NudgeState = z.infer<typeof nudgeState>;
