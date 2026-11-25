import { describe, expect, it } from "vitest";
import { readingPane } from "../test/reading-pane.ts";
import { rowInput } from "./input-row.ts";
import { type Clock, type Observation, PaneObserver, sampleEvery } from "./observer.ts";
import type { Snapshot } from "./pane.ts";
import type { Profile, Screen } from "./profile.ts";

// One reading of a scripted pane: a screen at a time, or a pane that cannot
// be read. A screen's first line names what the test profile finds on it,
// and its second line, when "limit", a usage limit resetting at `resetsAt`.
type Step =
  | {
      readonly at: number;
      readonly screen: readonly string[];
      readonly onePane?: boolean;
      readonly hostHasTerminal?: boolean;
      readonly cursorX?: number;
    }
  | { readonly at: number; readonly fails: true };

const testProfile: Profile = {
  name: "test",
  knowsMarker: false,
  screen(snapshot): Screen {
    const [kind, second] = snapshot.lines;
    if (kind === "throws") {
      throw new Error("a profile's bug");
    }
    const stoppedBy =
      second?.startsWith("limit") === true
        ? { stoppedBy: { reason: "usage_limit" as const, resetsAt: new Date(second.slice(6)) } }
        : {};
    if (kind === "permission_prompt" || kind === "other_prompt") {
      return { kind, ...stoppedBy };
    }
    const input = kind === "input" ? rowInput(snapshot) : undefined;
    if (input !== undefined) {
      return { kind: "input", input, ...stoppedBy };
    }
    return { kind: "other", ...stoppedBy };
  },
};

// observe runs an observer over scripted steps, one per sample, and returns
// what it yielded once the steps run out.
async function observe(steps: readonly Step[]): Promise<object[]> {
  const controller = new AbortController();
  let index = 0;
  let now = 0;
  const pane = readingPane(async () => {
    const step = steps[index++];
    if (step === undefined) {
      controller.abort();
      throw new Error("the steps ran out");
    }
    now = step.at;
    if ("fails" in step) {
      throw new Error("the pane cannot be read");
    }
    return {
      lines: step.screen,
      width: 80,
      cursor: { x: step.cursorX ?? 0, y: 0, visible: true },
      hostHasTerminal: step.hostHasTerminal ?? true,
      onePane: step.onePane ?? true,
      keysBlocked: false,
      lastTyped: undefined,
      at: step.at,
    } satisfies Snapshot;
  });
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => now,
    async sleep(ms) {
      sleeps.push(ms);
    },
  };
  const seen: object[] = [];
  for await (const observation of new PaneObserver(pane, testProfile, clock).observations(
    controller.signal,
  )) {
    seen.push(plain(observation));
  }
  expect(sleeps.every((ms) => ms === sampleEvery)).toBe(true);
  return seen;
}

// plain is an observation with its times as numbers, a usage limit as its
// reset time, and only the fields it has.
function plain(observation: Observation): object {
  const { activity, screen, since, stoppedBy } = observation;
  return {
    activity,
    ...(screen !== undefined && { screen }),
    since: since.getTime(),
    ...(stoppedBy?.reason === "usage_limit" && { stoppedBy: stoppedBy.resetsAt?.getTime() }),
  };
}

// The observations the tests expect, in plain's form.
const running = (since: number) => ({ activity: "running", since });
const unknown = (since: number) => ({ activity: "unknown", since });
const atRest = (screen: Screen["kind"], since: number, resetsAt?: string) => ({
  activity: "at_rest",
  screen,
  since,
  ...(resetsAt !== undefined && { stoppedBy: Date.parse(resetsAt) }),
});

// still repeats one screen once a second from a time, for a number of samples.
function still(from: number, samples: number, screen: readonly string[]): Step[] {
  return Array.from({ length: samples }, (_, i) => ({ at: from + i * 1000, screen }));
}

describe("PaneObserver", () => {
  it("finds a screen unchanged for two seconds at rest, and yields it once", async () => {
    expect(await observe(still(0, 5, ["input"]))).toEqual([atRest("input", 2000)]);
    expect(await observe(still(0, 5, ["other"]))).toEqual([atRest("other", 2000)]);
  });

  it("yields nothing until it has seen the screen long enough to tell", async () => {
    expect(await observe(still(0, 2, ["input"]))).toEqual([]);
  });

  it("finds a screen that changed within two seconds running, until it stays still", async () => {
    const steps = [
      { at: 0, screen: ["input", "a"] },
      { at: 1000, screen: ["input", "b"] },
      { at: 2000, screen: ["input", "c"] },
      ...still(3000, 3, ["input", "c"]),
    ];
    expect(await observe(steps)).toEqual([running(1000), atRest("input", 4000)]);
  });

  it("finds a moving cursor running", async () => {
    const steps = [
      { at: 0, screen: ["input"], cursorX: 0 },
      { at: 1000, screen: ["input"], cursorX: 1 },
    ];
    expect(await observe(steps)).toEqual([running(1000)]);
  });

  it("reads a dialog from one screen, so its animation never reads as running", async () => {
    const blinking = [0, 1000, 2000, 3000].map((at) => ({
      at,
      screen: ["permission_prompt", at % 2000 === 0 ? "*" : " "],
    }));
    expect(await observe(blinking)).toEqual([atRest("permission_prompt", 0)]);
    expect(await observe([{ at: 0, screen: ["other_prompt"] }])).toEqual([
      atRest("other_prompt", 0),
    ]);
  });

  it("finds the pane unknown when it cannot be read, holds another pane, or the harness lacks the terminal", async () => {
    for (const failing of [
      { at: 3000, fails: true } as const,
      { at: 3000, screen: ["input"], onePane: false },
      { at: 3000, screen: ["input"], hostHasTerminal: false },
      { at: 3000, screen: ["throws"] },
    ]) {
      expect(await observe([...still(0, 3, ["input"]), failing])).toEqual([
        atRest("input", 2000),
        unknown(3000),
      ]);
    }
  });

  it("puts unknown before a dialog", async () => {
    expect(await observe([{ at: 0, screen: ["permission_prompt"], onePane: false }])).toEqual([
      unknown(0),
    ]);
  });

  it("forgets the screens it read before an unknown one", async () => {
    const steps = [
      ...still(0, 3, ["input"]),
      { at: 3000, fails: true } as const,
      ...still(4000, 3, ["input"]),
    ];
    expect(await observe(steps)).toEqual([
      atRest("input", 2000),
      unknown(3000),
      atRest("input", 6000),
    ]);
  });

  it("shows a stopped-by reason only at rest", async () => {
    const tenOClock = "limit 2026-11-25T10:00:00Z";
    const elevenOClock = "limit 2026-11-25T11:00:00Z";
    const steps = [
      { at: 0, screen: ["other", tenOClock, "a"] },
      ...still(1000, 3, ["other", tenOClock, "b"]),
      { at: 4000, screen: ["other", elevenOClock, "b"] },
      { at: 5000, screen: ["permission_prompt", elevenOClock] },
      ...still(6000, 3, ["other"]),
    ];
    expect(await observe(steps)).toEqual([
      running(1000),
      atRest("other", 3000, "2026-11-25T10:00:00Z"),
      running(4000),
      atRest("permission_prompt", 5000, "2026-11-25T11:00:00Z"),
      running(6000),
      atRest("other", 8000),
    ]);
  });

  it("yields a changed stopped-by reason with the since of the activity and screen", async () => {
    const steps = [
      ...still(0, 3, ["input", "limit 2026-11-25T10:00:00Z"]),
      { at: 3000, screen: ["permission_prompt", "limit 2026-11-25T10:00:00Z"] },
      { at: 4000, screen: ["permission_prompt", "limit 2026-11-25T11:00:00Z"] },
    ];
    expect(await observe(steps)).toEqual([
      atRest("input", 2000, "2026-11-25T10:00:00Z"),
      atRest("permission_prompt", 3000, "2026-11-25T10:00:00Z"),
      atRest("permission_prompt", 3000, "2026-11-25T11:00:00Z"),
    ]);
  });

  it("reads nothing once its signal has aborted", async () => {
    let reads = 0;
    const pane = readingPane(async () => {
      reads++;
      throw new Error("unreachable");
    });
    const seen = [];
    for await (const observation of new PaneObserver(pane, testProfile).observations(
      AbortSignal.abort(),
    )) {
      seen.push(observation);
    }
    expect(seen).toEqual([]);
    expect(reads).toBe(0);
  });

  it("stops waiting for its next sample as soon as its signal aborts", async () => {
    const controller = new AbortController();
    const pane = readingPane(async () => {
      throw new Error("the pane cannot be read");
    });
    const started = Date.now();
    for await (const observation of new PaneObserver(pane, testProfile).observations(
      controller.signal,
    )) {
      expect(observation.activity).toBe("unknown");
      setTimeout(() => controller.abort(), 50);
    }
    expect(Date.now() - started).toBeLessThan(sampleEvery / 2);
  });
});
