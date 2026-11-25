import { describe, expect, it } from "vitest";
import { scriptedProfile } from "../test/scripted-profile.ts";
import { genericStrict } from "./generic-profiles.ts";
import { lookEvery, type NudgeTexts, quietFor, settleWithin, warnFor } from "./nudge.ts";
import { type Clock, PaneObserver } from "./observer.ts";
import type { Key, Pane, Snapshot } from "./pane.ts";
import type { Profile } from "./profile.ts";

// nudge's steps against a fake pane: an input line, "> " and what it holds,
// under a row the harness changes when it takes a message. Every read and
// write is logged with what the line held then, so a test can check that no
// key went out without a reading that confirmed the line just before it.

type Event =
  | { readonly kind: "snapshot"; readonly text: string }
  | { readonly kind: "paste"; readonly line: string; readonly text: string }
  | { readonly kind: "key"; readonly key: Key; readonly text: string };

const texts: NudgeTexts = { warning: "Nudging in 5s: type to stop. a1b2", message: "Check in." };

class FakeClock implements Clock {
  time = Date.parse("2026-11-25T12:00:00Z");
  readonly sleeps: number[] = [];
  // Runs before a sleep of a length resolves, as if during it.
  during: ((ms: number) => void) | undefined;

  now(): number {
    return this.time;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.during?.(ms);
    this.time += ms;
  }
}

class FakePane implements Pane {
  readonly log: Event[] = [];
  text = "";
  above = "idle";
  keysBlocked = false;
  onePane = true;
  hostHasTerminal = true;
  cursorVisible = true;
  lastTyped: number | undefined;
  backspaceMoves = false;
  enterIgnored = false;
  // How many readings after a paste it shows, as a slow harness does.
  pasteShowsAfter = 0;
  failSnapshotsAfter = Infinity;
  #cursor = 0;
  #pending: { line: string; after: number } | undefined;

  readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  async snapshot(): Promise<Snapshot> {
    if (this.failSnapshotsAfter-- <= 0) {
      throw new Error("the pane cannot be read");
    }
    if (this.#pending !== undefined && this.#pending.after-- <= 0) {
      this.#insert(this.#pending.line);
      this.#pending = undefined;
    }
    this.log.push({ kind: "snapshot", text: this.text });
    return {
      lines: [this.above, "", `> ${this.text}`],
      width: 80,
      cursor: { x: 2 + this.#cursor, y: 2, visible: this.cursorVisible },
      hostHasTerminal: this.hostHasTerminal,
      onePane: this.onePane,
      keysBlocked: this.keysBlocked,
      lastTyped: this.lastTyped,
      at: this.clock.now(),
    };
  }

  async paste(line: string): Promise<void> {
    this.log.push({ kind: "paste", line, text: this.text });
    if (this.pasteShowsAfter > 0) {
      this.#pending = { line, after: this.pasteShowsAfter };
    } else {
      this.#insert(line);
    }
  }

  async key(key: Key): Promise<void> {
    this.log.push({ kind: "key", key, text: this.text });
    if (key === "Backspace" && this.#cursor > 0) {
      this.#cursor--;
      if (!this.backspaceMoves) {
        this.text = this.text.slice(0, this.#cursor) + this.text.slice(this.#cursor + 1);
      }
    } else if (key === "Enter" && !this.enterIgnored) {
      this.text = "";
      this.#cursor = 0;
      this.above = "working";
    }
  }

  // type is someone typing at the line, through a client.
  type(text: string): void {
    this.#insert(text);
    this.lastTyped = this.clock.now();
  }

  // draft puts text in the line as if typed long ago.
  draft(text: string): void {
    this.#insert(text);
  }

  #insert(text: string): void {
    this.text = this.text.slice(0, this.#cursor) + text + this.text.slice(this.#cursor);
    this.#cursor += text.length;
  }

  get writes(): Event[] {
    return this.log.filter((event) => event.kind !== "snapshot");
  }
}

// observed starts an observer on a pane and reads observations until it
// finds the harness at rest, as a running observations loop would have when
// a nudge is asked for, and returns the observer and a function that stops
// observing.
async function observed(
  pane: FakePane,
  profile: Profile = scriptedProfile,
): Promise<{ observer: PaneObserver; stop: () => Promise<void> }> {
  const observer = new PaneObserver(pane, profile, pane.clock);
  const controller = new AbortController();
  const iterator = observer.observations(controller.signal)[Symbol.asyncIterator]();
  for (;;) {
    const { value } = await iterator.next();
    if (value?.activity === "at_rest") {
      break;
    }
  }
  pane.log.length = 0;
  return {
    observer,
    stop: async () => {
      controller.abort();
      await iterator.return?.();
    },
  };
}

async function nudge(
  pane: FakePane,
  profile: Profile = scriptedProfile,
  nudgeTexts: NudgeTexts = texts,
) {
  const { observer, stop } = await observed(pane, profile);
  try {
    return await observer.nudge(nudgeTexts);
  } finally {
    await stop();
  }
}

// expectConfirmedWrites checks that every paste and key came right after a
// reading of the pane, with the line as that reading saw it.
function expectConfirmedWrites(log: readonly Event[]): void {
  log.forEach((event, i) => {
    if (event.kind !== "snapshot") {
      expect(log[i - 1], `the event before ${JSON.stringify(event)}`).toEqual({
        kind: "snapshot",
        text: event.text,
      });
    }
  });
}

const backspaces = (count: number) =>
  Array.from({ length: count }, () => ({ kind: "key", key: "Backspace" }));

describe("nudge", () => {
  it("warns, waits, clears, pastes the message and submits it, confirming before every key", async () => {
    const pane = new FakePane(new FakeClock());
    expect(await nudge(pane)).toEqual({ sent: true });
    expect(pane.writes.map(({ text: _, ...write }) => write)).toEqual([
      { kind: "paste", line: texts.warning },
      ...backspaces(texts.warning.length),
      { kind: "paste", line: texts.message },
      { kind: "key", key: "Enter" },
    ]);
    expectConfirmedWrites(pane.log);
    expect(pane.clock.sleeps).toContain(warnFor);
    expect(pane.text).toBe("");
  });

  it("confirms before every key with a generic profile, by the row before and after", async () => {
    const pane = new FakePane(new FakeClock());
    expect(await nudge(pane, genericStrict)).toEqual({ sent: true });
    expectConfirmedWrites(pane.log);
    expect(pane.writes.at(-1)).toMatchObject({ kind: "key", key: "Enter" });
  });

  it("is not ready, and sends nothing, where a guard fails", async () => {
    // Each arranged once the observer finds the harness at rest at its
    // prompt, but a draft, which is there from the start.
    const cases: [string, (pane: FakePane) => void][] = [
      ["keys are blocked", (pane) => (pane.keysBlocked = true)],
      ["the server holds another pane", (pane) => (pane.onePane = false)],
      ["the harness lacks the terminal", (pane) => (pane.hostHasTerminal = false)],
      ["someone typed lately", (pane) => (pane.lastTyped = pane.clock.now() - quietFor + 1000)],
      ["the screen changed since the observation", (pane) => (pane.above = "changed")],
      ["the input holds a draft", () => {}],
    ];
    for (const [why, arrange] of cases) {
      const pane = new FakePane(new FakeClock());
      if (why === "the input holds a draft") {
        pane.draft("a draft");
      }
      const { observer, stop } = await observed(pane);
      arrange(pane);
      expect(await observer.nudge(texts), why).toEqual({ sent: false, step: "not-ready" });
      expect(pane.writes, why).toEqual([]);
      await stop();
    }
  });

  it("is ready once no one has typed for long enough", async () => {
    const pane = new FakePane(new FakeClock());
    pane.lastTyped = pane.clock.now() - quietFor - 5000;
    expect(await nudge(pane)).toEqual({ sent: true });
  });

  it("is not ready at a dialog, or without room for its texts", async () => {
    const dialog = new FakePane(new FakeClock());
    dialog.cursorVisible = false;
    expect(await nudge(dialog)).toEqual({ sent: false, step: "not-ready" });
    // The line is 80 columns, "> " takes 2 and the cursor 1 after the text.
    const long = { warning: "w".repeat(78), message: "m" };
    expect(await nudge(new FakePane(new FakeClock()), scriptedProfile, long)).toEqual({
      sent: false,
      step: "not-ready",
    });
    const fits = { warning: "w".repeat(77), message: "m" };
    expect(await nudge(new FakePane(new FakeClock()), scriptedProfile, fits)).toEqual({
      sent: true,
    });
  });

  it("is not ready under a usage limit before its reset, and ready after it", async () => {
    const limitedUntil = (resetsAt: Date | undefined): Profile => ({
      ...scriptedProfile,
      screen: (snapshot) => ({
        ...scriptedProfile.screen(snapshot),
        stoppedBy: { reason: "usage_limit", ...(resetsAt && { resetsAt }) },
      }),
    });
    const clock = new FakeClock();
    for (const resetsAt of [undefined, new Date(clock.now() + 3_600_000)]) {
      expect(await nudge(new FakePane(clock), limitedUntil(resetsAt))).toEqual({
        sent: false,
        step: "not-ready",
      });
    }
    const reset = new Date(clock.now() - 1000);
    expect(await nudge(new FakePane(clock), limitedUntil(reset))).toEqual({ sent: true });
  });

  it("is not ready without a running observations loop, or while another nudge runs", async () => {
    const pane = new FakePane(new FakeClock());
    expect(await new PaneObserver(pane, scriptedProfile, pane.clock).nudge(texts)).toEqual({
      sent: false,
      step: "not-ready",
    });
    const { observer, stop } = await observed(pane);
    const [first, second] = await Promise.all([observer.nudge(texts), observer.nudge(texts)]);
    await stop();
    expect([first, second]).toEqual([{ sent: true }, { sent: false, step: "not-ready" }]);
  });

  it("abandons at the warning, removing nothing, when it is typed over during the wait", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && pane.type("x");
    expect(await nudge(pane)).toEqual({ sent: false, step: "warning" });
    expect(pane.text).toBe(`${texts.warning}x`);
    expect(pane.writes).toHaveLength(1);
  });

  it("abandons at the warning when a key that changes nothing was typed during the wait", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && (pane.lastTyped = pane.clock.now());
    expect(await nudge(pane)).toEqual({ sent: false, step: "warning" });
    expect(pane.text).toBe(texts.warning);
  });

  it("abandons at the warning when the paste never shows", async () => {
    const pane = new FakePane(new FakeClock());
    pane.pasteShowsAfter = settleWithin;
    expect(await nudge(pane)).toEqual({ sent: false, step: "warning" });
    expect(pane.writes).toHaveLength(1);
  });

  it("abandons at cleared after the first Backspace that does not delete", async () => {
    const pane = new FakePane(new FakeClock());
    pane.backspaceMoves = true;
    expect(await nudge(pane)).toEqual({ sent: false, step: "cleared" });
    expect(pane.text).toBe(texts.warning);
    expect(pane.writes).toHaveLength(2);
    expectConfirmedWrites(pane.log);
  });

  it("abandons at the message, removing it, when it shows only after its confirmation gave up", async () => {
    const pane = new FakePane(new FakeClock());
    const paste = pane.paste.bind(pane);
    pane.paste = async (line) => {
      pane.pasteShowsAfter = line === texts.message ? settleWithin / lookEvery + 1 : 0;
      await paste(line);
    };
    expect(await nudge(pane)).toEqual({ sent: false, step: "message" });
    expect(pane.text).toBe("");
    expect(
      pane.writes.filter((write) => write.kind === "key").map(({ text: _, ...key }) => key),
    ).toEqual(backspaces(texts.warning.length + texts.message.length));
    expectConfirmedWrites(pane.log);
  });

  it("abandons at the message, leaving the line, when something else is there", async () => {
    const pane = new FakePane(new FakeClock());
    const paste = pane.paste.bind(pane);
    pane.paste = async (line) => {
      await paste(line);
      if (line === texts.message) {
        pane.type("y");
      }
    };
    expect(await nudge(pane)).toEqual({ sent: false, step: "message" });
    expect(pane.text).toBe(`${texts.message}y`);
  });

  it("abandons at submitted when Enter does not take the message", async () => {
    const pane = new FakePane(new FakeClock());
    pane.enterIgnored = true;
    expect(await nudge(pane)).toEqual({ sent: false, step: "submitted" });
    expect(pane.text).toBe(texts.message);
    expect(
      pane.writes.filter((write) => write.kind === "key" && write.key === "Enter"),
    ).toHaveLength(1);
  });

  it("stops at the step where the pane fails", async () => {
    const pane = new FakePane(new FakeClock());
    const { observer, stop } = await observed(pane);
    pane.failSnapshotsAfter = 2;
    expect(await observer.nudge(texts)).toEqual({ sent: false, step: "warning" });
    await stop();
  });

  it.each([
    ["empty", { ...texts, warning: "" }],
    ["holding a line break", { ...texts, message: "a\nb" }],
    ["holding a control character", { ...texts, warning: "a\u001b[201~b" }],
    ["holding a character outside printable ASCII", { ...texts, message: "café" }],
  ])("refuses a text %s before anything reaches the pane", async (_, refused) => {
    const pane = new FakePane(new FakeClock());
    const { observer, stop } = await observed(pane);
    await expect(observer.nudge(refused)).rejects.toBeInstanceOf(RangeError);
    await stop();
    expect(pane.writes).toEqual([]);
  });
});
