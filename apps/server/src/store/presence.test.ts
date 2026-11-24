import { agentApi } from "@wayfarerlabs/agention-api";
import { sessionsQuery, threadFilters, threadsQuery } from "@wayfarerlabs/agention-server-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markRead } from "./marks.ts";
import { markSeen, seenStep } from "./presence.ts";
import { revokeRegistration } from "./registrations.ts";
import { listSessions } from "./sessions.ts";
import { defaultQuietAfter } from "./store.ts";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";
import { countThreads, listThreads } from "./thread-lists.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

const target = (number = 1) => threadTarget(agent, number);

// The thread as the operator, its audience, sees it.
const thread = (number = 1) => fixture.thread(fixture.operator, target(number)).thread;

const lastSeen = () =>
  (
    fixture.db.prepare("SELECT last_seen_at FROM sessions WHERE id = ?").get(agent.sessionId) as {
      last_seen_at: number | null;
    }
  ).last_seen_at;

describe("last seen", () => {
  it("is stamped only when that moves it a minute or more", () => {
    expect(lastSeen()).toBeNull();
    fixture.seen(agent);
    const first = fixture.now;
    expect(lastSeen()).toBe(first);
    fixture.advance(seenStep - 1);
    fixture.seen(agent);
    expect(lastSeen()).toBe(first);
    fixture.advance(1);
    fixture.seen(agent);
    expect(lastSeen()).toBe(first + seenStep);
  });

  it("moves back with a clock stepped back, so it never holds still", () => {
    fixture.seen(agent);
    fixture.advance(-5 * seenStep);
    fixture.seen(agent);
    expect(lastSeen()).toBe(fixture.now);
  });

  it("is stamped only while the registration is approved", () => {
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    fixture.seen(agent);
    expect(lastSeen()).toBeNull();
  });
});

describe("the agent API version", () => {
  const recorded = () =>
    (
      fixture.db
        .prepare("SELECT agent_api_version FROM sessions WHERE id = ?")
        .get(agent.sessionId) as { agent_api_version: number | null }
    ).agent_api_version;

  // Whether the sessions view marks the session's plugin behind.
  const behind = () =>
    listSessions(fixture.store, fixture.operator, sessionsQuery.parse({})).agents[0]?.sessions[0]
      ?.plugin_behind;

  // How many rows the last statement on the connection wrote.
  const written = () => (fixture.db.prepare("SELECT changes() AS n").get() as { n: number }).n;

  it("records none, and marks nothing, for a session never seen", () => {
    expect([recorded(), behind()]).toEqual([null, false]);
  });

  it.each([
    ["version 1, which a missing header reads as", 1, true],
    ["an older version", agentApi.version - 1, true],
    ["the server's own", agentApi.version, false],
  ])(
    "records %s, marking the session behind while it is below the server's",
    (_, version, marked) => {
      fixture.seen(agent, version);
      expect([recorded(), behind()]).toEqual([version, marked]);
    },
  );

  it("is recorded whenever it changes, within the minute that holds last seen", () => {
    fixture.seen(agent, agentApi.version - 1);
    const first = fixture.now;
    fixture.advance(1);
    fixture.seen(agent, agentApi.version);
    expect([recorded(), lastSeen(), behind()]).toEqual([agentApi.version, first, false]);
    fixture.advance(1);
    fixture.seen(agent, agentApi.version - 1);
    expect([recorded(), lastSeen(), behind()]).toEqual([agentApi.version - 1, first, true]);
  });

  it("writes nothing on a call that changes neither it nor last seen", () => {
    fixture.seen(agent);
    expect(written()).toBe(1);
    fixture.advance(seenStep - 1);
    markSeen(fixture.store, agent.registrationId, agentApi.version);
    expect(written()).toBe(0);
    expect(recorded()).toBe(agentApi.version);
  });

  it("is recorded only while the registration is approved", () => {
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    fixture.seen(agent, 1);
    expect([recorded(), behind()]).toEqual([null, false]);
  });

  it("marks a session behind only while it has not stopped, and again once it reports working", () => {
    fixture.seen(agent, agentApi.version - 1);
    fixture.report(agent, { state: "working" });
    expect(behind()).toBe(true);
    fixture.report(agent, { state: "stopped", outcome: "completed" });
    expect([recorded(), behind()]).toEqual([agentApi.version - 1, false]);
    fixture.report(agent, { state: "working" });
    expect(behind()).toBe(true);
  });

  it("marks a session behind only while it holds an approved credential", () => {
    fixture.seen(agent, agentApi.version - 1);
    expect(behind()).toBe(true);
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    expect([recorded(), behind()]).toEqual([agentApi.version - 1, false]);
  });
});

describe("quiet", () => {
  it("holds for a session never seen, and once it goes unseen past the threshold", () => {
    fixture.createThread(agent);
    expect(thread().presence).toEqual({ quiet: true });
    fixture.seen(agent);
    const seenAt = new Date(fixture.now).toISOString();
    expect(thread().presence).toEqual({ last_seen_at: seenAt, quiet: false });
    // Quiet allows the minute a stamp may lag behind the latest call.
    fixture.advance(defaultQuietAfter + seenStep);
    expect(thread().presence?.quiet).toBe(false);
    fixture.advance(1);
    expect(thread().presence).toEqual({ last_seen_at: seenAt, quiet: true });
  });

  it("follows the server's threshold, and never holds for a session calling within it", () => {
    const short = new Fixture({ quietAfter: seenStep });
    try {
      const own = short.registerAgent("builder", "main");
      short.createThread(own);
      const quiet = () => short.thread(short.operator, threadTarget(own, 1)).thread.presence?.quiet;
      // Calling every 59 seconds stamps every other call, and is never quiet.
      for (let call = 0; call < 10; call++) {
        short.seen(own);
        expect(quiet()).toBe(false);
        short.advance(59_000);
        expect(quiet()).toBe(false);
      }
      short.advance(2 * seenStep);
      expect(quiet()).toBe(true);
    } finally {
      short.close();
    }
  });

  it("is the audience's to see, never the session's own", () => {
    fixture.createThread(agent);
    const own = fixture.thread(agent.identity, target()).thread;
    expect(own).not.toHaveProperty("presence");
    expect(own).not.toHaveProperty("stranded");
  });
});

describe("a session's state", () => {
  it("shows on its threads' presence, never on a group's", () => {
    fixture.createThread(agent);
    fixture.seen(agent);
    fixture.report(agent, { state: "stopped", outcome: "stalled" });
    expect(thread().presence).toMatchObject({ state: "stopped", outcome: "stalled" });
    const grouped = listThreads(
      fixture.store,
      fixture.operator,
      threadsQuery.parse({ group: "agent" }),
    );
    expect(grouped.groups?.sessions[0]?.presence).toEqual({
      last_seen_at: new Date(fixture.now).toISOString(),
      quiet: false,
    });
  });
});

describe("stranded", () => {
  beforeEach(() => {
    fixture.createThread(agent, { title: "written to" });
    fixture.write(fixture.operator, target(1), { text: "Over to you." });
    fixture.createThread(agent, { title: "read" });
    fixture.write(fixture.operator, target(2), { text: "Over to you." });
    markRead(fixture.store, agent.identity, target(2), { through: 2 });
    fixture.createThread(agent, { title: "not written to" });
    fixture.seen(agent);
  });

  const stranded = () =>
    listThreads(
      fixture.store,
      fixture.operator,
      threadsQuery.parse({ agent_read: "stranded" }),
    ).threads.map((each) => each.title);

  it("holds an operator's message the session has not read while it is quiet", () => {
    expect([1, 2, 3].map((number) => thread(number).stranded)).toEqual([false, false, false]);
    expect(stranded()).toEqual([]);
    fixture.advance(defaultQuietAfter + seenStep + 1);
    expect([1, 2, 3].map((number) => thread(number).stranded)).toEqual([true, false, false]);
    expect(stranded()).toEqual(["written to"]);
    // The agent coming back ends it, before it reads a thing.
    fixture.seen(agent);
    expect(thread(1).stranded).toBe(false);
  });

  it("holds such a message while the session has stopped, until it resumes", () => {
    fixture.report(agent, { state: "stopped", outcome: "completed" });
    expect([1, 2, 3].map((number) => thread(number).stranded)).toEqual([true, false, false]);
    expect(stranded()).toEqual(["written to"]);
    const counts = countThreads(fixture.store, fixture.operator, threadFilters.parse({}));
    expect(counts.agent_read).toEqual({ any: 3, unread: 1, stranded: 1 });
    fixture.report(agent, { state: "working" });
    expect(stranded()).toEqual([]);
  });

  it("holds such a message while the session has no active credential, seen or not", () => {
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    expect(thread(1)).toMatchObject({ stranded: true, presence: { quiet: false } });
    expect(stranded()).toEqual(["written to"]);
    const counts = countThreads(fixture.store, fixture.operator, threadFilters.parse({}));
    expect(counts.agent_read).toEqual({ any: 3, unread: 1, stranded: 1 });
  });
});
