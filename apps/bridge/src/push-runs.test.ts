import { agentApi, agentApiHeader } from "@wayfarerlabs/agention-api";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { nearestClaude, nearestClaudeBy, type ProcessInfo } from "./claude-ancestor.ts";
import { claudeHostsDirectory } from "./host-directory.ts";
import {
  childUnder,
  claudeLauncher,
  eventually,
  host,
  integersOf,
  lapsed,
  PushHarness,
  threadWith,
  timing,
  untilLapsed,
} from "./push-test-support.ts";
import { claudeCodeClient } from "./push.ts";

// Where push runs, how long it reads a registration, and what the agent is
// told when push gives up, against the bridge's real test server.

// These tests wait on a background loop and real processes, which a busy
// machine slows down, so each has more time than the default.
vi.setConfig({ testTimeout: 20_000 });

let harness: PushHarness;

beforeEach(async () => {
  harness = await new PushHarness().start();
});

afterEach(async () => {
  await harness.close();
});

const hour = 60 * 60 * 1000;

// A launcher named claude, removed when the test ends.
function launcher(): ReturnType<typeof claudeLauncher> {
  const made = claudeLauncher();
  onTestFinished(made.remove);
  return made;
}

describe("where push runs", () => {
  it("runs nothing for a client that is not Claude Code, which is never told push", async () => {
    harness.markHost();
    const waits = harness.counting("/wait");
    const { bridge, answer } = await harness.registered("codex-mcp-client");
    expect(answer.pushed).toBe(false);
    await harness.operatorWrites(await threadWith(bridge), { text: "Go ahead." });
    await delay(500);
    expect(waits()).toBe(0);
    expect(harness.filesOf("wake")).toEqual([]);
  });

  it("runs nothing for a host without the watcher's mark", async () => {
    mkdirSync(harness.hostDirectory(), { recursive: true, mode: 0o700 });
    const waits = harness.counting("/wait");
    const { bridge, answer } = await harness.registered();
    expect(answer.pushed).toBe(false);
    await harness.operatorWrites(await threadWith(bridge), { text: "Go ahead." });
    await delay(500);
    expect(waits()).toBe(0);
  });

  it("counts no mark that breaks the private-file rule", async () => {
    const directory = harness.markHost();
    chmodSync(path.join(directory, "hooked"), 0o644);
    const { answer } = await harness.registered();
    expect(answer.pushed).toBe(false);
  });

  it("removes the directories of this machine's host processes that have ended", async () => {
    const ended = spawnSync(process.execPath, ["-e", ""]).pid ?? 0;
    harness.markHost();
    const gone = harness.markHost(ended);
    // Another machine sharing the home keeps its own.
    const elsewhere = path.join(claudeHostsDirectory(harness.home, "elsewhere"), String(ended));
    mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
    const bridge = await harness.claudeBridge();
    await bridge.ok("register");
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(harness.hostDirectory())).toBe(true);
    expect(existsSync(elsewhere)).toBe(true);
  });

  it("runs nothing on a machine whose host name is no path component", async () => {
    harness.markHost();
    const bridge = await harness.bridge({}, harness.home, {
      client: claudeCodeClient,
      host: () => host,
      hostName: "../elsewhere",
    });
    await bridge.ok("register");
    await harness.approve(harness.keyOnDisk());
    expect(await bridge.ok("register")).toMatchObject({ status: "approved", pushed: false });
  });

  it("finds its Claude Code process among its ancestors when run as a process", async () => {
    // The launcher stands in for Claude Code, and marks its own directory
    // as the watcher would; the bridge then exits at once when its input
    // closes, even while push waits.
    const claude = launcher();
    const pidFile = path.join(harness.home, "launcher.pid");
    const started = harness.process({
      client: claudeCodeClient,
      launcher: { command: claude.command, args: claude.args(pidFile) },
    });
    const pid = await eventually(
      () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : undefined),
      "the launcher",
    );
    harness.markHost(pid);
    const { bridge } = await started;
    await bridge.ok("register");
    await harness.approve(harness.keyOnDisk());
    const waits = harness.counting("/wait");
    expect(await bridge.ok("register")).toMatchObject({ status: "approved", pushed: true });
    await eventually(() => (waits() > 0 ? true : undefined), "push's wait");
    const closing = performance.now();
    // The client waits two seconds for the process to exit before signalling it.
    await bridge.client.close();
    expect(performance.now() - closing).toBeLessThan(1_500);
  });

  it("never looks past its nearest Claude Code process", async () => {
    // Two launchers named claude, one started by the other: the outer one
    // is marked, but the inner one, the bridge's parent, is its Claude Code,
    // and has no mark.
    const outer = launcher();
    const inner = launcher();
    const outerFile = path.join(harness.home, "outer.pid");
    const innerFile = path.join(harness.home, "inner.pid");
    const started = harness.process({
      client: claudeCodeClient,
      launcher: {
        command: outer.command,
        args: outer.args(outerFile, [inner.command, ...inner.args(innerFile)]),
      },
    });
    const pid = await eventually(
      () => (existsSync(outerFile) ? Number(readFileSync(outerFile, "utf8")) : undefined),
      "the outer launcher",
    );
    // So is every Claude Code above it, such as one running these tests, so
    // only a walk that stops at the first claude finds no mark.
    for (
      let marked: number | undefined = pid;
      marked !== undefined;
      marked = nearestClaude(marked)
    ) {
      harness.markHost(marked);
    }
    const { bridge } = await started;
    const waits = harness.counting("/wait");
    await bridge.ok("register");
    await harness.approve(harness.keyOnDisk());
    expect(await bridge.ok("register")).toMatchObject({ status: "approved", pushed: false });
    await delay(500);
    expect(waits()).toBe(0);
  });

  it.each(["linux", "darwin"] as const)("finds the nearest claude as %s does", async (platform) => {
    const { launcher: claude, child, stop } = await childUnder(launcher());
    onTestFinished(stop);
    expect(nearestClaude(child, platform)).toBe(claude);
  });

  it("looks at pid 1 too, as in a container whose entry point is Claude Code", () => {
    const processes = new Map<number, ProcessInfo>([
      [40, { parent: 30, command: "node" }],
      [30, { parent: 1, command: "npm" }],
      [1, { parent: undefined, command: "claude" }],
    ]);
    const read = (pid: number) => processes.get(pid) ?? { parent: undefined, command: undefined };
    expect(nearestClaudeBy(40, read)).toBe(1);
  });
});

describe("reading the registration", () => {
  it("stops at a pending registration's expiry, so it never registers the key again", async () => {
    // Reads come 1.5 seconds apart, so the registration expires and is
    // pruned between two of them.
    harness.markHost();
    const bridge = await harness.claudeBridge(undefined, {}, { ...timing, stateEvery: 1500 });
    const reads = harness.counting("/registrations");
    await bridge.ok("register");
    const expired = harness.keyOnDisk();
    await eventually(() => (reads() >= 2 ? true : undefined), "push reading the registration");
    harness.server.fixture.advance(hour + 1);
    // Another session registering prunes the expired registration, which a
    // read of the same key would then register afresh.
    const other = await harness.bridge({ AGENTWORKS_SESSION: "other" });
    await other.ok("register");
    const before = reads();
    await delay(2500);
    expect(reads()).toBe(before);
    expect(harness.registrations().map((row) => row.public_key)).not.toContain(expired);
  });

  it("reads a key registered again once its pending registration expired", async () => {
    harness.markHost();
    const bridge = await harness.claudeBridge();
    const reads = harness.counting("/registrations");
    await bridge.ok("register");
    await eventually(() => (reads() >= 2 ? true : undefined), "push reading the registration");
    harness.server.fixture.advance(hour + 1);
    await delay(300);
    const other = await harness.bridge({ AGENTWORKS_SESSION: "other" });
    await other.ok("register");
    // The same key, registered afresh, then approved.
    expect(await bridge.ok("register")).toMatchObject({ status: "pending" });
    await harness.approve(harness.keyOnDisk());
    expect(await bridge.ok("register")).toMatchObject({ status: "approved", pushed: true });
    await harness.operatorWrites(await threadWith(bridge), { text: "Go ahead." });
    await harness.takeWake();
  });

  it("recovers from a refused wait long after the pending registration it read", async () => {
    // Approved while the agent waits, after push read it pending.
    harness.markHost();
    const bridge = await harness.claudeBridge();
    await harness.approveWhileWaiting(bridge);
    const thread = await threadWith(bridge);
    harness.server.fixture.advance(2 * hour);
    let refused = 0;
    harness.beforeRequest = (request) => {
      if (refused > 0 || !new URL(request.url).pathname.endsWith("/wait")) {
        return undefined;
      }
      refused++;
      return Response.json(
        { error: { code: "unauthenticated", message: "Not now." } },
        { status: 401, headers: { [agentApiHeader]: String(agentApi.version) } },
      );
    };
    await eventually(() => (refused > 0 ? true : undefined), "the refused wait");
    await harness.operatorWrites(thread, { text: "Go ahead." });
    expect(integersOf(await harness.takeWake())).toEqual([thread, 1]);
  });

  it("reads the registration again when register comes during a reading that ends", async () => {
    harness.markHost();
    const bridge = await harness.claudeBridge();
    await bridge.ok("register");
    // The loop's next reading is held while the operator rejects the key
    // and register replaces it, and then answers that the key was rejected.
    let release = (): void => {};
    let held = false;
    harness.beforeRequest = async (request) => {
      if (!held && new URL(request.url).pathname.endsWith("/registrations")) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
    };
    await eventually(() => (held ? true : undefined), "the loop's reading");
    await harness.reject(harness.keyOnDisk());
    expect(await bridge.ok("register")).toMatchObject({ status: "pending", replaced: "rejected" });
    release();
    // Approved, push starts with no further register: a thread tool does not
    // start it.
    await harness.approve(harness.keyOnDisk());
    await harness.operatorWrites(await threadWith(bridge), { text: "Go ahead." });
    await harness.takeWake();
  });

  it("stops once an approved registration is revoked", async () => {
    harness.markHost();
    const { bridge } = await harness.registered();
    await harness.revoke(harness.keyOnDisk());
    await untilLapsed(bridge);
    const reads = harness.counting("/registrations");
    const waits = harness.counting("/wait");
    await delay(500);
    expect([reads(), waits()]).toEqual([0, 0]);
  });
});

describe("a lapse", () => {
  it("is said on a revocation long after the pending registration push read", async () => {
    // Told its answers are pushed, the agent registers a new key once the
    // first is revoked, and the operator approves it while the agent waits,
    // after push read it pending.
    harness.markHost();
    const { bridge } = await harness.registered();
    await harness.revoke(harness.keyOnDisk());
    await untilLapsed(bridge);
    await harness.approveWhileWaiting(bridge);
    harness.server.fixture.advance(2 * hour);
    await harness.revoke(harness.keyOnDisk());
    await untilLapsed(bridge);
  });

  it("is said once on the next answer after push gives up, and register restarts push", async () => {
    harness.markHost();
    const { bridge } = await harness.registered();
    await harness.revoke(harness.keyOnDisk());
    await untilLapsed(bridge);
    expect(lapsed(await bridge.call("thread_list"))).toBe(false);
    // register makes a new key, and push starts again once it is approved.
    expect(await bridge.ok("register")).toMatchObject({ status: "pending", replaced: "revoked" });
    await harness.approve(harness.keyOnDisk());
    expect(await bridge.ok("register")).toMatchObject({ status: "approved", pushed: true });
    await harness.operatorWrites(await threadWith(bridge), { text: "Welcome back." });
    await harness.takeWake();
  });

  it("is said to a bridge started again that resumed push", async () => {
    harness.markHost();
    const { bridge } = await harness.registered();
    await bridge.close();
    const restarted = await harness.claudeBridge();
    expect(lapsed(await restarted.call("thread_list"))).toBe(false);
    await harness.revoke(harness.keyOnDisk());
    await untilLapsed(restarted);
  });

  it("is said when the server stops serving the bridge's version", async () => {
    harness.markHost();
    const { bridge } = await harness.registered();
    harness.beforeRequest = () =>
      Response.json(
        { threads: [], since: "x" },
        { headers: { [agentApiHeader]: String(agentApi.version - 1) } },
      );
    await untilLapsed(bridge);
  });

  it("is said while the host directory cannot be used, and push recovers after", async () => {
    harness.markHost();
    const { bridge } = await harness.registered();
    const thread = await threadWith(bridge);
    await harness.operatorWrites(thread, { text: "One." });
    await harness.takeWake();
    const [cursor] = harness.filesOf("cursor");
    if (cursor === undefined) {
      throw new Error("no cursor saved");
    }
    chmodSync(cursor, 0o644);
    await untilLapsed(bridge);
    chmodSync(cursor, 0o600);
    await harness.operatorWrites(thread, { text: "Two." });
    expect(integersOf(await harness.takeWake())).toEqual([thread, 2]);
    // A lapse push recovers from before any answer says it is not said.
    chmodSync(cursor, 0o644);
    await delay(1500);
    chmodSync(cursor, 0o600);
    await harness.operatorWrites(thread, { text: "Three." });
    await harness.takeWake();
    expect(lapsed(await bridge.call("thread_list"))).toBe(false);
  });

  it("is never said to an agent never told its answers are pushed", async () => {
    // Push runs from the pending register, which tells the agent nothing of
    // push, and ends once the operator rejects the key.
    harness.markHost();
    const bridge = await harness.claudeBridge();
    expect(await bridge.ok("register")).toMatchObject({ status: "pending" });
    const reads = harness.counting("/registrations");
    await harness.reject(harness.keyOnDisk());
    await eventually(() => (reads() >= 1 ? true : undefined), "push reading the rejection");
    await delay(100);
    expect(lapsed(await bridge.call("thread_list"))).toBe(false);
  });
});
