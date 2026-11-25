import { printableAscii } from "./input-row.ts";
import type { Clock, Observation } from "./observer.ts";
import { type Key, type Pane, sameScreen, type Snapshot } from "./pane.ts";
import type { InputLine, Profile, StoppedBy } from "./profile.ts";

// The two texts of a nudge, both the caller's: a warning that a nudge is
// coming, which is pasted, left a while for anyone to type over and then
// removed, and the message, which is pasted and submitted.
export interface NudgeTexts {
  readonly warning: string;
  readonly message: string;
}

// What a caller gives a nudge beside its texts. begin is called once, after
// the checks that the harness is ready pass and before anything reaches the
// pane, and the nudge goes on only where it answers true, as when the caller
// claims the nudge it is about to try. signal stops the nudge: once it
// aborts, nothing more reaches the pane, not even a key that would remove
// the nudge's own text.
export interface NudgeOptions {
  readonly begin: () => Promise<boolean>;
  readonly signal: AbortSignal;
}

// How a nudge ended: sent, the message submitted and taken, or not sent, with
// the step it stopped at. "not-ready" sent nothing; "warning" left the
// warning where it was; "cleared" left what Backspace had not removed of it;
// "message" and, before Enter, "submitted" removed the message where it was
// still exactly as pasted and left it otherwise; and "submitted" after Enter
// saw no sign the harness took the message. A nudge that a failure or the
// signal stopped ends at the step it reached, as a failed check there does,
// except that a stopped nudge sends nothing more.
export type NudgeOutcome =
  { readonly sent: true } | { readonly sent: false; readonly step: NudgeStep };

export type NudgeStep = "not-ready" | "warning" | "cleared" | "message" | "submitted";

// How long no client may have typed before a nudge starts.
export const quietFor = 10_000;
// How long the warning stays for anyone to type over it.
export const warnFor = 5000;
// How long the harness has to clear the line and change its screen once the
// message is submitted.
export const submitWithin = 5000;
// How long a paste or a Backspace has to show on the screen.
export const settleWithin = 2000;
// How often the pane is read while waiting for one of those.
export const lookEvery = 50;

// The latest reading of a pane an observer made: the observation it holds
// and the snapshot it last read, from which a nudge starts.
export interface LatestReading {
  readonly observation: Observation;
  readonly snapshot: Snapshot;
}

// refuseNudgeText throws a RangeError for a text a nudge cannot use: an empty
// one, and one that is not all printable ASCII, whose width terminals
// disagree on, so it can never be shown to fit. Printable ASCII holds no line
// break or control character, so a pane never refuses to paste it.
export function refuseNudgeText(text: string): void {
  if (text === "" || !printableAscii.test(text)) {
    throw new RangeError("a nudge's texts must be printable ASCII, and not empty");
  }
}

// A reading of the pane while it can take keys, with its input line.
interface Look {
  readonly snapshot: Snapshot;
  readonly input: InputLine;
}

// Nudge carries out one nudge on a pane through its profile, which knows its
// harness's prompt marker, so an empty input line reads as empty. Every key
// it sends follows a reading that confirmed the line holds exactly what the
// nudge expects, cursor at its end, while the pane holds one pane, the
// harness holds the terminal and keys reach it.
export class Nudge {
  readonly #pane: Pane;
  readonly #profile: Profile;
  readonly #clock: Clock;
  readonly #signal: AbortSignal;
  // When a client last typed as the nudge started, which must stay so.
  #typed: number | undefined;

  constructor(pane: Pane, profile: Profile, clock: Clock, signal: AbortSignal) {
    this.#pane = pane;
    this.#profile = profile;
    this.#clock = clock;
    this.#signal = signal;
  }

  async run(
    latest: LatestReading | undefined,
    texts: NudgeTexts,
    begin: () => Promise<boolean>,
  ): Promise<NudgeOutcome> {
    const { warning, message } = texts;
    let step: NudgeStep = "not-ready";
    // Whether the message may be on the line, not yet submitted: from its
    // paste until Enter.
    let messageIn = false;
    try {
      const ready = await this.#ready(latest, Math.max(warning.length, message.length));
      if (ready === undefined || !(await begin()) || !(await this.#stillReady(ready))) {
        return { sent: false, step };
      }

      step = "warning";
      await this.#paste(warning);
      const pasted = await this.#confirm(warning, true);
      if (pasted === undefined) {
        return { sent: false, step };
      }
      await this.#clock.sleep(warnFor, this.#signal);
      if ((await this.#still(pasted, warning)) === undefined) {
        return { sent: false, step };
      }

      step = "cleared";
      if (!(await this.#erase(warning, true))) {
        return { sent: false, step };
      }

      step = "message";
      messageIn = true;
      await this.#paste(message);
      const confirmed = await this.#confirm(message, true);
      if (confirmed === undefined) {
        return await this.#abandon(step, message);
      }

      step = "submitted";
      const before = await this.#still(confirmed, message);
      if (before === undefined) {
        return await this.#abandon(step, message);
      }
      messageIn = false;
      await this.#key("Enter");
      return (await this.#taken(before)) ? { sent: true } : { sent: false, step };
    } catch {
      // The pane could not be read or written, the profile failed on a
      // screen, which is untrusted input, or the signal stopped the nudge:
      // it stops as a failed check at its step does, so the warning stays
      // and the message goes where it is still exactly there.
      return messageIn ? await this.#abandon(step, message) : { sent: false, step };
    }
  }

  // ready gives the reading a nudge may start from, if any: the latest
  // observation is at rest at the input line and not stopped by a usage
  // limit before its reset; a fresh reading shows the same screen, with keys
  // reaching the harness, no key from any client for quietFor, and an empty
  // input line with the cursor at its end and room for the longer text.
  async #ready(latest: LatestReading | undefined, longest: number): Promise<Look | undefined> {
    if (latest === undefined) {
      return undefined;
    }
    const { observation, snapshot: seen } = latest;
    if (observation.activity !== "at_rest" || observation.screen !== "input") {
      return undefined;
    }
    const look = await this.#look();
    if (look === undefined) {
      return undefined;
    }
    const { snapshot, input } = look;
    const typedLately =
      snapshot.lastTyped !== undefined && snapshot.at - snapshot.lastTyped < quietFor;
    if (
      limited(observation.stoppedBy, snapshot.at) ||
      typedLately ||
      !sameScreen(seen, snapshot) ||
      !input.cursorAtEnd ||
      input.text !== "" ||
      input.room < longest
    ) {
      return undefined;
    }
    this.#typed = snapshot.lastTyped;
    return look;
  }

  // stillReady reads the pane again once begin has answered, which may have
  // taken a while, and says whether keys still reach the harness and it shows
  // the very screen the nudge was ready at, so the same input line, with no
  // key typed since.
  async #stillReady(ready: Look): Promise<boolean> {
    this.#signal.throwIfAborted();
    const look = await this.#look();
    return (
      look !== undefined &&
      sameScreen(ready.snapshot, look.snapshot) &&
      look.snapshot.lastTyped === this.#typed
    );
  }

  // look reads the pane, and returns the reading where the pane can take keys
  // and the profile finds the input line on it.
  async #look(): Promise<Look | undefined> {
    const snapshot = await this.#pane.snapshot();
    if (!snapshot.onePane || !snapshot.hostHasTerminal || snapshot.keysBlocked) {
      return undefined;
    }
    const screen = this.#profile.screen(snapshot);
    return screen.kind === "input" ? { snapshot, input: screen.input } : undefined;
  }

  // paste and key write to the pane, unless the signal has stopped the
  // nudge, when they throw instead.
  async #paste(text: string): Promise<void> {
    this.#signal.throwIfAborted();
    await this.#pane.paste(text);
  }

  async #key(key: Key): Promise<void> {
    this.#signal.throwIfAborted();
    await this.#pane.key(key);
  }

  // holds says whether a reading's input line holds exactly a text, with the
  // cursor at its end, and, while typing stops the nudge, no client has typed
  // since it started.
  #holds(look: Look, text: string, untyped: boolean): boolean {
    return (
      look.input.text === text &&
      look.input.cursorAtEnd &&
      (!untyped || look.snapshot.lastTyped === this.#typed)
    );
  }

  // confirm reads the pane until its input line holds a text, as holds says,
  // for settleWithin at most, and returns that reading's snapshot.
  async #confirm(text: string, untyped: boolean): Promise<Snapshot | undefined> {
    const deadline = this.#clock.now() + settleWithin;
    for (;;) {
      const look = await this.#look();
      if (look !== undefined && this.#holds(look, text, untyped)) {
        return look.snapshot;
      }
      if (this.#clock.now() >= deadline) {
        return undefined;
      }
      await this.#clock.sleep(lookEvery, this.#signal);
      this.#signal.throwIfAborted();
    }
  }

  // still reads the pane once, and returns the snapshot where its input line
  // still holds a text and nothing else on the screen changed since an
  // earlier snapshot, so the harness has not started a turn meanwhile.
  async #still(earlier: Snapshot, text: string): Promise<Snapshot | undefined> {
    this.#signal.throwIfAborted();
    const look = await this.#look();
    return look !== undefined && this.#holds(look, text, true) && sameScreen(earlier, look.snapshot)
      ? look.snapshot
      : undefined;
  }

  // erase removes a text the line has just been confirmed to hold, one
  // Backspace at a time, confirming before each next one that the last
  // removed one character, and at the end that the line is empty. It says
  // whether it got there.
  async #erase(text: string, untyped: boolean): Promise<boolean> {
    for (let left = text.length; left > 0; left--) {
      await this.#key("Backspace");
      if ((await this.#confirm(text.slice(0, left - 1), untyped)) === undefined) {
        return false;
      }
    }
    return true;
  }

  // abandon ends the nudge at a step after its message went in and before
  // Enter, removing the message where a fresh reading shows the line holding
  // exactly it. Someone having typed since the nudge started does not stop
  // this, since the text is the nudge's own and the line is confirmed before
  // each Backspace. A failure of its own changes nothing of the outcome, and
  // a stopped nudge sends nothing more.
  async #abandon(step: NudgeStep, message: string): Promise<NudgeOutcome> {
    try {
      const look = await this.#look();
      if (look !== undefined && this.#holds(look, message, false)) {
        await this.#erase(message, false);
      }
    } catch {
      // The failure the nudge stopped for, if any, is the one it reports.
    }
    return { sent: false, step };
  }

  // taken reads the pane, for submitWithin at most, until the input line is
  // empty again and something else on the screen changed since the snapshot
  // before Enter, which a turn starting shows.
  async #taken(before: Snapshot): Promise<boolean> {
    const deadline = this.#clock.now() + submitWithin;
    for (;;) {
      const snapshot = await this.#pane.snapshot();
      const screen = this.#profile.screen(snapshot);
      if (
        screen.kind === "input" &&
        screen.input.text === "" &&
        changedBesideInput(before, snapshot)
      ) {
        return true;
      }
      if (this.#clock.now() >= deadline) {
        return false;
      }
      await this.#clock.sleep(lookEvery, this.#signal);
      this.#signal.throwIfAborted();
    }
  }
}

// limited says whether a harness stopped by a usage limit is still before its
// reset at a time; a limit with no known reset always is.
function limited(stoppedBy: StoppedBy | undefined, at: number): boolean {
  return (
    stoppedBy?.reason === "usage_limit" &&
    (stoppedBy.resetsAt === undefined || stoppedBy.resetsAt.getTime() > at)
  );
}

// changedBesideInput says whether any row but the earlier snapshot's input
// row changed between two snapshots.
function changedBesideInput(earlier: Snapshot, later: Snapshot): boolean {
  const { lines } = earlier;
  return (
    lines.length !== later.lines.length ||
    lines.some((line, i) => i !== earlier.cursor.y && line !== later.lines[i])
  );
}
