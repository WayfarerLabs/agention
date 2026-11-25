import { afterEach, describe, expect, it } from "vitest";
import { scriptedHarness, TmuxServer } from "../test/tmux-server.ts";
import { genericLenient, genericStrict } from "./generic-profiles.ts";
import { type Condition, type Observation, PaneObserver } from "./observer.ts";
import type { Profile } from "./profile.ts";
import { TmuxPane } from "./tmux-pane.ts";

// The observer against a real tmux server running the scripted harness, at
// its real sampling rate.

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

  get conditions(): Condition[] {
    return this.seen.map((observation) => observation.condition);
  }

  // until waits for the latest observation to be a condition.
  async until(condition: Condition): Promise<void> {
    const deadline = Date.now() + 8000;
    while (this.seen.at(-1)?.condition !== condition) {
      if (Date.now() > deadline) {
        throw new Error(`never ${condition}; seen ${this.conditions.join(", ")}`);
      }
      await pause(100);
    }
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await this.#done;
  }
}

// expectInOrder checks that the observer yielded the expected conditions in
// order. A loaded machine can slow a redraw past a sample, which yields an
// extra reading between them, so others may come between.
function expectInOrder(seen: readonly Condition[], expected: readonly Condition[]): void {
  let matched = 0;
  for (const condition of seen) {
    if (condition === expected[matched]) {
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
      await observed.until("at_prompt");
      expectInOrder(observed.conditions, ["at_prompt"]);
      await observed.stop();
      await server?.kill();
    }
  });

  it("tells a cursor before the end of its row apart by profile", async () => {
    const strict = await observe(genericStrict, ["e"], "> a draft");
    await strict.until("waiting");
    await strict.stop();
    await server?.kill();
    const lenient = await observe(genericLenient, ["e"], "> a draft");
    await lenient.until("at_prompt");
  });

  it("finds a harness redrawing its screen running, yielding only when the condition changes", async () => {
    const observed = await observe(genericStrict, [], ">");
    await observed.until("at_prompt");
    await server!.keys("r");
    await observed.until("running");
    // The harness redraws five times a second, but running is yielded once
    // for as long as it does.
    await pause(3000);
    await server!.keys("p");
    await observed.until("at_prompt");
    expectInOrder(observed.conditions, ["at_prompt", "running", "at_prompt"]);
    const running = observed.seen.findLast((observation) => observation.condition === "running");
    const atPrompt = observed.seen.at(-1);
    expect(atPrompt!.since.getTime() - running!.since.getTime()).toBeGreaterThan(3000);
  });

  it("finds a dialog waiting with the generic profiles, which name no prompt", async () => {
    const observed = await observe(genericLenient, ["d"], "Allow this action?");
    await observed.until("waiting");
    expectInOrder(observed.conditions, ["waiting"]);
  });

  it("finds the pane unknown once the server is gone", async () => {
    const observed = await observe(genericStrict, [], ">");
    await observed.until("at_prompt");
    await server!.tmux("kill-server");
    await observed.until("unknown");
    expectInOrder(observed.conditions, ["at_prompt", "unknown"]);
  });

  it("finds the pane unknown once its server holds a second pane", async () => {
    const observed = await observe(genericStrict, [], ">");
    await observed.until("at_prompt");
    await server!.tmux("split-window", "-d", "--", ...scriptedHarness);
    await observed.until("unknown");
    expectInOrder(observed.conditions, ["at_prompt", "unknown"]);
  });
});
