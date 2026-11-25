import { setTimeout as delay } from "node:timers/promises";
import type { Pane, Snapshot } from "./pane.ts";
import type { Profile, StoppedBy } from "./profile.ts";

// Where a harness is, as its pane shows it, in order of precedence.
export type Condition =
  "unknown" | "permission-prompt" | "other-prompt" | "running" | "at-prompt" | "waiting";

// A condition, since when it has held, and, for a harness at rest, why it
// stopped where its profile can tell.
export interface Observation {
  readonly condition: Condition;
  readonly since: Date;
  readonly stoppedBy?: StoppedBy;
}

export interface Observer {
  // observations reads the pane until the signal aborts, yielding an
  // observation whenever the condition or the stopped-by reason changes. It
  // never throws: a pane it cannot read is unknown.
  observations(signal: AbortSignal): AsyncIterable<Observation>;
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

// A reading of one snapshot: a condition at a time, or undefined while too
// few snapshots have been read to tell a running harness from one at rest.
type Reading =
  | { readonly condition: Condition; readonly stoppedBy?: StoppedBy; readonly at: number }
  | undefined;

// PaneObserver reads a pane through one profile. It applies the order of
// conditions for every profile, so a profile only says what one screen shows:
//
// 1. unknown, when the pane cannot be read, its terminal server holds more
//    than one pane, the harness does not hold the terminal, or the profile
//    fails on the screen;
// 2. the profile's permission or other prompt, from the latest screen alone,
//    so a dialog's animation never reads as running;
// 3. running, when the screen changed within the last two seconds;
// 4. at its prompt, when the profile finds the input line;
// 5. waiting otherwise.
//
// A stopped-by reason shows only at rest: with a prompt, at its prompt or
// waiting, never with running or unknown.
export class PaneObserver implements Observer {
  readonly #pane: Pane;
  readonly #profile: Profile;
  readonly #clock: Clock;

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
    while (!signal.aborted) {
      const reading = await this.#read(history);
      if (signal.aborted) {
        return;
      }
      if (reading !== undefined && !sameReading(latest, reading)) {
        latest = {
          condition: reading.condition,
          since: latest?.condition === reading.condition ? latest.since : new Date(reading.at),
          ...(reading.stoppedBy && { stoppedBy: reading.stoppedBy }),
        };
        yield latest;
      }
      await this.#clock.sleep(sampleEvery, signal);
    }
  }

  async #read(history: Snapshot[]): Promise<Reading> {
    let snapshot: Snapshot;
    try {
      snapshot = await this.#pane.snapshot();
    } catch {
      return unknown(history, this.#clock.now());
    }
    if (!snapshot.onePane || !snapshot.hostHasTerminal) {
      return unknown(history, snapshot.at);
    }
    let screen;
    try {
      screen = this.#profile.screen(snapshot);
    } catch {
      // The screen is untrusted input, so a profile that fails on one cannot
      // say what it shows.
      return unknown(history, snapshot.at);
    }
    remember(history, snapshot);
    const at = snapshot.at;
    const stoppedBy = screen.stoppedBy && { stoppedBy: screen.stoppedBy };
    if (screen.kind === "permission-prompt" || screen.kind === "other-prompt") {
      return { condition: screen.kind, at, ...stoppedBy };
    }
    if (changedRecently(history)) {
      return { condition: "running", at };
    }
    if (history[0]!.at > at - stillFor) {
      return undefined;
    }
    return { condition: screen.kind === "input" ? "at-prompt" : "waiting", at, ...stoppedBy };
  }
}

function unknown(history: Snapshot[], at: number): Reading {
  history.length = 0;
  return { condition: "unknown", at };
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

function sameScreen(a: Snapshot, b: Snapshot): boolean {
  return (
    a.width === b.width &&
    a.cursor.x === b.cursor.x &&
    a.cursor.y === b.cursor.y &&
    a.cursor.visible === b.cursor.visible &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i])
  );
}

function sameReading(observation: Observation | undefined, reading: NonNullable<Reading>): boolean {
  return (
    observation?.condition === reading.condition &&
    sameStoppedBy(observation.stoppedBy, reading.stoppedBy)
  );
}

function sameStoppedBy(a: StoppedBy | undefined, b: StoppedBy | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const resetsAt = (stoppedBy: StoppedBy) =>
    stoppedBy.reason === "usage-limit" ? stoppedBy.resetsAt?.getTime() : undefined;
  return a.reason === b.reason && resetsAt(a) === resetsAt(b);
}
