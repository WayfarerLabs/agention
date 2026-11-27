import { printableAscii } from "./input-row.ts";
import type { Clock, Observation } from "./observer.ts";
import { type Key, type Pane, sameScreen, type Snapshot } from "./pane.ts";
import type { InputLine, Profile, StoppedBy } from "./profile.ts";

// The two texts of a nudge, both the caller's: a warning that a nudge is
// coming, which is pasted, left a while for anyone to type over and then
// removed, and the message, which is pasted and submitted; and how the
// caller tells nudge text, its own or an earlier nudge's, from anything else
// an input line may hold, as by a marker every nudge's texts carry. A nudge
// never pastes over nudge text, and says so where that held it off.
export interface NudgeTexts {
  readonly warning: string;
  readonly message: string;
  isNudgeText(text: string): boolean;
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

// How a nudge ended, with the step it ended at:
//
// - deferred: nothing of the nudge's stayed in the pane, so it is no nudge
//   and may be tried again. Either nothing was pasted, at "not-ready", with
//   nudgeTextLeft where the input line held nudge text, as the texts'
//   isNudgeText says; or, at a confirmation, the line held exactly the
//   nudge's own text but the rest of the screen had changed, as when the
//   harness starts a turn or redraws, and the nudge took its text back; or
//   the line came empty, or the input line went from the screen, with no
//   key typed, the harness having taken or cleared it.
// - stopped: someone at the terminal stopped it: a key was typed since the
//   nudge began, or the line held something other than the warning, or the
//   nudge's text altered once confirmed.
// - failed: the pane could not be read or written, or the profile failed on
//   a screen, once something was pasted; a Backspace did not shorten the
//   line by one; the message did not show exactly; or the harness did not
//   take it after Enter.
// - sent: the harness took the message.
//
// Each step names how far the nudge got: "not-ready" pasted nothing;
// "warning" pasted the warning and waited; "cleared" removed it; "message"
// pasted the message; and "submitted" confirmed it before Enter and saw
// whether the harness took it after.
export type NudgeOutcome =
  | {
      readonly outcome: "deferred";
      readonly step: NudgeStep;
      readonly nudgeTextLeft?: true;
    }
  | { readonly outcome: "stopped" | "failed"; readonly step: NudgeStep }
  | { readonly outcome: "sent"; readonly step: "submitted" };

export type NudgeStep = "not-ready" | "warning" | "cleared" | "message" | "submitted";

// The outcome of a nudge that pasted nothing.
export const notReady: NudgeOutcome = { outcome: "deferred", step: "not-ready" };

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

// A reading of the pane, with its input line where the pane can take keys
// and the profile finds one on it.
interface Look {
  readonly snapshot: Snapshot;
  readonly input: InputLine | undefined;
}

// How a nudge ends before it is sent.
type Unsent = Exclude<NudgeOutcome["outcome"], "sent">;

// Ended stops a nudge before it is sent, with how it ended.
class Ended extends Error {
  readonly outcome: Unsent;

  constructor(outcome: Unsent) {
    super(`the nudge ended ${outcome}`);
    this.outcome = outcome;
  }
}

// Nudge carries out one nudge on a pane through its profile, which knows its
// harness's prompt marker, so an empty input line reads as empty. Every key
// it sends follows a reading that confirmed the line holds exactly what the
// nudge expects, cursor at its end, while the pane holds one pane, the
// harness holds the terminal and keys reach it. Only the line and the cursor
// are compared for the texts themselves: a change elsewhere on the screen
// takes the nudge's text back, never fails the nudge.
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
      const ready = await this.#ready(latest, texts);
      if (!("look" in ready)) {
        return ready.nudgeTextLeft ? { outcome: "deferred", step, nudgeTextLeft: true } : notReady;
      }
      if (!(await begin()) || !(await this.#stillReady(ready.look))) {
        return notReady;
      }

      step = "warning";
      await this.#paste(warning);
      const pasted = await this.#confirm(warning, "stopped");
      await this.#clock.sleep(warnFor, this.#signal);
      await this.#still(pasted, warning);

      step = "cleared";
      await this.#erase(warning, true);

      step = "message";
      messageIn = true;
      await this.#paste(message);
      const confirmed = await this.#confirm(message, "failed");

      step = "submitted";
      const before = await this.#still(confirmed, message);
      messageIn = false;
      await this.#key("Enter");
      if (!(await this.#taken(before))) {
        return { outcome: "failed", step };
      }
      return { outcome: "sent", step };
    } catch (error) {
      // A check that ended the nudge says how. Otherwise the pane could not
      // be read or written, the profile failed on a screen, which is
      // untrusted input, the caller's isNudgeText failed, or the signal
      // stopped the nudge: before anything was pasted that defers it, and
      // after, it failed, leaving the warning where it is. Either way the
      // message goes where it is still exactly there.
      const outcome =
        error instanceof Ended ? error.outcome : step === "not-ready" ? "deferred" : "failed";
      if (messageIn) {
        await this.#abandon(message);
      }
      return { outcome, step };
    }
  }

  // ready gives the reading a nudge may start from, if any: the latest
  // observation is at rest at the input line and not stopped by a usage
  // limit before its reset; a fresh reading shows the same screen, with keys
  // reaching the harness, no key from any client for quietFor, and an empty
  // input line with the cursor at its end and room for the longer text.
  // Otherwise it says whether that reading found nudge text on the line.
  async #ready(
    latest: LatestReading | undefined,
    texts: NudgeTexts,
  ): Promise<{ look: Look } | { nudgeTextLeft: boolean }> {
    const notYet = { nudgeTextLeft: false };
    if (latest === undefined) {
      return notYet;
    }
    const { observation, snapshot: seen } = latest;
    if (observation.activity !== "at_rest" || observation.screen !== "input") {
      return notYet;
    }
    const look = await this.#look();
    const { snapshot, input } = look;
    if (input === undefined) {
      return notYet;
    }
    if (input.text !== "" && texts.isNudgeText(input.text)) {
      return { nudgeTextLeft: true };
    }
    const typedLately =
      snapshot.lastTyped !== undefined && snapshot.at - snapshot.lastTyped < quietFor;
    if (
      limited(observation.stoppedBy, snapshot.at) ||
      typedLately ||
      !sameScreen(seen, snapshot) ||
      !input.cursorAtEnd ||
      input.text !== "" ||
      input.room < Math.max(texts.warning.length, texts.message.length)
    ) {
      return notYet;
    }
    this.#typed = snapshot.lastTyped;
    return { look };
  }

  // stillReady reads the pane again once begin has answered, which may have
  // taken a while, and says whether keys still reach the harness and it shows
  // the very screen the nudge was ready at, so the same input line, with no
  // key typed since.
  async #stillReady(ready: Look): Promise<boolean> {
    this.#signal.throwIfAborted();
    const look = await this.#look();
    return (
      look.input !== undefined &&
      sameScreen(ready.snapshot, look.snapshot) &&
      look.snapshot.lastTyped === this.#typed
    );
  }

  // look reads the pane, with the input line where the pane can take keys
  // and the profile finds one on it.
  async #look(): Promise<Look> {
    const snapshot = await this.#pane.snapshot();
    if (!snapshot.onePane || !snapshot.hostHasTerminal || snapshot.keysBlocked) {
      return { snapshot, input: undefined };
    }
    const screen = this.#profile.screen(snapshot);
    return { snapshot, input: screen.kind === "input" ? screen.input : undefined };
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

  // typedSince says whether a client has typed since the nudge started.
  #typedSince(look: Look): boolean {
    return look.snapshot.lastTyped !== this.#typed;
  }

  // holds says whether a reading's input line holds exactly a text, with the
  // cursor at its end, and, while typing stops the nudge, no client has typed
  // since it started.
  #holds(look: Look, text: string, untyped: boolean): boolean {
    return (
      look.input !== undefined &&
      look.input.text === text &&
      look.input.cursorAtEnd &&
      (!untyped || !this.#typedSince(look))
    );
  }

  // ending says how a nudge ends at a reading whose line does not hold what
  // it expects: stopped where a client typed since it started; deferred where
  // the line is empty, or gone from the screen, with no key typed, so nothing
  // of the nudge's is left in it; and otherwise as the step says, where the
  // line holds other text.
  #ending(look: Look, otherText: Unsent): Unsent {
    if (this.#typedSince(look)) {
      return "stopped";
    }
    return look.input === undefined || look.input.text === "" ? "deferred" : otherText;
  }

  // confirm reads the pane until its input line holds a text, as holds says,
  // for settleWithin at most, and returns that reading's snapshot. It ends
  // the nudge, as ending says, at the last reading where the line never does,
  // and at once where a client typed.
  async #confirm(text: string, otherText: Unsent, untyped = true): Promise<Snapshot> {
    const deadline = this.#clock.now() + settleWithin;
    for (;;) {
      const look = await this.#look();
      if (this.#holds(look, text, untyped)) {
        return look.snapshot;
      }
      if (this.#clock.now() >= deadline || (untyped && this.#typedSince(look))) {
        throw new Ended(this.#ending(look, otherText));
      }
      await this.#clock.sleep(lookEvery, this.#signal);
      this.#signal.throwIfAborted();
    }
  }

  // still reads the pane once, and returns the snapshot where its input line
  // still holds a text, with no key typed, and nothing else on the screen
  // changed since an earlier snapshot. Where the line holds exactly the text
  // but the rest of the screen changed, as when the harness starts a turn or
  // redraws, it takes the text back and defers the nudge; where the line
  // holds anything else, the text altered, it ends the nudge as ending says.
  async #still(earlier: Snapshot, text: string): Promise<Snapshot> {
    this.#signal.throwIfAborted();
    const look = await this.#look();
    if (!this.#holds(look, text, true)) {
      throw new Ended(this.#ending(look, "stopped"));
    }
    if (!sameScreen(earlier, look.snapshot)) {
      await this.#erase(text, false);
      throw new Ended("deferred");
    }
    return look.snapshot;
  }

  // erase removes a text the line has just been confirmed to hold, one
  // Backspace at a time, confirming before each next one that the last
  // removed one character, and at the end that the line is empty. A
  // Backspace that did not remove one character fails the nudge, unless a
  // key was typed or the line came empty, as ending says. untyped says
  // whether a client typing stops it: removing a text the nudge takes back
  // goes on regardless, as long as the line holds exactly what it expects.
  async #erase(text: string, untyped: boolean): Promise<void> {
    for (let left = text.length; left > 0; left--) {
      await this.#key("Backspace");
      await this.#confirm(text.slice(0, left - 1), "failed", untyped);
    }
  }

  // abandon ends the nudge at a step after its message went in and before
  // Enter, removing the message where a fresh reading shows the line holding
  // exactly it. Someone having typed since the nudge started does not stop
  // this, since the text is the nudge's own and the line is confirmed before
  // each Backspace. A failure of its own changes nothing of the outcome, and
  // a stopped nudge sends nothing more.
  async #abandon(message: string): Promise<void> {
    try {
      const look = await this.#look();
      if (this.#holds(look, message, false)) {
        await this.#erase(message, false);
      }
    } catch {
      // The outcome the nudge ended with is the one it reports.
    }
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
