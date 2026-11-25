import { setTimeout as delay } from "node:timers/promises";
import {
  type LatestReading,
  Nudge,
  type NudgeOptions,
  type NudgeOutcome,
  type NudgeTexts,
  refuseNudgeText,
} from "./nudge.ts";
import { type Pane, sameScreen, type Snapshot } from "./pane.ts";
import type { Profile, Screen, StoppedBy } from "./profile.ts";

// Two questions and a reason: is the harness running a turn, and, at rest,
// what does its screen hold and why did it stop?
export interface Observation {
  // Running a turn, at rest, or unknown when the pane cannot be read or no
  // longer runs the harness.
  readonly activity: "running" | "at_rest" | "unknown";
  // At rest only: what the screen holds, "input" for the harness's own
  // prompt and "other" for nothing the profile recognizes.
  readonly screen?: Screen["kind"];
  // At rest only: why the harness stopped, where its profile can tell,
  // beside whatever prompt is on its screen.
  readonly stoppedBy?: StoppedBy;
  // When the activity or the screen last changed. A change in the
  // stopped-by reason alone keeps it.
  readonly since: Date;
}

export interface Observer {
  // observations reads the pane until the signal aborts, yielding an
  // observation whenever its activity, screen or stopped-by reason changes.
  // It never throws: a pane it cannot read is unknown.
  observations(signal: AbortSignal): AsyncIterable<Observation>;
  // nudge puts a warning and then a message in the harness's input line and
  // submits the message, with every check before each key that the package's
  // README lists, and says how it ended. It starts from the latest
  // observation, so it is never ready while observations is not running, and
  // asks options.begin before it writes anything; options.signal stops it.
  // It throws, before anything reaches the pane, a RangeError for a text it
  // cannot use, an empty one or one that is not all printable ASCII, and an
  // Error where the observer's profile does not know its harness's prompt
  // marker, since such a profile cannot tell a draft someone left at the
  // prompt from an empty one.
  nudge(texts: NudgeTexts, options: NudgeOptions): Promise<NudgeOutcome>;
}

// The time source an observer samples by; tests pass one that needs no
// waiting.
export interface Clock {
  now(): number;
  // sleep resolves after ms, or as soon as the signal aborts; it never
  // rejects.
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  async sleep(ms, signal) {
    try {
      await delay(ms, undefined, { signal });
    } catch {
      // Aborted: the caller checks its signal.
    }
  },
};

// How often the pane is read.
export const sampleEvery = 1000;
// How long a screen must stay unchanged before the harness is at rest. A
// harness redraws its screen at least every second during a turn.
export const stillFor = 2000;

// A reading of one snapshot: an observation at a time, or undefined while too
// few snapshots have been read to tell a running harness from one at rest.
type Reading = (Omit<Observation, "since"> & { readonly at: number }) | undefined;

// PaneObserver reads a pane through one profile. It applies one order for
// every profile, so a profile only says what one screen shows:
//
// 1. unknown, when the pane cannot be read, its terminal server holds more
//    than one pane, the harness does not hold the terminal, or the profile
//    fails on the screen;
// 2. at rest with the profile's permission or other prompt, from the latest
//    screen alone, so a dialog's animation never reads as running;
// 3. running, when the screen changed within the last two seconds;
// 4. at rest otherwise, with what the profile finds on the screen.
//
// A stopped-by reason shows only at rest.
//
// nudge starts from the latest observation and the snapshot it came from,
// and runs one nudge at a time: a second while one runs is not ready.
export class PaneObserver implements Observer {
  readonly #pane: Pane;
  readonly #profile: Profile;
  readonly #clock: Clock;
  // The latest observation and the snapshot last read, while observations
  // runs and the pane was last read with the profile.
  #latest: LatestReading | undefined;
  #nudging = false;

  constructor(pane: Pane, profile: Profile, clock: Clock = systemClock) {
    this.#pane = pane;
    this.#profile = profile;
    this.#clock = clock;
  }

  async *observations(signal: AbortSignal): AsyncIterable<Observation> {
    // The snapshots of the last few seconds, oldest first, all read since the
    // last reading that was unknown.
    const history: Snapshot[] = [];
    let latest: Observation | undefined;
    try {
      while (!signal.aborted) {
        const { reading, snapshot } = await this.#read(history);
        if (signal.aborted) {
          return;
        }
        let changed: Observation | undefined;
        if (reading !== undefined && !sameReading(latest, reading)) {
          const { at, ...observed } = reading;
          changed = latest = {
            ...observed,
            since:
              latest?.activity === reading.activity && latest.screen === reading.screen
                ? latest.since
                : new Date(at),
          };
        }
        // A nudge starts from the observation this snapshot bears out.
        this.#latest =
          reading !== undefined && snapshot !== undefined && latest !== undefined
            ? { observation: latest, snapshot }
            : undefined;
        if (changed !== undefined) {
          yield changed;
        }
        await this.#clock.sleep(sampleEvery, signal);
      }
    } finally {
      this.#latest = undefined;
    }
  }

  async nudge(texts: NudgeTexts, options: NudgeOptions): Promise<NudgeOutcome> {
    refuseNudgeText(texts.warning);
    refuseNudgeText(texts.message);
    if (!this.#profile.knowsMarker) {
      throw new Error(`the ${this.#profile.name} profile cannot tell when a harness may be nudged`);
    }
    if (this.#nudging) {
      return { sent: false, step: "not-ready" };
    }
    this.#nudging = true;
    try {
      return await new Nudge(this.#pane, this.#profile, this.#clock, options.signal).run(
        this.#latest,
        texts,
        options.begin,
      );
    } finally {
      this.#nudging = false;
    }
  }

  // read reads the pane once, and returns the reading and, where the profile
  // read it, the snapshot.
  async #read(history: Snapshot[]): Promise<{ reading: Reading; snapshot?: Snapshot }> {
    let snapshot: Snapshot;
    try {
      snapshot = await this.#pane.snapshot();
    } catch {
      return { reading: unknown(history, this.#clock.now()) };
    }
    if (!snapshot.onePane || !snapshot.hostHasTerminal) {
      return { reading: unknown(history, snapshot.at) };
    }
    let screen;
    try {
      screen = this.#profile.screen(snapshot);
    } catch {
      // The screen is untrusted input, so a profile that fails on one cannot
      // say what it shows.
      return { reading: unknown(history, snapshot.at) };
    }
    remember(history, snapshot);
    const at = snapshot.at;
    const stoppedBy = screen.stoppedBy && { stoppedBy: screen.stoppedBy };
    const atRest = { activity: "at_rest", screen: screen.kind, at, ...stoppedBy } as const;
    if (screen.kind === "permission_prompt" || screen.kind === "other_prompt") {
      return { reading: atRest, snapshot };
    }
    if (changedRecently(history)) {
      return { reading: { activity: "running", at }, snapshot };
    }
    if (history[0]!.at > at - stillFor) {
      return { reading: undefined, snapshot };
    }
    return { reading: atRest, snapshot };
  }
}

function unknown(history: Snapshot[], at: number): Reading {
  history.length = 0;
  return { activity: "unknown", at };
}

// remember adds a snapshot to the history and drops those it no longer needs:
// it keeps the newest snapshot at least stillFor old, which the screen is
// compared from, and every one since.
function remember(history: Snapshot[], snapshot: Snapshot): void {
  history.push(snapshot);
  while (history.length > 1 && history[1]!.at <= snapshot.at - stillFor) {
    history.shift();
  }
}

function changedRecently(history: readonly Snapshot[]): boolean {
  return history.some((snapshot, i) => i > 0 && !sameScreen(history[i - 1]!, snapshot));
}

function sameReading(observation: Observation | undefined, reading: NonNullable<Reading>): boolean {
  return (
    observation?.activity === reading.activity &&
    observation.screen === reading.screen &&
    sameStoppedBy(observation.stoppedBy, reading.stoppedBy)
  );
}

function sameStoppedBy(a: StoppedBy | undefined, b: StoppedBy | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const resetsAt = (stoppedBy: StoppedBy) =>
    stoppedBy.reason === "usage_limit" ? stoppedBy.resetsAt?.getTime() : undefined;
  return a.reason === b.reason && resetsAt(a) === resetsAt(b);
}
