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
      width: 80,
      cursor: { x: 2, y: 2, visible: true },
      hostHasTerminal: true,
      onePane: true,
      at: expect.any(Number),
    });
    expect(snapshot.at).toBeGreaterThanOrEqual(before);
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
    writeFileSync(oldTmux, `#!/bin/sh\nprintf '      \\npane\\nscreen\\n'\n`);
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
