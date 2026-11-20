import type {
  ErrorBody,
  SessionState,
  SessionsPage,
  ThreadGetResult,
  ThreadList,
  WaitResult,
  WriteResult,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBrowserSession } from "../auth/browser-sessions.ts";
import { findOperator } from "../store/index.ts";
import { hour } from "../store/test-fixture.ts";
import {
  type AgentKey,
  codeOf,
  Harness,
  newThread,
  origin,
  sessionCookie,
} from "./test-harness.ts";

const day = 24 * hour;

let harness: Harness;
let agent: AgentKey;

beforeEach(async () => {
  harness = new Harness();
  agent = await harness.approvedAgent("builder", "main");
  await harness.agent(agent, "POST", "/s/builder/main/threads", newThread("r-1"));
});

afterEach(() => {
  harness.close();
});

const markRead = (options = {}) =>
  harness.web("POST", "/s/builder/main/threads/1/read", { through: 1 }, options);

describe("the browser session", () => {
  it("reports the signed-in operator and the CSRF token", async () => {
    const response = await harness.web("GET", "/session");
    expect(response.body).toEqual({
      signed_in: true,
      operator: { name: "operator" },
      csrf_token: harness.csrf,
    } satisfies SessionState);
  });

  it("reports a browser without a live session as signed out", async () => {
    for (const cookie of [null, "not-a-session", "A".repeat(43)]) {
      const response = await harness.web("GET", "/session", undefined, { cookie });
      expect(response.body).toEqual({ signed_in: false, operator_exists: true });
    }
  });

  it("is required by the operator's routes", async () => {
    for (const path of ["/threads", "/registrations", "/agents"]) {
      const response = await harness.web("GET", path, undefined, { cookie: null });
      expect([path, codeOf(response)]).toEqual([path, "unauthenticated"]);
      expect([path, codeOf(await harness.web("GET", path))]).toEqual([path, "ok"]);
    }
  });

  it("ends after seven days without use", async () => {
    harness.fixture.advance(7 * day - 1);
    expect(codeOf(await harness.web("GET", "/threads"))).toBe("ok");
    harness.fixture.advance(7 * day);
    expect(codeOf(await harness.web("GET", "/threads"))).toBe("unauthenticated");
  });

  it("lasts while used, but never past thirty days", async () => {
    for (let elapsed = 0; elapsed + 6 * day < 30 * day; elapsed += 6 * day) {
      harness.fixture.advance(6 * day);
      expect(codeOf(await harness.web("GET", "/threads"))).toBe("ok");
    }
    harness.fixture.advance(6 * day);
    expect(codeOf(await harness.web("GET", "/threads"))).toBe("unauthenticated");
  });

  it("ends when the operator signs out, and the cookie is cleared", async () => {
    const response = await harness.web("POST", "/auth/signout");
    expect(response.body).toEqual({ signed_in: false, operator_exists: true });
    expect(response.headers.get("set-cookie")).toMatch(
      new RegExp(`^${sessionCookie}=; Max-Age=0;.*Secure`),
    );
    expect(codeOf(await harness.web("GET", "/threads"))).toBe("unauthenticated");
  });

  it("deletes expired sessions when the table is next written", async () => {
    const { db } = harness.fixture;
    const count = () =>
      (db.prepare("SELECT count(*) AS n FROM browser_sessions").get() as { n: number }).n;
    const before = count();
    harness.fixture.advance(8 * day);
    const operator = findOperator(db);
    db.transaction(() =>
      openBrowserSession(
        db,
        operator?.personId ?? 0,
        harness.fixture.passkeyId,
        harness.fixture.now,
      ),
    );
    expect(count()).toBe(1);
    expect(before).toBeGreaterThan(1);
  });
});

describe("changes from the browser", () => {
  it("succeed with the CSRF token from the exact origin", async () => {
    expect(codeOf(await markRead())).toBe("ok");
  });

  it.each([
    ["no CSRF token", { csrf: null }],
    ["another session's CSRF token", { csrf: "A".repeat(43) }],
    ["no Origin", { origin: null }],
    ["another origin", { origin: "https://evil.test" }],
    // Another server's page on the same host.
    ["the host's origin on another port", { origin: "https://agention.test:8443" }],
    ["the origin over plain HTTP", { origin: "http://agention.test" }],
    ["the origin with a path", { origin: `${origin}/` }],
    ["two Origin values", { origin: `${origin}, ${origin}` }],
  ])("are refused with %s", async (_, options) => {
    const changes: [string, unknown][] = [
      ["/s/builder/main/threads/1/read", { through: 1 }],
      ["/passkeys/register/begin", { name: "Phone" }],
      ["/passkeys/register/finish", { credential: {} }],
      ["/passkeys/1/name", { name: "Laptop" }],
      ["/passkeys/1/remove", undefined],
    ];
    for (const [path, body] of changes) {
      const response = await harness.web("POST", path, body, options);
      expect([path, response.status, codeOf(response)]).toEqual([path, 401, "unauthenticated"]);
    }
  });

  it("need the exact origin even before sign-in", async () => {
    const response = await harness.web("POST", "/auth/signin/begin", undefined, {
      cookie: null,
      origin: "https://evil.test",
    });
    expect(codeOf(response)).toBe("unauthenticated");
  });

  it("do not need a CSRF token to read", async () => {
    for (const path of ["/s/builder/main/threads/1", "/passkeys"]) {
      const response = await harness.web("GET", path, undefined, { csrf: null, origin: null });
      expect([path, codeOf(response)]).toEqual([path, "ok"]);
    }
  });
});

describe("marking a thread unread", () => {
  const markUnread = (options = {}) =>
    harness.web("POST", "/s/builder/main/threads/1/unread", { from: 1 }, options);

  it("lowers the operator's cursor and answers both cursors", async () => {
    expect(codeOf(await markRead())).toBe("ok");
    const response = await markUnread();
    expect(response.body).toEqual({ cursors: { requester: 1, audience: 0 } });
  });

  it("needs the CSRF token, as every change does", async () => {
    expect(codeOf(await markUnread({ csrf: null }))).toBe("unauthenticated");
  });
});

describe("the operator's views", () => {
  const named = { agent: "builder", session: "main", thread: 1 };
  const shown = { ...named, through: 1 };

  it("list threads with their total, and mark them read and archive them in bulk", async () => {
    const list = await harness.web(
      "GET",
      "/threads?unread=true&agent=builder&session=builder/main&sort=latest&reverse=true",
    );
    expect(list.body).toEqual({ threads: [expect.objectContaining({ number: 1 })], total: 1 });
    // Agents and sessions repeat, one parameter for each.
    const several = await harness.web(
      "GET",
      "/threads?agent=reviewer&agent=builder&session=builder/main&session=builder/side",
    );
    expect(several.body).toMatchObject({ threads: [{ number: 1 }], total: 1 });
    // So do topics, each with its session.
    const topics = await harness.web(
      "GET",
      "/threads?topic=builder/main/auth&topic=reviewer/main/auth",
    );
    expect(topics.body).toEqual({ threads: [], total: 0 });
    // Status and read by agent filter by the thread's roll-up and its
    // session's reading and presence.
    const none = await harness.web("GET", "/threads?status=none");
    expect(none.body).toMatchObject({ threads: [{ number: 1, status: "none" }], total: 1 });
    expect((await harness.web("GET", "/threads?status=open")).body).toMatchObject({ total: 0 });
    expect((await harness.web("GET", "/threads?agent_read=stranded")).body).toMatchObject({
      total: 0,
    });
    for (const [query, field] of [
      ["priority=low", "priority"],
      ["impact=none", "impact"],
      ["status=closed", "status"],
      ["agent_read=yes", "agent_read"],
      ["effort=longer", "effort"],
      ["sort=oldest", "sort"],
      ["sort=latest&sort=due", "sort"],
      ["reverse=yes", "reverse"],
      ["group=topic", "group"],
      ["session=main", "session.0"],
      ["agent=builder&agent=builder", "agent"],
      ["topic=auth", "topic.0"],
      ["topic=builder/main/auth&topic=builder/main/auth", "topic"],
      // A search with no word in it, which the full-text query cannot take.
      ["search=%20%20", "search"],
    ]) {
      const refused = await harness.web("GET", `/threads?${query}`);
      expect(codeOf(refused)).toBe("invalid_input");
      expect((refused.body as ErrorBody).error.field).toBe(field);
    }
    const reads = await harness.web("POST", "/reads", { threads: [shown] });
    expect(reads.body).toEqual({
      threads: [{ ...named, cursors: { requester: 1, audience: 1 } }],
    });
    const archives = await harness.web("POST", "/archives", { threads: [shown] });
    expect(archives.body).toEqual({
      archived: [{ ...named, marks: { read_through: 1, archived_through: 1 } }],
      skipped: [],
    });
    expect((await harness.web("GET", "/threads")).body).toMatchObject({ threads: [] });
  });

  it("count the threads each filter's values keep, and group the list with its roll-ups", async () => {
    const counts = await harness.web("GET", "/threads/counts?agent=builder&unread=true");
    expect(counts.body).toMatchObject({
      status: { any: 1, open: 0, answered: 0, withdrawn: 0, none: 1 },
      unread: { any: 1, unread: 1 },
      agent_read: { any: 1, unread: 0, stranded: 0 },
      agent: { agents: [{ agent: "builder", total: 1 }], truncated: false },
      session: { sessions: [{ agent: "builder", session: "main", total: 1 }], truncated: false },
      reset: 1,
    });
    const grouped = (group: string) =>
      harness.web("GET", `/threads?session=builder/main&sort=due&group=${group}`);
    const rollup = { threads: 1, unread: 1, blocked: false, archived: false };
    expect((await grouped("session")).body).toMatchObject({
      threads: [{ number: 1 }],
      total: 1,
      groups: {
        sessions: [
          {
            agent: "builder",
            session: "main",
            rollup,
            presence: { last_seen_at: expect.any(String), quiet: false },
            topics: [{ rollup }],
          },
        ],
        truncated: false,
      },
    });
    // Grouped by agent, the roll-ups are the sessions' alone.
    expect((await grouped("agent")).body).toMatchObject({
      groups: { sessions: [{ agent: "builder", session: "main", rollup }], truncated: false },
    });
    const [session] = ((await grouped("agent")).body as ThreadList).groups?.sessions ?? [];
    expect(session).not.toHaveProperty("topics");
    expect(codeOf(await harness.web("GET", "/threads/counts?topic=auth"))).toBe("invalid_input");
    expect(codeOf(await harness.web("GET", "/threads/counts", undefined, { cookie: null }))).toBe(
      "unauthenticated",
    );
  });

  it("list registrations and agents for approval", async () => {
    const registrations = await harness.web("GET", "/registrations?status=approved");
    expect(registrations.body).toMatchObject({ registrations: [{ status: "approved" }] });
    const agents = await harness.web("GET", "/agents");
    expect(agents.body).toEqual({
      agents: [
        {
          agent: "builder",
          sessions: [{ session: "main", credential_active: true }],
          truncated: false,
        },
      ],
    });
  });

  it("answer an unknown registration as not_found and a malformed id as invalid_input", async () => {
    expect(codeOf(await harness.web("POST", "/registrations/999/reject"))).toBe("not_found");
    const malformed = await harness.web("POST", "/registrations/first/reject");
    expect(codeOf(malformed)).toBe("invalid_input");
  });
});

describe("the sessions view", () => {
  const report = (body: unknown) => harness.agent(agent, "POST", "/s/builder/main/status", body);

  it("lists each agent's sessions with their status and unread updates", async () => {
    await report({ state: "working", title: "Retire invoices", goal: "Drop the table" });
    await report({ percent: 40, note: "Backfill under way." });
    const page = (await harness.web("GET", "/sessions")).body as SessionsPage;
    expect(page.agents).toMatchObject([
      {
        agent: "builder",
        sessions: [
          {
            session: "main",
            presence: { quiet: false },
            registrations: [{ id: harness.registrationId(agent) }],
            status: {
              state: "working",
              title: "Retire invoices",
              goal: "Drop the table",
              percent: 40,
              note: "Backfill under way.",
            },
            unread_updates: 2,
            threads: { total: 1, stranded: 0 },
          },
        ],
        truncated: false,
      },
    ]);
    expect(codeOf(await harness.web("GET", "/sessions?limit=0"))).toBe("invalid_input");
  });

  it("pages a session's log newest first and marks it read", async () => {
    await report({ state: "working" });
    await report({ percent: 20 });
    await report({ percent: 60 });
    const log = await harness.web("GET", "/s/builder/main/updates?limit=2");
    expect(log.body).toMatchObject({
      updates: [
        { seq: 3, percent: 60 },
        { seq: 2, percent: 20 },
      ],
      read_through: 0,
    });
    const older = await harness.web("GET", "/s/builder/main/updates?before=2");
    expect(older.body).toMatchObject({ updates: [{ seq: 1, state: "working" }] });
    const read = await harness.web("POST", "/s/builder/main/updates/read", { through: 3 });
    expect(read.body).toEqual({ read_through: 3 });
    const beyond = await harness.web("POST", "/s/builder/main/updates/read", { through: 4 });
    expect([codeOf(beyond), (beyond.body as ErrorBody).error.field]).toEqual([
      "invalid_input",
      "through",
    ]);
    const unsigned = await harness.web(
      "POST",
      "/s/builder/main/updates/read",
      { through: 3 },
      {
        csrf: null,
      },
    );
    expect(codeOf(unsigned)).toBe("unauthenticated");
  });

  it("starts the operator's thread on a session, which the session's next wait reports", async () => {
    const start = { request_id: "o-1", title: "Rebase onto main", text: "Main moved." };
    const started = await harness.web("POST", "/s/builder/main/threads", start);
    expect(started.body).toEqual({ number: 2, seq: 1 });
    expect((await harness.web("POST", "/s/builder/main/threads", start)).body).toEqual(
      started.body,
    );
    const conflict = await harness.web("POST", "/s/builder/main/threads", {
      ...start,
      text: "Main moved again.",
    });
    expect(codeOf(conflict)).toBe("request_id_conflict");
    const waited = await harness.agent(agent, "GET", "/s/builder/main/wait?wait=0");
    expect((waited.body as WaitResult).threads).toMatchObject([
      { number: 2, title: "Rebase onto main", unread: 1 },
    ]);
    const refused = await harness.web("POST", "/s/builder/main/threads", {
      ...start,
      request_id: "o-2",
      text: undefined,
    });
    expect([codeOf(refused), (refused.body as ErrorBody).error.field]).toEqual([
      "invalid_input",
      "text",
    ]);
  });

  it("starts the operator's thread with no asks, topic or references, whatever its body carries", async () => {
    const started = await harness.web("POST", "/s/builder/main/threads", {
      request_id: "o-parts",
      title: "Look at this",
      text: "Please look.",
      asks: [{ question: "Ship it?" }],
      topic: "release",
      references: [{ label: "The pull request", url: "https://example.com/pull/1" }],
    });
    expect(codeOf(started)).toBe("ok");
    const { number } = started.body as WriteResult;
    const read = (await harness.web("GET", `/s/builder/main/threads/${number}`))
      .body as ThreadGetResult;
    expect(read.thread).not.toHaveProperty("topic");
    expect(read.thread.open_asks.count).toBe(0);
    expect(read.messages[0]).toMatchObject({ seq: 1, text: "Please look." });
    expect(read.messages[0]).not.toHaveProperty("asks");
    expect(read.messages[0]).not.toHaveProperty("references");
  });
});
