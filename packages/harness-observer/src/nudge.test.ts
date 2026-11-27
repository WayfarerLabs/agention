import { describe, expect, it } from "vitest";
import { scriptedProfile } from "../test/scripted-profile.ts";
import { genericLenient, genericStrict } from "./generic-profiles.ts";
import {
  lookEvery,
  type NudgeOptions,
  type NudgeStep,
  type NudgeTexts,
  quietFor,
  recheckAfter,
  settleWithin,
  warnFor,
} from "./nudge.ts";
import { type Clock, PaneObserver } from "./observer.ts";
import type { Key, Pane, Snapshot } from "./pane.ts";
import type { Profile } from "./profile.ts";

// nudge's steps against a fake pane: an input line, "> " and what it holds,
// under a row the harness changes when it takes a message. Every read and
// write is logged with what the line held then, so a test can check that no
// key went out without a reading that confirmed the line just before it.

type Event =
  | { readonly kind: "begin" }
  | { readonly kind: "snapshot"; readonly text: string }
  | { readonly kind: "paste"; readonly line: string; readonly text: string }
  | { readonly kind: "key"; readonly key: Key; readonly text: string };

type Write = Extract<Event, { readonly kind: "paste" | "key" }>;

// Nudge text starts with "Nudge" and an id, as an earlier nudge's does too.
const texts: NudgeTexts = {
  warning: "Nudge a1b2 in 5s: type to stop.",
  message: "Nudge a1b2: check in.",
  isNudgeText: (text) => /^Nudge [0-9a-f]{4}\b/.test(text),
};

const sent = { outcome: "sent", step: "submitted" } as const;
const ended = (outcome: "deferred" | "stopped" | "failed", step: NudgeStep) => ({ outcome, step });
const notReady = ended("deferred", "not-ready");
// Not ready, having read the input line and found no nudge text there.
const readNotReady = { ...notReady, nudgeTextLeft: false };

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
  // Enter clears the line but changes nothing else, as when the harness
  // takes no turn.
  enterOnlyClears = false;
  // How many of the next readings fail, as a pane that falters does.
  failNext = 0;
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
    if (this.failSnapshotsAfter-- <= 0 || this.failNext-- > 0) {
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
      if (!this.enterOnlyClears) {
        this.above = "working";
      }
    }
  }

  // type is someone typing at the line, through a client.
  type(text: string): void {
    this.#insert(text);
    this.lastTyped = this.clock.now();
  }

  // clear empties the line as the harness itself might, no client typing.
  clear(): void {
    this.text = "";
    this.#cursor = 0;
  }

  // draft puts text in the line as if typed long ago.
  draft(text: string): void {
    this.#insert(text);
  }

  #insert(text: string): void {
    this.text = this.text.slice(0, this.#cursor) + text + this.text.slice(this.#cursor);
    this.#cursor += text.length;
  }

  get writes(): Write[] {
    return this.log.filter(
      (event): event is Write => event.kind === "paste" || event.kind === "key",
    );
  }

  // options lets a nudge go ahead, logging when it asks.
  options(signal = new AbortController().signal): NudgeOptions {
    return {
      begin: () => {
        this.log.push({ kind: "begin" });
        return Promise.resolve(true);
      },
      signal,
    };
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
  options: NudgeOptions = pane.options(),
) {
  const { observer, stop } = await observed(pane, profile);
  try {
    return await observer.nudge(nudgeTexts, options);
  } finally {
    await stop();
  }
}

// expectConfirmedWrites checks that every paste and key came right after a
// reading of the pane, with the line as that reading saw it.
function expectConfirmedWrites(log: readonly Event[]): void {
  log.forEach((event, i) => {
    if (event.kind === "paste" || event.kind === "key") {
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
    expect(await nudge(pane)).toEqual(sent);
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

  it("asks begin once, once the harness is ready and before anything reaches the pane", async () => {
    const pane = new FakePane(new FakeClock());
    expect(await nudge(pane)).toEqual(sent);
    const begins = pane.log.flatMap((event, i) => (event.kind === "begin" ? [i] : []));
    expect(begins).toHaveLength(1);
    expect(pane.log.findIndex((event) => event.kind === "paste")).toBeGreaterThan(begins[0] ?? 0);
    // Not ready, it never asks.
    const dialog = new FakePane(new FakeClock());
    dialog.cursorVisible = false;
    expect(await nudge(dialog)).toEqual(notReady);
    expect(dialog.log.some((event) => event.kind === "begin")).toBe(false);
  });

  it("sends nothing where begin answers false", async () => {
    const pane = new FakePane(new FakeClock());
    const options = { ...pane.options(), begin: () => Promise.resolve(false) };
    expect(await nudge(pane, scriptedProfile, texts, options)).toEqual(readNotReady);
    expect(pane.writes).toEqual([]);
  });

  it("sends nothing where the screen changed or a key was typed while begin answered", async () => {
    const meanwhile: [string, (pane: FakePane) => void][] = [
      ["someone typed", (pane) => pane.type("x")],
      ["the harness drew", (pane) => (pane.above = "changed")],
      ["a key changed nothing", (pane) => (pane.lastTyped = pane.clock.now())],
    ];
    for (const [why, change] of meanwhile) {
      const pane = new FakePane(new FakeClock());
      const options = {
        ...pane.options(),
        begin: () => {
          change(pane);
          return Promise.resolve(true);
        },
      };
      expect(await nudge(pane, scriptedProfile, texts, options), why).toEqual(readNotReady);
      expect(pane.writes, why).toEqual([]);
    }
  });

  it("sends nothing more once its signal aborts, at every write, not even to remove its text", async () => {
    const whole = new FakePane(new FakeClock());
    await nudge(whole);
    const total = whole.writes.length;
    for (let stopAt = 0; stopAt <= total; stopAt++) {
      const pane = new FakePane(new FakeClock());
      const controller = new AbortController();
      const options = pane.options(controller.signal);
      const begin = options.begin;
      const write = (sent: () => Promise<void>) => async () => {
        await sent();
        if (pane.writes.length === stopAt) {
          controller.abort();
        }
      };
      const paste = pane.paste.bind(pane);
      const key = pane.key.bind(pane);
      pane.paste = (line) => write(() => paste(line))();
      pane.key = (pressed) => write(() => key(pressed))();
      const outcome = await nudge(pane, scriptedProfile, texts, {
        ...options,
        begin: async () => {
          const go = await begin();
          if (stopAt === 0) {
            controller.abort();
          }
          return go;
        },
      });
      expect(pane.writes, `stopped after ${stopAt}`).toHaveLength(stopAt);
      expect(outcome.outcome, `stopped after ${stopAt}`).toBe(
        stopAt === total ? "sent" : stopAt === 0 ? "deferred" : "failed",
      );
    }
  });

  it("leaves the warning where it was when stopped during its wait", async () => {
    const pane = new FakePane(new FakeClock());
    const controller = new AbortController();
    pane.clock.during = (ms) => ms === warnFor && controller.abort();
    expect(await nudge(pane, scriptedProfile, texts, pane.options(controller.signal))).toEqual(
      ended("failed", "warning"),
    );
    expect(pane.text).toBe(texts.warning);
    expect(pane.writes).toHaveLength(1);
  });

  it("refuses a profile that does not know its harness's prompt marker, before anything reaches the pane", async () => {
    for (const profile of [genericStrict, genericLenient]) {
      const pane = new FakePane(new FakeClock());
      const { observer, stop } = await observed(pane, profile);
      await expect(observer.nudge(texts, pane.options())).rejects.toThrow(profile.name);
      await stop();
      expect(pane.log.filter((event) => event.kind !== "snapshot")).toEqual([]);
    }
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
      // Where the line cannot be read, it says nothing of nudge text.
      expect(await observer.nudge(texts, pane.options()), why).toMatchObject(notReady);
      expect(pane.writes, why).toEqual([]);
      await stop();
    }
  });

  it("is ready once no one has typed for long enough", async () => {
    const pane = new FakePane(new FakeClock());
    pane.lastTyped = pane.clock.now() - quietFor - 5000;
    expect(await nudge(pane)).toEqual(sent);
  });

  it("is not ready at a dialog, or without room for its texts", async () => {
    const dialog = new FakePane(new FakeClock());
    dialog.cursorVisible = false;
    expect(await nudge(dialog)).toEqual(notReady);
    // The line is 80 columns, "> " takes 2 and the cursor 1 after the text.
    const long = { ...texts, warning: "w".repeat(78), message: "m" };
    expect(await nudge(new FakePane(new FakeClock()), scriptedProfile, long)).toEqual(readNotReady);
    const fits = { ...texts, warning: "w".repeat(77), message: "m" };
    expect(await nudge(new FakePane(new FakeClock()), scriptedProfile, fits)).toEqual(sent);
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
      expect(await nudge(new FakePane(clock), limitedUntil(resetsAt))).toEqual(readNotReady);
    }
    const reset = new Date(clock.now() - 1000);
    expect(await nudge(new FakePane(clock), limitedUntil(reset))).toEqual(sent);
  });

  it("is not ready without a running observations loop, or while another nudge runs", async () => {
    const pane = new FakePane(new FakeClock());
    const observer = new PaneObserver(pane, scriptedProfile, pane.clock);
    expect(await observer.nudge(texts, pane.options())).toEqual(notReady);
    const running = await observed(pane);
    const [first, second] = await Promise.all([
      running.observer.nudge(texts, pane.options()),
      running.observer.nudge(texts, pane.options()),
    ]);
    await running.stop();
    expect([first, second]).toEqual([sent, notReady]);
  });

  it("stops at the warning, removing nothing, when it is typed over during the wait", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && pane.type("x");
    expect(await nudge(pane)).toEqual(ended("stopped", "warning"));
    expect(pane.text).toBe(`${texts.warning}x`);
    expect(pane.writes).toHaveLength(1);
  });

  it("stops at the warning when a key that changes nothing was typed during the wait", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && (pane.lastTyped = pane.clock.now());
    expect(await nudge(pane)).toEqual(ended("stopped", "warning"));
    expect(pane.text).toBe(texts.warning);
  });

  it("is not ready where its profile finds the cursor short of an empty line's end", async () => {
    const pane = new FakePane(new FakeClock());
    const astray: Profile = {
      ...scriptedProfile,
      screen: (snapshot) => {
        const screen = scriptedProfile.screen(snapshot);
        return screen.kind === "input" && screen.input.text === ""
          ? { ...screen, input: { ...screen.input, cursorAtEnd: false } }
          : screen;
      },
    };
    expect(await nudge(pane, astray)).toEqual(readNotReady);
    expect(pane.writes).toEqual([]);
  });

  it("defers at the warning, taking it back, when anything else on the screen changed during the wait", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && (pane.above = "a turn began");
    expect(await nudge(pane)).toEqual(ended("deferred", "warning"));
    expect(pane.text).toBe("");
    expect(pane.writes.map(({ text: _, ...write }) => write)).toEqual([
      { kind: "paste", line: texts.warning },
      ...backspaces(texts.warning.length),
    ]);
    expectConfirmedWrites(pane.log);
  });

  it("fails at the warning where a Backspace taking it back does not delete", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => {
      if (ms === warnFor) {
        pane.above = "a turn began";
        pane.backspaceMoves = true;
      }
    };
    expect(await nudge(pane)).toEqual(ended("failed", "warning"));
    expect(pane.text).toBe(texts.warning);
    expect(pane.writes).toHaveLength(2);
  });

  it("stops at the warning where someone types while it is taken back", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && (pane.above = "a turn began");
    const key = pane.key.bind(pane);
    pane.key = async (pressed) => {
      await key(pressed);
      if (pane.writes.length === 3) {
        pane.type("z");
      }
    };
    expect(await nudge(pane)).toEqual(ended("stopped", "warning"));
    expect(pane.text).toBe(`${texts.warning.slice(0, -2)}z`);
  });

  it("defers at the warning when the harness clears it during the wait with no one typing", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && pane.clear();
    expect(await nudge(pane)).toEqual(ended("deferred", "warning"));
    expect(pane.writes).toHaveLength(1);
  });

  it("defers at the warning when the paste never shows", async () => {
    const pane = new FakePane(new FakeClock());
    pane.pasteShowsAfter = settleWithin;
    expect(await nudge(pane)).toEqual(ended("deferred", "warning"));
    expect(pane.writes).toHaveLength(1);
    expect(pane.clock.sleeps).toContain(recheckAfter);
  });

  it("defers at the warning, taking it back, when it shows only after its confirmation gave up", async () => {
    const pane = new FakePane(new FakeClock());
    pane.pasteShowsAfter = settleWithin / lookEvery + 1;
    expect(await nudge(pane)).toEqual(ended("deferred", "warning"));
    expect(pane.text).toBe("");
    expect(pane.writes.map(({ text: _, ...write }) => write)).toEqual([
      { kind: "paste", line: texts.warning },
      ...backspaces(texts.warning.length),
    ]);
    expectConfirmedWrites(pane.log);
  });

  it("fails at the warning, leaving it, when the input line goes from the screen during the wait and stays gone", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && (pane.cursorVisible = false);
    expect(await nudge(pane)).toEqual(ended("failed", "warning"));
    expect(pane.text).toBe(texts.warning);
    expect(pane.writes).toHaveLength(1);
  });

  it("defers at the warning, taking it back, when the input line goes out of sight during the wait and comes back holding it", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => {
      if (ms === warnFor) {
        pane.keysBlocked = true;
      } else if (ms === recheckAfter) {
        pane.keysBlocked = false;
      }
    };
    expect(await nudge(pane)).toEqual(ended("deferred", "warning"));
    expect(pane.text).toBe("");
    expectConfirmedWrites(pane.log);
  });

  it("defers, pasting nothing and saying so, where the line holds nudge text left by an earlier nudge", async () => {
    const pane = new FakePane(new FakeClock());
    pane.draft("Nudge 9f9f in 5s: type to st");
    expect(await nudge(pane)).toEqual({ ...notReady, nudgeTextLeft: true });
    expect(pane.writes).toEqual([]);
    expect(pane.log.some((event) => event.kind === "begin")).toBe(false);
    // A draft of anyone's is no nudge text.
    const drafted = new FakePane(new FakeClock());
    drafted.draft("Nudge me later");
    expect(await nudge(drafted)).toEqual(readNotReady);
  });

  it("fails at cleared after the first Backspace that does not delete", async () => {
    const pane = new FakePane(new FakeClock());
    pane.backspaceMoves = true;
    expect(await nudge(pane)).toEqual(ended("failed", "cleared"));
    expect(pane.text).toBe(texts.warning);
    expect(pane.writes).toHaveLength(2);
    expectConfirmedWrites(pane.log);
  });

  it("defers at the message, removing it, when it shows only after its confirmation gave up", async () => {
    const pane = new FakePane(new FakeClock());
    const paste = pane.paste.bind(pane);
    pane.paste = async (line) => {
      pane.pasteShowsAfter = line === texts.message ? settleWithin / lookEvery + 1 : 0;
      await paste(line);
    };
    expect(await nudge(pane)).toEqual(ended("deferred", "message"));
    expect(pane.text).toBe("");
    expect(
      pane.writes.filter((write) => write.kind === "key").map(({ text: _, ...key }) => key),
    ).toEqual(backspaces(texts.warning.length + texts.message.length));
    expectConfirmedWrites(pane.log);
  });

  it("stops at once, reading the pane no more, when someone types while a paste is confirmed", async () => {
    const pane = new FakePane(new FakeClock());
    pane.pasteShowsAfter = 3;
    const paste = pane.paste.bind(pane);
    let slept = 0;
    pane.paste = async (line) => {
      await paste(line);
      pane.lastTyped = pane.clock.now();
      slept = pane.clock.sleeps.length;
    };
    expect(await nudge(pane)).toEqual(ended("stopped", "warning"));
    const pasted = pane.log.findIndex((event) => event.kind === "paste");
    expect(pane.log.slice(pasted + 1).filter((event) => event.kind === "snapshot")).toHaveLength(1);
    expect(pane.clock.sleeps.slice(slept)).toEqual([]);
  });

  it("stops at the message, leaving the line, when someone types into it", async () => {
    const pane = new FakePane(new FakeClock());
    const paste = pane.paste.bind(pane);
    pane.paste = async (line) => {
      await paste(line);
      if (line === texts.message) {
        pane.type("y");
      }
    };
    expect(await nudge(pane)).toEqual(ended("stopped", "message"));
    expect(pane.text).toBe(`${texts.message}y`);
  });

  it("fails at the message, leaving the line, when it does not show exactly", async () => {
    const pane = new FakePane(new FakeClock());
    const paste = pane.paste.bind(pane);
    pane.paste = (line) => paste(line === texts.message ? `${line}!` : line);
    expect(await nudge(pane)).toEqual(ended("failed", "message"));
    expect(pane.text).toBe(`${texts.message}!`);
  });

  it("defers at submitted, taking the message back, when anything else on the screen changed before Enter", async () => {
    const pane = new FakePane(new FakeClock());
    // The harness redraws once the reading that confirmed the message is
    // taken, before the one Enter would follow.
    const snapshot = pane.snapshot.bind(pane);
    pane.snapshot = async () => {
      const read = await snapshot();
      if (pane.text === texts.message) {
        pane.above = "the harness redrew";
      }
      return read;
    };
    expect(await nudge(pane)).toEqual(ended("deferred", "submitted"));
    expect(pane.text).toBe("");
    expect(pane.writes.some((write) => write.kind === "key" && write.key === "Enter")).toBe(false);
    expectConfirmedWrites(pane.log);
  });

  it("fails at submitted when Enter does not take the message", async () => {
    const pane = new FakePane(new FakeClock());
    pane.enterIgnored = true;
    expect(await nudge(pane)).toEqual(ended("failed", "submitted"));
    expect(pane.text).toBe(texts.message);
    expect(
      pane.writes.filter((write) => write.kind === "key" && write.key === "Enter"),
    ).toHaveLength(1);
  });

  it("fails at submitted when the line clears but nothing else on the screen changes", async () => {
    const pane = new FakePane(new FakeClock());
    pane.enterOnlyClears = true;
    expect(await nudge(pane)).toEqual(ended("failed", "submitted"));
    expect(pane.text).toBe("");
  });

  it("defers, taking the warning back, where the pane fails once during its wait", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && (pane.failNext = 1);
    expect(await nudge(pane)).toEqual(ended("deferred", "warning"));
    expect(pane.text).toBe("");
    expect(pane.writes.map(({ text: _, ...write }) => write)).toEqual([
      { kind: "paste", line: texts.warning },
      ...backspaces(texts.warning.length),
    ]);
    expectConfirmedWrites(pane.log);
  });

  it("fails, leaving the warning, where the pane still fails when it would take it back", async () => {
    const pane = new FakePane(new FakeClock());
    pane.clock.during = (ms) => ms === warnFor && (pane.failNext = 2);
    expect(await nudge(pane)).toEqual(ended("failed", "warning"));
    expect(pane.text).toBe(texts.warning);
    expect(pane.writes).toHaveLength(1);
  });

  it("defers at cleared, never pasting the message, where the screen beside the line changed while the warning was removed", async () => {
    const pane = new FakePane(new FakeClock());
    const key = pane.key.bind(pane);
    pane.key = async (pressed) => {
      await key(pressed);
      if (pane.text === "") {
        pane.above = "a turn began";
      }
    };
    expect(await nudge(pane)).toEqual(ended("deferred", "cleared"));
    expect(pane.text).toBe("");
    expect(pane.writes.filter((write) => write.kind === "paste")).toHaveLength(1);
  });

  it.each([
    ["message", 0],
    ["submitted", 1],
  ] as const)(
    "defers, removing the message, where the pane fails at %s, though a key was typed",
    async (step, fine) => {
      const pane = new FakePane(new FakeClock());
      const paste = pane.paste.bind(pane);
      pane.paste = async (line) => {
        await paste(line);
        if (line === texts.message) {
          // A key that changes nothing, after the readings that go well.
          const snapshot = pane.snapshot.bind(pane);
          let left = fine;
          pane.snapshot = async () => {
            if (left-- === 0) {
              pane.lastTyped = pane.clock.now();
              pane.snapshot = snapshot;
              throw new Error("the pane cannot be read");
            }
            return snapshot();
          };
        }
      };
      expect(await nudge(pane)).toEqual(ended("deferred", step));
      expect(pane.text).toBe("");
      expect(pane.writes.map(({ text: _, ...write }) => write)).toEqual([
        { kind: "paste", line: texts.warning },
        ...backspaces(texts.warning.length),
        { kind: "paste", line: texts.message },
        ...backspaces(texts.message.length),
      ]);
      expectConfirmedWrites(pane.log);
    },
  );

  it("fails, never deferring, where the pane cannot be read once Enter is sent", async () => {
    const pane = new FakePane(new FakeClock());
    const key = pane.key.bind(pane);
    pane.key = async (pressed) => {
      await key(pressed);
      if (pressed === "Enter") {
        pane.failSnapshotsAfter = 0;
      }
    };
    expect(await nudge(pane)).toEqual(ended("failed", "submitted"));
  });

  it("fails, never deferring, where the Enter write throws once delivered", async () => {
    const pane = new FakePane(new FakeClock());
    const key = pane.key.bind(pane);
    pane.key = async (pressed) => {
      await key(pressed);
      if (pressed === "Enter") {
        throw new Error("the pane's answer was lost");
      }
    };
    expect(await nudge(pane)).toEqual(ended("failed", "submitted"));
    expect(pane.text).toBe("");
  });

  it("takes back a warning whose paste threw and shows a reading later, never deferring with it left", async () => {
    const pane = new FakePane(new FakeClock());
    const paste = pane.paste.bind(pane);
    pane.paste = async (line) => {
      pane.pasteShowsAfter = 1;
      await paste(line);
      throw new Error("tmux timed out");
    };
    expect(await nudge(pane)).toEqual(ended("deferred", "warning"));
    expect(pane.text).toBe("");
    expectConfirmedWrites(pane.log);
  });

  it("takes back the rest of the warning, and defers, where the pane fails once while it is removed", async () => {
    const pane = new FakePane(new FakeClock());
    const key = pane.key.bind(pane);
    let backspaces = 0;
    pane.key = async (pressed) => {
      await key(pressed);
      if (pressed === "Backspace" && ++backspaces === 3) {
        pane.failNext = 1;
      }
    };
    expect(await nudge(pane)).toEqual(ended("deferred", "cleared"));
    expect(pane.text).toBe("");
    expect(pane.writes.filter((write) => write.kind === "paste")).toHaveLength(1);
    expectConfirmedWrites(pane.log);
  });

  it("reports the failure it stopped for where removing its text fails too", async () => {
    const pane = new FakePane(new FakeClock());
    const paste = pane.paste.bind(pane);
    pane.paste = async (line) => {
      await paste(line);
      if (line === texts.message) {
        throw new Error("the pane cannot be written");
      }
    };
    const key = pane.key.bind(pane);
    pane.key = async (pressed) => {
      if (pane.text === texts.message) {
        throw new Error("the pane cannot be written");
      }
      await key(pressed);
    };
    expect(await nudge(pane)).toEqual(ended("failed", "message"));
    expect(pane.text).toBe(texts.message);
  });

  it("fails at the step where the pane fails, and defers where nothing was pasted", async () => {
    const pane = new FakePane(new FakeClock());
    const { observer, stop } = await observed(pane);
    pane.failSnapshotsAfter = 2;
    expect(await observer.nudge(texts, pane.options())).toEqual(ended("failed", "warning"));
    pane.failSnapshotsAfter = 0;
    expect(await observer.nudge(texts, pane.options())).toEqual(notReady);
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
    await expect(observer.nudge(refused, pane.options())).rejects.toBeInstanceOf(RangeError);
    await stop();
    expect(pane.writes).toEqual([]);
  });
});
