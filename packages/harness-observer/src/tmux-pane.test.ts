import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedHarness, TmuxServer } from "../test/tmux-server.ts";
import { PaneUnusable, type Snapshot } from "./pane.ts";
import { TmuxPane } from "./tmux-pane.ts";

// These tests read a real tmux server, running the scripted harness or a
// shell in its one pane.

let server: TmuxServer | undefined;

afterEach(async () => {
  await server?.kill();
  server = undefined;
});

// snapshotWhere reads the pane until a snapshot satisfies a test, and returns
// it, failing after a few seconds.
async function snapshotWhere(
  pane: TmuxPane,
  test: (snapshot: Snapshot) => boolean,
): Promise<Snapshot> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const snapshot = await pane.snapshot();
    if (test(snapshot)) {
      return snapshot;
    }
    if (Date.now() > deadline) {
      throw new Error(`no snapshot matched; the last: ${JSON.stringify(snapshot)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const showsPrompt = (snapshot: Snapshot) => snapshot.lines[2] === ">";

// A pane that asks for bracketed paste and shows each read of its input on a
// line of its own, under "ready", as the hex of its bytes.
const rawEcho = [
  process.execPath,
  "-e",
  [
    'process.stdout.write("\\u001b[?2004h" + "ready\\r\\n");',
    "process.stdin.setRawMode(true);",
    'process.stdin.on("data", (data) => process.stdout.write(data.toString("hex") + "\\r\\n"));',
  ].join(" "),
];

const hex = (text: string) => Buffer.from(text).toString("hex");

const unusable = (reason: PaneUnusable["reason"]) => (error: unknown) =>
  error instanceof PaneUnusable && error.reason === reason;

// childOf finds a child of a process from /proc, failing if it has none.
function childOf(parent: number): number {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === parent) {
        return Number(entry);
      }
    } catch {
      // Gone since it was listed.
    }
  }
  throw new Error(`process ${parent} has no child`);
}

describe("TmuxPane", () => {
  it("reads the screen, the cursor and the pane's state", async () => {
    server = await TmuxServer.start(scriptedHarness);
    const pane = new TmuxPane(server.socket);
    const before = Date.now();
    const snapshot = await snapshotWhere(pane, showsPrompt);
    expect(snapshot).toEqual({
      lines: ["scripted harness", "", ">", "", "", "", "", "", "", "", "", ""],
      faint: [],
      width: 80,
      cursor: { x: 2, y: 2, visible: true },
      hostHasTerminal: true,
      onePane: true,
      keysBlocked: false,
      lastTyped: undefined,
      at: expect.any(Number),
    });
    expect(snapshot.at).toBeGreaterThanOrEqual(before);
  });

  it("reads faint text apart, its row's text as plain", async () => {
    server = await TmuxServer.start([...scriptedHarness, "--suggestion"]);
    const pane = new TmuxPane(server.socket);
    const snapshot = await snapshotWhere(pane, (read) => read.lines[2] !== "");
    expect(snapshot.lines[2]).toBe("> run the tests again");
    expect(snapshot.faint).toEqual([{ row: 2, from: 2, to: 21 }]);
    expect(snapshot.cursor).toMatchObject({ x: 2, y: 2 });
  });

  it("reads a hidden cursor", async () => {
    server = await TmuxServer.start(scriptedHarness);
    const pane = new TmuxPane(server.socket);
    await snapshotWhere(pane, showsPrompt);
    await server.keys("d");
    const snapshot = await snapshotWhere(pane, (s) => s.lines[2] === "Allow this action?");
    expect(snapshot.cursor.visible).toBe(false);
  });

  it("reads a second pane", async () => {
    server = await TmuxServer.start(scriptedHarness);
    const pane = new TmuxPane(server.socket);
    await snapshotWhere(pane, showsPrompt);
    await server.tmux("split-window", "-d", "--", ...scriptedHarness);
    expect((await pane.snapshot()).onePane).toBe(false);
  });

  it("reads keys as blocked in copy mode and while the pane's input is off", async () => {
    server = await TmuxServer.start(scriptedHarness);
    const pane = new TmuxPane(server.socket);
    await snapshotWhere(pane, showsPrompt);
    await server.tmux("copy-mode");
    await snapshotWhere(pane, (s) => s.keysBlocked);
    await server.tmux("send-keys", "-X", "cancel");
    await snapshotWhere(pane, (s) => !s.keysBlocked);
    await server.tmux("select-pane", "-d");
    await snapshotWhere(pane, (s) => s.keysBlocked);
  });

  it("reads when an attached client last typed, to the end of tmux's second", async () => {
    server = await TmuxServer.start(scriptedHarness);
    const pane = new TmuxPane(server.socket);
    await snapshotWhere(pane, showsPrompt);
    const type = await server.attach();
    const attached = await pane.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const before = Date.now();
    type("\u001b[D");
    const typed = await snapshotWhere(pane, (s) => s.lastTyped !== attached.lastTyped);
    expect(typed.lastTyped! % 1000).toBe(999);
    expect(typed.lastTyped).toBeGreaterThanOrEqual(before);
    // A paste and a key from the observer are no client's.
    await pane.paste("a");
    await pane.key("Backspace");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await pane.snapshot()).lastTyped).toBe(typed.lastTyped);
  });

  it("pastes a line as one bracketed paste, verbatim, and presses Backspace and Enter", async () => {
    server = await TmuxServer.start(rawEcho);
    const pane = new TmuxPane(server.socket);
    await snapshotWhere(pane, (s) => s.lines[0] === "ready");
    // tmux reads an argument ending in ";" as a command's end, and one
    // starting with "-" as an option.
    await pane.paste("-a #{pane_id}; b;");
    await snapshotWhere(pane, (s) => s.lines[1] !== "");
    await pane.key("Backspace");
    await snapshotWhere(pane, (s) => s.lines[2] !== "");
    await pane.key("Enter");
    const shown = await snapshotWhere(pane, (s) => s.lines[3] !== "");
    expect(shown.lines.slice(1, 4)).toEqual([
      hex("\u001b[200~-a #{pane_id}; b;\u001b[201~"),
      hex("\u007f"),
      hex("\r"),
    ]);
  });

  it("pastes through a buffer of its own, leaving the operator's as they were", async () => {
    server = await TmuxServer.start(rawEcho);
    const pane = new TmuxPane(server.socket);
    await snapshotWhere(pane, (s) => s.lines[0] === "ready");
    await server.tmux("set-buffer", "the operator's copy");
    await server.tmux("set-buffer", "-b", "named", "a named buffer");
    const list = () => server!.tmux("list-buffers", "-F", "#{buffer_name} #{buffer_sample}");
    const [buffers, top] = [await list(), await server.tmux("show-buffer")];
    await pane.paste("text");
    await snapshotWhere(pane, (s) => s.lines[1] !== "");
    expect(await list()).toBe(buffers);
    expect(await server.tmux("show-buffer")).toBe(top);
  });

  it.each([
    ["a line feed", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a tab", "a\tb"],
    ["an escape, which could end the paste", "a\u001b[201~b"],
    ["a C1 control character", "a\u009bb"],
    ["a line separator", "a\u2028b"],
  ])("refuses to paste a line holding %s, sending nothing", async (_, line) => {
    server = await TmuxServer.start(rawEcho);
    const pane = new TmuxPane(server.socket);
    await snapshotWhere(pane, (s) => s.lines[0] === "ready");
    await expect(pane.paste(line)).rejects.toBeInstanceOf(RangeError);
    await pane.key("Enter");
    const shown = await snapshotWhere(pane, (s) => s.lines[1] !== "");
    expect(shown.lines[1]).toBe(hex("\r"));
  });

  it("reads a command the harness started in the foreground as the harness lacking the terminal", async () => {
    // An interactive shell runs its commands in the foreground with job
    // control, as an editor or a pager a harness started would be.
    server = await TmuxServer.start(["/bin/sh", "-i"]);
    const pane = new TmuxPane(server.socket);
    await snapshotWhere(pane, (s) => s.hostHasTerminal);
    await server.keys("sleep 60", "Enter");
    await snapshotWhere(pane, (s) => !s.hostHasTerminal);
  });

  it("reads a dead pane, which remain-on-exit keeps, as the harness lacking the terminal", async () => {
    server = await TmuxServer.start(scriptedHarness);
    await server.tmux("set-option", "-g", "remain-on-exit", "on");
    const pane = new TmuxPane(server.socket, { requireAncestorOf: process.pid });
    const pid = Number(await server.tmux("display-message", "-p", "#{pane_pid}"));
    process.kill(pid);
    await snapshotWhere(new TmuxPane(server.socket), (s) => !s.hostHasTerminal);
    expect((await server.tmux("display-message", "-p", "#{pane_dead}")).trim()).toBe("1");
    // A dead pane's process is no one's ancestor, and reads as no harness
    // rather than another's pane.
    expect((await pane.snapshot()).hostHasTerminal).toBe(false);
  });

  it("refuses a machine with no /proc as unusable", async () => {
    server = await TmuxServer.start(scriptedHarness);
    await snapshotWhere(new TmuxPane(server.socket), showsPrompt);
    const pane = new TmuxPane(server.socket, { proc: path.join(server.directory, "proc") });
    await expect(pane.snapshot()).rejects.toSatisfy(unusable("no-proc"));
  });

  it("refuses a tmux that leaves the formats empty as unusable", async () => {
    server = await TmuxServer.start(scriptedHarness);
    // A stand-in for a tmux that prints an empty field for each format it
    // does not know.
    const oldTmux = path.join(server.directory, "old-tmux");
    writeFileSync(oldTmux, `#!/bin/sh\nprintf '        \\npane\\nscreen\\n'\n`);
    chmodSync(oldTmux, 0o755);
    const pane = new TmuxPane(server.socket, { tmux: oldTmux });
    await expect(pane.snapshot()).rejects.toSatisfy(unusable("old-tmux"));
  });

  it("reads a pane whose first process is an ancestor of the one required", async () => {
    // The pane's shell starts a child and then becomes the scripted harness,
    // so the child's parent is the pane's first process.
    server = await TmuxServer.start([
      "/bin/sh",
      "-c",
      `sleep 60 & exec ${scriptedHarness.map((arg) => `'${arg}'`).join(" ")}`,
    ]);
    await snapshotWhere(new TmuxPane(server.socket), showsPrompt);
    const pid = Number(await server.tmux("display-message", "-p", "#{pane_pid}"));
    const pane = new TmuxPane(server.socket, { requireAncestorOf: childOf(pid) });
    expect((await pane.snapshot()).hostHasTerminal).toBe(true);
  });

  it("refuses a pane whose first process is not an ancestor of the one required", async () => {
    server = await TmuxServer.start(scriptedHarness);
    await snapshotWhere(new TmuxPane(server.socket), showsPrompt);
    const pane = new TmuxPane(server.socket, { requireAncestorOf: process.pid });
    await expect(pane.snapshot()).rejects.toSatisfy(unusable("not-ancestor"));
  });

  it("rejects once the server is gone", async () => {
    server = await TmuxServer.start(scriptedHarness);
    const pane = new TmuxPane(server.socket);
    await snapshotWhere(pane, showsPrompt);
    await server.tmux("kill-server");
    await expect(pane.snapshot()).rejects.toBeInstanceOf(Error);
  });

  it("rejects a socket path too long to connect to", async () => {
    server = await TmuxServer.start(scriptedHarness);
    const pane = new TmuxPane(path.join(server.directory, "s".repeat(120)));
    await expect(pane.snapshot()).rejects.toBeInstanceOf(Error);
  });

  it("rejects when tmux cannot be run", async () => {
    server = await TmuxServer.start(scriptedHarness);
    const pane = new TmuxPane(server.socket, { tmux: path.join(server.directory, "no-tmux") });
    await expect(pane.snapshot()).rejects.toBeInstanceOf(Error);
  });
});
