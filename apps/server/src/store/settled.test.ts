import {
  type AgentMessageSendInput,
  agentMessageSendInput,
  messageSendInput,
  sessionThreadsQuery,
  threadCreateInput,
  threadFilters,
  threadStartInput,
  threadsQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { type Agent, Fixture, requestId, threadTarget } from "./test-fixture.ts";
import { actOnMatchingThreads } from "./thread-actions.ts";
import { asOf, countThreads, listSessionThreads, listThreads } from "./thread-lists.ts";
import { sendMessage } from "./threads.ts";

// Settled threads: a message settles its thread, which stays Settled while
// that message is its latest, and the list's filter and counts.

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
const asSession = { kind: "session", agent: "builder", session: "main" };
const asOperator = { kind: "person", name: "operator" };

// summary reads a thread's summary as the operator sees it.
const summary = (number = 1) => fixture.thread(fixture.operator, target(number)).thread;

// settledBy reads who settled a thread, or undefined while it is not Settled.
const settledBy = (number = 1) => summary(number).settled_by;

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

// settle writes a settling message as the identity, with its text.
const settle = (
  identity = agent.identity,
  fields: Partial<Record<keyof AgentMessageSendInput, unknown>> = {},
  number = 1,
) =>
  fixture.write(identity, target(number), { text: "Merged, so done.", settles: true, ...fields });

describe("a settling message", () => {
  it("settles the thread while it is the latest, naming its author", () => {
    fixture.createThread(agent, { text: "Report on the pull request." });
    expect(summary()).not.toHaveProperty("settled_by");
    const { seq } = settle();
    const { thread, messages } = fixture.thread(fixture.operator, target());
    expect(thread).toMatchObject({ settled_by: asSession, last_seq: seq });
    expect(messages.at(-1)).toMatchObject({ seq, settles: true });
    expect(messages[0]).not.toHaveProperty("settles");
  });

  it("settles from the audience as from the requester", () => {
    fixture.createThread(agent, { text: "Report." });
    settle(fixture.operator);
    expect(settledBy()).toEqual(asOperator);
    expect(fixture.thread(agent.identity, target()).thread.settled_by).toEqual(asOperator);
  });

  it("reads and archives nothing for anyone", () => {
    fixture.createThread(agent, { text: "Report." });
    settle();
    expect(summary()).toMatchObject({ unread: 2, archived: false, read_through: 0 });
  });

  it.each([
    ["the requester", () => agent.identity],
    ["the audience", () => fixture.operator],
  ])("is ended by any later message, from %s", (_, writer) => {
    fixture.createThread(agent, { text: "Report." });
    settle();
    fixture.write(writer(), target(), { text: "Thanks." });
    expect(summary()).not.toHaveProperty("settled_by");
  });

  it("settles again from a writer who settled it before", () => {
    fixture.createThread(agent, { text: "Report." });
    settle();
    fixture.write(fixture.operator, target(), { text: "One more thing." });
    settle();
    expect(settledBy()).toEqual(asSession);
  });

  it("is ended by a replacement that does not settle, and kept by one that does", () => {
    fixture.createThread(agent, { text: "Report." });
    const { seq } = settle();
    const kept = fixture.write(agent.identity, target(), {
      text: "Merged, so done; edited.",
      settles: true,
      replaces: seq,
    });
    expect(summary()).toMatchObject({ settled_by: asSession, last_seq: kept.seq });
    fixture.write(agent.identity, target(), { text: "Not done after all.", replaces: kept.seq });
    expect(summary()).not.toHaveProperty("settled_by");
  });

  it("is ended by its retraction", () => {
    fixture.createThread(agent, { text: "Report." });
    const { seq } = settle();
    fixture.write(agent.identity, target(), { replaces: seq });
    expect(summary()).not.toHaveProperty("settled_by");
  });

  it("is ended by replacing an earlier message after it, unless that settles too", () => {
    fixture.createThread(agent, { text: "Report." });
    const earlier = fixture.write(agent.identity, target(), { text: "Draft." });
    settle();
    fixture.write(agent.identity, target(), { text: "Draft, edited.", replaces: earlier.seq });
    expect(summary()).not.toHaveProperty("settled_by");
    const latest = fixture.write(agent.identity, target(), { text: "Later." });
    settle(agent.identity, { replaces: latest.seq });
    expect(settledBy()).toEqual(asSession);
  });

  it("never starts a thread: a first message's schemas drop it, and the database refuses it", () => {
    const first = { request_id: "r", title: "Report", text: "Done.", settles: true };
    expect(threadCreateInput.parse(first)).not.toHaveProperty("settles");
    expect(threadStartInput.parse(first)).not.toHaveProperty("settles");
    fixture.createThread(agent, { text: "Report." });
    const insert = (seq: number, text: string | null) =>
      fixture.db
        .prepare(
          `INSERT INTO messages (thread_id, seq, session_id, session_pos, actor_id, created_at,
             request_id, digest, text, settles)
           VALUES (1, ?, 1, 100 + ?, 1, 1, 'raw-' || ?, zeroblob(32), ?, 1)`,
        )
        .run(seq, seq, seq, text);
    expect(() => insert(1, "Done.")).toThrow(/CHECK/);
    expect(() => insert(2, null)).toThrow(/CHECK/);
  });

  it("is refused without text, by each mount's schema", () => {
    for (const schema of [messageSendInput, agentMessageSendInput]) {
      const parsed = schema.safeParse({ request_id: "r", seen_through: 1, settles: true });
      expect(parsed.error?.issues.map((issue) => issue.path)).toContainEqual(["settles"]);
      const withDetail = schema.safeParse({
        request_id: "r",
        seen_through: 1,
        detail: "Why.",
        settles: true,
      });
      expect(withDetail.error?.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining([["detail"], ["settles"]]),
      );
    }
  });

  it("is part of the request's digest", () => {
    fixture.createThread(agent, { text: "Report." });
    const id = requestId();
    const write = (settles: true | undefined) =>
      sendMessage(
        fixture.store,
        agent.identity,
        target(),
        agentMessageSendInput.parse({ request_id: id, seen_through: 1, text: "Done.", settles }),
      );
    write(undefined);
    expect(failure(() => write(true))).toEqual({
      code: "request_id_conflict",
      field: "request_id",
    });
  });

  it("replayed after a later message, answers its first result and settles nothing again", () => {
    fixture.createThread(agent, { text: "Report." });
    const input = agentMessageSendInput.parse({
      request_id: requestId(),
      seen_through: 1,
      text: "Merged, so done.",
      settles: true,
    });
    const first = sendMessage(fixture.store, agent.identity, target(), input);
    fixture.write(fixture.operator, target(), { text: "Thanks." });
    expect(sendMessage(fixture.store, agent.identity, target(), input)).toEqual(first);
    expect(summary()).toMatchObject({ last_seq: 3 });
    expect(summary()).not.toHaveProperty("settled_by");
  });
});

describe("nothing left waiting", () => {
  const ask = { question: "Merge it?", suggestions: [{ label: "Yes" }, { label: "No" }] };

  it.each([
    ["the requester", () => agent.identity],
    ["the audience", () => fixture.operator],
  ])("refuses %s settling while an ask is open, writing nothing", (_, writer) => {
    fixture.createThread(agent, { asks: [ask, { question: "Tag it?" }] });
    expect(failure(() => settle(writer()))).toEqual({ code: "invalid_input", field: "settles" });
    expect(summary()).toMatchObject({ last_seq: 1, open_asks: { count: 2 } });
    expect(summary()).not.toHaveProperty("settled_by");
  });

  it("counts the asks the settling message withdraws", () => {
    fixture.createThread(agent, { asks: [ask, { question: "Tag it?" }] });
    const reason = "Merged without them.";
    expect(failure(() => settle(agent.identity, { withdrawals: [{ ask: 1, reason }] }))).toEqual({
      code: "invalid_input",
      field: "settles",
    });
    settle(agent.identity, {
      withdrawals: [
        { ask: 1, reason },
        { ask: 2, reason },
      ],
    });
    expect(summary()).toMatchObject({ settled_by: asSession, status: "withdrawn" });
  });

  it("counts the asks the settling message answers or declines", () => {
    fixture.createThread(agent, { asks: [ask, { question: "Tag it?" }] });
    settle(fixture.operator, {
      answers: [
        { ask: 1, picks: [0] },
        { ask: 2, declined: true },
      ],
    });
    expect(summary()).toMatchObject({ settled_by: asOperator, status: "answered" });
  });

  it("counts asks resolved before it", () => {
    fixture.createThread(agent, { asks: [ask] });
    fixture.write(fixture.operator, target(), { answers: [{ ask: 1, picks: [1] }] });
    settle();
    expect(settledBy()).toEqual(asSession);
  });

  it("refuses a settling replacement that asks again, and takes one that withdraws instead", () => {
    fixture.createThread(agent, { text: "Report.", asks: [ask] });
    expect(failure(() => settle(agent.identity, { asks: [ask], replaces: 1 }))).toEqual({
      code: "invalid_input",
      field: "settles",
    });
    settle(agent.identity, { withdrawals: [{ ask: 1, reason: "Merged." }], replaces: 1 });
    expect(summary()).toMatchObject({ settled_by: asSession, status: "withdrawn" });
  });

  it("refuses a settling replacement that drops an answer, by the replacement rule", () => {
    fixture.createThread(agent, { asks: [ask] });
    const answered = fixture.write(fixture.operator, target(), {
      text: "Yes.",
      answers: [{ ask: 1, picks: [0] }],
    });
    expect(failure(() => settle(fixture.operator, { replaces: answered.seq }))).toEqual({
      code: "invalid_input",
      field: "answers",
    });
    expect(summary()).not.toHaveProperty("settled_by");
  });

  it("names no more than the first asks it lists, however many are open", () => {
    const ten = Array.from({ length: 10 }, (_, index) => ({ question: `Step ${index + 1}?` }));
    fixture.createThread(agent, { asks: ten });
    for (let more = 0; more < 5; more++) {
      fixture.write(agent.identity, target(), { text: "More.", asks: ten });
    }
    const refusal = (): string => {
      try {
        settle(fixture.operator);
      } catch (error) {
        if (error instanceof ApiError && error.field === "settles") {
          return error.message;
        }
        throw error;
      }
      throw new Error("expected the settle to be refused");
    };
    const withSixty = refusal();
    const withdrawals = [56, 57, 58, 59, 60].map((number) => ({ ask: number, reason: "Done." }));
    fixture.write(agent.identity, target(), { withdrawals });
    expect(summary().open_asks.count).toBe(55);
    expect(refusal()).toBe(withSixty);
  });

  it("refuses a settling message that asks", () => {
    fixture.createThread(agent, { text: "Report." });
    expect(failure(() => settle(agent.identity, { asks: [ask] }))).toEqual({
      code: "invalid_input",
      field: "settles",
    });
  });
});

describe("the settled filter", () => {
  // Thread 1 Settled, thread 2 not, and thread 3 Settled by the operator.
  beforeEach(() => {
    for (const title of ["Alpha", "Beta", "Gamma"]) {
      fixture.createThread(agent, { title, text: "Report." });
    }
    settle(agent.identity, {}, 1);
    settle(fixture.operator, {}, 3);
  });

  const listed = (query: Record<string, string> = {}) =>
    listThreads(fixture.store, fixture.operator, threadsQuery.parse(query))
      .threads.map((thread) => thread.number)
      .sort();

  it("shows Settled threads among the rest unless it keeps only them or hides them", () => {
    expect(listed()).toEqual([1, 2, 3]);
    expect(listed({ settled: "only" })).toEqual([1, 3]);
    expect(listed({ settled: "hide" })).toEqual([2]);
  });

  it("counts each of its values with the other filters as they are", () => {
    const counts = (query: Record<string, string> = {}) =>
      countThreads(fixture.store, fixture.operator, threadFilters.parse(query)).settled;
    expect(counts()).toEqual({ any: 3, only: 2, hide: 1 });
    expect(counts({ settled: "only" })).toEqual({ any: 3, only: 2, hide: 1 });
    expect(counts({ search: "Alpha" })).toEqual({ any: 1, only: 1, hide: 0 });
  });

  it("keeps a thread out once a later message ends Settled", () => {
    fixture.write(fixture.operator, target(1), { text: "Thanks." });
    expect(listed({ settled: "only" })).toEqual([3]);
  });

  it("lets the operator read and archive every Settled thread at once", () => {
    const filters = threadFilters.parse({ settled: "only" });
    const result = actOnMatchingThreads(fixture.store, fixture.operator, {
      action: "read_and_archive",
      filters,
      as_of: asOf(fixture.db),
      expected: 2,
    });
    expect(result.acted.map((thread) => thread.thread).sort()).toEqual([1, 3]);
    expect(listed()).toEqual([2]);
    expect(listed({ settled: "only", include_archived: "true" })).toEqual([1, 3]);
  });

  it("is no filter of the agent's own list, whose summaries name who settled", () => {
    const page = listSessionThreads(
      fixture.store,
      agent.identity,
      agent.target,
      sessionThreadsQuery.parse({}),
    );
    expect(
      page.threads
        .map((thread) => [thread.number, thread.settled_by])
        .sort(([a], [b]) => Number(a) - Number(b)),
    ).toEqual([
      [1, asSession],
      [2, undefined],
      [3, asOperator],
    ]);
  });
});
