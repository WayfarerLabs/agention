import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notReady } from "@wayfarerlabs/agention-harness-observer";
import type { Monitor } from "./monitoring.ts";
import { DrawnPane, eventually, MonitorHarness, timing } from "./monitoring-test-support.ts";
import { Reporter } from "./reporter.ts";
import { Session } from "./session.ts";
import { agent, serverJson, session, type TestBridge } from "./test-harness.ts";

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

  it("starts at its first tool call in a bridge started before its key was on disk", async () => {
    const early = await harness.monitored();
    await delay(300);
    expect(harness.seen).toHaveLength(0);
    // Another bridge of the session makes the key and has it approved.
    await harness.registered();
    const claims = harness.claims().length;
    await early.ok("thread_list");
    await eventually(
      () => (harness.claims().length > claims ? true : undefined),
      "the early bridge's claim",
    );
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

  it("sends a failed report again after a pause, without waiting for a poll's answer", async () => {
    const pane = new DrawnPane();
    let failing = false;
    harness.answer = (seen) =>
      failing && seen.method === "POST" && seen.path.endsWith("/monitor")
        ? new Response("Bad gateway", { status: 502 })
        : undefined;
    await harness.registered({ AGENTION_TMUX_SOCKET: "/drawn" }, { pane: () => pane });
    await eventually(
      () => (harness.held()?.condition === "at_prompt" ? true : undefined),
      "at_prompt",
    );
    failing = true;
    const before = harness.seen.length;
    pane.screen = { ...pane.screen, cursor: { ...pane.screen.cursor, visible: false } };
    // monitor is a bridge's monitoring request since the screen changed,
    // as GET or POST.
    const monitor = () =>
      harness.seen
        .slice(before)
        .filter((seen) => seen.path.endsWith("/monitor"))
        .map((seen) => seen.method);
    // Two reports in a row, with no poll between them, are a retry that no
    // poll's answer started.
    await eventually(
      () =>
        monitor().some((method, i) => method === "POST" && monitor()[i + 1] === "POST") ||
        undefined,
      "a report sent again before the next poll",
    );
    failing = false;
    await eventually(() => (harness.held()?.condition === "waiting" ? true : undefined), "waiting");
  });

  it("drops a report the server refuses, logging the refusal's code once", async () => {
    const pane = new DrawnPane();
    let refusing = false;
    harness.answer = (seen) =>
      refusing && seen.method === "POST" && seen.path.endsWith("/monitor")
        ? serverJson({ error: { code: "invalid_input", message: "a refusal's words" } }, 400)
        : undefined;
    const bridge = await harness.registered(
      { AGENTION_TMUX_SOCKET: "/drawn" },
      { pane: () => pane },
    );
    await eventually(
      () => (harness.held()?.condition === "at_prompt" ? true : undefined),
      "at_prompt",
    );
    refusing = true;
    const before = harness.seen.length;
    // The screen changes, which reports running and then waiting, each of
    // which the server refuses.
    pane.screen = { ...pane.screen, cursor: { ...pane.screen.cursor, visible: false } };
    const sent = () =>
      harness.seen
        .slice(before)
        .filter((seen) => seen.method === "POST" && seen.path.endsWith("/monitor"));
    await eventually(
      () =>
        sent().some((seen) => (seen.body as { condition?: string }).condition === "waiting") ||
        undefined,
      "the refused reports",
    );
    // Polls are answered meanwhile, which would wake a retry.
    await delay(1500);
    const numbers = sent().map((seen) => seen.query.get("seq"));
    expect(numbers.length).toBeGreaterThan(1);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(bridge.logged).toHaveLength(1);
    expect(bridge.logged[0]).toContain("invalid_input");
    expect(bridge.logged[0]).not.toContain("a refusal's words");
    expect(harness.held()?.condition).toBe("at_prompt");
    // The next report the server takes is held.
    refusing = false;
    pane.screen = { ...pane.screen, lines: [">", "a turn"] };
    await eventually(() => (harness.held()?.condition === "waiting" ? true : undefined), "waiting");
  });

  it("numbers its reports, counting up", async () => {
    const pane = new DrawnPane();
    await harness.registered({ AGENTION_TMUX_SOCKET: "/drawn" }, { pane: () => pane });
    await eventually(() => harness.held(), "the report");
    pane.screen = { ...pane.screen, cursor: { ...pane.screen.cursor, visible: false } };
    await eventually(() => (harness.held()?.condition === "waiting" ? true : undefined), "waiting");
    const numbers = harness.seen
      .filter((seen) => seen.method === "POST" && seen.path.endsWith("/monitor"))
      .map((seen) => Number(seen.query.get("seq")));
    expect(numbers.length).toBeGreaterThan(1);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it("looks up its session's credential as the bridge's background request", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    await bridge.close();
    await harness.approve(harness.keyOnDisk());
    const { api } = harness.asAgent();
    const environment = { AGENTWORKS_AGENT: agent, AGENTWORKS_SESSION: session };
    // A session that has learnt no names asks the server for them, marked
    // as a background request when it is asked for one.
    const reporting = new Session({ api, home: harness.home, environment });
    await reporting.credential(undefined, true);
    const last = harness.seen.filter((seen) => seen.path.endsWith("/registrations")).at(-1);
    expect(last?.body).toMatchObject({ background: true });
    // The reporter asks for it as one, for every request it makes.
    const credential = vi.spyOn(reporting, "credential");
    const monitor: Monitor = {
      async *reports(signal) {
        yield { monitored: false };
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
      },
      unable: () => undefined,
      onUnableChange: () => undefined,
      canNudge: () => Promise.resolve(false),
      nudge: () => Promise.resolve(notReady),
    };
    const reporter = new Reporter({
      api,
      session: reporting,
      monitor,
      clock: () => harness.server.fixture.now,
      timing,
      log: () => undefined,
    });
    reporter.start();
    try {
      await eventually(() => harness.held(), "the report");
    } finally {
      reporter.close();
    }
    expect(credential).toHaveBeenCalled();
    expect(credential.mock.calls.every(([, background]) => background === true)).toBe(true);
  });

  it("polls at most once a second while the server answers at once", async () => {
    harness.answer = (seen) =>
      seen.method === "GET" && seen.path.endsWith("/monitor")
        ? serverJson({ replaced: false, nudge: false })
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

  it("lets one bridge of a session act, the latest to start or handle a tool call", async () => {
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
    // A second bridge for the session, as Codex starts, takes over as it
    // starts, its key on disk, and the first stands down.
    await harness.monitored();
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

describe("the reporter at bridge start", () => {
  // restart closes a registered bridge and clears its session's presence,
  // so what the bridge started after it does shows on its own.
  const restart = async (bridge: TestBridge): Promise<number> => {
    await bridge.close();
    harness.server.fixture.db
      .prepare("UPDATE sessions SET background_at = NULL, last_seen_at = NULL")
      .run();
    return harness.seen.length;
  };

  it("reports the default session connected with no tool call, its key approved", async () => {
    const pane = new DrawnPane();
    const client = { name: "claude-code", version: "2.1.332" };
    const first = await harness.registered();
    const before = await restart(first);
    await harness.monitored({ AGENTION_TMUX_SOCKET: "/drawn" }, { pane: () => pane, client });
    await eventually(() => harness.held()?.profile ?? undefined, "the report");
    // The profile is the one the MCP client's initialize names.
    expect(harness.held()?.profile).toBe("claude-code");
    expect(harness.presence()).toMatchObject({ background_at: expect.any(Number) });
    // Every request the bridge made is its background one, so none checked
    // the agent in.
    expect(harness.presence()?.last_seen_at).toBeNull();
    const reads = harness.seen.slice(before).filter((seen) => seen.path.endsWith("/registrations"));
    expect(reads.every((seen) => (seen.body as { background?: boolean }).background)).toBe(true);
  });

  it("starts on approval for a pending key, with no tool call", async () => {
    const first = await harness.monitored();
    expect(await first.ok("register")).toMatchObject({ status: "pending" });
    const key = harness.keyOnDisk();
    const before = await restart(first);
    await harness.monitored();
    await eventually(
      () =>
        harness.seen
          .slice(before)
          .find(
            (seen) =>
              seen.path.endsWith("/registrations") &&
              (seen.body as { background?: boolean }).background === true,
          ),
      "the pending read",
    );
    await harness.approve(key);
    await eventually(() => harness.held(), "the report");
    expect(harness.keyOnDisk()).toBe(key);
    expect(harness.registrations()).toHaveLength(1);
  });

  it("does nothing without the session's key until register", async () => {
    const bridge = await harness.monitored();
    await delay(300);
    expect(harness.seen).toHaveLength(0);
    await bridge.ok("register");
    await harness.approve(harness.keyOnDisk());
    await eventually(() => harness.held(), "the report");
  });

  it("does nothing for a key the operator revoked", async () => {
    const first = await harness.registered();
    await harness.revoke(harness.keyOnDisk());
    const before = await restart(first);
    const bridge = await harness.monitored();
    await eventually(
      () => (harness.seen.length > before ? true : undefined),
      "the reporter reading the revocation",
    );
    await delay(300);
    // That one read, and no poll.
    expect(harness.seen).toHaveLength(before + 1);
    expect(bridge.logged).toEqual([]);
  });

  it("stays quiet for a key the server no longer knows, until a tool call submits it", async () => {
    const first = await harness.monitored();
    await first.ok("register");
    const key = harness.keyOnDisk();
    await restart(first);
    // The pending registration expires, and another session registering
    // prunes it.
    harness.server.fixture.advance(hour + 1);
    await (await harness.bridge({ AGENTWORKS_SESSION: "other" })).ok("register");
    expect(harness.registrations().map((row) => row.public_key)).not.toContain(key);
    // This session's requests from here on, not the other's.
    const pruned = harness.seen.length;
    const mine = () =>
      harness.seen
        .slice(pruned)
        .filter((seen) => (seen.body as { session?: string } | undefined)?.session !== "other");
    const bridge = await harness.monitored();
    await eventually(() => (mine().length > 0 ? true : undefined), "the reporter's read");
    await delay(300);
    // That one background read, which registered nothing, and no poll.
    expect(mine()).toMatchObject([
      { path: expect.stringMatching(/\/registrations$/), body: { session, background: true } },
    ]);
    expect(harness.registrations().map((row) => row.public_key)).not.toContain(key);
    expect(bridge.logged).toEqual([]);
    // A tool call submits the key as the agent's request, which registers it
    // afresh, as it always has.
    expect((await bridge.error("thread_list")).code).toBe("unauthenticated");
    expect(harness.registrations().map((row) => row.public_key)).toContain(key);
  });

  it("does nothing unless both variables name the session, until register", async () => {
    const first = await harness.registered();
    const before = await restart(first);
    // The agent alone names no session.
    const bridge = await harness.monitored({ AGENTWORKS_SESSION: "" });
    await delay(300);
    expect(harness.seen).toHaveLength(before);
    await bridge.ok("register", { agent, session });
    await eventually(() => harness.presence()?.background_at ?? undefined, "connected");
  });
});
