import { sessionThreadsQuery, threadsQuery } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { archiveThread, bulkArchive, bulkRead, markRead, markUnread } from "./marks.ts";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";
import { listSessionThreads, listThreads } from "./thread-lists.ts";

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

const read = (through: number, identity: Identity = fixture.operator, number = 1) =>
  markRead(fixture.store, identity, target(number), { through }).cursors;
const unread = (from: number, identity: Identity = fixture.operator) =>
  markUnread(fixture.store, identity, target(), { from }).cursors;
const archive = (through: number, identity: Identity = fixture.operator, number = 1) =>
  archiveThread(fixture.store, identity, target(number), { through }).marks;

// The operator's and the agent's lists, by thread number, given the list's
// query as its route reads it.
type ListQuery = Record<string, string>;
function operatorList(query: ListQuery = {}): number[] {
  return listThreads(fixture.store, fixture.operator, threadsQuery.parse(query)).threads.map(
    (thread) => thread.number,
  );
}
function agentList(query: ListQuery = {}): number[] {
  return listSessionThreads(
    fixture.store,
    agent.identity,
    agent.target,
    sessionThreadsQuery.parse(query),
  ).threads.map((thread) => thread.number);
}

const unreadCount = (identity: Identity = fixture.operator) =>
  fixture.thread(identity, target()).thread.unread;

describe("marking read", () => {
  it("raises the caller's cursor and never lowers it", () => {
    fixture.createThread(agent);
    fixture.write(agent.identity, target(), { text: "More." });
    expect(read(2)).toEqual({ requester: 2, audience: 2 });
    expect(read(1)).toEqual({ requester: 2, audience: 2 });
    expect(unreadCount()).toBe(0);
  });

  it("refuses a sequence beyond the latest message", () => {
    fixture.createThread(agent);
    expect(failure(() => read(2))).toEqual({ code: "invalid_input", field: "through" });
  });

  it("writes no message and wakes no one", async () => {
    fixture.createThread(agent);
    const woken = fixture.store.notifier.wait(agent.sessionId, 50);
    read(1);
    expect(await woken).toBe("timeout");
    expect(fixture.thread(fixture.operator, target()).messages).toHaveLength(1);
  });
});

describe("unread", () => {
  it("counts only live messages by another party", () => {
    fixture.createThread(agent, { text: "Draft." });
    fixture.write(agent.identity, target(), { text: "Better.", replaces: 1 });
    expect(unreadCount()).toBe(1);
    expect(unreadCount(agent.identity)).toBe(0);
    fixture.write(fixture.operator, target(), { text: "Mine." });
    expect(unreadCount()).toBe(0);
    expect(unreadCount(agent.identity)).toBe(1);
  });

  it("counts a replacement carrying nothing, so the other party learns of it", () => {
    fixture.createThread(agent, { text: "Shipping today." });
    read(1);
    fixture.write(agent.identity, target(), { replaces: 1 });
    expect(unreadCount()).toBe(1);
  });

  it("counts a withdrawal of an ask, so the operator learns of it", () => {
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }] });
    read(1);
    fixture.write(agent.identity, target(), { withdrawals: [{ ask: 1, reason: "Shipped." }] });
    expect(unreadCount()).toBe(1);
  });

  it("never counts an archived message, read or not", () => {
    fixture.createThread(agent);
    fixture.write(agent.identity, target(), { text: "More." });
    fixture.write(agent.identity, target(), { text: "And more." });
    expect(unreadCount()).toBe(3);
    archive(2);
    expect(unreadCount()).toBe(1);
    expect(operatorList({ include_archived: "true", unread: "true" })).toEqual([1]);
    archive(3);
    expect(unreadCount()).toBe(0);
    expect(operatorList({ include_archived: "true", unread: "true" })).toEqual([]);
    // The read cursor stays where it was, so the agent sees only what was read.
    expect(fixture.thread(agent.identity, target()).cursors.audience).toBe(0);
  });
});

describe("marking unread", () => {
  it("moves the cursor back to just before the message it starts from, never forward", () => {
    fixture.createThread(agent);
    fixture.write(agent.identity, target(), { text: "More." });
    fixture.write(agent.identity, target(), { text: "And more." });
    expect(read(3).audience).toBe(3);
    expect(unread(3)).toEqual({ requester: 3, audience: 2 });
    expect(unreadCount()).toBe(1);
    expect(unread(2).audience).toBe(1);
    expect(unreadCount()).toBe(2);
    // From a later message, it leaves a cursor already before it.
    expect(unread(3).audience).toBe(1);
  });

  it("counts only other actors' messages from there as unread", () => {
    fixture.createThread(agent);
    fixture.write(fixture.operator, target(), { text: "Noted." });
    fixture.write(agent.identity, target(), { text: "More." });
    read(3);
    expect(unread(2).audience).toBe(1);
    expect(unreadCount()).toBe(1);
  });

  it("refuses a message beyond the thread's latest", () => {
    fixture.createThread(agent);
    expect(failure(() => unread(2))).toEqual({ code: "invalid_input", field: "from" });
  });
});

describe("archiving", () => {
  it("raises the caller's own mark, which the other party never sees", () => {
    fixture.createThread(agent);
    expect(archive(1)).toEqual({ read_through: 0, archived_through: 1 });
    expect(archive(0)).toEqual({ read_through: 0, archived_through: 1 });
    expect(fixture.thread(agent.identity, target()).marks).toEqual({
      read_through: 1,
      archived_through: 0,
    });
  });

  it("is refused over an ask open to the caller, naming the field, until it is answered", () => {
    fixture.createThread(agent);
    fixture.write(agent.identity, target(), { asks: [{ question: "Ship it?" }] });
    expect(archive(1).archived_through).toBe(1);
    expect(failure(() => archive(2))).toEqual({ code: "invalid_input", field: "through" });
    fixture.write(fixture.operator, target(), { answers: [{ ask: 1, declined: true }] });
    expect(archive(3).archived_through).toBe(3);
  });

  it("is never refused to the requester over its own asks", () => {
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }] });
    expect(archive(1, agent.identity).archived_through).toBe(1);
  });

  it("refuses a sequence beyond the latest message", () => {
    fixture.createThread(agent);
    expect(failure(() => archive(2))).toEqual({ code: "invalid_input", field: "through" });
  });
});

describe("archived threads", () => {
  // The operator's list, archived threads included, with each archived one
  // marked.
  const archivedForOperator = () =>
    listThreads(fixture.store, fixture.operator, threadsQuery.parse({ include_archived: "true" }))
      .threads.filter((thread) => thread.archived)
      .map((thread) => thread.number);

  it("stays archived until another party's live message follows the caller's archive mark", () => {
    fixture.createThread(agent);
    expect(operatorList()).toEqual([1]);
    // The agent's own new thread is in its list too.
    expect(agentList()).toEqual([1]);
    archive(1);
    expect(operatorList()).toEqual([]);
    expect(operatorList({ include_archived: "true" })).toEqual([1]);
    expect(archivedForOperator()).toEqual([1]);
    // The operator's own message does not bring it back; the agent's does.
    fixture.write(fixture.operator, target(), { text: "One more thing." });
    expect(operatorList()).toEqual([]);
    expect(agentList()).toEqual([1]);
    fixture.write(agent.identity, target(), { text: "Noted." });
    expect(operatorList()).toEqual([1]);
    expect(archivedForOperator()).toEqual([]);
  });

  it("carry the mark on over the caller's own replies that follow the message archived", () => {
    fixture.createThread(agent);
    fixture.write(fixture.operator, target(), { text: "Reply." });
    fixture.write(fixture.operator, target(), { text: "And more." });
    fixture.write(agent.identity, target(), { text: "Noted." });
    expect(archive(1).archived_through).toBe(3);
    expect(archivedForOperator()).toEqual([]);
    fixture.write(fixture.operator, target(), { text: "Thanks." });
    expect(archive(4).archived_through).toBe(5);
    // Archived exactly when every message is: the thread and each message
    // agree.
    const { thread, marks } = fixture.thread(fixture.operator, target());
    expect([thread.archived, marks.archived_through]).toEqual([true, thread.last_seq]);
    expect(archivedForOperator()).toEqual([1]);
  });

  it("archive a thread through a message followed only by the caller's own reply", () => {
    fixture.createThread(agent);
    fixture.write(fixture.operator, target(), { text: "Reply." });
    expect(archive(1)).toEqual({ read_through: 2, archived_through: 2 });
    const { thread, marks } = fixture.thread(fixture.operator, target());
    expect([thread.archived, marks.archived_through]).toEqual([true, thread.last_seq]);
  });

  it("stay archived when the caller writes, its archive mark moving to its own message", () => {
    fixture.createThread(agent);
    archive(1);
    fixture.write(fixture.operator, target(), { text: "One more thing." });
    expect(fixture.thread(fixture.operator, target()).marks).toEqual({
      read_through: 2,
      archived_through: 2,
    });
    expect(archivedForOperator()).toEqual([1]);
    // A thread not archived for the writer leaves its archive mark alone.
    fixture.write(agent.identity, target(), { text: "Noted." });
    fixture.write(fixture.operator, target(), { text: "Thanks." });
    expect(fixture.thread(fixture.operator, target()).marks.archived_through).toBe(2);
    expect(archivedForOperator()).toEqual([]);
  });

  it("never holds an ask open to the caller", () => {
    fixture.createThread(agent);
    archive(1);
    fixture.write(agent.identity, target(), { asks: [{ question: "Ship it?" }] });
    expect(operatorList()).toEqual([1]);
    expect(failure(() => archive(2)).code).toBe("invalid_input");
  });

  it("are only the threads the caller archived", () => {
    fixture.createThread(agent);
    fixture.createThread(agent);
    fixture.write(fixture.operator, target(2), { text: "Read it." });
    expect(archivedForOperator()).toEqual([]);
    archive(2, agent.identity, 2);
    expect(agentList()).toEqual([1]);
    expect(agentList({ include_archived: "true" })).toEqual([2, 1]);
    expect(archivedForOperator()).toEqual([]);
  });
});

describe("bulk marks", () => {
  const shown = (number: number, through: number) => ({
    ...agent.target,
    thread: number,
    through,
  });

  it("read each thread through the message the list showed, so a later one stays unread", () => {
    fixture.createThread(agent);
    fixture.createThread(agent);
    fixture.write(agent.identity, target(2), { text: "Arrived after the list." });
    const result = bulkRead(fixture.store, fixture.operator, {
      threads: [shown(1, 1), shown(2, 1)],
    });
    expect(result.threads).toEqual([
      { ...agent.target, thread: 1, cursors: { requester: 1, audience: 1 } },
      { ...agent.target, thread: 2, cursors: { requester: 2, audience: 1 } },
    ]);
    expect(operatorList({ include_archived: "true", unread: "true" })).toEqual([2]);
  });

  it("read every thread or none", () => {
    fixture.createThread(agent);
    fixture.createThread(agent);
    const attempt = (threads: ReturnType<typeof shown>[]) =>
      failure(() => bulkRead(fixture.store, fixture.operator, { threads }));
    expect(attempt([shown(1, 1), shown(2, 5)])).toEqual({
      code: "invalid_input",
      field: "threads.1.through",
    });
    expect(attempt([shown(1, 1), shown(3, 1)])).toEqual({ code: "not_found", field: "threads.1" });
    expect(
      attempt([shown(1, 1), { agent: "nobody", session: "main", thread: 1, through: 1 }]),
    ).toEqual({ code: "not_found", field: "threads.1" });
    expect(operatorList({ include_archived: "true", unread: "true" })).toEqual([2, 1]);
  });

  it("archive each thread through the message the list showed, skipping open asks", () => {
    fixture.createThread(agent);
    fixture.createThread(agent);
    fixture.write(agent.identity, target(2), {
      asks: [{ question: "Ship it?" }, { question: "Today?" }],
    });
    fixture.createThread(agent);
    fixture.write(agent.identity, target(3), { text: "Arrived after the list." });
    const result = bulkArchive(fixture.store, fixture.operator, {
      threads: [shown(1, 1), shown(2, 2), shown(3, 1)],
    });
    // A skipped thread names its open asks by number.
    expect(result).toEqual({
      archived: [
        { ...agent.target, thread: 1, marks: { read_through: 0, archived_through: 1 } },
        { ...agent.target, thread: 3, marks: { read_through: 0, archived_through: 1 } },
      ],
      skipped: [{ ...agent.target, thread: 2, open_asks: [1, 2] }],
    });
    expect(operatorList()).toEqual([2, 3]);
  });
});
