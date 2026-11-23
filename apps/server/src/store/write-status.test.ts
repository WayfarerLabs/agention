import {
  agentMessageSendInput,
  formatTimestamp,
  sessionLogQuery,
  sessionsQuery,
  sessionThreadsQuery,
  threadCreateInput,
  waitQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { archiveThread, markRead, markUnread } from "./marks.ts";
import { listSessions, sessionLog } from "./sessions.ts";
import { listSessionThreads } from "./thread-lists.ts";
import { createThread, getThread, sendMessage } from "./threads.ts";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";
import { waitForThreads } from "./wait.ts";

// What a session's writes to its threads do to its status: the state and
// note a write reports, and working inferred from a write while idle.

let fixture: Fixture;
let agent: Agent;
const target = (number = 1) => threadTarget(agent, number);

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

const report = (fields: Record<string, unknown>) => fixture.report(agent, fields);

// The session's log as stored, oldest first, without the times.
const logged = () =>
  fixture.db
    .prepare(
      `SELECT seq, state, outcome, title, note, inferred FROM session_updates
       WHERE session_id = ? ORDER BY seq`,
    )
    .all(agent.sessionId);

// The session's status as the operator's sessions view shows it.
function status() {
  const page = listSessions(fixture.store, fixture.operator, sessionsQuery.parse({}));
  return page.agents[0]?.sessions.find((each) => each.session === "main")?.status;
}

// Each write a session makes to one of its threads, on thread 1, which the
// operator has written to so there is something to read.
const writes: [string, () => unknown][] = [
  ["starting a thread", () => fixture.createThread(agent)],
  ["sending a message", () => fixture.write(agent.identity, target(), { text: "More." })],
  ["marking read", () => markRead(fixture.store, agent.identity, target(), { through: 2 })],
  ["marking unread", () => markUnread(fixture.store, agent.identity, target(), { from: 2 })],
  ["archiving", () => archiveThread(fixture.store, agent.identity, target(), { through: 2 })],
];

describe("a write while idle", () => {
  beforeEach(() => {
    fixture.createThread(agent);
    fixture.write(fixture.operator, target(), { text: "Over to you." });
    report({ state: "idle", title: "Retire invoices", note: "Waiting on CI." });
  });

  it.each(writes)("marks the session working on %s, with no note", (_, write) => {
    fixture.advance(60_000);
    write();
    expect(status()).toEqual({
      state: "working",
      title: "Retire invoices",
      updated_at: formatTimestamp(fixture.now),
    });
    expect(logged().at(-1)).toEqual({
      seq: 2,
      state: "working",
      outcome: null,
      title: "Retire invoices",
      note: null,
      inferred: 1,
    });
  });

  it("is logged as inferred, keeping the idle note in the log alone", () => {
    fixture.write(agent.identity, target(), { text: "More." });
    const entries = sessionLog(
      fixture.store,
      fixture.operator,
      agent.target,
      sessionLogQuery.parse({}),
    ).updates;
    expect(entries.map((entry) => [entry.state, entry.note, entry.inferred])).toEqual([
      ["working", undefined, true],
      ["idle", "Waiting on CI.", false],
    ]);
    expect(status()).not.toHaveProperty("note");
    // Once working, later writes log nothing more.
    markRead(fixture.store, agent.identity, target(), { through: 3 });
    expect(logged()).toHaveLength(2);
  });

  it("changes nothing on a read or a wait", async () => {
    getThread(fixture.store, agent.identity, target(), { after: 0, limit: 10 });
    listSessionThreads(fixture.store, agent.identity, agent.target, sessionThreadsQuery.parse({}));
    await waitForThreads(fixture.store, agent.identity, agent.target, waitQuery.parse({}));
    expect(logged()).toHaveLength(1);
    expect(status()?.state).toBe("idle");
  });

  it("changes nothing when the operator writes", () => {
    fixture.write(fixture.operator, target(), { text: "And more." });
    markRead(fixture.store, fixture.operator, target(), { through: 3 });
    archiveThread(fixture.store, fixture.operator, target(), { through: 3 });
    fixture.startThread(agent);
    expect(logged()).toHaveLength(1);
  });

  it("changes nothing when it fails", () => {
    expect(
      failure(() => fixture.write(agent.identity, target(), { text: "Late.", seen_through: 1 }))
        .code,
    ).toBe("stale");
    expect(
      failure(() => markRead(fixture.store, agent.identity, target(), { through: 9 })).code,
    ).toBe("invalid_input");
    expect(logged()).toHaveLength(1);
  });
});

describe("a write in any other state", () => {
  it.each(writes)("leaves a stopped session stopped on %s", (_, write) => {
    fixture.createThread(agent);
    fixture.write(fixture.operator, target(), { text: "Over to you." });
    report({ state: "stopped", outcome: "completed" });
    write();
    expect(status()).toMatchObject({ state: "stopped", outcome: "completed" });
    expect(logged()).toHaveLength(1);
  });

  it("logs nothing for a session that is working or never reported", () => {
    fixture.createThread(agent);
    fixture.write(agent.identity, target(), { text: "More." });
    expect(logged()).toEqual([]);
    report({ state: "working" });
    fixture.write(agent.identity, target(), { text: "Again." });
    expect(logged()).toHaveLength(1);
  });
});

describe("a write that reports the status", () => {
  it("applies the state and note it gives, with the message", () => {
    report({ state: "working", title: "Retire invoices" });
    fixture.createThread(agent, { text: "Done; over to you.", state: "idle", note: "Asked." });
    expect(status()).toMatchObject({ state: "idle", title: "Retire invoices", note: "Asked." });
    fixture.write(agent.identity, target(), {
      text: "Shipped.",
      state: "stopped",
      outcome: "completed",
    });
    expect(status()).toMatchObject({ state: "stopped", outcome: "completed" });
    expect(logged()).toEqual([
      {
        seq: 1,
        state: "working",
        outcome: null,
        title: "Retire invoices",
        note: null,
        inferred: 0,
      },
      {
        seq: 2,
        state: "idle",
        outcome: null,
        title: "Retire invoices",
        note: "Asked.",
        inferred: 0,
      },
      {
        seq: 3,
        state: "stopped",
        outcome: "completed",
        title: "Retire invoices",
        note: null,
        inferred: 0,
      },
    ]);
  });

  it("applies a note alone as an update would, keeping an idle session idle", () => {
    report({ state: "idle" });
    fixture.createThread(agent, { note: "Still on CI." });
    expect(logged().at(-1)).toMatchObject({ state: "idle", note: "Still on CI.", inferred: 0 });
    expect(logged()).toHaveLength(2);
  });

  it("logs nothing for a state it already has, but logs a note", () => {
    report({ state: "idle" });
    fixture.createThread(agent, { state: "idle" });
    expect(logged()).toHaveLength(1);
    fixture.write(agent.identity, target(), { text: "Still waiting.", state: "idle", note: "CI." });
    expect(logged()).toHaveLength(2);
    expect(status()).toMatchObject({ state: "idle", note: "CI." });
    // A note beside a stopped session's write keeps it stopped.
    report({ state: "stopped", outcome: "stalled" });
    fixture.write(agent.identity, target(), { text: "Stuck.", note: "No access." });
    expect(status()).toMatchObject({ state: "stopped", outcome: "stalled", note: "No access." });
  });

  it("applies neither the message nor the status when the write fails", () => {
    report({ state: "working" });
    fixture.createThread(agent);
    fixture.write(fixture.operator, target(), { text: "Over to you." });
    expect(
      failure(() =>
        fixture.write(agent.identity, target(), {
          text: "Late.",
          seen_through: 1,
          state: "idle",
          note: "Waiting.",
        }),
      ).code,
    ).toBe("stale");
    expect(
      failure(() =>
        fixture.createThread(agent, {
          references: [{ label: "Nowhere", thread: 9 }],
          state: "idle",
        }),
      ).field,
    ).toBe("references.0.thread");
    expect(logged()).toHaveLength(1);
    expect(fixture.lastSeq(target())).toBe(2);
    expect(fixture.lastSeq(target(2))).toBe(0);
  });

  // Each write that takes a status, as a function of its request id and the
  // status it reports, on a session with thread 1.
  const reporting: [string, (requestId: string, status: object) => unknown][] = [
    [
      "thread_create",
      (requestId, status) =>
        createThread(
          fixture.store,
          agent.identity,
          agent.target,
          threadCreateInput.parse({ request_id: requestId, title: "Release", ...status }),
        ),
    ],
    [
      "message_send",
      (requestId, status) =>
        sendMessage(
          fixture.store,
          agent.identity,
          target(),
          agentMessageSendInput.parse({
            request_id: requestId,
            seen_through: 1,
            text: "Over to you.",
            ...status,
          }),
        ),
    ],
  ];

  it.each(reporting)(
    "applies its status once on %s, however often the write is repeated",
    (_, write) => {
      report({ state: "working" });
      fixture.createThread(agent);
      const first = write("send-1", { state: "idle", note: "Asked." });
      expect(write("send-1", { state: "idle", note: "Asked." })).toEqual(first);
      expect(logged()).toHaveLength(2);
      // The same request id with another status is another write.
      expect(failure(() => write("send-1", { state: "stopped", outcome: "completed" })).code).toBe(
        "request_id_conflict",
      );
      expect(failure(() => write("send-1", { state: "idle", note: "Asked again." })).code).toBe(
        "request_id_conflict",
      );
    },
  );

  it("is the session's own: the operator's write may carry none", () => {
    report({ state: "working" });
    fixture.createThread(agent);
    expect(
      failure(() => fixture.write(fixture.operator, target(), { text: "Hi.", state: "idle" })),
    ).toEqual({ code: "not_allowed", field: undefined });
    expect(fixture.lastSeq(target())).toBe(1);
    expect(logged()).toHaveLength(1);
  });
});
