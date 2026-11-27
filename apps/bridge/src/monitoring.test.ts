import { monitorReport } from "@wayfarerlabs/agention-api";
import { TmuxPane } from "@wayfarerlabs/agention-harness-observer";
import {
  scriptedHarness,
  TmuxServer,
} from "@wayfarerlabs/agention-harness-observer/test/tmux-server.ts";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { DrawnPane, eventually, MonitorHarness } from "./monitoring-test-support.ts";
import { harnessClient, monitoringSettings, reportOf } from "./monitoring.ts";

// What the bridge reports of the session's pane, and how its configuration
// and a pane it cannot use show, against the bridge's real test server and
// real tmux servers.

vi.setConfig({ testTimeout: 20_000 });

describe("the configuration", () => {
  it("takes an option over its variable, and an empty one as unset", () => {
    const environment = {
      AGENTION_TMUX_SOCKET: "/from/variable",
      AGENTION_HARNESS_PROFILE: "codex",
    };
    expect(monitoringSettings({ tmuxSocket: "/from/option" }, environment)).toEqual({
      tmuxSocket: "/from/option",
      harnessProfile: "codex",
    });
    expect(
      monitoringSettings({ tmuxSocket: "", harnessProfile: "generic-lenient" }, environment),
    ).toEqual({
      tmuxSocket: "/from/variable",
      harnessProfile: "generic-lenient",
    });
    expect(
      monitoringSettings({}, { AGENTION_TMUX_SOCKET: "", AGENTION_HARNESS_PROFILE: "" }),
    ).toEqual({
      tmuxSocket: undefined,
      harnessProfile: "auto",
    });
  });

  it("never reads the tmux the bridge happens to run in", () => {
    const environment = {
      TMUX: "/tmp/tmux-1000/default,1,0",
      TMUX_PANE: "%0",
      AGENTION_HARNESS_PROFILE: "codex",
    };
    expect(monitoringSettings({}, environment).tmuxSocket).toBeUndefined();
  });

  it.each([
    [
      { name: "claude-code", version: "2.1.332" },
      { name: "claude-code", version: "2.1.332" },
    ],
    [{ name: 1, version: "2.1.332" }, undefined],
    [{ name: "claude-code" }, undefined],
    [{ name: "x".repeat(101), version: "1.0.0" }, undefined],
    [{ name: "codex-mcp-client", version: "1".repeat(51) }, undefined],
    [undefined, undefined],
  ])("takes the MCP client %j as %j", (info, client) => {
    expect(harnessClient(info)).toEqual(client);
  });
});

describe("a report", () => {
  const since = new Date("2026-11-24T10:00:00.000Z");

  it.each([
    [{ activity: "unknown" }, "unknown"],
    [{ activity: "running" }, "running"],
    [{ activity: "at_rest", screen: "input" }, "at_prompt"],
    [{ activity: "at_rest", screen: "permission_prompt" }, "permission_prompt"],
    [{ activity: "at_rest", screen: "other_prompt" }, "other_prompt"],
    [{ activity: "at_rest", screen: "other" }, "waiting"],
  ] as const)("spells the observation %j as the condition %s", (observed, condition) => {
    expect(reportOf("codex", { ...observed, since })).toEqual({
      monitored: true,
      profile: "codex",
      condition,
      since: "2026-11-24T10:00:00.000Z",
    });
  });

  it("puts a stopped-by reason beside the condition, prompt or not", () => {
    for (const [screen, condition] of [
      ["permission_prompt", "permission_prompt"],
      ["other", "waiting"],
    ] as const) {
      const report = reportOf("codex", {
        activity: "at_rest",
        screen,
        stoppedBy: { reason: "block" },
        since,
      });
      expect(report).toMatchObject({ condition, stopped_by: { reason: "block" } });
      expect(monitorReport.safeParse(report).success).toBe(true);
    }
  });

  it("writes the reset time of a usage limit as the agent API takes it", () => {
    const report = reportOf("claude-code", {
      activity: "at_rest",
      screen: "permission_prompt",
      since,
      stoppedBy: { reason: "usage_limit", resetsAt: new Date("2026-11-24T15:00:00.000Z") },
    });
    expect(report).toEqual({
      monitored: true,
      profile: "claude-code",
      condition: "permission_prompt",
      since: "2026-11-24T10:00:00.000Z",
      stopped_by: { reason: "usage_limit", resets_at: "2026-11-24T15:00:00.000Z" },
    });
    expect(monitorReport.safeParse(report).success).toBe(true);
  });

  it.each([
    ["one the API would not take", new Date("1990-01-01T00:00:00.000Z")],
    ["no time at all", new Date(Number.NaN)],
  ])("leaves out a reset time that is %s", (_, resetsAt) => {
    const report = reportOf("claude-code", {
      activity: "at_rest",
      screen: "input",
      since,
      stoppedBy: { reason: "usage_limit", resetsAt },
    });
    expect(report).toMatchObject({ stopped_by: { reason: "usage_limit" } });
    expect(monitorReport.safeParse(report).success).toBe(true);
    expect(JSON.stringify(report)).not.toContain("resets_at");
  });
});

describe("monitoring", () => {
  let harness: MonitorHarness;

  beforeEach(async () => {
    harness = await new MonitorHarness().start();
  });

  afterEach(async () => {
    await harness.close();
  });

  // The conditions of the reports sent, in order.
  const conditions = () =>
    harness.reports().map((report) => (report.monitored ? report.condition : "unmonitored"));

  // tmuxServer starts a tmux server running the scripted harness, killed
  // when the test finishes.
  async function tmuxServer(): Promise<TmuxServer> {
    const server = await TmuxServer.start(scriptedHarness);
    onTestFinished(() => server.kill());
    return server;
  }

  // A test's tmux pane does not run the bridge, which runs in the test's own
  // process, so these tests read it as any pane, without the check that it
  // is the session's own.
  const anyPane = { pane: (socket: string) => new TmuxPane(socket) };

  it("reports no pane, and logs nothing, without a socket", async () => {
    const bridge = await harness.registered();
    await eventually(() => harness.held(), "the report");
    await delay(1500);
    expect(harness.reports()).toEqual([{ monitored: false }]);
    expect(bridge.logged).toEqual([]);
  });

  it("reports only when what it observes changes, and only fixed fields", async () => {
    const pane = new DrawnPane();
    await harness.registered({ AGENTION_TMUX_SOCKET: "/drawn" }, { pane: () => pane });
    await eventually(() => (harness.reports().length > 0 ? true : undefined), "the report");
    await delay(3000);
    expect(conditions()).toEqual(["at_prompt"]);
    // A screen that changes reads as running until it has been still for a
    // while.
    pane.screen = { ...pane.screen, cursor: { ...pane.screen.cursor, visible: false } };
    await eventually(() => (harness.reports().length > 2 ? true : undefined), "the reports");
    await delay(3000);
    expect(conditions()).toEqual(["at_prompt", "running", "waiting"]);
    for (const report of harness.reports()) {
      expect(Object.keys(report).sort()).toEqual(["condition", "monitored", "profile", "since"]);
    }
  });

  it("chooses the profile of the harness the MCP client names", async () => {
    const pane = new DrawnPane();
    await harness.registered(
      { AGENTION_TMUX_SOCKET: "/drawn" },
      { pane: () => pane, client: { name: "claude-code", version: "2.1.332" } },
    );
    await eventually(() => harness.held(), "the report");
    expect(harness.held()?.profile).toBe("claude-code");
  });

  it("takes the profile the configuration names, the option over the variable", async () => {
    const pane = new DrawnPane();
    await harness.registered(
      { AGENTION_TMUX_SOCKET: "/drawn", AGENTION_HARNESS_PROFILE: "codex" },
      {
        pane: () => pane,
        client: { name: "claude-code", version: "2.1.332" },
        options: { harnessProfile: "generic-lenient" },
      },
    );
    await eventually(() => harness.held(), "the report");
    expect(harness.held()?.profile).toBe("generic-lenient");
  });

  it("logs a profile name it does not know, once, and reads with the strict one", async () => {
    const pane = new DrawnPane();
    const bridge = await harness.registered(
      { AGENTION_TMUX_SOCKET: "/drawn", AGENTION_HARNESS_PROFILE: "claude" },
      { pane: () => pane, client: { name: "claude-code", version: "2.1.332" } },
    );
    await eventually(() => harness.held(), "the report");
    expect(harness.held()?.profile).toBe("generic-strict");
    expect(bridge.logged).toHaveLength(1);
  });

  it.each([
    ["a socket nothing listens on", (home: string) => path.join(home, "no-server")],
    ["a socket path too long for a socket", (home: string) => path.join(home, "x".repeat(200))],
  ])("reports unknown, and logs it once, at %s", async (_, socket) => {
    const bridge = await harness.registered({ AGENTION_TMUX_SOCKET: socket(harness.home) });
    await eventually(() => harness.held(), "the report");
    await delay(2500);
    expect(conditions()).toEqual(["unknown"]);
    expect(bridge.logged).toHaveLength(1);
    // The tools work as without monitoring.
    expect((await bridge.call("thread_list")).isError).toBe(false);
  });

  it("reports unknown, and logs it once, without tmux", async () => {
    const bridge = await harness.registered(
      { AGENTION_TMUX_SOCKET: path.join(harness.home, "socket") },
      { pane: (socket) => new TmuxPane(socket, { tmux: path.join(harness.home, "no-tmux") }) },
    );
    await eventually(() => harness.held(), "the report");
    await delay(2500);
    expect(conditions()).toEqual(["unknown"]);
    expect(bridge.logged).toHaveLength(1);
  });

  it("reports unknown, and logs it once, for a tmux server of more than one pane", async () => {
    const server = await tmuxServer();
    await server.tmux("split-window", "-d");
    const bridge = await harness.registered({ AGENTION_TMUX_SOCKET: server.socket }, anyPane);
    await eventually(() => harness.held(), "the report");
    await delay(2500);
    expect(conditions()).toEqual(["unknown"]);
    expect(bridge.logged).toHaveLength(1);
  });

  it("reports a real pane's condition as it changes, from approval on", async () => {
    const server = await tmuxServer();
    const bridge = await harness.monitored({ AGENTION_TMUX_SOCKET: server.socket }, anyPane);
    await bridge.ok("register");
    // Approved while the agent waits at its prompt: no tool call follows.
    await harness.approve(harness.keyOnDisk());
    await eventually(
      () => (harness.held()?.condition === "at_prompt" ? true : undefined),
      "at_prompt",
    );
    await server.keys("r");
    await eventually(() => (harness.held()?.condition === "running" ? true : undefined), "running");
    await server.keys("p");
    await eventually(
      () => (harness.held()?.condition === "at_prompt" ? true : undefined),
      "at_prompt again",
    );
    expect(harness.held()).toMatchObject({ monitored: 1, profile: "generic-strict" });
    // Nothing of the screen reaches the server or the log.
    expect(JSON.stringify(harness.seen.map((seen) => seen.body))).not.toContain("scripted");
    expect(bridge.logged).toEqual([]);
  });

  it("reports unknown, and logs it once, for a pane that does not run the bridge", async () => {
    const server = await tmuxServer();
    const bridge = await harness.registered({ AGENTION_TMUX_SOCKET: server.socket });
    await eventually(() => harness.held(), "the report");
    await delay(2500);
    expect(conditions()).toEqual(["unknown"]);
    expect(bridge.logged).toHaveLength(1);
    // Nothing of the screen reaches the log.
    expect(bridge.logged[0]).not.toContain("scripted");
  });
});
