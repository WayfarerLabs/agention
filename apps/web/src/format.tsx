import {
  type Author,
  type Effort,
  type Impact,
  type MonitorState,
  monitorCondition,
  type Presence,
  type Priority,
  type SessionPresence,
  type ThreadStatus,
  type ThreadSummary,
  type WorkOutcome,
  type WorkState,
} from "@wayfarerlabs/agention-api";

// Words and times for the views.

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000;
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.trunc(seconds / size), unit);
    }
  }
  return seconds < 0 ? "just now" : "in under a minute";
}

// Time shows when something happened relative to now, with the exact time in
// the element's machine-readable value and its tooltip.
export function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={absolute.format(Date.parse(value))}>
      {relativeTime(value)}
    </time>
  );
}

export function absoluteTime(iso: string): string {
  return absolute.format(Date.parse(iso));
}

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

// today says whether a time falls on today's date.
const today = (iso: string, now = Date.now()) =>
  new Date(iso).toDateString() === new Date(now).toDateString();

// sinceTime says briefly when something last happened: the time of day when
// it was today, and the date when earlier.
export function sinceTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  return today(iso, now) ? clock.format(at) : day.format(at);
}

// Since shows when something last happened, briefly, with the exact time in
// the element's machine-readable value and its tooltip.
export function Since({ value }: { value: string }) {
  return (
    <time dateTime={value} title={absolute.format(Date.parse(value))}>
      {sinceTime(value)}
    </time>
  );
}

const dayAndClock = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// dueTime says briefly when something is due: the time of day when that is
// today; otherwise the date too, with its year when it is not this year's.
export function dueTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (today(iso, now)) {
    return clock.format(at);
  }
  return at.getFullYear() === new Date(now).getFullYear()
    ? dayAndClock.format(at)
    : absolute.format(at);
}

// DueTime shows when something is due, briefly, with the exact time in the
// element's machine-readable value and its tooltip.
export function DueTime({ value }: { value: string }) {
  return (
    <time dateTime={value} title={absolute.format(Date.parse(value))}>
      {dueTime(value)}
    </time>
  );
}

// checkInWords says when a session's agent last checked in: "last check-in
// 14:02", or "never checked in".
function checkInWords(presence: Presence): string {
  return presence.last_seen_at === undefined
    ? "never checked in"
    : `last check-in ${sinceTime(presence.last_seen_at)}`;
}

// What a session reports it is doing, in a word.
const workStateLabel: Record<WorkState, string> = {
  working: "Working",
  idle: "Idle",
  stopped: "Stopped",
};

// workStateWords says what a session reports it is doing: "Working", "Idle",
// or "Stopped · completed", with the outcome a stopped session gives.
export function workStateWords(status: { state: WorkState; outcome?: WorkOutcome | undefined }) {
  const label = workStateLabel[status.state];
  return status.outcome === undefined ? label : `${label} · ${status.outcome}`;
}

// A session's condition as its bridge last reported it, while it monitors
// the session's terminal.
export type Observed = Extract<MonitorState, { monitored: true }>;

// observedOf gives what a session's bridge last observed of its terminal,
// which the server shows only while the bridge is connected, if it monitors
// one.
export const observedOf = (presence: SessionPresence): Observed | undefined =>
  presence.monitor?.monitored === true ? presence.monitor : undefined;

// The prompt a session's screen holds at rest, after "at".
const promptWords: Partial<Record<Observed["condition"], string>> = {
  at_prompt: "its prompt",
  permission_prompt: "a permission prompt",
  other_prompt: "another prompt",
};

// stoppedByWords says what stopped a session: "a usage limit (resets
// 15:00)", with the reset time when the host showed one, or "(reset due
// 15:00)" once that time has passed, "a block", "an error", or "something"
// for a reason a newer server gives that this page does not know.
function stoppedByWords(stopped: NonNullable<Observed["stopped_by"]>, now: number): string {
  switch (stopped.reason) {
    case "usage_limit": {
      const { resets_at: resets } = stopped;
      if (resets === undefined) {
        return "a usage limit";
      }
      const when = dueTime(resets, now);
      return Date.parse(resets) <= now
        ? `a usage limit (reset due ${when})`
        : `a usage limit (resets ${when})`;
    }
    case "block":
      return "a block";
    case "error":
      return "an error";
    default:
      return "something";
  }
}

// The conditions this page knows; a newer server may report others.
const knownConditions: ReadonlySet<string> = new Set(monitorCondition.options);

// conditionWords says briefly what a session's terminal shows, as a tag says
// it. What stopped it comes first, with any prompt beside it, as in "stopped
// by a usage limit (resets 15:00), at its prompt"; a dialog with nothing
// else to say why stopped it there, as in "stopped at a permission prompt";
// otherwise "running", "at its prompt", "waiting" or "condition unknown",
// which a condition this page does not know reads as too.
export function conditionWords(observed: Observed, now = Date.now()): string {
  const { condition, stopped_by: stopped } = observed;
  const prompt = promptWords[condition];
  if (stopped !== undefined) {
    return `stopped by ${stoppedByWords(stopped, now)}${prompt === undefined ? "" : `, at ${prompt}`}`;
  }
  switch (condition) {
    case "permission_prompt":
    case "other_prompt":
      return `stopped at ${prompt}`;
    case "at_prompt":
      return "at its prompt";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "unknown":
    default:
      return "condition unknown";
  }
}

// terminalNeedsYou says whether a session's terminal shows something for the
// operator to look at: a permission prompt or another prompt, or something
// that stopped it, whatever the reason, one this page does not know among
// them. A condition this page does not know needs nothing, as unknown does.
export const terminalNeedsYou = (observed: Observed | undefined): boolean =>
  observed !== undefined &&
  (observed.stopped_by !== undefined ||
    observed.condition === "permission_prompt" ||
    observed.condition === "other_prompt");

// ConditionClause says, as a clause, what a session's terminal shows: "its
// terminal shows it stopped at a permission prompt", or "its condition is
// unknown", as for a condition this page does not know.
export function ConditionClause({ observed }: { observed: Observed }) {
  const unknown = observed.condition === "unknown" || !knownConditions.has(observed.condition);
  return unknown && observed.stopped_by === undefined ? (
    <>its condition is unknown</>
  ) : (
    <>its terminal shows it {conditionWords(observed)}</>
  );
}

// What the operator knows of a session that says whether it is there to see
// what they write: the state it last reported, if any, and the outcome a
// stopped one gave; its presence, with what its bridge last observed of its
// terminal; and whether it has an active credential.
export interface Whereabouts {
  state?: WorkState | undefined;
  outcome?: WorkOutcome | undefined;
  presence: SessionPresence;
  credential_active: boolean;
}

// Why a session is not likely to see what the operator writes, with what its
// terminal shows, when its bridge observes one.
export type Absence = (
  | { kind: "stopped"; outcome: WorkOutcome | undefined }
  | { kind: "quiet"; last_seen_at: string | undefined }
  | { kind: "credential" }
  | { kind: "disconnected" }
) & { observed?: Observed | undefined };

// absenceOf says why a session is not likely to see what the operator writes
// until something starts it again, if it is not: it stopped, with its
// outcome; or it is quiet, with when its agent last checked in; or it has no active
// credential; or its bridge is not connected, the first of them that holds;
// with what its terminal shows, where its bridge observes one. A bridge from
// before monitoring never says whether it is connected, so its session is
// never disconnected.
export function absenceOf(session: Whereabouts): Absence | undefined {
  const observed = observedOf(session.presence);
  const beside = observed === undefined ? {} : { observed };
  if (session.state === "stopped") {
    return { kind: "stopped", outcome: session.outcome, ...beside };
  }
  if (session.presence.quiet) {
    return { kind: "quiet", last_seen_at: session.presence.last_seen_at, ...beside };
  }
  if (!session.credential_active) {
    return { kind: "credential", ...beside };
  }
  return session.presence.connected === false ? { kind: "disconnected" } : undefined;
}

// absenceWords says briefly why a session is not likely to see what the
// operator writes, as a tag says it: "stopped, completed", "last check-in
// 14:02", "never checked in", "no active credential" or "not connected",
// followed by what its terminal shows, where its bridge observes one, as in
// "last check-in 14:02 · stopped at a permission prompt".
export function absenceWords(absence: Absence): string {
  const why = absenceWhyWords(absence);
  return absence.observed === undefined ? why : `${why} · ${conditionWords(absence.observed)}`;
}

function absenceWhyWords(absence: Absence): string {
  switch (absence.kind) {
    case "stopped":
      return absence.outcome === undefined ? "stopped" : `stopped, ${absence.outcome}`;
    case "quiet":
      return checkInWords({ quiet: true, last_seen_at: absence.last_seen_at });
    case "credential":
      return "no active credential";
    case "disconnected":
      return "not connected";
  }
}

// AbsenceReason says, as a clause, why a session is not likely to see what
// the operator writes: "it stopped, completed", "it has not checked in since
// 14:02", "it has never checked in", "it has no active credential" or "its
// bridge is not connected", and what its terminal shows, where its bridge
// observes one, as in "it has not checked in since 14:02, and its terminal
// shows it stopped at a permission prompt".
export function AbsenceReason({ absence }: { absence: Absence }) {
  return (
    <>
      <AbsenceWhy absence={absence} />
      {absence.observed !== undefined && (
        <>
          , and <ConditionClause observed={absence.observed} />
        </>
      )}
    </>
  );
}

function AbsenceWhy({ absence }: { absence: Absence }) {
  switch (absence.kind) {
    case "stopped":
      return <>it stopped{absence.outcome === undefined ? "" : `, ${absence.outcome}`}</>;
    case "quiet":
      return absence.last_seen_at === undefined ? (
        <>it has never checked in</>
      ) : (
        <>
          it has not checked in since <Since value={absence.last_seen_at} />
        </>
      );
    case "credential":
      return <>it has no active credential</>;
    case "disconnected":
      return <>its bridge is not connected</>;
  }
}

// threadWhereabouts reads what a thread's audience knows of its session.
export function threadWhereabouts(thread: ThreadSummary): Whereabouts {
  return {
    state: thread.presence?.state,
    outcome: thread.presence?.outcome,
    presence: thread.presence ?? { quiet: false },
    credential_active: thread.credential_active,
  };
}

// settledWords says, muted, of a thread with no ask open, that its asks were
// answered, or withdrawn, with the latest reason.
export function settledWords(thread: ThreadSummary): string | undefined {
  if (thread.status === "answered") {
    return "Answered";
  }
  return thread.status === "withdrawn" && thread.withdrawal !== undefined
    ? `Withdrawn: ${thread.withdrawal.reason}`
    : undefined;
}

// A thread's status, as the filter sheet offers it.
export const statusLabel: Record<ThreadStatus, TerseLabel> = {
  open: { shown: "Open", spoken: "Open" },
  answered: { shown: "Answered", spoken: "Answered" },
  withdrawn: { shown: "Withdrawn", spoken: "Withdrawn" },
  none: { shown: "None", spoken: "No asks" },
};

// plural counts things in words: "1 thread", "12 threads", or with a word
// for several that is not the one's with an s, "2 branches".
export const plural = (count: number, one: string, several = `${one}s`) =>
  `${count} ${count === 1 ? one : several}`;

// byteSize says how large something is in binary units, as the limits are:
// bytes under 1 KiB, and above, to three figures: "512 B", "1.2 MiB",
// "100 MiB".
const figures = new Intl.NumberFormat("en", { maximumSignificantDigits: 3, useGrouping: false });
const byteUnits = ["KiB", "MiB", "GiB", "TiB", "PiB"];

export function byteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  while (Number(value.toPrecision(3)) >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${figures.format(value)} ${byteUnits[unit]}`;
}

// quoted writes labels as a reader sees them chosen: “Ship it”, “Hold”.
export const quoted = (labels: string[]) => labels.map((label) => `“${label}”`).join(", ");

// The last choice on an ask's card, for the operator's own words.
export const otherLabel = "Other";

export function authorName(author: Author): string {
  return author.kind === "person" ? author.name : `${author.agent}/${author.session}`;
}

export const priorityLabel: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High priority",
  normal: "Normal priority",
  low: "Low priority",
};

// The tone a priority draws the eye with, where it has one.
export const priorityTone: Record<Priority, string | undefined> = {
  urgent: "danger",
  high: "warning",
  normal: undefined,
  low: undefined,
};

// A terse label, as a tag or a segment shows it, with the words assistive
// technology says for it.
export interface TerseLabel {
  shown: string;
  spoken: string;
}

// plain is a label said as it is shown.
export const plain = (text: string): TerseLabel => ({ shown: text, spoken: text });

export function Spoken({ shown, spoken }: TerseLabel) {
  return shown === spoken ? (
    shown
  ) : (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="visually-hidden">{spoken}</span>
    </>
  );
}

// An ask's effort.
export const effortLabel: Record<Effort, TerseLabel> = {
  quick: { shown: "Quick", spoken: "Quick" },
  under_15m: { shown: "≤15m", spoken: "Under 15 minutes" },
  under_1h: { shown: "≤1h", spoken: "Under an hour" },
  longer: { shown: ">1h", spoken: "An hour or more" },
};

export const impactLabel: Record<Impact, string> = {
  blocking: "Blocking",
  assuming: "Proceeding on an assumption",
  none: "Not blocking",
};
