import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { claudeHostsDirectory } from "./host-directory.ts";
import { claudeCodeClient } from "./push.ts";
import { BridgeHarness } from "./test-harness.ts";

// Push end to end, as far as a test reaches without Claude Code: the
// plugin's own watcher, started as Claude Code starts the hook, and the
// bridge, against the bridge's test server. The operator writes, and the
// watcher exits 2 with the bridge's notice on stderr, which is what wakes
// Claude Code.

const watcherScript = fileURLToPath(
  new URL("../../agent-plugin/hooks/agention-watcher.sh", import.meta.url),
);

// These tests run real processes that look once a second, which a busy
// machine slows down, so each has more time than the default.
vi.setConfig({ testTimeout: 20_000 });

let harness: BridgeHarness;

beforeEach(async () => {
  harness = await new BridgeHarness().start();
});

afterEach(async () => {
  await harness.close();
});

it("wakes the host through the watcher when the operator writes", async () => {
  // This test's process stands in for Claude Code, the parent of both.
  const host = process.pid;
  const watcher = spawn(watcherScript, [], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: harness.home,
      AGENTION_URL: harness.origin,
      CLAUDE_PID: String(host),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  watcher.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => watcher.on("close", resolve));
  try {
    const mark = path.join(claudeHostsDirectory(harness.home), String(host), "hooked");
    for (let tries = 0; !existsSync(mark); tries++) {
      expect(tries).toBeLessThan(400);
      await delay(25);
    }
    const bridge = await harness.bridge({}, harness.home, {
      client: claudeCodeClient,
      ancestors: () => [host],
      pushTiming: { waitSeconds: 1, stateEvery: 50, retryFirst: 20, retryMost: 100 },
    });
    await bridge.ok("register");
    await harness.approve(harness.keyOnDisk());
    expect(await bridge.ok("register")).toMatchObject({ status: "approved", pushed: true });
    const { number } = await bridge.ok("thread_create", { request_id: "r1", title: "A question" });
    await harness.operatorWrites(number as number, { text: "Go ahead." });
    expect(await exited).toBe(2);
    expect([...stderr.matchAll(/\d+/g)].map((match) => Number(match[0]))).toEqual([number, 1]);
  } finally {
    watcher.kill();
  }
});
