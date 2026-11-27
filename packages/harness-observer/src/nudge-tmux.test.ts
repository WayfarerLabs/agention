import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedProfile } from "../test/scripted-profile.ts";
import { scriptedHarness, TmuxServer } from "../test/tmux-server.ts";
import { genericStrict } from "./generic-profiles.ts";
import { notReady, type NudgeOptions, type NudgeTexts, warnFor } from "./nudge.ts";
import { type Clock, PaneObserver } from "./observer.ts";
import type { Snapshot } from "./pane.ts";
import type { Profile } from "./profile.ts";
import { TmuxPane } from "./tmux-pane.ts";

// nudge against a real tmux server running the scripted harness. The clock
// waits for real, so the observer samples and the nudge confirms at their
// real rates, except for the wait for anyone to type over the warning, which
// passes at once.

const texts: NudgeTexts = {
  warning: "Nudge 3f9a is coming; type anything to stop it.",
  message: "Nudge 3f9a: check in with your inbox.",
  isNudgeText: (text) => /^Nudge [0-9a-f]{4}\b/.test(text),
};

// Not ready, having read the input line and found no nudge text there.
const readNotReady = { ...notReady, nudgeTextLeft: false };

// What lets every nudge here go ahead.
const go: NudgeOptions = {
  begin: () => Promise.resolve(true),
  signal: new AbortController().signal,
};

class QuickClock implements Clock {
  #skipped = 0;
  // Runs during the wait for anyone to type over the warning.
  during: (() => Promise<void>) | undefined;

  now(): number {
    return Date.now() + this.#skipped;
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms === warnFor) {
      await this.during?.();
      this.#skipped += ms;
      return;
    }
    try {
      await delay(ms, undefined, { signal });
    } catch {
      // Aborted: the caller checks its signal.
    }
  }
}

let server: TmuxServer | undefined;
let stopObserving: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopObserving?.();
  stopObserving = undefined;
  await server?.kill();
  server = undefined;
});

// The scripted harness's input row, as the pane shows it.
const inputRow = (snapshot: Snapshot) => snapshot.lines[2] ?? "";

async function until(pane: TmuxPane, test: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const snapshot = await pane.snapshot();
    if (test(snapshot)) {
      return snapshot;
    }
    if (Date.now() > deadline) {
      throw new Error(`no snapshot matched; the last: ${JSON.stringify(snapshot.lines)}`);
    }
    await delay(50);
  }
}

// Setup is a scripted harness in a tmux server, observed until the observer
// finds it at rest, ready for a nudge.
interface Setup {
  readonly server: TmuxServer;
  readonly pane: TmuxPane;
  readonly observer: PaneObserver;
  readonly clock: QuickClock;
}

// observed starts the scripted harness with options, lets a test arrange its
// screen, and observes it with a profile until the observer finds it at rest.
async function observed(
  profile: Profile,
  options: {
    harness?: string[];
    arrange?: (setup: Omit<Setup, "observer">) => Promise<void>;
    pane?: (socket: string) => TmuxPane;
  } = {},
): Promise<Setup> {
  server = await TmuxServer.start([...scriptedHarness, ...(options.harness ?? [])]);
  const pane = options.pane?.(server.socket) ?? new TmuxPane(server.socket);
  const clock = new QuickClock();
  await until(pane, (snapshot) => inputRow(snapshot).startsWith(">"));
  await options.arrange?.({ server, pane, clock });
  const observer = new PaneObserver(pane, profile, clock);
  const controller = new AbortController();
  const iterator = observer.observations(controller.signal)[Symbol.asyncIterator]();
  const done = (async () => {
    for (;;) {
      const { value, done: ended } = await iterator.next();
      if (ended === true || value.activity === "at_rest") {
        return;
      }
    }
  })();
  stopObserving = async () => {
    controller.abort();
    await iterator.return?.();
  };
  await done;
  // Keep sampling, as the bridge does, while the test nudges.
  void (async () => {
    for (;;) {
      const { done: ended } = await iterator.next();
      if (ended === true) {
        return;
      }
    }
  })();
  return { server, pane, observer, clock };
}

// buffers lists the server's paste buffers, by name and what they start with.
async function buffers(tmux: TmuxServer): Promise<string> {
  return tmux.tmux("list-buffers", "-F", "#{buffer_name} #{buffer_sample}");
}

describe("nudge on a tmux pane", () => {
  it("sends at a still prompt, and leaves the operator's buffers as they were", async () => {
    const { server, pane, observer } = await observed(scriptedProfile, {
      arrange: async ({ server }) => {
        await server.tmux("set-buffer", "the operator's copy");
        await server.tmux("set-buffer", "-b", "named", "a named buffer");
      },
    });
    const before = await buffers(server);
    const top = await server.tmux("show-buffer");
    expect(await observer.nudge(texts, go)).toEqual({ outcome: "sent", step: "submitted" });
    expect(await buffers(server)).toBe(before);
    // What the operator's paste key pastes.
    expect(await server.tmux("show-buffer")).toBe(top);
    // The harness ran the turn and is back at its prompt, empty.
    await until(pane, (snapshot) => snapshot.lines[1] === "turns 1" && inputRow(snapshot) === ">");
  });

  it("sends past a suggestion drawn faint, which shows again once the warning is removed, pressing Enter only on its message", async () => {
    // The input row at each reading, and at each key or paste, the row the
    // reading before it showed.
    const rows: string[] = [];
    const writes: { write: string; row: string }[] = [];
    class Recording extends TmuxPane {
      override async snapshot(): Promise<Snapshot> {
        const snapshot = await super.snapshot();
        rows.push(inputRow(snapshot));
        return snapshot;
      }
      override async paste(line: string): Promise<void> {
        writes.push({ write: "paste", row: rows.at(-1) ?? "" });
        await super.paste(line);
      }
      override async key(key: "Backspace" | "Enter"): Promise<void> {
        writes.push({ write: key, row: rows.at(-1) ?? "" });
        await super.key(key);
      }
    }
    const suggested = "> run the tests again";
    const { pane, observer } = await observed(scriptedProfile, {
      harness: ["--suggestion"],
      pane: (socket) => new Recording(socket),
    });
    expect(inputRow(await pane.snapshot())).toBe(suggested);
    expect(await observer.nudge(texts, go)).toEqual({ outcome: "sent", step: "submitted" });
    // The warning went in over the suggestion, which showed again once the
    // warning was removed and before the message went in, and Enter came
    // only right after a reading showed the message.
    expect(writes[0]).toEqual({ write: "paste", row: suggested });
    const message = writes.findLastIndex((write) => write.write === "paste");
    expect(writes[message]).toEqual({ write: "paste", row: suggested });
    expect(writes.filter((write) => write.write === "Enter")).toEqual([
      { write: "Enter", row: `> ${texts.message}` },
    ]);
    await until(pane, (snapshot) => snapshot.lines[1] === "turns 1");
  });

  it("refuses a generic profile, which cannot tell a draft from the prompt, sending nothing", async () => {
    const { pane, observer } = await observed(genericStrict, {
      arrange: ({ server, pane }) => keysShowing(server, pane, "xyz", "> xyz"),
    });
    await expect(observer.nudge(texts, go)).rejects.toThrow(genericStrict.name);
    expect(inputRow(await pane.snapshot())).toBe("> xyz");
  });

  it("is not ready at a dialog, and sends it nothing", async () => {
    const { pane, observer } = await observed(scriptedProfile, {
      arrange: ({ server, pane }) => keysShowing(server, pane, "d", "Allow this action?"),
    });
    const shown = await pane.snapshot();
    expect(await observer.nudge(texts, go)).toEqual(notReady);
    expect((await pane.snapshot()).lines).toEqual(shown.lines);
  });

  it("is not ready while someone has typed lately", async () => {
    const { pane, observer } = await observed(scriptedProfile, {
      arrange: async ({ server, pane }) => {
        const type = await server.attach();
        // A left arrow, which the harness ignores, so only the client's
        // activity shows it.
        type("\u001b[D");
        await until(pane, (snapshot) => snapshot.lastTyped !== undefined);
      },
    });
    const snapshot = await pane.snapshot();
    expect(snapshot.at - snapshot.lastTyped!).toBeLessThan(10_000);
    expect(await observer.nudge(texts, go)).toEqual(readNotReady);
    expect(inputRow(await pane.snapshot())).toBe(">");
  });

  it("is not ready in copy mode", async () => {
    const { server, pane, observer } = await observed(scriptedProfile);
    await server.tmux("copy-mode");
    await until(pane, (snapshot) => snapshot.keysBlocked);
    expect(await observer.nudge(texts, go)).toEqual(notReady);
    await server.tmux("send-keys", "-X", "cancel");
    expect(inputRow(await until(pane, (snapshot) => !snapshot.keysBlocked))).toBe(">");
  });

  it("is not ready with a draft in the input", async () => {
    const { pane, observer } = await observed(scriptedProfile, {
      arrange: ({ server, pane }) => keysShowing(server, pane, "xyz", "> xyz"),
    });
    expect(await observer.nudge(texts, go)).toEqual(readNotReady);
    expect(inputRow(await pane.snapshot())).toBe("> xyz");
  });

  it("is not ready under a usage limit before its reset", async () => {
    const { observer } = await observed(scriptedProfile, {
      arrange: ({ server, pane }) => keysShowing(server, pane, "l", "usage limit reached"),
    });
    expect(await observer.nudge(texts, go)).toEqual(readNotReady);
  });

  it("stops at the warning, leaving it, when someone types over it during the wait", async () => {
    const { server, pane, observer, clock } = await observed(scriptedProfile);
    clock.during = () => keysShowing(server, pane, "x", `> ${texts.warning}x`);
    expect(await observer.nudge(texts, go)).toEqual({ outcome: "stopped", step: "warning" });
    expect(inputRow(await pane.snapshot())).toBe(`> ${texts.warning}x`);
  });

  it("defers at the warning, taking it back, when the rest of the screen changes during the wait", async () => {
    const { server, pane, observer, clock } = await observed(scriptedProfile);
    clock.during = () => keysShowing(server, pane, "n", "a note");
    expect(await observer.nudge(texts, go)).toEqual({ outcome: "deferred", step: "warning" });
    const after = await pane.snapshot();
    expect(inputRow(after)).toBe(">");
    expect(after.lines).toContain("a note");
  });

  it("defers, sending nothing and saying so, with nudge text left in the input", async () => {
    const left = "Nudge 9f9f is coming; type";
    const { pane, observer } = await observed(scriptedProfile, {
      arrange: ({ server, pane }) => keysShowing(server, pane, left, `> ${left}`),
    });
    expect(await observer.nudge(texts, go)).toEqual({
      outcome: "deferred",
      step: "not-ready",
      nudgeTextLeft: true,
    });
    expect(inputRow(await pane.snapshot())).toBe(`> ${left}`);
  });

  it("fails at cleared where Backspace does not delete", async () => {
    const { pane, observer } = await observed(scriptedProfile, {
      harness: ["--backspace-moves"],
    });
    expect(await observer.nudge(texts, go)).toEqual({ outcome: "failed", step: "cleared" });
    expect(inputRow(await pane.snapshot())).toBe(`> ${texts.warning}`);
  });

  it("fails at the message when a dialog covers the line after its paste, since nothing shows the paste gone", async () => {
    const { pane, observer } = await observed(scriptedProfile, {
      harness: ["--dialog-at-second-paste"],
    });
    expect(await observer.nudge(texts, go)).toEqual({ outcome: "failed", step: "message" });
    expect((await pane.snapshot()).lines).toContain("Allow this action?");
  });

  it("fails at submitted when Enter does not submit", async () => {
    const { pane, observer } = await observed(scriptedProfile, { harness: ["--enter-ignored"] });
    expect(await observer.nudge(texts, go)).toEqual({ outcome: "failed", step: "submitted" });
    expect(inputRow(await pane.snapshot())).toBe(`> ${texts.message}`);
  });
});

// keysShowing sends keys to the pane and waits until it shows a row.
async function keysShowing(
  server: TmuxServer,
  pane: TmuxPane,
  keys: string,
  row: string,
): Promise<void> {
  await server.keys(keys);
  await until(pane, (snapshot) => snapshot.lines.includes(row));
}
