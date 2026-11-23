import { agentApi, agentApiHeader } from "@wayfarerlabs/agention-api";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { nearestClaude } from "./claude-ancestor.ts";
import {
  childUnder,
  claudeLauncher,
  eventually,
  host,
  integersOf,
  lapsed,
  PushHarness,
  threadWith,
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

// processUnderClaude starts a bridge as Claude Code does, a process under a
// process named claude, and returns it with the launcher's pid.
async function processUnderClaude() {
  const claude = launcher();
  const pidFile = path.join(harness.home, "launcher.pid");
  const started = await harness.process({
    client: claudeCodeClient,
    launcher: { command: claude.command, args: claude.args(pidFile) },
  });
  return { ...started, launcher: Number(readFileSync(pidFile, "utf8")) };
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

  it("removes the directories of host processes that have ended", async () => {
    const ended = spawnSync(process.execPath, ["-e", ""]).pid ?? 0;
    harness.markHost();
    const gone = harness.markHost(ended);
    const bridge = await harness.claudeBridge();
    await bridge.ok("register");
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(harness.hostDirectory())).toBe(true);
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
    // This test's process is marked, but the launcher named claude between
    // it and the bridge is the bridge's Claude Code, and has no mark.
    harness.markHost(host);
    const { bridge } = await processUnderClaude();
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
});

describe("reading the registration", () => {
  it("stops at a pending registration's expiry, so it never registers the key again", async () => {
    harness.markHost();
    const bridge = await harness.claudeBridge();
    await bridge.ok("register");
    const expired = harness.keyOnDisk();
    const reads = harness.counting("/registrations");
    await eventually(() => (reads() >= 2 ? true : undefined), "push reading the registration");
    harness.server.fixture.advance(hour + 1);
    await delay(300);
    const before = reads();
    // Another session registering prunes the expired registration, which a
    // read of the same key would then register afresh.
    const other = await harness.bridge({ AGENTWORKS_SESSION: "other" });
    await other.ok("register");
    await delay(500);
    expect(reads()).toBe(before + 1);
    expect(harness.registrations().map((row) => row.public_key)).not.toContain(expired);
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
