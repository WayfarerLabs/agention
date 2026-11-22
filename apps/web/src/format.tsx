import type {
  Author,
  Effort,
  Impact,
  Presence,
  Priority,
  ThreadStatus,
  ThreadSummary,
  WorkOutcome,
  WorkState,
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
function dueTime(iso: string, now = Date.now()): string {
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

// lastSeenWords says when a session was last seen: "last seen 14:02", or
// "never seen".
export function lastSeenWords(presence: Presence): string {
  return presence.last_seen_at === undefined
    ? "never seen"
    : `last seen ${sinceTime(presence.last_seen_at)}`;
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

// What the operator knows of a session that says whether it is there to see
// what they write: the state it last reported, if any, and the outcome a
// stopped one gave; its presence; and whether it has an active credential.
export interface Whereabouts {
  state?: WorkState | undefined;
  outcome?: WorkOutcome | undefined;
  presence: Presence;
  credential_active: boolean;
}

// Why a session is not likely to see what the operator writes.
export type Absence =
  | { kind: "stopped"; outcome: WorkOutcome | undefined }
  | { kind: "quiet"; last_seen_at: string | undefined }
  | { kind: "credential" };

// absenceOf says why a session is not likely to see what the operator writes
// until something starts it again, if it is not: it stopped, with its
// outcome; or it is quiet, with when it was last seen; or it has no active
// credential, the first of them that holds.
export function absenceOf(session: Whereabouts): Absence | undefined {
  if (session.state === "stopped") {
    return { kind: "stopped", outcome: session.outcome };
  }
  if (session.presence.quiet) {
    return { kind: "quiet", last_seen_at: session.presence.last_seen_at };
  }
  return session.credential_active ? undefined : { kind: "credential" };
}

// absenceWords says briefly why a session is not likely to see what the
// operator writes, as a tag says it: "stopped, completed", "last seen 14:02",
// "never seen" or "no active credential".
export function absenceWords(absence: Absence): string {
  switch (absence.kind) {
    case "stopped":
      return absence.outcome === undefined ? "stopped" : `stopped, ${absence.outcome}`;
    case "quiet":
      return lastSeenWords({ quiet: true, last_seen_at: absence.last_seen_at });
    case "credential":
      return "no active credential";
  }
}

// AbsenceReason says, as a clause, why a session is not likely to see what
// the operator writes: "it stopped, completed", "it has not been seen since
// 14:02", "it has never been seen" or "it has no active credential".
export function AbsenceReason({ absence }: { absence: Absence }) {
  switch (absence.kind) {
    case "stopped":
      return <>it stopped{absence.outcome === undefined ? "" : `, ${absence.outcome}`}</>;
    case "quiet":
      return absence.last_seen_at === undefined ? (
        <>it has never been seen</>
      ) : (
        <>
          it has not been seen since <Since value={absence.last_seen_at} />
        </>
      );
    case "credential":
      return <>it has no active credential</>;
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

// plural counts things in words: "1 thread", "12 threads".
export const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

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
