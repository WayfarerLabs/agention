import {
  maxActionThreads,
  type ThreadAction,
  threadFilters,
  threadsQuery,
} from "@wayfarerlabs/agention-server-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.ts";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";
import { actOnMatchingThreads, actOnThreads } from "./thread-actions.ts";
import { asOf, listThreads } from "./thread-lists.ts";

let fixture: Fixture;
let agent: Agent;
let other: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
  other = fixture.registerAgent("reviewer", "main");
});

afterEach(() => {
  fixture.close();
});

const target = (number: number, of: Agent = agent) => threadTarget(of, number);
const shown = (number: number, through: number, of: Agent = agent) => ({
  ...target(number, of),
  through,
});
const named = (number: number, of: Agent = agent) => target(number, of);

const act = (action: ThreadAction, threads: ReturnType<typeof shown>[]) =>
  actOnThreads(fixture.store, fixture.operator, { action, threads });
// actMatching acts on the threads matching filters as of a list read at
// as_of, expecting as many as it held; by default one read now, expecting
// its total.
const actMatching = (
  action: ThreadAction,
  filters: Record<string, unknown> = {},
  read: { as_of?: string; expected?: number } = {},
) =>
  actOnMatchingThreads(fixture.store, fixture.operator, {
    action,
    filters: threadFilters.parse(filters),
    as_of: read.as_of ?? asOf(fixture.db),
    expected:
      read.expected ??
      listThreads(fixture.store, fixture.operator, threadsQuery.parse(filters)).total,
  });

// The operator's list, by agent and thread number, given its query as its
// route reads it.
function listed(query: Record<string, string> = {}): string[] {
  return listThreads(fixture.store, fixture.operator, threadsQuery.parse(query)).threads.map(
    (thread) => `${thread.agent}/${thread.number}`,
  );
}

const unreadOf = (number: number, of: Agent = agent) =>
  fixture.thread(fixture.operator, target(number, of)).thread.unread;

// The asks of a thread's messages that the operator declined, by number.
function declinedAsks(number: number, of: Agent = agent): number[] {
  return fixture
    .thread(of.identity, target(number, of))
    .messages.flatMap((message) =>
      (message.answers ?? []).filter((answer) => answer.declined).map((answer) => answer.ask),
    );
}

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

describe("acting on threads named one by one", () => {
  it("marks each read, and unread from the message the list showed, a later one staying unread", () => {
    fixture.createThread(agent);
    fixture.createThread(agent);
    fixture.write(agent.identity, target(2), { text: "Arrived after the list." });
    expect(act("read", [shown(1, 1), shown(2, 1)])).toEqual({
      acted: [named(1), named(2)],
      declined: [],
      kept: [],
    });
    expect([unreadOf(1), unreadOf(2)]).toEqual([0, 1]);
    fixture.write(agent.identity, target(1), { text: "A second message." });
    act("read", [shown(1, 2)]);
    expect(act("unread", [shown(1, 2)]).acted).toEqual([named(1)]);
    expect(unreadOf(1)).toBe(1);
  });

  it("marks unread from the other party's latest message, leaving out a thread holding none", () => {
    fixture.createThread(agent);
    fixture.write(fixture.operator, target(1), { text: "My reply." });
    fixture.startThread(agent);
    expect(act("unread", [shown(1, 2), shown(2, 1)]).acted).toEqual([named(1)]);
    expect([unreadOf(1), unreadOf(2)]).toEqual([1, 0]);
  });

  it("marks read and archives each, keeping out a thread holding an ask open to the operator", () => {
    fixture.createThread(agent);
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }, { question: "Today?" }] });
    fixture.createThread(agent);
    expect(act("read_and_archive", [shown(1, 1), shown(2, 1), shown(3, 1)])).toEqual({
      acted: [named(1), named(3)],
      declined: [],
      kept: [{ ...named(2), open_asks: [1, 2] }],
    });
    expect(listed()).toEqual(["builder/2"]);
    // The thread kept is left as it was, unread.
    expect(unreadOf(2)).toBe(1);
    expect(listed({ include_archived: "true", unread: "true" })).toEqual(["builder/2"]);
  });

  it("declines every ask open to the operator in one message per thread, then marks read and archives", () => {
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }, { question: "Today?" }] });
    fixture.createThread(agent);
    fixture.createThread(other, { asks: [{ question: "Merge?" }] });
    const notify = vi.spyOn(fixture.store.notifier, "notify");
    expect(act("decline_read_and_archive", [shown(1, 1), shown(2, 1), shown(1, 1, other)])).toEqual(
      {
        acted: [named(1), named(2), named(1, other)],
        declined: [
          { ...named(1), asks: [1, 2] },
          { ...named(1, other), asks: [1] },
        ],
        kept: [],
      },
    );
    // Each session written to wakes, once the call commits.
    expect(notify.mock.calls.map(([session]) => session).sort()).toEqual(
      [agent.sessionId, other.sessionId].sort(),
    );
    expect(declinedAsks(1)).toEqual([1, 2]);
    expect(declinedAsks(1, other)).toEqual([1]);
    const declining = fixture.thread(agent.identity, target(1)).messages.at(-1);
    expect(declining).toMatchObject({ seq: 2, author: { kind: "person", name: "operator" } });
    expect(declining?.text).toBeUndefined();
    expect(fixture.thread(fixture.operator, target(1)).thread.status).toBe("answered");
    expect(listed()).toEqual([]);
    // Read through the decline, it comes back unread with the agent's next
    // message alone.
    fixture.write(agent.identity, target(1), { text: "Understood." });
    expect(listed()).toEqual(["builder/1"]);
    expect(unreadOf(1)).toBe(1);
  });

  it("leaves a thread to decline in as it was when a message the list did not show arrived", () => {
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }] });
    fixture.write(agent.identity, target(1), { asks: [{ question: "Or wait?" }] });
    expect(act("decline_read_and_archive", [shown(1, 1)])).toEqual({
      acted: [],
      declined: [],
      kept: [{ ...named(1), open_asks: [1] }],
    });
    expect(declinedAsks(1)).toEqual([]);
    expect(unreadOf(1)).toBe(2);
    expect(listed()).toEqual(["builder/1"]);
  });

  it("acts on every thread or, when one is refused, on none", () => {
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }] });
    fixture.createThread(agent);
    const attempt = (threads: ReturnType<typeof shown>[]) =>
      failure(() => act("decline_read_and_archive", threads));
    expect(attempt([shown(1, 1), shown(2, 5)])).toEqual({
      code: "invalid_input",
      field: "threads.1.through",
    });
    expect(attempt([shown(1, 1), shown(3, 1)])).toEqual({ code: "not_found", field: "threads.1" });
    expect(
      attempt([
        shown(1, 1),
        shown(1, 1, { ...agent, target: { agent: "nobody", session: "main" } }),
      ]),
    ).toEqual({
      code: "not_found",
      field: "threads.1",
    });
    expect(declinedAsks(1)).toEqual([]);
    expect(listed()).toEqual(["builder/1", "builder/2"]);
  });
});

describe("acting on the threads the filters keep", () => {
  it("acts on every thread the list's filters keep as the call runs, each through its latest message as of the list", () => {
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }] });
    fixture.createThread(agent);
    fixture.createThread(other);
    fixture.write(agent.identity, target(2), { text: "And more." });
    expect(actMatching("read", { agent: ["builder"] })).toEqual({
      acted: [named(1), named(2)],
      declined: [],
      kept: [],
    });
    expect(listed({ unread: "true" })).toEqual(["reviewer/1"]);
    expect(actMatching("read_and_archive")).toEqual({
      acted: [named(2), named(1, other)],
      declined: [],
      kept: [{ ...named(1), open_asks: [1] }],
    });
    expect(actMatching("decline_read_and_archive", { status: "open" })).toEqual({
      acted: [named(1)],
      declined: [{ ...named(1), asks: [1] }],
      kept: [],
    });
    expect(listed()).toEqual([]);
    expect(actMatching("unread", { include_archived: true }).acted).toEqual([
      named(1),
      named(2),
      named(1, other),
    ]);
  });

  it("keeps only the threads whose live messages name a pull request the filters name", () => {
    fixture.createThread(agent, { pull_requests: [{ repo: "acme/agention", number: 135 }] });
    fixture.createThread(agent, { pull_requests: [{ repo: "acme/agention", number: 136 }] });
    fixture.createThread(other, { branches: [{ repo: "acme/agention", branch: "feat/links" }] });
    expect(actMatching("read", { pull_request: ["Acme/Agention#135"] }).acted).toEqual([named(1)]);
    expect(actMatching("read", { branch: ["acme/agention:feat/links"] }).acted).toEqual([
      named(1, other),
    ]);
    expect(listed({ unread: "true" })).toEqual(["builder/2"]);
  });

  it("acts on nothing that arrived after the list's as_of, so a retry reaches the same messages", () => {
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }] });
    fixture.createThread(agent);
    const before = asOf(fixture.db);
    // After the list was read: a message in thread 2, an ask in thread 1,
    // and a new thread.
    fixture.write(agent.identity, target(2), { text: "Arrived after the list." });
    fixture.write(agent.identity, target(1), { asks: [{ question: "Or wait?" }] });
    fixture.createThread(other);
    // The list read before held the two threads it acts on.
    const asRead = { as_of: before, expected: 2 };
    expect(actMatching("read", {}, asRead)).toEqual({
      acted: [named(1), named(2)],
      declined: [],
      kept: [],
    });
    expect([unreadOf(1), unreadOf(2), unreadOf(1, other)]).toEqual([1, 1, 1]);
    // Declining declines no ask the list did not show, and leaves a thread
    // holding a newer message as it was.
    expect(actMatching("decline_read_and_archive", {}, asRead)).toEqual({
      acted: [named(2)],
      declined: [],
      kept: [{ ...named(1), open_asks: [1] }],
    });
    expect(declinedAsks(1)).toEqual([]);
    expect(listed()).toEqual(["builder/1", "reviewer/1", "builder/2"]);
    // Read as of now, the thread keeps it no more.
    expect(actMatching("decline_read_and_archive", { agent: ["builder"] }).declined).toEqual([
      { ...named(1), asks: [1, 2] },
    ]);
    expect(failure(() => actMatching("read", {}, { as_of: "not-a-position" }))).toEqual({
      code: "invalid_input",
      field: "as_of",
    });
  });

  it("is refused as stale, acting on none, when the threads it would act on number other than expected", () => {
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }] });
    fixture.createThread(agent, { asks: [{ question: "Merge it?" }] });
    act("read", [shown(2, 1)]);
    // The list kept to the unread holds thread 1 alone.
    const asRead = { as_of: asOf(fixture.db), expected: 1 };
    expect(listed({ unread: "true" })).toEqual(["builder/1"]);
    // Marked unread elsewhere, thread 2 comes to match with no new message.
    act("unread", [shown(2, 1)]);
    expect(
      failure(() => actMatching("decline_read_and_archive", { unread: true }, asRead)),
    ).toEqual({ code: "stale", field: "expected" });
    expect([declinedAsks(1), declinedAsks(2)]).toEqual([[], []]);
    // Choosing again from the list as it is now acts.
    expect(actMatching("decline_read_and_archive", { unread: true }).declined).toEqual([
      { ...named(1), asks: [1] },
      { ...named(2), asks: [1] },
    ]);
  });

  it("declines more asks than one message answers in several messages, each replaceable", () => {
    const questions = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ question: `Question ${from + index}?` }));
    fixture.createThread(agent, { asks: questions(1, 10) });
    fixture.write(agent.identity, target(1), { asks: questions(11, 2) });
    const asks = Array.from({ length: 12 }, (_, index) => index + 1);
    expect(act("decline_read_and_archive", [shown(1, 2)])).toEqual({
      acted: [named(1)],
      declined: [{ ...named(1), asks }],
      kept: [],
    });
    const declines = fixture
      .thread(agent.identity, target(1))
      .messages.filter((message) => message.answers !== undefined);
    expect(
      declines.map((message) => [message.seq, message.answers?.map((each) => each.ask)]),
    ).toEqual([
      [3, asks.slice(0, 10)],
      [4, asks.slice(10)],
    ]);
    expect(listed()).toEqual([]);
    // Each is replaced as any message of the operator's is, its answers given
    // again.
    for (const message of declines) {
      fixture.write(fixture.operator, target(1), {
        replaces: message.seq,
        text: "Declined, for now.",
        answers: message.answers?.map(({ ask }) => ({ ask, declined: true })),
      });
    }
    expect(
      fixture.thread(agent.identity, target(1)).messages.map((message) => message.seq),
    ).toEqual(expect.arrayContaining([5, 6]));
    expect(listed()).toEqual([]);
  });

  it(`is refused, acting on none, when the filters keep more than ${maxActionThreads} threads`, () => {
    for (let count = 0; count <= maxActionThreads; count++) {
      fixture.createThread(agent);
    }
    expect(failure(() => actMatching("read"))).toEqual({
      code: "invalid_input",
      field: "filters",
    });
    expect(listed({ unread: "true", limit: "1" })).toHaveLength(1);
    // Narrowed to fewer, it acts.
    fixture.createThread(other);
    expect(actMatching("read", { agent: ["reviewer"] }).acted).toEqual([named(1, other)]);
  });
});
