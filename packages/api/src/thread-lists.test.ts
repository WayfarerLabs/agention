import { describe, expect, it } from "vitest";
import { invalidInputBody } from "./errors.ts";
import {
  composePresence,
  composeRollup,
  sessionThreadsQuery,
  statusKept,
  threadFilters,
  threadsQuery,
  waitQuery,
} from "./thread-lists.ts";

function fieldOf(result: { error?: Parameters<typeof invalidInputBody>[0] | undefined }) {
  return result.error === undefined ? undefined : invalidInputBody(result.error).error.field;
}

describe("list queries", () => {
  it("read numbers and booleans from query text, every filter off by default", () => {
    expect(sessionThreadsQuery.parse({ limit: "100" })).toEqual({
      include_archived: false,
      unread: false,
      limit: 100,
    });
    expect(sessionThreadsQuery.parse({ status: "withdrawn" }).status).toBe("withdrawn");
    expect(waitQuery.parse({})).toEqual({ wait: 0, limit: 50 });
    expect(
      threadsQuery.parse({
        include_archived: "true",
        search: "release notes",
        unread: "true",
        effort: "under_15m",
        impact: "assuming",
        priority: "high",
        agent: "builder",
        session: ["builder/main", "reviewer/main"],
        topic: "reviewer/main/auth",
        status: "open",
        agent_read: "stranded",
        reverse: "true",
        group: "agent",
      }),
    ).toEqual({
      include_archived: true,
      search: "release notes",
      status: "open",
      overdue: false,
      effort: "under_15m",
      impact: "assuming",
      priority: ["high"],
      unread: true,
      agent_read: "stranded",
      agent: ["builder"],
      session: ["builder/main", "reviewer/main"],
      topic: ["reviewer/main/auth"],
      sort: "priority",
      reverse: true,
      group: "agent",
      limit: 50,
    });
  });

  it.each([
    [sessionThreadsQuery, { limit: "101" }, "limit"],
    [sessionThreadsQuery, { cursor: "c".repeat(1_025) }, "cursor"],
    [waitQuery, { since: "s".repeat(1_025) }, "since"],
    [waitQuery, { wait: "26" }, "wait"],
    [threadsQuery, { session: "main" }, "session.0"],
    [threadsQuery, { session: "builder/main/side" }, "session.0"],
    [threadsQuery, { agent: "Builder" }, "agent.0"],
    [threadsQuery, { agent: ["builder", "builder"] }, "agent"],
    [threadsQuery, { session: [] }, "session"],
    [threadsQuery, { agent: Array.from({ length: 51 }, (_, i) => `agent-${i}`) }, "agent"],
    [threadsQuery, { topic: "auth" }, "topic.0"],
    [threadsQuery, { topic: "builder/auth" }, "topic.0"],
    [threadsQuery, { topic: "builder/main/Auth" }, "topic.0"],
    [threadsQuery, { topic: "builder/main/a/b" }, "topic.0"],
    [threadsQuery, { topic: [] }, "topic"],
    [threadFilters, { topic: ["builder/main/auth", "builder/main/auth"] }, "topic"],
    [threadsQuery, { group: "tag" }, "group"],
    [threadsQuery, { group: ["session", "agent"] }, "group"],
    [threadsQuery, { overdue: "yes" }, "overdue"],
    [threadsQuery, { status: "closed" }, "status"],
    [threadsQuery, { status: ["open", "none"] }, "status"],
    [threadsQuery, { agent_read: "true" }, "agent_read"],
    [threadsQuery, { agent_read: ["unread", "stranded"] }, "agent_read"],
    [sessionThreadsQuery, { status: "Open" }, "status"],
    [threadsQuery, { priority: "lowest" }, "priority.0"],
    [threadsQuery, { priority: ["high", "high"] }, "priority"],
    [threadsQuery, { priority: [] }, "priority"],
    [threadsQuery, { impact: "none" }, "impact"],
    [threadsQuery, { effort: "longer" }, "effort"],
    [threadsQuery, { sort: "oldest" }, "sort"],
    [threadsQuery, { sort: ["latest", "due"] }, "sort"],
    [threadsQuery, { reverse: "yes" }, "reverse"],
    [threadsQuery, { reverse: ["true", "true"] }, "reverse"],
    [sessionThreadsQuery, { search: "release\nnotes" }, "search"],
    [sessionThreadsQuery, { search: " " }, "search"],
  ] as const)("refuses %j", (schema, query, field) => {
    expect(fieldOf(schema.safeParse(query))).toBe(field);
  });

  it("take a cursor of up to 1,024 characters", () => {
    expect(threadsQuery.safeParse({ cursor: "c".repeat(1_024) }).success).toBe(true);
    expect(waitQuery.safeParse({ since: "s".repeat(1_024) }).success).toBe(true);
  });

  it("take up to 50 agents, 50 sessions and 50 topics", () => {
    const agents = Array.from({ length: 50 }, (_, i) => `agent-${i}`);
    const sessions = agents.map((agent) => `${agent}/main`);
    const topics = sessions.map((session) => `${session}/auth`);
    expect(
      threadsQuery.safeParse({ agent: agents, session: sessions, topic: topics }).success,
    ).toBe(true);
    expect(fieldOf(threadsQuery.safeParse({ topic: [...topics, "agent-50/main/auth"] }))).toBe(
      "topic",
    );
  });

  it("take any set of priorities, low included, one alone as a set of one", () => {
    expect(threadsQuery.parse({ priority: "low" }).priority).toEqual(["low"]);
    expect(threadFilters.parse({ priority: ["urgent", "low"] }).priority).toEqual([
      "urgent",
      "low",
    ]);
    expect(threadsQuery.safeParse({ priority: ["urgent", "high", "normal", "low"] }).success).toBe(
      true,
    );
  });

  it("take topics of several sessions, with or without a session filter", () => {
    const topic = ["builder/main/auth", "reviewer/side/billing-api"];
    expect(threadsQuery.parse({ topic }).topic).toEqual(topic);
    expect(threadFilters.parse({ topic, agent: "builder" }).topic).toEqual(topic);
    expect(threadFilters.parse({ topic, session: ["builder/main", "builder/side"] }).topic).toEqual(
      topic,
    );
  });
});

describe("statusKept", () => {
  it("is the status a query names, or open while a property of open asks narrows it", () => {
    const off = threadFilters.parse({});
    expect(statusKept(off)).toBeUndefined();
    expect(statusKept({ ...off, status: "none" })).toBe("none");
    expect(statusKept({ ...off, effort: "quick" })).toBe("open");
    expect(statusKept({ ...off, overdue: true })).toBe("open");
  });
});

describe("composePresence", () => {
  it("is quiet only when every part is, and was last seen when the latest part was", () => {
    const early = { last_seen_at: "2026-11-05T09:00:00.000Z", quiet: true };
    const late = { last_seen_at: "2026-11-05T14:02:00.000Z", quiet: false };
    expect(composePresence([early, late, { quiet: true }])).toEqual(late);
    expect(composePresence([early, { quiet: true }])).toEqual(early);
    expect(composePresence([{ quiet: true }, { quiet: true }])).toEqual({ quiet: true });
  });
});

describe("composeRollup", () => {
  it("sums the counts, and holds blocked if any is, the highest priority and archived if all are", () => {
    const quiet = { threads: 2, unread: 0, blocked: false, archived: true };
    expect(
      composeRollup([
        quiet,
        { threads: 3, unread: 2, blocked: true, priority: "high", archived: false },
        { ...quiet, priority: "urgent" },
        { ...quiet, priority: "low" },
      ]),
    ).toEqual({ threads: 9, unread: 2, blocked: true, priority: "urgent", archived: false });
    expect(composeRollup([quiet, quiet])).toEqual({ ...quiet, threads: 4 });
  });
});
