import {
  composePresence,
  composeRollup,
  type Rollup,
  sessionThreadsQuery,
  maxListed,
  threadFilters,
  type ThreadGrouping,
  threadGrouping,
  type ThreadList,
  threadsQuery,
  type ThreadSummary,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { createGroup, setAgentTags, setSessionGroup, setSessionTags } from "./groups-and-tags.ts";
import { archiveThread, markRead } from "./marks.ts";
import { encodeCursor } from "./opaque-cursors.ts";
import { revokeRegistration } from "./registrations.ts";
import { type Agent, Fixture, hour, start as began, threadTarget } from "./test-fixture.ts";
import { countThreads, ftsQuery, listSessionThreads, listThreads } from "./thread-lists.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

// A list's query as its route reads it: each value as text, a filter of
// several values as a list of them.
type Query = Record<string, string | string[] | undefined>;

function list(query: Query = {}) {
  return listThreads(fixture.store, fixture.operator, threadsQuery.parse(query));
}

// agentList lists the agent's session as the agent sees it.
function agentList(query: Record<string, string> = {}) {
  return titles(
    listSessionThreads(
      fixture.store,
      agent.identity,
      agent.target,
      sessionThreadsQuery.parse(query),
    ),
  );
}

const titles = (page: { threads: { title: string }[] }) => page.threads.map((t) => t.title);

// A thread as the operator's list shows it.
type ListedThread = ThreadList["threads"][number];

// start begins a thread titled title in the agent's session, a millisecond
// after the last, so newest-first order is the order of creation reversed.
function start(title: string, fields: Record<string, unknown> = {}, from: Agent = agent) {
  fixture.advance(1);
  return fixture.createThread(from, { title, ...fields }).number;
}

describe("the priority order", () => {
  it("ranks by highest priority, then blocking, then earliest answer-by, then oldest ask", () => {
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    start("normal, none");
    fixture.write(agent.identity, threadTarget(agent, 1), { asks: [{ question: "q" }] });
    start("normal, late", { asks: [{ question: "q", answer_by: at(5) }] });
    start("normal, soon", { asks: [{ question: "q", answer_by: at(3) }] });
    start("normal, overdue", { asks: [{ question: "q", answer_by: at(1) }] });
    start("normal, blocked", { asks: [{ question: "q", impact: "blocking" }] });
    start("low, blocked", { asks: [{ question: "q", impact: "blocking", priority: "low" }] });
    start("urgent", { asks: [{ question: "q", priority: "urgent" }] });
    start("high, and a low ask", { asks: [{ question: "q", priority: "high" }] });
    fixture.write(agent.identity, threadTarget(agent, 8), {
      asks: [{ question: "q", priority: "low", impact: "blocking" }],
    });
    start("nothing asked");
    fixture.advance(2 * hour);
    const order = [
      "urgent",
      "high, and a low ask",
      "normal, blocked",
      "normal, overdue",
      "normal, soon",
      "normal, late",
      "normal, none",
      "low, blocked",
    ];
    expect(titles(list({ status: "open" }))).toEqual(order);
    // The operator's list by default, and the agent's, put them first, then
    // the rest by latest message.
    expect(titles(list())).toEqual([...order, "nothing asked"]);
    expect(agentList()).toEqual([...order, "nothing asked"]);
  });

  it("ranks a thread by its most pressing open ask, not by its asks together", () => {
    start("urgent, and a low blocking ask", { asks: [{ question: "q", priority: "urgent" }] });
    fixture.write(agent.identity, threadTarget(agent, 1), {
      asks: [{ question: "q", priority: "low", impact: "blocking" }],
    });
    start("urgent, blocking", {
      asks: [{ question: "q", priority: "urgent", impact: "blocking" }],
    });
    expect(titles(list())).toEqual(["urgent, blocking", "urgent, and a low blocking ask"]);
  });

  it("orders archived threads, when included, as any other", () => {
    start("low", { asks: [{ question: "q", priority: "low", effort: "quick" }] });
    start("urgent", { asks: [{ question: "q", priority: "urgent", effort: "quick" }] });
    start("archived");
    start("latest");
    archiveThread(fixture.store, fixture.operator, threadTarget(agent, 3), { through: 1 });
    expect(titles(list({ effort: "quick" }))).toEqual(["urgent", "low"]);
    expect(titles(list())).toEqual(["urgent", "low", "latest"]);
    expect(titles(list({ include_archived: "true" }))).toEqual([
      "urgent",
      "low",
      "latest",
      "archived",
    ]);
  });

  it("pages in the same order as one page", () => {
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    for (let i = 0; i < 7; i++) {
      const number = start(`thread ${i}`, {
        asks: [
          {
            question: "q",
            priority: i % 2 === 0 ? "high" : "normal",
            ...(i % 3 === 0 ? {} : { effort: i % 3 === 1 ? "under_1h" : "quick" }),
            ...(i % 4 === 0 ? {} : { answer_by: at(8 - i) }),
          },
        ],
      });
      // A second ask on some, which leads under some orders and filters.
      if ([0, 2, 3, 5].includes(i)) {
        fixture.write(agent.identity, threadTarget(agent, number), {
          asks: [
            {
              question: "q2",
              priority: i % 2 === 0 ? "urgent" : "low",
              effort: i === 0 ? "longer" : "quick",
              ...(i === 0 ? {} : { answer_by: at(i + 1) }),
            },
          ],
        });
      }
    }
    start("no ask 1");
    start("no ask 2");
    archiveThread(fixture.store, fixture.operator, threadTarget(agent, 8), { through: 1 });
    for (const query of [
      {},
      { status: "open" },
      { effort: "under_15m" },
      { include_archived: "true" },
      { search: "thread" },
      ...(["due", "effort", "latest", "created"] as const).map((sort) => ({ sort })),
      ...(["priority", "due", "effort", "latest", "created"] as const).map((sort) => ({
        sort,
        reverse: "true",
      })),
      { sort: "due", effort: "under_1h" },
      { sort: "effort", priority: "high" },
      { sort: "effort", include_archived: "true" },
      { sort: "effort", include_archived: "true", reverse: "true" },
    ]) {
      const all = titles(list({ ...query, limit: "100" }));
      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = list({ ...query, limit: "2", ...(cursor === undefined ? {} : { cursor }) });
        paged.push(...titles(page));
        cursor = page.next;
        fixture.advance(2 * hour);
      } while (cursor !== undefined);
      expect([query, paged]).toEqual([query, all]);
    }
  });

  it("refuses a cursor it did not give out", () => {
    start("a");
    expect(() => list({ cursor: encodeCursor("registrations", [0, 0]) })).toThrow(ApiError);
    let refusal: unknown;
    try {
      list({ cursor: "not a cursor" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "invalid_input", field: "cursor" });
  });
});

describe("what a list holds, and its filters", () => {
  beforeEach(() => {
    start("read and archived");
    start("unread");
    start("asking", { asks: [{ question: "q", effort: "quick" }] });
    start("answered", { asks: [{ question: "q" }] });
    fixture.write(fixture.operator, threadTarget(agent, 4), {
      answers: [{ ask: 1, declined: true }],
    });
    start("archived unread");
    markRead(fixture.store, fixture.operator, threadTarget(agent, 1), { through: 1 });
    for (const number of [1, 5]) {
      archiveThread(fixture.store, fixture.operator, threadTarget(agent, number), { through: 1 });
    }
  });

  it.each([
    ["the threads not archived, by default", {}, ["asking", "answered", "unread"]],
    [
      "archived threads too, when included",
      { include_archived: "true" },
      ["asking", "archived unread", "answered", "unread", "read and archived"],
    ],
    ["open threads", { status: "open" }, ["asking"]],
    ["answered threads", { status: "answered" }, ["answered"]],
    ["threads asking nothing", { status: "none" }, ["unread"]],
    // Only an open thread holds an open ask.
    ["answered threads with quick asks", { status: "answered", effort: "quick" }, []],
    ["unread threads", { unread: "true" }, ["asking", "unread"]],
    ["quick asks", { effort: "quick" }, ["asking"]],
    // An archived message is never unread, so archived threads add none.
    [
      "unread threads, archived ones included",
      { include_archived: "true", unread: "true" },
      ["asking", "unread"],
    ],
    ["unread open threads", { unread: "true", status: "open" }, ["asking"]],
    ["titles found by search", { search: "un" }, ["unread"]],
    [
      "titles found by search, archived ones included",
      { search: "un", include_archived: "true" },
      ["archived unread", "unread"],
    ],
  ])("lists %s", (_, query, expected) => {
    expect(titles(list(query))).toEqual(expected);
  });

  it("marks the threads archived for the viewer", () => {
    const archived = list({ include_archived: "true" }).threads.filter((thread) => thread.archived);
    expect(archived.map((thread) => thread.title)).toEqual([
      "archived unread",
      "read and archived",
    ]);
  });

  it("counts the threads the list holds, every page of it", () => {
    expect(list().total).toBe(3);
    expect(list({ limit: "1" }).total).toBe(3);
    expect(list({ unread: "true" }).total).toBe(2);
    expect(list({ status: "open", unread: "true", effort: "quick" }).total).toBe(1);
    expect(list({ include_archived: "true" }).total).toBe(5);
    expect(list({ search: "unread", include_archived: "true" }).total).toBe(2);
  });

  it("gives the agent its own view of its session, its new threads and asks included", () => {
    expect(agentList()).toEqual([
      "asking",
      "archived unread",
      "answered",
      "unread",
      "read and archived",
    ]);
    expect(agentList({ status: "open" })).toEqual(["asking"]);
    expect(agentList({ status: "answered" })).toEqual(["answered"]);
    expect(agentList({ unread: "true" })).toEqual(["answered"]);
    expect(agentList({ search: "ANSWER" })).toEqual(["answered"]);
    archiveThread(fixture.store, agent.identity, threadTarget(agent, 2), { through: 1 });
    expect(agentList()).not.toContain("unread");
    expect(agentList({ include_archived: "true" })).toContain("unread");
  });
});

describe("the signals of open asks", () => {
  beforeEach(() => {
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    start("urgent blocking", { asks: [{ question: "q", priority: "urgent", impact: "blocking" }] });
    start("high overdue", {
      asks: [{ question: "q", priority: "high", answer_by: at(1), effort: "under_1h" }],
    });
    start("normal quick", { asks: [{ question: "q", effort: "quick", impact: "assuming" }] });
    start("low, a quarter hour", {
      asks: [{ question: "q", priority: "low", effort: "under_15m" }],
    });
    start("low, longer", { asks: [{ question: "q", priority: "low", effort: "longer" }] });
    start("nothing asked");
    fixture.advance(2 * hour);
  });

  it.each([
    ["blocking", { impact: "blocking" }, ["urgent blocking"]],
    ["assuming", { impact: "assuming" }, ["normal quick"]],
    ["overdue", { overdue: "true" }, ["high overdue"]],
    ["quick", { effort: "quick" }, ["normal quick"]],
    ["at most a quarter hour's", { effort: "under_15m" }, ["normal quick", "low, a quarter hour"]],
    [
      "at most an hour's",
      { effort: "under_1h" },
      ["high overdue", "normal quick", "low, a quarter hour"],
    ],
    ["urgent", { priority: "urgent" }, ["urgent blocking"]],
    ["high or more", { priority: "high" }, ["urgent blocking", "high overdue"]],
    ["normal or more", { priority: "normal" }, ["urgent blocking", "high overdue", "normal quick"]],
    ["high and overdue", { priority: "high", overdue: "true" }, ["high overdue"]],
    ["blocking and quick", { impact: "blocking", effort: "quick" }, []],
  ])("keep the threads holding %s asks", (_, query, expected) => {
    expect(titles(list(query))).toEqual(expected);
  });

  it("keep a thread only for one open ask that meets them all, which it leads with", () => {
    start("urgent, and a low blocking ask", { asks: [{ question: "q", priority: "urgent" }] });
    fixture.write(agent.identity, threadTarget(agent, 7), {
      asks: [{ question: "low and blocking", priority: "low", impact: "blocking" }],
    });
    const both = { impact: "blocking", priority: "urgent" };
    expect(titles(list(both))).toEqual(["urgent blocking"]);
    expect(list(both).total).toBe(1);
    const blocking = list({ impact: "blocking" });
    expect(titles(blocking)).toEqual(["urgent blocking", "urgent, and a low blocking ask"]);
    // The thread leads with the ask the filters kept, not its most pressing.
    expect(blocking.threads[1]?.open_asks.lead?.question).toBe("low and blocking");
    expect(list().threads.find((thread) => thread.number === 7)?.open_asks.lead?.number).toBe(1);
  });

  it("roll up the earliest answer-by and overdue over every open ask, whatever the filters keep", () => {
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    const [soon, later] = [at(1), at(5)];
    const number = start("high, and a low ask due sooner", {
      asks: [{ question: "high", priority: "high", answer_by: later }],
    });
    fixture.write(agent.identity, threadTarget(agent, number), {
      asks: [{ question: "low", priority: "low", answer_by: soon }],
    });
    fixture.advance(2 * hour);
    const row = list({ priority: "high" }).threads.find((thread) => thread.number === number);
    expect(row?.open_asks).toMatchObject({
      lead: { question: "high", answer_by: later, overdue: false },
      answer_by: soon,
      overdue: true,
    });
  });
});

describe("the orders", () => {
  beforeEach(() => {
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    start("urgent, no answer-by", { asks: [{ question: "q", priority: "urgent" }] });
    start("normal, due later", { asks: [{ question: "q", answer_by: at(5), effort: "under_1h" }] });
    start("nothing asked, older");
    start("low, due soon", {
      asks: [{ question: "q", priority: "low", answer_by: at(2), effort: "quick" }],
    });
    start("high, unknown effort", { asks: [{ question: "q", priority: "high" }] });
    start("normal, quick and due last", {
      asks: [{ question: "q", answer_by: at(9), effort: "quick" }],
    });
    start("nothing asked, newest");
  });

  // Each order of the threads above.
  const orders: Record<string, string[]> = {
    priority: [
      "urgent, no answer-by",
      "high, unknown effort",
      "normal, due later",
      "normal, quick and due last",
      "low, due soon",
      "nothing asked, newest",
      "nothing asked, older",
    ],
    latest: [
      "nothing asked, newest",
      "normal, quick and due last",
      "high, unknown effort",
      "low, due soon",
      "nothing asked, older",
      "normal, due later",
      "urgent, no answer-by",
    ],
    due: [
      "low, due soon",
      "normal, due later",
      "normal, quick and due last",
      "urgent, no answer-by",
      "high, unknown effort",
      "nothing asked, newest",
      "nothing asked, older",
    ],
    effort: [
      "normal, quick and due last",
      "low, due soon",
      "normal, due later",
      "urgent, no answer-by",
      "high, unknown effort",
      "nothing asked, newest",
      "nothing asked, older",
    ],
    // No thread has had a message since it began, so creation and the latest
    // message agree here.
    created: [
      "nothing asked, newest",
      "normal, quick and due last",
      "high, unknown effort",
      "low, due soon",
      "nothing asked, older",
      "normal, due later",
      "urgent, no answer-by",
    ],
  };

  it.each(Object.keys(orders))("list by %s", (sort) => {
    expect(titles(list({ sort }))).toEqual(orders[sort]);
  });

  it("list by priority by default", () => {
    expect(titles(list())).toEqual(orders.priority);
  });

  it("list by when each thread was created, whatever came since", () => {
    fixture.advance(1);
    fixture.write(agent.identity, threadTarget(agent, 1), { text: "More." });
    expect(titles(list({ sort: "latest" }))[0]).toBe("urgent, no answer-by");
    expect(titles(list({ sort: "created" }))).toEqual(orders.created);
  });

  it.each(Object.keys(orders))(
    "order archived threads, when included, as any other by %s",
    (sort) => {
      archiveThread(fixture.store, fixture.operator, threadTarget(agent, 3), { through: 1 });
      const kept = orders[sort]?.filter((title) => title !== "nothing asked, older");
      expect(titles(list({ sort }))).toEqual(kept);
      expect(titles(list({ sort, include_archived: "true" }))).toEqual(orders[sort]);
    },
  );

  it("count an effort of an hour or more as stated, after the quicker ones", () => {
    fixture.write(agent.identity, threadTarget(agent, 5), {
      asks: [{ question: "low, longer", priority: "low", effort: "longer" }],
    });
    start("low, longer, alone", { asks: [{ question: "q", priority: "low", effort: "longer" }] });
    expect(titles(list({ sort: "effort" }))).toEqual([
      "normal, quick and due last",
      "low, due soon",
      "normal, due later",
      "high, unknown effort",
      "low, longer, alone",
      "urgent, no answer-by",
      "nothing asked, newest",
      "nothing asked, older",
    ]);
    const leadOf = (sort: string) =>
      list({ sort }).threads.find((thread) => thread.number === 5)?.open_asks.lead?.number;
    expect(leadOf("effort")).toBe(2);
    expect(leadOf("priority")).toBe(1);
  });

  it("lead each thread with the ask that ranks first under the order", () => {
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    fixture.write(agent.identity, threadTarget(agent, 1), {
      asks: [{ question: "low but due", priority: "low", answer_by: at(1), effort: "under_15m" }],
    });
    const leadOf = (sort: string, reverse = "false") =>
      list({ sort, reverse }).threads.find((thread) => thread.number === 1)?.open_asks.lead?.number;
    const leads = { priority: 1, due: 2, effort: 2, latest: 1, created: 1 };
    for (const [sort, lead] of Object.entries(leads)) {
      expect([sort, leadOf(sort), leadOf(sort, "true")]).toEqual([sort, lead, lead]);
    }
    expect(titles(list({ sort: "due" }))[0]).toBe("urgent, no answer-by");
  });

  it("refuse a cursor another order or direction gave out", () => {
    const refusal = (under: Query, cursor: string) => {
      try {
        list({ ...under, cursor });
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const forward = list({ sort: "due", limit: "1" }).next ?? "";
    const backward = list({ sort: "due", reverse: "true", limit: "1" }).next ?? "";
    for (const [under, cursor] of [
      [{ sort: "effort" }, forward],
      [{ sort: "due", reverse: "true" }, forward],
      [{ sort: "due" }, backward],
      [{ sort: "latest" }, list({ sort: "created", limit: "1" }).next ?? ""],
    ] as const) {
      expect(refusal(under, cursor)).toMatchObject({ code: "invalid_input", field: "cursor" });
    }
    expect(titles(list({ sort: "due", cursor: forward }))[0]).toBe("normal, due later");
    expect(titles(list({ sort: "due", reverse: "true", cursor: backward }))[0]).toBe(
      "normal, due later",
    );
  });
});

describe("reversed orders", () => {
  // Three threads of each shape begin at one instant, two in one session and
  // one in another, so they tie on every key but their session and number.
  beforeEach(() => {
    const reviewer = fixture.registerAgent("reviewer", "main");
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    const shapes: [string, Record<string, unknown>][] = [
      [
        "urgent, quick, due",
        { asks: [{ question: "q", priority: "urgent", answer_by: at(3), effort: "quick" }] },
      ],
      ["normal", { asks: [{ question: "q" }] }],
      [
        "low, longer, due",
        { asks: [{ question: "q", priority: "low", answer_by: at(1), effort: "longer" }] },
      ],
      // Its lead is the urgent ask, or the quick one while effort is filtered.
      [
        "urgent, and low and quick",
        {
          asks: [
            { question: "q", priority: "urgent" },
            { question: "q2", priority: "low", effort: "quick" },
          ],
        },
      ],
      ["nothing asked", {}],
    ];
    for (const [title, fields] of shapes) {
      fixture.advance(1);
      for (const from of [agent, agent, reviewer]) {
        fixture.createThread(from, { title, ...fields });
      }
    }
    fixture.advance(1);
    archiveThread(fixture.store, fixture.operator, threadTarget(agent, 9), { through: 1 });
  });

  // Which threads each order ranks, as the list shows them.
  const ranks: Record<string, (thread: ThreadSummary) => boolean> = {
    priority: (thread) => thread.open_asks.lead !== undefined,
    due: (thread) => thread.open_asks.lead?.answer_by !== undefined,
    effort: (thread) => thread.open_asks.lead?.effort !== undefined,
    latest: () => true,
    created: () => true,
  };
  const key = (thread: ThreadSummary) => `${thread.agent}/${thread.session}/${thread.number}`;
  const leads = (threads: ThreadSummary[]) =>
    new Map(threads.map((thread) => [key(thread), thread.open_asks.lead?.number]));

  it.each(
    [{}, { include_archived: "true" }, { effort: "quick" }, { agent: "builder" }].flatMap((query) =>
      Object.keys(ranks).map((sort) => ({ ...query, sort })),
    ),
  )("reverse what %j ranks, ties too, keeping the rest after it as it was", (query) => {
    const rank = ranks[query.sort] ?? (() => false);
    const forward = list({ ...query, limit: "100" }).threads;
    const backward = list({ ...query, reverse: "true", limit: "100" }).threads;
    const ranked = forward.filter(rank);
    expect(ranked.length).toBeGreaterThan(1);
    expect(backward.map(key)).toEqual(
      [...ranked.reverse(), ...forward.filter((thread) => !rank(thread))].map(key),
    );
    expect(leads(backward)).toEqual(leads(forward));
  });
});

describe("the created order", () => {
  it("follows the threads' numbers within a session, even when the clock went back between them", () => {
    const reviewer = fixture.registerAgent("reviewer", "main");
    start("main 1");
    start("reviewer 1", {}, reviewer);
    fixture.advance(-hour);
    start("main 2");
    fixture.advance(-hour);
    start("main 3");
    start("reviewer 2", {}, reviewer);
    const threads = list({ sort: "created" }).threads;
    // The clock says main 1 began after main 3.
    const began = (title: string) =>
      Date.parse(threads.find((thread) => thread.title === title)?.created_at ?? "");
    expect(began("main 1")).toBeGreaterThan(began("main 3"));
    expect(titles({ threads })).toEqual(["reviewer 2", "main 3", "main 2", "reviewer 1", "main 1"]);
    expect(titles(list({ sort: "created", reverse: "true" }))).toEqual([
      "main 1",
      "reviewer 1",
      "main 2",
      "main 3",
      "reviewer 2",
    ]);
    const numbers = (query: Query) => list(query).threads.map((thread) => thread.number);
    expect(numbers({ sort: "created", session: "builder/main" })).toEqual([3, 2, 1]);
    expect(numbers({ sort: "created", reverse: "true", session: "builder/main" })).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("unread by the agent", () => {
  it("keeps the threads holding a live message of the operator's the agent has not read", () => {
    start("written, unread");
    start("written, read");
    start("retracted");
    start("not written");
    for (const number of [1, 2, 3]) {
      fixture.write(fixture.operator, threadTarget(agent, number), { text: "Noted." });
    }
    markRead(fixture.store, agent.identity, threadTarget(agent, 2), { through: 2 });
    markRead(fixture.store, agent.identity, threadTarget(agent, 3), { through: 1 });
    fixture.write(fixture.operator, threadTarget(agent, 3), { replaces: 2 });
    expect(titles(list({ agent_read: "unread" }))).toEqual(["retracted", "written, unread"]);
    markRead(fixture.store, agent.identity, threadTarget(agent, 3), { through: 3 });
    expect(titles(list({ agent_read: "unread" }))).toEqual(["written, unread"]);
  });
});

describe("search", () => {
  beforeEach(() => {
    start("Asked to review", { asks: [{ question: "q" }] });
    start("Release notes are up");
    start("Café notes");
    start('C++ build "fails" (NEAR the end)');
  });

  it.each([
    ["a word's start", "rel", ["Release notes are up"]],
    ["every word, in any order", "note REL", ["Release notes are up"]],
    ["ignoring case and accents", "CAFE note", ["Café notes"]],
    ["words as written, quotes included", '"fails', ['C++ build "fails" (NEAR the end)']],
    ["query syntax as words", "NEAR end", ['C++ build "fails" (NEAR the end)']],
    ["punctuation alone as nothing", "(", []],
    [
      "every match in list order, open asks first",
      "re",
      ["Asked to review", "Release notes are up"],
    ],
  ])("finds %s", (_, text, expected) => {
    expect(titles(list({ search: text }))).toEqual(expected);
  });

  it("quotes each word as a prefix term, doubling its quotes", () => {
    expect(ftsQuery('  one "two"  AND* ')).toBe('"one"* """two"""* "AND*"*');
  });

  it("relies on titles that never change", () => {
    let errcode: unknown;
    try {
      fixture.db.prepare("UPDATE threads SET title = 'Changed'").run();
    } catch (error) {
      errcode = (error as { errcode?: number }).errcode;
    }
    // SQLITE_CONSTRAINT_TRIGGER: the threads trigger refused it.
    expect(errcode).toBe(1811);
  });
});

describe("narrowing", () => {
  let reviewer: Agent;
  let side: Agent;

  beforeEach(() => {
    reviewer = fixture.registerAgent("reviewer", "main");
    side = fixture.registerAgent("builder", "side");
    start("auth one", { topic: "auth" });
    start("billing", { topic: "billing" });
    start("auth two");
    fixture.write(agent.identity, threadTarget(agent, 3), { topic: "auth" });
    start("side", { topic: "auth" }, side);
    start("reviewer", {}, reviewer);
  });

  it("keeps the threads of any of the agents and any of the sessions given", () => {
    expect(titles(list({ agent: "builder" }))).toEqual(["side", "auth two", "billing", "auth one"]);
    expect(titles(list({ agent: ["reviewer", "builder"] }))).toEqual([
      "reviewer",
      "side",
      "auth two",
      "billing",
      "auth one",
    ]);
    expect(titles(list({ session: "builder/main" }))).toEqual(["auth two", "billing", "auth one"]);
    expect(titles(list({ session: ["builder/side", "reviewer/main"] }))).toEqual([
      "reviewer",
      "side",
    ]);
    // Agents and sessions are two filters, so both must keep a thread.
    expect(titles(list({ agent: "reviewer", session: ["builder/side", "reviewer/main"] }))).toEqual(
      ["reviewer"],
    );
    expect(titles(list({ agent: "reviewer", session: "builder/main" }))).toEqual([]);
    expect(titles(list({ agent: "nobody" }))).toEqual([]);
  });

  it("keeps the threads on any of the topics given, each of its own session", () => {
    const narrowed = list({ topic: "builder/main/auth" });
    expect(titles(narrowed)).toEqual(["auth two", "auth one"]);
    expect(narrowed.total).toBe(2);
    expect(titles(list({ topic: ["builder/side/auth", "builder/main/auth"] }))).toEqual([
      "side",
      "auth two",
      "auth one",
    ]);
    expect(titles(list({ topic: ["builder/main/auth", "builder/main/billing"] }))).toEqual([
      "auth two",
      "billing",
      "auth one",
    ]);
    expect(list({ topic: "reviewer/main/auth" }).total).toBe(0);
  });

  it("keeps topics as one filter, which every other filter narrows", () => {
    const topics = ["builder/main/auth", "builder/side/auth"];
    expect(titles(list({ topic: topics, session: "builder/side" }))).toEqual(["side"]);
    expect(titles(list({ topic: topics, agent: "reviewer" }))).toEqual([]);
    expect(titles(list({ topic: topics, search: "two" }))).toEqual(["auth two"]);
  });

  it("combines with the filters and archived threads", () => {
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "Seen." });
    archiveThread(fixture.store, fixture.operator, threadTarget(agent, 3), { through: 2 });
    const narrowed = { agent: "builder", topic: "builder/main/auth" };
    expect(titles(list({ ...narrowed, unread: "true" }))).toEqual([]);
    // Archived without being read, auth two holds nothing unread.
    expect(titles(list({ ...narrowed, include_archived: "true", unread: "true" }))).toEqual([]);
    expect(titles(list({ ...narrowed, include_archived: "true" }))).toEqual([
      "auth one",
      "auth two",
    ]);
    expect(list({ ...narrowed, include_archived: "true" }).total).toBe(2);
  });

  it("keeps a topic as the threads carry it now", () => {
    fixture.write(agent.identity, threadTarget(agent, 2), { topic: "auth" });
    expect(titles(list({ topic: "builder/main/auth" }))).toEqual([
      "billing",
      "auth two",
      "auth one",
    ]);
    expect(list({ topic: "builder/main/billing" }).total).toBe(0);
  });

  it("keeps a topic within the agent's own session", () => {
    const page = listSessionThreads(
      fixture.store,
      agent.identity,
      agent.target,
      sessionThreadsQuery.parse({ topic: "auth" }),
    );
    expect(titles(page)).toEqual(["auth two", "auth one"]);
  });

  it("never reaches another session for an agent", () => {
    const page = listThreads(fixture.store, side.identity, threadsQuery.parse({}));
    expect(titles(page)).toEqual(["side"]);
  });
});

describe("positions", () => {
  // agentCursors lists one session's threads a thread at a time, in an
  // instance where another session started the given number of threads
  // first, and collects the positions it is given.
  function agentCursors(elsewhere: number, query: Record<string, string>): string[] {
    const instance = new Fixture();
    try {
      if (elsewhere > 0) {
        const other = instance.registerAgent("reviewer", "main");
        for (let i = 0; i < elsewhere; i++) {
          instance.createThread(other);
        }
      }
      const own = instance.registerAgent("builder", "main");
      for (const priority of ["high", "high", "low"]) {
        instance.advance(1);
        instance.createThread(own, { asks: [{ question: "q", priority }] });
        instance.createThread(own);
      }
      const cursors: string[] = [];
      let cursor: string | undefined;
      do {
        const page = listSessionThreads(
          instance.store,
          own.identity,
          own.target,
          sessionThreadsQuery.parse({ ...query, limit: "1", ...(cursor ? { cursor } : {}) }),
        );
        cursor = page.next;
        if (cursor !== undefined) {
          cursors.push(cursor);
        }
      } while (cursor !== undefined);
      return cursors;
    } finally {
      instance.close();
    }
  }

  it.each([{}, { status: "open" }])(
    "the positions a session's list %j gives out say nothing about other sessions",
    (query) => {
      const alone = agentCursors(0, query);
      expect(alone.length).toBeGreaterThan(1);
      expect(agentCursors(5, query)).toEqual(alone);
    },
  );
});

describe("topic counts", () => {
  it("list topics by their session's name, then their own, then their agent's", () => {
    // Any other order of the three puts these differently.
    const places: [string, string, string][] = [
      ["zed", "alpha", "able"],
      ["mike", "alpha", "mid"],
      ["bravo", "alpha", "mid"],
      ["able", "zulu", "ace"],
    ];
    for (const [name, session, topic] of places) {
      start(`${name} on ${topic}`, { topic }, fixture.registerAgent(name, session));
    }
    const counts = countThreads(fixture.store, fixture.operator, threadFilters.parse({}));
    expect(counts.topic.topics.map((each) => [each.session, each.topic, each.agent])).toEqual([
      ["alpha", "able", "zed"],
      ["alpha", "mid", "bravo"],
      ["alpha", "mid", "mike"],
      ["zulu", "ace", "able"],
    ]);
  });
});

describe("counts and groups", () => {
  beforeEach(() => {
    // Sessions go quiet only after a month here, so the hours that pass
    // between pages leave every session's presence as it was.
    fixture.close();
    fixture = new Fixture({ quietAfter: 30 * 24 * hour });
    agent = fixture.registerAgent("builder", "main");
    const side = fixture.registerAgent("builder", "side");
    const reviewer = fixture.registerAgent("reviewer", "main");
    fixture.seen(agent);
    fixture.seen(side);
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    start("urgent blocking", {
      topic: "auth",
      asks: [{ question: "q", priority: "urgent", impact: "blocking", effort: "quick" }],
    });
    start("high overdue", {
      topic: "auth",
      asks: [{ question: "q", priority: "high", answer_by: at(1), effort: "under_1h" }],
    });
    // Asks whose properties no one ask holds together, two in one message and
    // one in a later message.
    start("normal assuming, low blocking", {
      topic: "billing",
      asks: [
        { question: "q", impact: "assuming", effort: "under_15m" },
        { question: "q2", priority: "low", impact: "blocking" },
      ],
    });
    fixture.write(agent.identity, threadTarget(agent, 3), {
      asks: [{ question: "q3", priority: "high", effort: "longer" }],
    });
    start("plain");
    start("answered", { topic: "billing", asks: [{ question: "q" }] });
    fixture.write(fixture.operator, threadTarget(agent, 5), {
      answers: [{ ask: 1, declined: true }],
    });
    start("withdrawn", { asks: [{ question: "q", priority: "urgent" }] });
    fixture.write(agent.identity, threadTarget(agent, 6), {
      withdrawals: [{ ask: 1, reason: "Settled elsewhere." }],
    });
    // Unread by a session that is not quiet, so not stranded.
    start("main written to");
    fixture.write(fixture.operator, threadTarget(agent, 7), { text: "Noted." });
    start("side ask", { topic: "auth", asks: [{ question: "q", effort: "longer" }] }, side);
    start("side archived", {}, side);
    archiveThread(fixture.store, fixture.operator, threadTarget(side, 2), { through: 1 });
    // A topic holding an archived thread beside one that is not.
    start("side auth archived", { topic: "auth" }, side);
    archiveThread(fixture.store, fixture.operator, threadTarget(side, 3), { through: 1 });
    start("reviewer read", {}, reviewer);
    markRead(fixture.store, fixture.operator, threadTarget(reviewer, 1), { through: 1 });
    // Stranded, by a session never seen.
    start("reviewer written to", {}, reviewer);
    fixture.write(fixture.operator, threadTarget(reviewer, 2), { text: "Noted." });
    // Stranded, by a session with no active credential.
    fixture.write(fixture.operator, threadTarget(side, 1), { text: "Over to you." });
    revokeRegistration(fixture.store, fixture.operator, side.registrationId);
    // builder/side and reviewer/main in one group, its id 1, and builder/main
    // in none; builder's tag counting for both its sessions, and the
    // sessions' own.
    const { id } = createGroup(fixture.store, fixture.operator, { name: "Work" });
    createGroup(fixture.store, fixture.operator, { name: "Empty" });
    for (const session of [side, reviewer]) {
      setSessionGroup(fixture.store, fixture.operator, session.target, { group: id });
    }
    setAgentTags(fixture.store, fixture.operator, "builder", { tags: ["infra"] });
    setSessionTags(fixture.store, fixture.operator, side.target, { tags: ["infra", "ops"] });
    setSessionTags(fixture.store, fixture.operator, reviewer.target, { tags: ["ops"] });
    fixture.advance(2 * hour);
  });

  const queries: Query[] = [
    {},
    { unread: "true" },
    { status: "open" },
    { status: "answered" },
    { status: "withdrawn", unread: "true" },
    { status: "none" },
    { status: "answered", priority: "high" },
    { priority: "high" },
    { impact: "blocking" },
    { effort: "under_15m", unread: "true" },
    { overdue: "true" },
    { priority: "normal", impact: "blocking" },
    { agent_read: "unread" },
    { agent_read: "stranded" },
    { agent_read: "stranded", agent: "builder" },
    { status: "none", effort: "quick" },
    { agent: "builder" },
    { agent: ["builder", "reviewer"], status: "open" },
    { topic: "builder/main/auth" },
    { topic: ["builder/main/auth", "builder/side/auth"], include_archived: "true" },
    { session: "builder/side", topic: "builder/main/billing" },
    { session: ["builder/main", "builder/side"], include_archived: "true" },
    { agent: "reviewer", session: "builder/side" },
    { search: "side", include_archived: "true" },
  ];

  // Queries on the session groups and tags, which the counts check beside
  // the others; the folds check groups through the queries above.
  const organizing: Query[] = [
    { session_group: "1" },
    { session_group: "none", status: "open" },
    { session_group: ["none", "1"], agent: "builder" },
    // A group no longer there keeps nothing.
    { session_group: "9" },
    { tag: "infra" },
    { tag: ["ops", "gone"], unread: "true" },
    { tag: "ops", session_group: "1", include_archived: "true" },
  ];

  const asksOff = {
    priority: undefined,
    impact: undefined,
    overdue: undefined,
    effort: undefined,
  };

  it.each([...queries, ...organizing])(
    "count for %j what each value keeps with every other filter as it is",
    (query) => {
      const counts = countThreads(fixture.store, fixture.operator, threadFilters.parse(query));
      const total = (change: Query) => list({ ...query, ...change }).total;
      // A filter taking one value counts what the list would hold with it
      // chosen; every status but open turns off the properties of open asks
      // too, and a property of open asks chooses open.
      expect(counts.status).toEqual({
        any: total({ status: undefined, ...asksOff }),
        open: total({ status: "open" }),
        answered: total({ status: "answered", ...asksOff }),
        withdrawn: total({ status: "withdrawn", ...asksOff }),
        none: total({ status: "none", ...asksOff }),
      });
      const open = { status: "open" };
      expect(counts.priority).toEqual({
        any: total({ priority: undefined }),
        normal: total({ priority: "normal", ...open }),
        high: total({ priority: "high", ...open }),
        urgent: total({ priority: "urgent", ...open }),
      });
      expect(counts.impact).toEqual({
        any: total({ impact: undefined }),
        blocking: total({ impact: "blocking", ...open }),
        assuming: total({ impact: "assuming", ...open }),
      });
      expect(counts.overdue).toEqual({
        any: total({ overdue: undefined }),
        overdue: total({ overdue: "true", ...open }),
      });
      expect(counts.effort).toEqual({
        any: total({ effort: undefined }),
        quick: total({ effort: "quick", ...open }),
        under_15m: total({ effort: "under_15m", ...open }),
        under_1h: total({ effort: "under_1h", ...open }),
      });
      expect(counts.unread).toEqual({
        any: total({ unread: undefined }),
        unread: total({ unread: "true" }),
      });
      expect(counts.agent_read).toEqual({
        any: total({ agent_read: undefined }),
        unread: total({ agent_read: "unread" }),
        stranded: total({ agent_read: "stranded" }),
      });
      expect(counts.include_archived).toEqual({
        hide: total({ include_archived: undefined }),
        show: total({ include_archived: "true" }),
      });
      // Each agent, session and topic holding a thread, in name order, counts
      // what it keeps on its own, whichever of its kind are chosen.
      expect(counts.agent).toEqual({
        agents: ["builder", "reviewer"].map((name) => ({
          agent: name,
          total: total({ agent: name }),
        })),
        truncated: false,
      });
      expect(counts.session).toEqual({
        sessions: ["builder/main", "reviewer/main", "builder/side"].map((path) => {
          const [name, session] = path.split("/");
          return { agent: name, session, total: total({ session: path }) };
        }),
        truncated: false,
      });
      // Topics come by their session's name, their own and their agent's,
      // archived threads' included, each counting what the list would hold
      // with that topic alone chosen, none included.
      const held = list({ include_archived: "true", limit: "100" }).threads.flatMap((thread) =>
        thread.topic === undefined ? [] : [[thread.session, thread.topic, thread.agent].join(" ")],
      );
      expect(counts.topic).toEqual({
        topics: [...new Set(held)].sort().map((key) => {
          const [session = "", topic = "", name = ""] = key.split(" ");
          return {
            agent: name,
            session,
            topic,
            total: total({ topic: `${name}/${session}/${topic}` }),
          };
        }),
        truncated: false,
      });
      // Each group holding a thread, in name order, and no group, counts
      // what it keeps on its own; so does each tag carried by a session
      // holding a thread or by its agent.
      expect(counts.session_group).toEqual({
        groups: [{ id: 1, name: "Work", total: total({ session_group: "1" }) }],
        none: total({ session_group: "none" }),
      });
      expect(counts.tag).toEqual({
        tags: ["infra", "ops"].map((tag) => ({ tag, total: total({ tag }) })),
        truncated: false,
      });
      expect(counts.reset).toBe(list().total);
    },
  );

  it("keep a thread when its session or its agent carries a chosen tag", () => {
    const sessionsOf = (query: Query) =>
      [
        ...new Set(
          list({ ...query, include_archived: "true", limit: "100" }).threads.map(
            (thread) => `${thread.agent}/${thread.session}`,
          ),
        ),
      ].sort();
    expect(sessionsOf({ tag: "infra" })).toEqual(["builder/main", "builder/side"]);
    expect(sessionsOf({ tag: "ops" })).toEqual(["builder/side", "reviewer/main"]);
    expect(sessionsOf({ tag: ["infra", "ops"] })).toEqual([
      "builder/main",
      "builder/side",
      "reviewer/main",
    ]);
    expect(sessionsOf({ session_group: "none" })).toEqual(["builder/main"]);
    // Each thread carries its session's group.
    const groupOf = list({ include_archived: "true", limit: "100" }).threads.map((thread) => [
      thread.session === "main" && thread.agent === "builder",
      thread.group,
    ]);
    expect(new Set(groupOf.map(([main, group]) => JSON.stringify([main, group])))).toEqual(
      new Set([
        JSON.stringify([true, undefined]),
        JSON.stringify([false, { id: 1, name: "Work" }]),
      ]),
    );
  });

  // fold groups the list's threads, in the list's order, by the session's
  // group, then session and then topic, by session and then topic, or by
  // agent and then session, rolling each group up from its threads: each
  // group in the order of its first thread, and grouped by session group or
  // by session, each topic within it.
  function fold(threads: ListedThread[], grouping: ThreadGrouping) {
    const rollupOf = (held: ListedThread[]): Rollup => {
      const ranks = ["urgent", "high", "normal", "low"] as const;
      const highest = ranks.find((rank) => held.some((each) => each.open_asks.priority === rank));
      return {
        threads: held.length,
        unread: held.filter((each) => each.unread > 0).length,
        blocked: held.some((each) => each.open_asks.blocking),
        ...(highest === undefined ? {} : { priority: highest }),
        archived: held.every((each) => each.archived),
      };
    };
    const gather = <K>(held: ListedThread[], key: (thread: ListedThread) => K) => {
      const groups = new Map<K, ListedThread[]>();
      for (const thread of held) {
        groups.set(key(thread), [...(groups.get(key(thread)) ?? []), thread]);
      }
      return [...groups.values()];
    };
    const path = (thread: ListedThread) => `${thread.agent}/${thread.session}`;
    const byTopic = grouping !== "agent";
    const [outer, inner] = byTopic
      ? [path, (thread: ListedThread) => thread.topic]
      : [(thread: ListedThread) => thread.agent, path];
    // Grouped by session group, the groups come first, each placed by its
    // first thread.
    const placed =
      grouping === "session_group" ? gather(threads, (thread) => thread.group?.id).flat() : threads;
    const nested = gather(placed, outer).map((group) => gather(group, inner));
    const sessions = (byTopic ? nested : nested.flat().map((each) => [each])).map((groups) => {
      const [first] = groups.flat();
      return {
        agent: first?.agent,
        session: first?.session,
        ...(first?.group === undefined ? {} : { group: first.group }),
        rollup: rollupOf(groups.flat()),
        presence: first?.presence,
        ...(byTopic
          ? {
              topics: gather(groups.flat(), (thread) => thread.topic).map((held) => ({
                ...(held[0]?.topic === undefined ? {} : { topic: held[0].topic }),
                rollup: rollupOf(held),
              })),
            }
          : {}),
      };
    });
    return { threads: nested.flat(2), sessions };
  }

  // pages reads a list a page of two at a time, letting time pass between
  // pages, and collects its threads and the roll-ups each page carries.
  function pages(query: Query) {
    const threads: ListedThread[] = [];
    const groups: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = list({ ...query, limit: "2", ...(cursor === undefined ? {} : { cursor }) });
      threads.push(...page.threads);
      groups.push(page.groups);
      cursor = page.next;
      fixture.advance(2 * hour);
    } while (cursor !== undefined);
    return { threads, groups };
  }

  // Every other query is reversed, so each sort and grouping folds both ways.
  it.each(
    queries.flatMap((query, index) =>
      ["priority", "due", "effort", "latest", "created"].flatMap((sort) =>
        threadGrouping.options.map((group) => ({
          ...query,
          sort,
          reverse: String(index % 2 === 1),
          group,
        })),
      ),
    ),
  )("group %j as a fold over the list, a group's threads together across pages", (query) => {
    const { group, ...flat } = query;
    const folded = fold(list({ ...flat, limit: "100" }).threads, group);
    const grouped = pages(query);
    const key = (thread: ThreadSummary) => `${thread.agent}/${thread.session}/${thread.number}`;
    expect(grouped.threads.map(key)).toEqual(folded.threads.map(key));
    for (const each of grouped.groups) {
      expect(each).toEqual({ sessions: folded.sessions, truncated: false });
    }
  });

  it("compose a session's roll-up from its topics' as an agent's composes from its sessions'", () => {
    const sessions = list({ include_archived: "true", group: "session" }).groups?.sessions ?? [];
    expect(sessions.length).toBe(3);
    for (const session of sessions) {
      expect(composeRollup((session.topics ?? []).map((topic) => topic.rollup))).toEqual(
        session.rollup,
      );
    }
    const builder = sessions.filter((each) => each.agent === "builder");
    expect(composeRollup(builder.map((each) => each.rollup))).toEqual({
      threads: 10,
      unread: 5,
      blocked: true,
      priority: "urgent",
      archived: false,
    });
    // An agent is quiet only while all its sessions are, and was last seen
    // when the latest of them was.
    expect(composePresence(builder.map((each) => each.presence))).toEqual({
      last_seen_at: new Date(began).toISOString(),
      quiet: false,
    });
    const reviewer = sessions.filter((each) => each.agent === "reviewer");
    expect(composePresence(reviewer.map((each) => each.presence))).toEqual({ quiet: true });
  });

  it("refuse a cursor another grouping gave out", () => {
    const refused = (from: Query, under: Query) => {
      const { next } = list({ ...from, limit: "1" });
      let refusal: unknown;
      try {
        list({ ...under, cursor: next ?? "" });
      } catch (error) {
        refusal = error;
      }
      return refusal;
    };
    for (const [from, under] of [
      [{}, { group: "session" }],
      [{ group: "session" }, {}],
      [{ group: "session" }, { group: "agent" }],
      [{ group: "session_group" }, { group: "session" }],
      [{ group: "session" }, { group: "session_group" }],
      [{ group: "agent", sort: "due" }, { group: "agent" }],
      [{ group: "session", reverse: "true" }, { group: "session" }],
      [{ group: "session" }, { group: "session", reverse: "true" }],
      [{ group: "agent", reverse: "true" }, { reverse: "true" }],
    ] as Query[][]) {
      expect(refused(from ?? {}, under ?? {})).toMatchObject({
        code: "invalid_input",
        field: "cursor",
      });
    }
    expect(refused({ group: "agent" }, { group: "agent" })).toBeUndefined();
    expect(
      refused({ group: "agent", reverse: "true" }, { group: "agent", reverse: "true" }),
    ).toBeUndefined();
  });
});

describe("grouped pages as the list changes", () => {
  let side: Agent;
  let reviewer: Agent;

  // Three sessions of two threads each, grouped by session in the latest
  // order, each session placed by its newest thread: builder/main's, then
  // builder/side's, then reviewer/main's.
  beforeEach(() => {
    side = fixture.registerAgent("builder", "side");
    reviewer = fixture.registerAgent("reviewer", "main");
    start("r1", {}, reviewer);
    start("m1");
    start("s1", {}, side);
    start("r2", {}, reviewer);
    start("s2", {}, side);
    start("m2");
  });

  const grouped = { sort: "latest", group: "session" };
  const firstPage = () => list({ ...grouped, limit: "3" });
  const rest = (cursor: string | undefined) => titles(list({ ...grouped, cursor }));
  // What a cursor holds: the list it names and the keys of its position.
  const opened = (cursor: string | undefined) =>
    JSON.parse(Buffer.from(cursor ?? "", "base64url").toString("utf8")) as [string, ...number[]];

  // inGroups puts each session in a group of its own, so each group is placed
  // by its session's newest thread.
  const inGroups = () => {
    for (const session of [agent, side, reviewer]) {
      const { id } = createGroup(fixture.store, fixture.operator, {
        name: `${session.target.agent}/${session.target.session}`,
      });
      setSessionGroup(fixture.store, fixture.operator, session.target, { group: id });
    }
  };

  // The same changes, under any grouping: reviewer/main's newest thread
  // now leads the list, ahead of the cursor, and archiving m2 places
  // builder/main by m1, behind it.
  const change = () => {
    fixture.advance(1);
    fixture.write(reviewer.identity, threadTarget(reviewer, 1), { text: "More." });
    archiveThread(fixture.store, fixture.operator, threadTarget(agent, 2), { through: 1 });
  };

  it("continue the cursor's group as changes move other groups around it, and are whole again from the first", () => {
    const page = firstPage();
    expect(titles(page)).toEqual(["m2", "m1", "s2"]);
    change();
    expect(rest(page.next)[0]).toBe("s1");
    expect(titles(list(grouped))).toEqual(["r1", "r2", "s2", "s1", "m1"]);
  });

  it("place a session's group by its first thread, as a session is placed", () => {
    inGroups();
    const byGroup = { ...grouped, group: "session_group" };
    const page = list({ ...byGroup, limit: "3" });
    expect(titles(page)).toEqual(["m2", "m1", "s2"]);
    change();
    expect(titles(list({ ...byGroup, cursor: page.next }))[0]).toBe("s1");
    expect(titles(list(byGroup))).toEqual(["r1", "r2", "s2", "s1", "m1"]);
  });

  it("place no group as a group of its own, and leave the session grouping as it is", () => {
    const before = firstPage();
    setSessionGroup(fixture.store, fixture.operator, side.target, {
      group: createGroup(fixture.store, fixture.operator, { name: "Side" }).id,
    });
    // The session grouping holds the session's and topic's places alone, so a
    // session going into a group leaves its positions as they were.
    const [name, ...position] = opened(firstPage().next);
    expect([name, position.length]).toEqual(["threads.latest.own.session", 24]);
    expect(rest(before.next)).toEqual(["s1", "r2", "r1"]);
    // Grouped by session group, the group's place joins them; with
    // builder/side in a group and the rest in none, no group is placed by
    // m2 and Side by s2.
    const byGroup = { ...grouped, group: "session_group" };
    const [nameByGroup, ...positionByGroup] = opened(list({ ...byGroup, limit: "3" }).next);
    expect([nameByGroup, positionByGroup.length]).toEqual(["threads.latest.own.session_group", 32]);
    expect(titles(list(byGroup))).toEqual(["m2", "m1", "r2", "r1", "s2", "s1"]);
  });
});

// Building past each bound through the real write paths takes seconds.
describe("bounds", { timeout: 30_000 }, () => {
  it(`counts and rolls up at most ${maxListed} agents and sessions, saying when it leaves any out`, () => {
    for (let index = 0; index <= maxListed; index++) {
      start(
        `thread ${index}`,
        {},
        fixture.registerAgent(`agent-${String(index).padStart(3, "0")}`, "main"),
      );
    }
    const counts = countThreads(fixture.store, fixture.operator, threadFilters.parse({}));
    expect(counts.agent.agents.length).toBe(maxListed);
    expect(counts.agent.agents[0]).toEqual({ agent: "agent-000", total: 1 });
    expect(counts.agent.truncated).toBe(true);
    expect(counts.session.sessions.length).toBe(maxListed);
    expect(counts.session.truncated).toBe(true);
    // The first sessions in the list's order, the newest under no asks.
    const { groups, total } = list({ group: "session" });
    expect(total).toBe(maxListed + 1);
    expect(groups?.sessions.length).toBe(maxListed);
    expect(groups?.sessions[0]?.agent).toBe(`agent-${maxListed}`);
    expect(groups?.truncated).toBe(true);
    expect(list({ group: "agent", agent: "agent-000" }).groups?.truncated).toBe(false);
  });

  it(`counts and rolls up at most ${maxListed} topics, saying when it leaves any out`, () => {
    for (let index = 0; index <= maxListed; index++) {
      start(`thread ${index}`, { topic: `topic-${String(index).padStart(3, "0")}` });
    }
    const counts = countThreads(fixture.store, fixture.operator, threadFilters.parse({}));
    expect(counts.topic.topics.length).toBe(maxListed);
    expect(counts.topic.topics[0]).toEqual({
      agent: "builder",
      session: "main",
      topic: "topic-000",
      total: 1,
    });
    expect(counts.topic.truncated).toBe(true);
    const { groups } = list({ group: "session" });
    expect(groups?.sessions[0]?.rollup.threads).toBe(maxListed + 1);
    expect(groups?.sessions[0]?.topics?.length).toBe(maxListed);
    expect(groups?.truncated).toBe(true);
  });
});
