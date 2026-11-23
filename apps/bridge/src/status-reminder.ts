import { type SessionStatus, sessionStatus } from "@wayfarerlabs/agention-api";

// How long a working session's status may go without an update through this
// bridge before a tool's answer reminds the agent to send one, and how long
// after one reminder the next comes, in milliseconds. Long enough that a
// status set at the start of an ordinary step, a build, a test run or a short
// wait, still holds when it ends; short enough that the operator's sessions
// view is never much more than that behind an agent that forgot. One reminder
// per period, rather than one on every answer, keeps an agent that checks
// Agention every half minute from reading the same line hundreds of times.
export const statusReminderAfter = 20 * 60_000;

// The most a reminder takes, in bytes of UTF-8 text, which the size every
// tool declares counts beside the answer's capped JSON (tools.ts toolMeta).
// The reminder's words and a count of minutes take well under this.
export const maxReminderBytes = 500;

// StatusReminder keeps, within the bridge's process, when this bridge last
// sent a status update the server logged, and says when an answer should
// remind the agent to send another. It knows only this bridge's updates:
// another bridge may share the session, and the agent API offers no reading
// of the status.
export class StatusReminder {
  readonly #clock: () => number;
  // When this bridge last sent an update the server logged, or, until it
  // first does, when a tool first answered in the session, which needs
  // approval. Undefined until then.
  #since: number | undefined;
  // When the next reminder is due.
  #due = 0;
  // The status the last update answered with, undefined until one does.
  #status: SessionStatus | undefined;

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  // reported records a successful session_update: the note it gave, if any,
  // and the status it answered with. The server logs an update with a note,
  // or one that changes the status, and only those restart the count, so an
  // update that changes nothing leaves the reminder as due as the operator's
  // view is old. The bridge's first update counts as a change, since it has
  // no earlier one to compare.
  reported(note: string | undefined, answer: unknown): void {
    const parsed = sessionStatus.safeParse(answer);
    const status = parsed.success ? parsed.data : undefined;
    if (note !== undefined || this.#status === undefined || !same(this.#status, status)) {
      this.#start();
    }
    this.#status = status;
  }

  // remind is called after any other tool answers in the session. It returns
  // the reminder that answer carries, if one is due, and counts it as given.
  // One is due while the session last said it was working, or has said
  // nothing through this bridge, once statusReminderAfter has passed since
  // its last logged update, and again each time that long passes after a
  // reminder. An idle or stopped status says what the session is doing for
  // as long as it holds, and the operator sees its age.
  remind(): string | undefined {
    if (this.#since === undefined) {
      this.#start();
      return undefined;
    }
    const now = this.#clock();
    const state = this.#status?.state ?? "working";
    if (state !== "working" || now <= this.#due) {
      return undefined;
    }
    this.#due = now + statusReminderAfter;
    const minutes = Math.floor((now - this.#since) / 60_000);
    // A note has the server log the update even when the status itself is
    // unchanged, so the operator sees when it was last confirmed.
    return (
      `This bridge has not sent a status update for this Agention session in ${minutes} ` +
      "minutes. Report what you are doing now with session_update, with a note on what just " +
      "happened, so the operator's view of this session stays current."
    );
  }

  #start(): void {
    this.#since = this.#clock();
    this.#due = this.#since + statusReminderAfter;
  }
}

// same says whether two statuses agree in every field the server compares.
function same(a: SessionStatus, b: SessionStatus | undefined): boolean {
  return (
    b !== undefined &&
    a.state === b.state &&
    a.outcome === b.outcome &&
    a.title === b.title &&
    a.goal === b.goal &&
    a.percent === b.percent
  );
}
