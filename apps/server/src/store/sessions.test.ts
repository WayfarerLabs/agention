import {
  formatTimestamp,
  maxListed,
  sessionLogQuery,
  sessionsQuery,
  sessionUpdateInput,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { archiveThread, markRead } from "./marks.ts";
import { seenStep } from "./presence.ts";
import { revokeRegistration } from "./registrations.ts";
import { listSessions, readSessionLog, sessionLog, updateSession } from "./sessions.ts";
import { defaultQuietAfter } from "./store.ts";
import { type Agent, Fixture, hour, threadTarget } from "./test-fixture.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

function failure(fn: () => unknown): { code: string; field: string | undefined } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return { code: error.code, field: error.field };
    }
    throw error;
  }
  throw new Error("expected the operation to fail");
}

// The session's log as stored, oldest first, without the times.
const logged = (session = agent) =>
  fixture.db
    .prepare(
      `SELECT seq, registration_id, state, outcome, title, goal, percent, note
       FROM session_updates WHERE session_id = ? ORDER BY seq`,
    )
    .all(session.sessionId);

const report = (fields: Record<string, unknown>) => fixture.report(agent, fields);

// The log as the operator reads it, a page at a time.
const log = (query: Record<string, string> = {}) =>
  sessionLog(fixture.store, fixture.operator, agent.target, sessionLogQuery.parse(query));

const readThrough = (through: number) =>
  readSessionLog(fixture.store, fixture.operator, agent.target, { through });

// The page's summary of a session of builder's, as the operator sees it.
function summary(session = "main") {
  const page = listSessions(fixture.store, fixture.operator, sessionsQuery.parse({}));
  const found = page.agents
    .find((each) => each.agent === "builder")
    ?.sessions.find((each) => each.session === session);
  if (found === undefined) {
    throw new Error(`no session ${session}`);
  }
  return found;
}

describe("updateSession", () => {
  it("starts working when the first update gives no state", () => {
    expect(report({ title: "Retire invoices" })).toEqual({
      state: "working",
      title: "Retire invoices",
    });
    expect(logged()).toEqual([
      {
        seq: 1,
        registration_id: agent.registrationId,
        state: "working",
        outcome: null,
        title: "Retire invoices",
        goal: null,
        percent: null,
        note: null,
      },
    ]);
  });

  it("replaces the state, with an outcome beside stopped and none beside the others", () => {
    expect(report({ state: "idle" })).toEqual({ state: "idle" });
    expect(report({ state: "stopped", outcome: "stalled" })).toEqual({
      state: "stopped",
      outcome: "stalled",
    });
    expect(report({ state: "stopped", outcome: "completed" })).toEqual({
      state: "stopped",
      outcome: "completed",
    });
    expect(report({ state: "working" })).toEqual({ state: "working" });
    report({ state: "stopped", outcome: "withdrawn" });
    expect(report({ state: "idle" })).toEqual({ state: "idle" });
  });

  it("keeps a stopped session stopped until it reports working or idle", () => {
    report({ state: "stopped", outcome: "completed" });
    expect(report({ title: "Wrapped up", percent: 100, note: "Done." })).toEqual({
      state: "stopped",
      outcome: "completed",
      title: "Wrapped up",
      percent: 100,
    });
  });

  it("sets each field it gives, leaving the others as they were", () => {
    report({ state: "working", title: "Retire invoices", goal: "Drop the table", percent: 10 });
    expect(report({ percent: 40 })).toEqual({
      state: "working",
      title: "Retire invoices",
      goal: "Drop the table",
      percent: 40,
    });
    expect(report({ title: "Retire the invoices table" })).toEqual({
      state: "working",
      title: "Retire the invoices table",
      goal: "Drop the table",
      percent: 40,
    });
  });

  it("clears the percent with a new goal, unless the update gives one", () => {
    report({ goal: "Drop the table", percent: 60 });
    expect(report({ goal: "Drop the table" })).toMatchObject({ percent: 60 });
    expect(report({ goal: "Backfill the ledger" })).toEqual({
      state: "working",
      goal: "Backfill the ledger",
    });
    report({ percent: 30 });
    expect(report({ goal: "Archive the rest", percent: 5 })).toMatchObject({
      goal: "Archive the rest",
      percent: 5,
    });
  });

  it("logs nothing for an update that changes nothing and carries no note", () => {
    report({ state: "working", title: "Retire invoices", percent: 20 });
    expect(report({ state: "working", percent: 20 })).toEqual({
      state: "working",
      title: "Retire invoices",
      percent: 20,
    });
    expect(logged()).toHaveLength(1);
  });

  it("logs a note with its entry alone, and again when it is repeated", () => {
    report({ state: "working", percent: 20 });
    expect(report({ note: "Backfill half done." })).toEqual({ state: "working", percent: 20 });
    report({ note: "Backfill half done." });
    report({ percent: 50 });
    expect(logged()).toMatchObject([
      { seq: 1, note: null },
      { seq: 2, state: "working", percent: 20, note: "Backfill half done." },
      { seq: 3, state: "working", percent: 20, note: "Backfill half done." },
      { seq: 4, percent: 50, note: null },
    ]);
  });

  it("numbers each session's entries on their own, from 1", () => {
    const other = fixture.registerAgent("builder", "side");
    report({ state: "working" });
    fixture.report(other, { state: "idle" });
    report({ state: "idle" });
    expect(logged().map((row) => (row as { seq: number }).seq)).toEqual([1, 2]);
    expect(logged(other).map((row) => (row as { seq: number }).seq)).toEqual([1]);
  });

  it("is the session's own: the operator may not, and another session's is not found", () => {
    const input = sessionUpdateInput.parse({ state: "working" });
    expect(
      failure(() => updateSession(fixture.store, fixture.operator, agent.target, input)),
    ).toEqual({ code: "not_allowed", field: undefined });
    const other = fixture.registerAgent("reviewer", "main");
    expect(
      failure(() => updateSession(fixture.store, agent.identity, other.target, input)),
    ).toEqual({ code: "not_found", field: undefined });
    expect(logged()).toEqual([]);
  });

  it("refuses a credential the operator revoked", () => {
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    expect(failure(() => report({ state: "working" })).code).toBe("unauthenticated");
  });
});

describe("the session log", () => {
  beforeEach(() => {
    report({ state: "working", title: "Retire invoices" });
    fixture.advance(1000);
    report({ percent: 20 });
    fixture.advance(1000);
    report({ percent: 60, note: "Backfill well along." });
  });

  it("pages newest first, with how far the operator has read", () => {
    const first = log({ limit: "2" });
    expect(first).toEqual({
      updates: [
        {
          seq: 3,
          created_at: formatTimestamp(fixture.now),
          state: "working",
          title: "Retire invoices",
          percent: 60,
          note: "Backfill well along.",
        },
        {
          seq: 2,
          created_at: formatTimestamp(fixture.now - 1000),
          state: "working",
          title: "Retire invoices",
          percent: 20,
        },
      ],
      read_through: 0,
    });
    expect(log({ before: "2" }).updates.map((update) => update.seq)).toEqual([1]);
    expect(log({ before: "1" }).updates).toEqual([]);
  });

  it("is marked read up to its latest entry, and never back", () => {
    expect(readThrough(2)).toEqual({ read_through: 2 });
    expect(readThrough(1)).toEqual({ read_through: 2 });
    expect(log().read_through).toBe(2);
    expect(failure(() => readThrough(4))).toEqual({ code: "invalid_input", field: "through" });
    expect(readThrough(3)).toEqual({ read_through: 3 });
  });

  it("counts the entries above the operator's mark as unread", () => {
    expect(summary().unread_updates).toBe(3);
    readThrough(2);
    expect(summary().unread_updates).toBe(1);
    report({ note: "Dropping the table." });
    expect(summary().unread_updates).toBe(2);
  });

  it("is not found for a session that does not exist", () => {
    const nowhere = { agent: "builder", session: "nowhere" };
    expect(
      failure(() => sessionLog(fixture.store, fixture.operator, nowhere, sessionLogQuery.parse({})))
        .code,
    ).toBe("not_found");
    expect(
      failure(() => readSessionLog(fixture.store, fixture.operator, nowhere, { through: 0 })).code,
    ).toBe("not_found");
  });

  it("does not exist for the session's own credential, which holds no sessions scope", () => {
    const query = sessionLogQuery.parse({});
    expect(failure(() => sessionLog(fixture.store, agent.identity, agent.target, query))).toEqual({
      code: "not_found",
      field: undefined,
    });
    expect(
      failure(() => readSessionLog(fixture.store, agent.identity, agent.target, { through: 1 })),
    ).toEqual({ code: "not_found", field: undefined });
    expect(log().read_through).toBe(0);
  });
});

describe("a stopped session", () => {
  const target = (number = 1) => threadTarget(agent, number);
  const thread = (number = 1) => fixture.thread(fixture.operator, target(number)).thread;

  beforeEach(() => {
    fixture.createThread(agent);
    fixture.write(fixture.operator, target(), { text: "Over to you." });
    fixture.seen(agent);
  });

  it("strands the threads holding a message of the operator's it has not read", () => {
    report({ state: "working" });
    expect(thread()).toMatchObject({
      stranded: false,
      presence: { quiet: false, state: "working" },
    });
    report({ state: "stopped", outcome: "completed" });
    expect(thread()).toMatchObject({
      stranded: true,
      presence: { quiet: false, state: "stopped", outcome: "completed" },
    });
    expect(summary().threads).toEqual({ total: 1, unread: 0, stranded: 1 });
  });

  it("strands nothing once it resumes, or once it has read the message", () => {
    report({ state: "stopped", outcome: "stalled" });
    report({ state: "idle" });
    expect(thread()).toMatchObject({ stranded: false, presence: { state: "idle" } });
    expect(thread().presence).not.toHaveProperty("outcome");
    report({ state: "stopped", outcome: "stalled" });
    expect(thread().stranded).toBe(true);
    fixture.write(agent.identity, target(), { text: "Read it." });
    expect(thread().stranded).toBe(false);
  });

  it("shows no state for a session that never reported", () => {
    expect(thread().presence).toEqual({
      last_seen_at: formatTimestamp(fixture.now),
      quiet: false,
    });
  });
});

describe("listSessions", () => {
  it("pages agents by name, each session with its presence, credentials and status", () => {
    const side = fixture.registerAgent("builder", "side");
    const second = fixture.registerAgent("builder", "main");
    fixture.registerAgent("reviewer", "main");
    revokeRegistration(fixture.store, fixture.operator, side.registrationId);
    fixture.seen(agent);
    report({ state: "stopped", outcome: "completed", title: "Retire invoices", note: "Done." });

    const first = listSessions(
      fixture.store,
      fixture.operator,
      sessionsQuery.parse({ limit: "1" }),
    );
    expect(first.agents).toEqual([
      {
        agent: "builder",
        tags: [],
        sessions: [
          {
            session: "side",
            created_at: formatTimestamp(fixture.now),
            tags: [],
            presence: { quiet: true },
            registrations: [],
            unread_updates: 0,
            threads: { total: 0, unread: 0, stranded: 0 },
            open_asks: { count: 0, blocking_count: 0 },
          },
          {
            session: "main",
            created_at: formatTimestamp(fixture.now),
            tags: [],
            presence: { last_seen_at: formatTimestamp(fixture.now), quiet: false },
            registrations: [agent, second].map((each) => ({
              id: each.registrationId,
              code: registrationCode(each.publicKey),
            })),
            status: {
              state: "stopped",
              outcome: "completed",
              title: "Retire invoices",
              note: "Done.",
              updated_at: formatTimestamp(fixture.now),
            },
            unread_updates: 1,
            threads: { total: 0, unread: 0, stranded: 0 },
            open_asks: { count: 0, blocking_count: 0 },
          },
        ],
        truncated: false,
      },
    ]);
    const nextPage = listSessions(
      fixture.store,
      fixture.operator,
      sessionsQuery.parse({ limit: "1", cursor: first.next }),
    );
    expect(nextPage.agents.map((each) => each.agent)).toEqual(["reviewer"]);
    expect(nextPage).not.toHaveProperty("next");
  });

  it("dates the status by its latest entry, which an update that logs nothing leaves", () => {
    report({ state: "working", title: "Retire invoices" });
    const first = formatTimestamp(fixture.now);
    fixture.advance(60_000);
    report({ state: "working" });
    expect(summary().status?.updated_at).toBe(first);
    fixture.advance(60_000);
    report({ note: "Backfill under way." });
    expect(summary().status?.updated_at).toBe(formatTimestamp(fixture.now));
  });

  it("orders working and idle sessions first, then those that never reported, then stopped ones", () => {
    const names = ["stopped-early", "stopped-late", "silent", "idle", "working-early"];
    const sessions = Object.fromEntries(
      names.map((name) => [name, fixture.registerAgent("builder", name)]),
    );
    const at = (name: string, report?: Record<string, unknown>) => {
      const session = sessions[name] as Agent;
      fixture.seen(session);
      if (report !== undefined) {
        fixture.report(session, report);
      }
      fixture.advance(seenStep);
    };
    at("working-early", { state: "working" });
    at("stopped-early", { state: "stopped", outcome: "completed" });
    at("silent");
    at("stopped-late", { state: "stopped", outcome: "withdrawn" });
    at("idle", { state: "idle" });
    const page = listSessions(fixture.store, fixture.operator, sessionsQuery.parse({}));
    expect(page.agents[0]?.sessions.map((each) => each.session)).toEqual([
      "idle",
      "working-early",
      "silent",
      "main",
      "stopped-late",
      "stopped-early",
    ]);
  });

  it("counts each session's threads the operator has not archived, and the stranded among them", () => {
    const other = fixture.registerAgent("reviewer", "main");
    for (let number = 1; number <= 3; number++) {
      fixture.createThread(agent);
      fixture.write(fixture.operator, threadTarget(agent, number), { text: "Over to you." });
    }
    fixture.createThread(other);
    archiveThread(fixture.store, fixture.operator, threadTarget(agent, 3), { through: 2 });
    fixture.seen(agent);
    fixture.seen(other);
    expect(summary().threads).toEqual({ total: 2, unread: 0, stranded: 0 });
    fixture.advance(defaultQuietAfter + seenStep + 1);
    expect(summary().threads).toEqual({ total: 2, unread: 0, stranded: 2 });
    fixture.thread(agent.identity, threadTarget(agent, 1));
    fixture.write(agent.identity, threadTarget(agent, 1), { text: "Read." });
    // The session's answer is unread by the operator.
    expect(summary().threads).toEqual({ total: 2, unread: 1, stranded: 1 });
    const page = listSessions(fixture.store, fixture.operator, sessionsQuery.parse({}));
    expect(page.agents[1]?.sessions[0]?.threads).toEqual({ total: 1, unread: 1, stranded: 0 });
    // Reading it, or archiving a thread, leaves nothing unread there.
    markRead(fixture.store, fixture.operator, threadTarget(agent, 1), { through: 3 });
    expect(summary().threads.unread).toBe(0);
  });

  it("counts each session's open asks in all its threads, and the blocking among them", () => {
    const side = fixture.registerAgent("builder", "side");
    const first = threadTarget(agent, 1);
    const second = threadTarget(agent, 2);
    fixture.createThread(agent, {
      asks: [{ question: "Ship it?", impact: "blocking" }, { question: "Tag it?" }],
    });
    fixture.createThread(agent, { asks: [{ question: "Which host?", impact: "blocking" }] });
    fixture.createThread(side, { asks: [{ question: "Rename it?", impact: "blocking" }] });
    expect(summary().open_asks).toEqual({ count: 3, blocking_count: 2 });
    expect(summary("side").open_asks).toEqual({ count: 1, blocking_count: 1 });
    // An answered ask and a withdrawn one wait on no one.
    fixture.write(fixture.operator, first, { answers: [{ ask: 1, text: "Ship it." }] });
    fixture.write(agent.identity, second, { withdrawals: [{ ask: 1, reason: "Settled." }] });
    expect(summary().open_asks).toEqual({ count: 1, blocking_count: 0 });
    // A thread the session archived still holds the asks open in it.
    fixture.write(agent.identity, second, {
      asks: [{ question: "Which port?", impact: "blocking" }],
    });
    archiveThread(fixture.store, agent.identity, second, { through: fixture.lastSeq(second) });
    expect(fixture.thread(agent.identity, second).thread.archived).toBe(true);
    expect(summary().open_asks).toEqual({ count: 2, blocking_count: 1 });
    expect(summary().threads.total).toBe(2);
  });

  it("refuses an agent, to which it does not exist", () => {
    expect(
      failure(() => listSessions(fixture.store, agent.identity, sessionsQuery.parse({}))).code,
    ).toBe("not_found");
  });

  it(
    `lists at most ${maxListed} sessions of an agent, saying when it leaves any out`,
    { timeout: 30_000 },
    () => {
      for (let index = 0; index < maxListed; index++) {
        fixture.registerAgent("builder", `session-${String(index).padStart(3, "0")}`);
      }
      fixture.seen(agent);
      fixture.advance(hour);
      const [builder] = listSessions(
        fixture.store,
        fixture.operator,
        sessionsQuery.parse({}),
      ).agents;
      expect(builder?.sessions.length).toBe(maxListed);
      expect(builder?.sessions[0]?.session).toBe("main");
      expect(builder?.truncated).toBe(true);
    },
  );
});
