import { afterEach, describe, expect, it } from "vitest";
import { scriptedHarness, TmuxServer } from "../test/tmux-server.ts";
import { genericLenient, genericStrict } from "./generic-profiles.ts";
import { type Observation, PaneObserver } from "./observer.ts";
import type { Profile, Screen } from "./profile.ts";
import { TmuxPane } from "./tmux-pane.ts";

// The observer against a real tmux server running the scripted harness, at
// its real sampling rate.

// An observation in brief: running, unknown, or at rest with what its screen
// holds, such as "input" at its prompt.
type Label = Exclude<Observation["activity"], "at_rest"> | Screen["kind"];

function label(observation: Observation): Label {
  return observation.activity === "at_rest" ? observation.screen! : observation.activity;
}

// Recording collects what an observer yields until it is stopped.
class Recording {
  readonly seen: Observation[] = [];
  readonly #controller = new AbortController();
  readonly #done: Promise<void>;

  constructor(observer: PaneObserver) {
    this.#done = (async () => {
      for await (const observation of observer.observations(this.#controller.signal)) {
        this.seen.push(observation);
      }
    })();
  }

  get labels(): Label[] {
    return this.seen.map(label);
  }

  // until waits for the latest observation to have a label.
  async until(expected: Label): Promise<void> {
    const deadline = Date.now() + 8000;
    while (this.labels.at(-1) !== expected) {
      if (Date.now() > deadline) {
        throw new Error(`never ${expected}; seen ${this.labels.join(", ")}`);
      }
      await pause(100);
    }
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await this.#done;
  }
}

// expectInOrder checks that the observer yielded the expected labels in
// order. A loaded machine can slow a redraw past a sample, which yields an
// extra reading between them, so others may come between.
function expectInOrder(seen: readonly Label[], expected: readonly Label[]): void {
  let matched = 0;
  for (const each of seen) {
    if (each === expected[matched]) {
      matched++;
    }
  }
  expect(matched, `${expected.join(", ")} in order, in ${seen.join(", ")}`).toBe(expected.length);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let server: TmuxServer | undefined;
let recording: Recording | undefined;

afterEach(async () => {
  await recording?.stop();
  recording = undefined;
  await server?.kill();
  server = undefined;
});

// observe starts the scripted harness, sends it keys to reach a screen, waits
// until the pane shows a row, and then starts observing it.
async function observe(profile: Profile, keys: string[], row: string): Promise<Recording> {
  server = await TmuxServer.start(scriptedHarness);
  const pane = new TmuxPane(server.socket);
  const deadline = Date.now() + 5000;
  while (!(await pane.snapshot()).lines.includes(">")) {
    if (Date.now() > deadline) {
      throw new Error("the scripted harness never drew its prompt");
    }
    await pause(50);
  }
  if (keys.length > 0) {
    await server.keys(...keys);
  }
  while (!(await pane.snapshot()).lines.includes(row)) {
    if (Date.now() > deadline) {
      throw new Error(`the scripted harness never drew ${row}`);
    }
    await pause(50);
  }
  recording = new Recording(new PaneObserver(pane, profile));
  return recording;
}

describe("PaneObserver on a tmux pane", () => {
  it("finds the harness at its prompt with either generic profile", async () => {
    for (const profile of [genericStrict, genericLenient]) {
      const observed = await observe(profile, [], ">");
      await observed.until("input");
      expectInOrder(observed.labels, ["input"]);
      await observed.stop();
      await server?.kill();
    }
  });

  it("tells a cursor before the end of its row apart by profile", async () => {
    const strict = await observe(genericStrict, ["e"], "> a draft");
    await strict.until("other");
    await strict.stop();
    await server?.kill();
    const lenient = await observe(genericLenient, ["e"], "> a draft");
    await lenient.until("input");
  });

  it("finds a harness redrawing its screen running, yielding only when that changes", async () => {
    const observed = await observe(genericStrict, [], ">");
    await observed.until("input");
    await server!.keys("r");
    await observed.until("running");
    // The harness redraws five times a second, but running is yielded once
    // for as long as it does.
    await pause(3000);
    await server!.keys("p");
    await observed.until("input");
    expectInOrder(observed.labels, ["input", "running", "input"]);
    const running = observed.seen.findLast((observation) => observation.activity === "running");
    const atPrompt = observed.seen.at(-1);
    expect(atPrompt!.since.getTime() - running!.since.getTime()).toBeGreaterThan(3000);
  });

  it("finds a dialog at rest on an unrecognized screen with the generic profiles, which name no prompt", async () => {
    const observed = await observe(genericLenient, ["d"], "Allow this action?");
    await observed.until("other");
    expectInOrder(observed.labels, ["other"]);
  });

  it("finds the pane unknown once the server is gone", async () => {
    const observed = await observe(genericStrict, [], ">");
    await observed.until("input");
    await server!.tmux("kill-server");
    await observed.until("unknown");
    expectInOrder(observed.labels, ["input", "unknown"]);
  });

  it("finds the pane unknown once its server holds a second pane", async () => {
    const observed = await observe(genericStrict, [], ">");
    await observed.until("input");
    await server!.tmux("split-window", "-d", "--", ...scriptedHarness);
    await observed.until("unknown");
    expectInOrder(observed.labels, ["input", "unknown"]);
  });
});
