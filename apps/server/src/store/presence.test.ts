import {
  agentApi,
  monitoringAgentApiVersion,
  threadFilters,
  threadsQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markRead } from "./marks.ts";
import { connectedFor, seenStep } from "./presence.ts";
import { revokeRegistration } from "./registrations.ts";
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

// What the session's row holds of its presence.
const stamps = () =>
  fixture.db
    .prepare("SELECT last_seen_at, last_seen_version, background_at FROM sessions WHERE id = ?")
    .get(agent.sessionId) as {
    last_seen_at: number | null;
    last_seen_version: number | null;
    background_at: number | null;
  };
const lastSeen = () => stamps().last_seen_at;

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

  it("is stamped on the first call after a message someone else wrote, however soon, never for the agent's own", () => {
    fixture.seen(agent);
    const first = fixture.now;
    fixture.advance(1_000);
    fixture.createThread(agent);
    fixture.advance(1_000);
    fixture.seen(agent);
    expect(lastSeen()).toBe(first);
    fixture.advance(1_000);
    fixture.startThread(agent);
    fixture.advance(1_000);
    fixture.seen(agent);
    expect(lastSeen()).toBe(fixture.now);
    // Checked in since that message, the next call within the minute is not.
    fixture.advance(1_000);
    fixture.seen(agent);
    expect(lastSeen()).toBe(fixture.now - 1_000);
  });

  it("moves back with a clock stepped back, so it never holds still", () => {
    fixture.seen(agent);
    fixture.advance(-5 * seenStep);
    fixture.seen(agent);
    expect(lastSeen()).toBe(fixture.now);
  });

  it("keeps the version of the agent API the check-in came through, at once when it changes", () => {
    fixture.seen(agent);
    expect(stamps()).toMatchObject({ last_seen_version: agentApi.version });
    fixture.advance(1_000);
    fixture.seen(agent, 4);
    expect(stamps()).toMatchObject({ last_seen_at: fixture.now, last_seen_version: 4 });
    fixture.advance(1_000);
    fixture.seen(agent, 4);
    expect(stamps()).toMatchObject({ last_seen_at: fixture.now - 1_000, last_seen_version: 4 });
  });

  it("is stamped only while the registration is approved", () => {
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    fixture.seen(agent);
    fixture.connect(agent);
    expect(stamps()).toEqual({ last_seen_at: null, last_seen_version: null, background_at: null });
  });

  it("never moves for the bridge's background requests, which are stamped on each one", () => {
    fixture.connect(agent);
    expect(stamps()).toEqual({
      last_seen_at: null,
      last_seen_version: null,
      background_at: fixture.now,
    });
    fixture.advance(1_000);
    fixture.connect(agent);
    expect(stamps().background_at).toBe(fixture.now);
    fixture.advance(-5 * seenStep);
    fixture.connect(agent);
    expect(stamps().background_at).toBe(fixture.now);
  });
});

describe("connected", () => {
  beforeEach(() => {
    fixture.createThread(agent);
  });

  it("holds for a minute after the bridge's latest background request", () => {
    expect(thread().presence?.connected).toBe(false);
    fixture.connect(agent);
    expect(thread().presence).toEqual({ quiet: true, connected: true });
    fixture.advance(connectedFor);
    expect(thread().presence?.connected).toBe(true);
    fixture.advance(1);
    expect(thread().presence?.connected).toBe(false);
  });

  it("is never stated while the agent last checked in through a bridge older than monitoring", () => {
    fixture.seen(agent, monitoringAgentApiVersion - 1);
    expect(thread().presence).toEqual({
      last_seen_at: new Date(fixture.now).toISOString(),
      quiet: false,
    });
    // A newer bridge's background request beside it still shows.
    fixture.connect(agent);
    expect(thread().presence?.connected).toBe(true);
    fixture.advance(connectedFor + 1);
    expect(thread().presence).not.toHaveProperty("connected");
  });

  it("is never stated for a check-in from before versions were kept", () => {
    fixture.seen(agent);
    fixture.db
      .prepare("UPDATE sessions SET last_seen_version = NULL WHERE id = ?")
      .run(agent.sessionId);
    expect(thread().presence).not.toHaveProperty("connected");
  });

  it("follows a session pinned back below monitoring after it ran it, and forward again", () => {
    fixture.seen(agent);
    fixture.connect(agent);
    fixture.advance(connectedFor + 1);
    expect(thread().presence?.connected).toBe(false);
    fixture.seen(agent, monitoringAgentApiVersion - 1);
    expect(thread().presence).not.toHaveProperty("connected");
    fixture.seen(agent, monitoringAgentApiVersion);
    expect(thread().presence?.connected).toBe(false);
  });
});

describe("quiet", () => {
  it("holds for a session never seen, and once it goes unseen past the threshold", () => {
    fixture.createThread(agent);
    expect(thread().presence).toEqual({ quiet: true, connected: false });
    fixture.seen(agent);
    const seenAt = new Date(fixture.now).toISOString();
    expect(thread().presence).toMatchObject({ last_seen_at: seenAt, quiet: false });
    // Quiet allows the minute a stamp may lag behind the latest call.
    fixture.advance(defaultQuietAfter + seenStep);
    expect(thread().presence?.quiet).toBe(false);
    fixture.advance(1);
    expect(thread().presence).toMatchObject({ last_seen_at: seenAt, quiet: true });
    // A connected bridge leaves its agent quiet.
    fixture.connect(agent);
    expect(thread().presence).toEqual({ last_seen_at: seenAt, quiet: true, connected: true });
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
    expect(own).not.toHaveProperty("ignored");
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
      connected: false,
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
    fixture.connect(agent);
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
    // Its bridge is still connected; its agent has not checked in.
    fixture.connect(agent);
    expect([1, 2, 3].map((number) => thread(number).stranded)).toEqual([true, false, false]);
    expect(stranded()).toEqual(["written to"]);
    // The agent coming back ends it, before it reads a thing.
    fixture.seen(agent);
    expect(thread(1).stranded).toBe(false);
  });

  it("holds such a message once the session's bridge is no longer connected", () => {
    fixture.advance(connectedFor + 1);
    fixture.seen(agent);
    expect(thread(1)).toMatchObject({
      stranded: true,
      presence: { quiet: false, connected: false },
    });
    expect(stranded()).toEqual(["written to"]);
    fixture.connect(agent);
    expect(thread(1).stranded).toBe(false);
  });

  it("holds no such message for want of a connection a bridge older than monitoring cannot report", () => {
    fixture.advance(connectedFor + 1);
    fixture.seen(agent, monitoringAgentApiVersion - 1);
    expect(thread(1).stranded).toBe(false);
    expect(stranded()).toEqual([]);
    fixture.advance(defaultQuietAfter + seenStep + 1);
    expect(stranded()).toEqual(["written to"]);
  });

  it("holds such a message while the session has stopped, until it resumes", () => {
    fixture.report(agent, { state: "stopped", outcome: "completed" });
    expect([1, 2, 3].map((number) => thread(number).stranded)).toEqual([true, false, false]);
    expect(stranded()).toEqual(["written to"]);
    const counts = countThreads(fixture.store, fixture.operator, threadFilters.parse({}));
    expect(counts.agent_read).toEqual({ any: 3, unread: 1, stranded: 1, ignored: 0 });
    fixture.report(agent, { state: "working" });
    expect(stranded()).toEqual([]);
  });

  it("holds such a message while the session has no active credential, seen or not", () => {
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    expect(thread(1)).toMatchObject({ stranded: true, presence: { quiet: false } });
    expect(stranded()).toEqual(["written to"]);
    const counts = countThreads(fixture.store, fixture.operator, threadFilters.parse({}));
    expect(counts.agent_read).toEqual({ any: 3, unread: 1, stranded: 1, ignored: 0 });
  });
});
