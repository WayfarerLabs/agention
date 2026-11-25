import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawnPane, eventually, MonitorHarness, timing } from "./monitoring-test-support.ts";
import { serverJson } from "./test-harness.ts";

// The reporter against the bridge's real test server: when it starts, how it
// paces its requests, how it recovers, and which of a session's bridges acts
// for it.

// These tests wait on a background loop, which a busy machine slows down, so
// each has more time than the default.
vi.setConfig({ testTimeout: 20_000 });

let harness: MonitorHarness;

beforeEach(async () => {
  harness = await new MonitorHarness().start();
});

afterEach(async () => {
  await harness.close();
});

const hour = 60 * 60 * 1000;

describe("the reporter", () => {
  it("starts once the operator approves, with no tool call", async () => {
    const bridge = await harness.monitored();
    expect(await bridge.ok("register")).toMatchObject({ status: "pending" });
    await harness.approve(harness.keyOnDisk());
    await eventually(() => harness.held(), "the report");
    expect(harness.held()).toMatchObject({ monitored: 0 });
    expect(harness.claims()).toHaveLength(1);
  });

  it("reads a pending registration as the bridge's background request", async () => {
    const bridge = await harness.monitored();
    await bridge.ok("register");
    await eventually(
      () =>
        harness.seen.filter((seen) => seen.path.endsWith("/registrations")).length > 2 || undefined,
      "the reporter's reads",
    );
    const bodies = harness.seen
      .filter((seen) => seen.path.endsWith("/registrations"))
      .map((seen) => (seen.body as { background?: boolean }).background);
    // register's own request is the agent's; the reporter's are background.
    expect(bodies[0]).toBeUndefined();
    expect(bodies.slice(1).every((background) => background === true)).toBe(true);
  });

  it("starts in a bridge started again at its first tool call, without register", async () => {
    const first = await harness.registered();
    await first.close();
    const polls = harness.polls().length;
    const restarted = await harness.monitored();
    await delay(300);
    expect(harness.polls()).toHaveLength(polls);
    await restarted.ok("thread_list");
    await eventually(() => (harness.claims().length > 1 ? true : undefined), "the claim");
  });

  it("recovers on its own once the server answers again, sending what it could not", async () => {
    const pane = new DrawnPane();
    await harness.registered({ AGENTION_TMUX_SOCKET: "/drawn" }, { pane: () => pane });
    await eventually(
      () => (harness.held()?.condition === "at_prompt" ? true : undefined),
      "at_prompt",
    );
    // The polls and reports fail as they do while a proxy's server is down,
    // and the screen changes meanwhile.
    harness.down = (path) => path.endsWith("/monitor") || path.endsWith("/registrations");
    const failed = harness.polls().length;
    await eventually(() => (harness.polls().length >= failed + 3 ? true : undefined), "failures");
    pane.screen = { ...pane.screen, cursor: { ...pane.screen.cursor, visible: false } };
    await eventually(
      () =>
        harness.reports().at(-1)?.monitored === true &&
        (harness.reports().at(-1) as { condition: string }).condition === "waiting"
          ? true
          : undefined,
      "the failed report",
    );
    expect(harness.held()?.condition).toBe("at_prompt");
    harness.down = undefined;
    await eventually(() => (harness.held()?.condition === "waiting" ? true : undefined), "waiting");
  });

  it("polls at most once a second while the server answers at once", async () => {
    harness.answer = (seen) =>
      seen.method === "GET" && seen.path.endsWith("/monitor")
        ? serverJson({ replaced: false })
        : undefined;
    await harness.registered();
    const before = harness.polls().length;
    const started = performance.now();
    await delay(2500);
    const seconds = (performance.now() - started) / 1000;
    const polls = harness.polls().length - before;
    expect(polls).toBeGreaterThan(0);
    expect(polls).toBeLessThanOrEqual(Math.ceil(seconds) + 1);
  });

  it("stops at a pending registration's expiry, so it never registers the key again", async () => {
    // Reads come 1.5 seconds apart, so the registration expires and is
    // pruned between two of them.
    const bridge = await harness.bridge({}, harness.home, {
      reporterTiming: { ...timing, stateEvery: 1500 },
    });
    // The reads of this session's registration, not the other's below.
    const reads = () =>
      harness.seen.filter(
        (seen) =>
          seen.path.endsWith("/registrations") &&
          (seen.body as { session?: string }).session === "main",
      ).length;
    await bridge.ok("register");
    const expired = harness.keyOnDisk();
    await eventually(() => (reads() >= 2 ? true : undefined), "the reporter reading");
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

  it("stops once the approved registration is revoked", async () => {
    await harness.registered();
    await harness.revoke(harness.keyOnDisk());
    await eventually(
      () =>
        harness.seen.some(
          (seen) =>
            seen.path.endsWith("/registrations") &&
            (seen.body as { background?: boolean }).background === true,
        ) || undefined,
      "the reporter reading the revocation",
    );
    await delay(300);
    const before = harness.seen.length;
    await delay(500);
    expect(harness.seen).toHaveLength(before);
  });

  it("lets one bridge of a session act, the latest to handle a tool call", async () => {
    const first = await harness.registered();
    const firstId = harness.claims()[0]?.query.get("bridge");
    const pollsOf = (id: string | null | undefined) =>
      harness.polls().filter((seen) => seen.query.get("bridge") === id);
    // standsDown waits until a bridge has learnt from a poll that another
    // claimed the session, its open poll woken or its next answered at once,
    // and then sees it poll no more.
    const standsDown = async (id: string | null | undefined) => {
      await delay(timing.waitSeconds * 1000 + 500);
      const polls = pollsOf(id).length;
      await delay(1500);
      expect(pollsOf(id)).toHaveLength(polls);
    };
    // A second bridge for the session, as Codex starts, takes over at its
    // first tool call, and the first stands down.
    const second = await harness.monitored();
    await second.ok("thread_list");
    const secondClaim = await eventually(
      () => harness.claims().find((seen) => seen.query.get("bridge") !== firstId),
      "the second bridge's claim",
    );
    const secondId = secondClaim.query.get("bridge");
    await standsDown(firstId);
    expect(pollsOf(secondId).length).toBeGreaterThan(1);
    // The first takes over again at its next tool call, and the second
    // stands down.
    await first.ok("thread_list");
    await eventually(
      () =>
        pollsOf(firstId).find(
          (seen) => seen.query.get("claim") === "true" && seen.at > secondClaim.at,
        ),
      "the first bridge's claim",
    );
    await standsDown(secondId);
  });

  it("puts nothing of monitoring in any tool's answer", async () => {
    const pane = new DrawnPane();
    const bridge = await harness.registered(
      { AGENTION_TMUX_SOCKET: "/drawn" },
      { pane: () => pane },
    );
    await eventually(() => harness.held()?.condition ?? undefined, "a report");
    for (const answer of [
      await bridge.call("register"),
      await bridge.call("thread_list"),
      await bridge.call("session_update", { state: "working", note: "Testing." }),
    ]) {
      expect(answer.isError).toBe(false);
      expect(answer.text).not.toMatch(/monitor|condition|at_prompt|profile/);
    }
  });
});
