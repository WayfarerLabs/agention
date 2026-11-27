import type { WorkOutcome, WorkState } from "@wayfarerlabs/agention-api";
import type { SessionUpdate } from "@wayfarerlabs/agention-server-api";

// A session's log as the sessions view shows it, newest first: each entry
// read against the one before it, for what it changed, and consecutive
// entries that changed only the percent, with no note, collapsed into one
// line, as from 20% to 60%. The log itself keeps every entry.

// What an entry changed of the session's status.
export type Change =
  | {
      kind: "state";
      from?: { state: WorkState; outcome?: WorkOutcome | undefined } | undefined;
      to: { state: WorkState; outcome?: WorkOutcome | undefined };
    }
  | { kind: "title"; title: string }
  | { kind: "goal"; goal: string }
  | { kind: "percent"; from?: number | undefined; to: number };

// A line of the log: the entries it stands for, newest first, what they
// changed together, and the note of the one entry that carries any.
export interface LogLine {
  entries: SessionUpdate[];
  changes: Change[];
  note?: string | undefined;
}

// changesOf says what an entry changed against the entry before it, or
// against nothing for the session's first. A field an entry leaves as it was,
// or clears, as a new goal clears the percent, is no change of its own.
export function changesOf(entry: SessionUpdate, before: SessionUpdate | undefined): Change[] {
  const changes: Change[] = [];
  if (before === undefined || before.state !== entry.state || before.outcome !== entry.outcome) {
    changes.push({
      kind: "state",
      from: before === undefined ? undefined : { state: before.state, outcome: before.outcome },
      to: { state: entry.state, outcome: entry.outcome },
    });
  }
  if (entry.title !== undefined && entry.title !== before?.title) {
    changes.push({ kind: "title", title: entry.title });
  }
  if (entry.goal !== undefined && entry.goal !== before?.goal) {
    changes.push({ kind: "goal", goal: entry.goal });
  }
  if (entry.percent !== undefined && entry.percent !== before?.percent) {
    changes.push({ kind: "percent", from: before?.percent, to: entry.percent });
  }
  return changes;
}

// progressOnly says whether an entry changed only the percent, with no note.
function progressOnly(entry: SessionUpdate, before: SessionUpdate | undefined): boolean {
  const changes = changesOf(entry, before);
  return (
    before !== undefined &&
    entry.note === undefined &&
    changes.length === 1 &&
    changes[0]?.kind === "percent"
  );
}

// logLines reads entries, newest first, into the lines the view shows. The
// entry after the last, when given, is the one before the oldest shown, so
// what that one changed can be read; without it, the oldest is read as the
// session's first.
export function logLines(entries: SessionUpdate[], earlier?: SessionUpdate): LogLine[] {
  const before = (index: number) => entries[index + 1] ?? earlier;
  const lines: LogLine[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as SessionUpdate;
    if (!progressOnly(entry, before(index))) {
      lines.push({
        entries: [entry],
        changes: changesOf(entry, before(index)),
        note: entry.note,
      });
      continue;
    }
    // A run of progress alone, from the percent before its oldest entry, or
    // the oldest's own where there was none, to its newest's.
    let end = index;
    while (
      end + 1 < entries.length &&
      progressOnly(entries[end + 1] as SessionUpdate, before(end + 1))
    ) {
      end++;
    }
    const from = before(end)?.percent ?? (end > index ? entries[end]?.percent : undefined);
    lines.push({
      entries: entries.slice(index, end + 1),
      changes: [{ kind: "percent", from, to: entry.percent as number }],
    });
    index = end;
  }
  return lines;
}
