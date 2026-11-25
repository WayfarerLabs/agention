import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedHarness, TmuxServer } from "../test/tmux-server.ts";
import type { Snapshot } from "./pane.ts";
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

  it("reads a missing /proc as the harness lacking the terminal", async () => {
    server = await TmuxServer.start(scriptedHarness);
    await snapshotWhere(new TmuxPane(server.socket), showsPrompt);
    const pane = new TmuxPane(server.socket, { proc: path.join(server.directory, "proc") });
    expect((await pane.snapshot()).hostHasTerminal).toBe(false);
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
