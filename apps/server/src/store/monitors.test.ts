import {
  type MonitorAnswer,
  monitorPollQuery,
  monitorReport,
  sessionsQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { pollMonitor, reportMonitor } from "./monitors.ts";
import { connectedFor } from "./presence.ts";
import { revokeRegistration } from "./registrations.ts";
import { listSessions } from "./sessions.ts";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

const first = "bridge-first-0000";
const second = "bridge-second-000";

function poll(
  bridge: string,
  query: Record<string, string> = {},
  signal?: AbortSignal,
  as: Agent = agent,
): Promise<MonitorAnswer> {
  return pollMonitor(
    fixture.store,
    as.identity,
    as.target,
    monitorPollQuery.parse({ bridge, ...query }),
    signal,
  );
}

function report(bridge: string, body: unknown, as: Agent = agent): MonitorAnswer {
  return reportMonitor(
    fixture.store,
    as.identity,
    as.target,
    { bridge },
    monitorReport.parse(body),
  );
}

// settled reports whether a promise has settled after pending callbacks run.
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

// The session's presence as the operator's sessions view shows it.
const presence = () =>
  listSessions(fixture.store, fixture.operator, sessionsQuery.parse({})).agents[0]?.sessions[0]
    ?.presence;

const since = new Date(Date.UTC(2026, 9, 27, 11, 58)).toISOString();
const running = { monitored: true, profile: "claude-code", condition: "running", since };

describe("the background poll", () => {
  it("answers once its wait ends, the bridge still acting for the session", async () => {
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false });
    const pending = poll(first, { wait: "1" });
    expect(await settled(pending)).toBe(false);
    expect(await pending).toEqual({ replaced: false });
    expect(fixture.store.notifier.waiting(agent.sessionId)).toBe(0);
  });

  it("is not answered by a message on the session's threads, and ends when aborted", async () => {
    fixture.createThread(agent);
    const controller = new AbortController();
    const pending = poll(first, { wait: "20" }, controller.signal);
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "Over to you." });
    expect(await settled(pending)).toBe(false);
    controller.abort();
    expect(await pending).toEqual({ replaced: false });
    expect(fixture.store.notifier.waiting(agent.sessionId)).toBe(0);
  });

  it("ends the open poll of the bridge another claims the session from, at once", async () => {
    const pending = poll(first, { wait: "20" });
    expect(await settled(pending)).toBe(false);
    const taking = poll(second, { claim: "true", wait: "20" });
    expect(await pending).toEqual({ replaced: true });
    expect(await settled(taking)).toBe(false);
    // The replaced bridge's later polls and reports are refused until it
    // claims the session again.
    expect(await poll(first, { wait: "20" })).toEqual({ replaced: true });
    expect(report(first, { monitored: false })).toEqual({ replaced: true });
    const controller = new AbortController();
    const retaking = poll(first, { claim: "true", wait: "20" }, controller.signal);
    expect(await taking).toEqual({ replaced: true });
    expect(report(first, running)).toEqual({ replaced: false });
    controller.abort();
    expect(await retaking).toEqual({ replaced: false });
  });

  it("lets the first bridge to poll act for the session without claiming it", async () => {
    expect(await poll(second, { wait: "0" })).toEqual({ replaced: false });
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: true });
    expect(await poll(second, { claim: "true", wait: "0" })).toEqual({ replaced: false });
  });

  it("keeps each session's bridge apart", async () => {
    const other = fixture.registerAgent("builder", "side");
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false });
    expect(await poll(second, { wait: "0" }, undefined, other)).toEqual({ replaced: false });
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false });
  });

  it("ends as unauthenticated when its credential is revoked", async () => {
    const pending = poll(first, { wait: "20" });
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    await expect(pending).rejects.toSatisfy(
      (error) => error instanceof ApiError && error.code === "unauthenticated",
    );
  });

  it("refuses another session as one that does not exist", async () => {
    const other = fixture.registerAgent("reviewer", "main");
    await expect(
      pollMonitor(
        fixture.store,
        agent.identity,
        other.target,
        monitorPollQuery.parse({ bridge: first, wait: "0" }),
      ),
    ).rejects.toSatisfy((error) => error instanceof ApiError && error.code === "not_found");
    expect(() =>
      reportMonitor(
        fixture.store,
        agent.identity,
        other.target,
        { bridge: first },
        {
          monitored: false,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "not_found" }) as Error);
  });
});

describe("the report", () => {
  it("shows the operator the latest report while the session is connected", () => {
    fixture.connect(agent);
    expect(presence()).toEqual({ quiet: true, connected: true });
    report(first, running);
    expect(presence()?.monitor).toEqual(running);
    const limited = {
      monitored: true,
      profile: "claude-code",
      condition: "at_prompt",
      since,
      stopped_by: { reason: "usage_limit", resets_at: "2026-10-27T15:00:00.000Z" },
    };
    report(first, limited);
    expect(presence()?.monitor).toEqual(limited);
    report(first, { ...limited, stopped_by: { reason: "block" } });
    expect(presence()?.monitor).toEqual({ ...limited, stopped_by: { reason: "block" } });
    report(first, { monitored: false });
    expect(presence()?.monitor).toEqual({ monitored: false });
  });

  it("is never shown once the bridge is no longer connected, and again once it is", () => {
    fixture.connect(agent);
    report(first, running);
    fixture.advance(connectedFor + 1);
    expect(presence()).toEqual({ quiet: true, connected: false });
    fixture.connect(agent);
    expect(presence()?.monitor).toEqual(running);
  });

  it("is never shown for a session following the older bridges' rule", () => {
    report(first, running);
    fixture.seen(agent, 4);
    expect(presence()).not.toHaveProperty("monitor");
  });

  it("keeps nothing from a bridge another has replaced", async () => {
    fixture.connect(agent);
    report(first, running);
    expect(await poll(second, { claim: "true", wait: "0" })).toEqual({ replaced: false });
    expect(report(first, { monitored: false })).toEqual({ replaced: true });
    expect(presence()?.monitor).toEqual(running);
  });
});
