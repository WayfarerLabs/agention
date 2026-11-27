import {
  type ThreadGrouping,
  threadGrouping,
  type ThreadNeighbors,
  threadSort,
  threadsQuery,
  threadsView,
} from "@wayfarerlabs/agention-server-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { createGroup, setSessionGroup } from "./groups-and-tags.ts";
import { archiveThread, markRead } from "./marks.ts";
import { type Agent, Fixture, hour, threadTarget } from "./test-fixture.ts";
import { findThreadNeighbors, listThreads } from "./thread-lists.ts";

// The threads just above and below one in the operator's list.

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

type Query = Record<string, string>;

// start begins a thread titled title, a millisecond after the last, so the
// latest order is the order of creation reversed.
function start(title: string, from: Agent = agent, fields: Record<string, unknown> = {}): number {
  fixture.advance(1);
  return fixture.createThread(from, { title, ...fields }).number;
}

// around names the threads above and below a thread, by their titles.
function around(number: number, query: Query = {}, from: Agent = agent) {
  const found: ThreadNeighbors = findThreadNeighbors(
    fixture.store,
    fixture.operator,
    threadTarget(from, number),
    threadsView.parse(query),
  );
  return [found.above?.title, found.below?.title];
}

const listed = (query: Query) =>
  listThreads(fixture.store, fixture.operator, threadsQuery.parse({ ...query, limit: "100" }))
    .threads;
const titles = (query: Query) => listed(query).map((thread) => thread.title);

// keyOf names a thread by where it is.
const keyOf = (thread: { agent: string; session: string; number: number } | undefined) =>
  thread === undefined ? undefined : `${thread.agent}/${thread.session}/${thread.number}`;

describe("the threads above and below", () => {
  it("are the rows around each thread in the list, under every order, direction and grouping", () => {
    // Three sessions, two in groups, with threads of each kind of lead ask,
    // some started at the same moment in different sessions, so ties break
    // on the session as the list breaks them, and some on a topic, so
    // grouping by topic splits a session.
    const side = fixture.registerAgent("builder", "side");
    const reviewer = fixture.registerAgent("reviewer", "main");
    for (const [name, session] of [
      ["alpha", agent],
      ["beta", side],
    ] as const) {
      const { id } = createGroup(fixture.store, fixture.operator, { name });
      setSessionGroup(fixture.store, fixture.operator, session.target, { group: id });
    }
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    start("m1", agent, { topic: "auth", asks: [{ question: "q", priority: "high" }] });
    start("s1", side, {
      topic: "auth",
      asks: [{ question: "q", answer_by: at(3), effort: "quick" }],
    });
    start("r1", reviewer, { asks: [{ question: "q", impact: "blocking" }] });
    fixture.advance(1);
    for (const session of [agent, side, reviewer]) {
      fixture.createThread(session, { title: `${session.target.session} together` });
      fixture.createThread(session, {
        title: `${session.target.agent} asks together`,
        asks: [{ question: "q", effort: "longer" }],
      });
    }
    start("m4", agent, { topic: "auth" });
    start("s4", side, { asks: [{ question: "q", answer_by: at(1), priority: "low" }] });
    markRead(fixture.store, fixture.operator, threadTarget(side, 1), { through: 1 });
    const groupings: (ThreadGrouping | undefined)[] = [undefined, ...threadGrouping.options];
    for (const sort of threadSort.options) {
      for (const reverse of ["false", "true"]) {
        for (const group of groupings) {
          const query: Query = { sort, reverse, ...(group === undefined ? {} : { group }) };
          const list = listed(query);
          expect(list).toHaveLength(11);
          list.forEach((thread, index) => {
            const found = findThreadNeighbors(
              fixture.store,
              fixture.operator,
              { agent: thread.agent, session: thread.session, thread: thread.number },
              threadsView.parse(query),
            );
            expect([query, keyOf(thread), keyOf(found.above), keyOf(found.below)]).toEqual([
              query,
              keyOf(thread),
              keyOf(list[index - 1]),
              keyOf(list[index + 1]),
            ]);
          });
        }
      }
    }
  });

  it("follow the thread to where it stands now", () => {
    for (const title of ["one", "two", "three"]) {
      start(title);
    }
    fixture.advance(1);
    fixture.write(agent.identity, threadTarget(agent, 1), { text: "Later." });
    expect(titles({ sort: "latest" })).toEqual(["one", "three", "two"]);
    expect(around(1, { sort: "latest" })).toEqual([undefined, "three"]);
  });

  it("stand around a thread the unread filter leaves out, where it would be", () => {
    for (const title of ["one", "two", "three"]) {
      start(title);
    }
    markRead(fixture.store, fixture.operator, threadTarget(agent, 2), { through: 1 });
    expect(titles({ sort: "latest", unread: "true" })).toEqual(["three", "one"]);
    expect(around(2, { sort: "latest", unread: "true" })).toEqual(["three", "one"]);
  });

  it("stand around a thread just archived, where it would be", () => {
    for (const title of ["one", "two", "three"]) {
      start(title);
    }
    archiveThread(fixture.store, fixture.operator, threadTarget(agent, 2), { through: 1 });
    expect(titles({ sort: "latest" })).toEqual(["three", "one"]);
    expect(around(2, { sort: "latest" })).toEqual(["three", "one"]);
  });

  describe("of a thread the list leaves out, in a grouped list", () => {
    // Two sessions, main holding m2 and m1 and side s2 and s1, with s2 the
    // newest, so it would lead side's group, and that group the list, were
    // it in the list.
    let side: Agent;
    beforeEach(() => {
      side = fixture.registerAgent("builder", "side");
      start("s1", side);
      start("m1");
      start("m2");
    });
    const grouped = { sort: "latest", group: "session" };

    it("leave its group where the list shows it, once the unread filter leaves it out", () => {
      start("s2", side);
      markRead(fixture.store, fixture.operator, threadTarget(side, 2), { through: 1 });
      const unread = { ...grouped, unread: "true" };
      expect(titles(unread)).toEqual(["m2", "m1", "s1"]);
      expect(around(2, unread, side)).toEqual(["m1", "s1"]);
    });

    it("leave its group where the list shows it, once archived", () => {
      start("s2", side);
      archiveThread(fixture.store, fixture.operator, threadTarget(side, 2), { through: 1 });
      expect(titles(grouped)).toEqual(["m2", "m1", "s1"]);
      expect(around(2, grouped, side)).toEqual(["m1", "s1"]);
    });

    it("place a group holding no other thread of the list by that thread", () => {
      const other = fixture.registerAgent("builder", "other");
      start("o1", other);
      markRead(fixture.store, fixture.operator, threadTarget(other, 1), { through: 1 });
      const unread = { ...grouped, unread: "true" };
      expect(titles(unread)).toEqual(["m2", "m1", "s1"]);
      expect(around(1, unread, other)).toEqual([undefined, "m2"]);
    });
  });

  it("are none at the ends of the list", () => {
    start("one");
    start("two");
    expect(around(2, { sort: "latest" })).toEqual([undefined, "one"]);
    expect(around(1, { sort: "latest" })).toEqual(["two", undefined]);
    start("alone", fixture.registerAgent("reviewer", "main"));
    expect(around(1, { sort: "latest", agent: "reviewer" }, agent)).toEqual(["alone", undefined]);
  });

  it("refuse an unknown thread, and a thread of a session the identity does not reach, as not_found", () => {
    start("one");
    const other = fixture.registerAgent("reviewer", "main");
    const refused = (from: Agent, number: number) => {
      try {
        findThreadNeighbors(
          fixture.store,
          other.identity,
          threadTarget(from, number),
          threadsView.parse({}),
        );
      } catch (error) {
        return error instanceof ApiError ? error.code : error;
      }
      return "answered";
    };
    expect(refused(agent, 1)).toBe("not_found");
    expect(refused(other, 9)).toBe("not_found");
  });
});
