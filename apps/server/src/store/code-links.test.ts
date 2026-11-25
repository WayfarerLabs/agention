import {
  agentMessageSendInput,
  maxListed,
  maxLinks,
  sessionThreadsQuery,
  threadFilters,
  threadsQuery,
  type ThreadSummary,
  threadsView,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";
import {
  countThreads,
  findThreadNeighbors,
  listSessionThreads,
  listThreads,
} from "./thread-lists.ts";
import { pollEverySession, pollThreads } from "./wait.ts";
import { sendMessage } from "./threads.ts";

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
const read = (number = 1) => fixture.thread(fixture.operator, target(number));
const rollup = (number = 1) => {
  const { pull_requests: pulls, branches } = read(number);
  return { pull_requests: pulls, branches };
};

const pr135 = {
  repo: "Acme/Agention",
  number: 135,
  url: "https://github.com/Acme/agention/pull/135",
};
const pr136 = { repo: "acme/agention", number: 136 };
const feature = { repo: "acme/agention", branch: "feat/links" };

// listed lists the session's threads by the filters given, as their numbers.
function listed(filters: Record<string, string>): number[] {
  return listSessionThreads(
    fixture.store,
    agent.identity,
    agent.target,
    sessionThreadsQuery.parse(filters),
  )
    .threads.map((thread) => thread.number)
    .sort();
}

describe("a message's pull requests and branches", () => {
  it("are read back as written, in order, and only on the messages naming them", () => {
    fixture.createThread(agent, { pull_requests: [pr135, pr136], branches: [feature] });
    fixture.write(agent.identity, target(), { text: "No links." });
    const [first, second] = read().messages;
    expect(first).toMatchObject({ pull_requests: [pr135, pr136], branches: [feature] });
    expect(second).not.toHaveProperty("pull_requests");
    expect(second).not.toHaveProperty("branches");
  });

  it("make a message of their own, and either party may write them", () => {
    fixture.createThread(agent, { text: "Start." });
    fixture.write(fixture.operator, target(), { branches: [feature] });
    expect(read().messages[1]).toMatchObject({ author: { kind: "person" }, branches: [feature] });
  });

  it("join the write's digest, so a retry replays and a changed one is refused", () => {
    fixture.createThread(agent, { text: "Start." });
    const input = (pulls: unknown[]) => ({
      request_id: "same",
      seen_through: 1,
      text: "Links.",
      pull_requests: pulls,
    });
    const write = (pulls: unknown[]) =>
      sendMessage(
        fixture.store,
        agent.identity,
        target(),
        agentMessageSendInput.parse(input(pulls)),
      );
    expect(write([pr135])).toEqual({ number: 1, seq: 2 });
    expect(write([pr135])).toEqual({ number: 1, seq: 2 });
    expect(() => write([pr136])).toThrow(/different write/);
  });

  it("are kept for good with their message", () => {
    fixture.createThread(agent, { pull_requests: [pr135] });
    expect(() => fixture.db.prepare("DELETE FROM message_links").run()).toThrow(/append-only/);
    expect(() => fixture.db.prepare("UPDATE message_links SET repo = 'x/y'").run()).toThrow(
      /append-only/,
    );
  });
});

describe("a thread's roll-up", () => {
  it("is empty for a thread naming none", () => {
    fixture.createThread(agent, { text: "Start." });
    expect(rollup()).toEqual({
      pull_requests: { links: [], truncated: false },
      branches: { links: [], truncated: false },
    });
  });

  it("drops what only a replaced message names, and keeps what its replacement names again", () => {
    fixture.createThread(agent, { text: "Start." });
    fixture.write(agent.identity, target(), { pull_requests: [pr135], branches: [feature] });
    fixture.write(agent.identity, target(), {
      replaces: 2,
      pull_requests: [pr136],
      branches: [feature],
    });
    expect(rollup()).toEqual({
      pull_requests: { links: [pr136], truncated: false },
      branches: { links: [feature], truncated: false },
    });
    // The replaced message keeps its own lists.
    expect(read().messages[1]).toMatchObject({ live: false, pull_requests: [pr135] });
  });

  it("lists each entry once, as its latest live mention wrote it, with the latest URL given", () => {
    const url = "https://github.com/acme/agention/pull/135";
    fixture.createThread(agent, { pull_requests: [{ ...pr135, url }] });
    fixture.write(agent.identity, target(), {
      pull_requests: [{ repo: "ACME/AGENTION", number: 135 }],
    });
    expect(rollup().pull_requests).toEqual({
      links: [{ repo: "ACME/AGENTION", number: 135, url }],
      truncated: false,
    });
    const later = "https://github.com/acme/agention/pull/135/files";
    fixture.write(fixture.operator, target(), {
      pull_requests: [{ repo: "acme/agention", number: 135, url: later }],
    });
    expect(rollup().pull_requests.links).toEqual([
      { repo: "acme/agention", number: 135, url: later },
    ]);
  });

  it("meets owners differing only in case, and keeps branches differing only in case apart", () => {
    fixture.createThread(agent, {
      branches: [
        { repo: "Acme/Agention", branch: "Main" },
        { repo: "Acme/Agention", branch: "main" },
      ],
    });
    fixture.write(agent.identity, target(), {
      branches: [{ repo: "acme/agention", branch: "main" }],
    });
    expect(rollup().branches.links).toEqual([
      { repo: "acme/agention", branch: "main" },
      { repo: "Acme/Agention", branch: "Main" },
    ]);
  });

  it("lists the most recently mentioned first, a message's own in its order", () => {
    fixture.createThread(agent, { pull_requests: [pr135, pr136] });
    fixture.write(agent.identity, target(), {
      pull_requests: [{ repo: "acme/agention", number: 1 }, pr136],
    });
    expect(rollup().pull_requests.links.map((link) => link.number)).toEqual([1, 136, 135]);
  });

  it(`lists at most ${maxListed} of each, saying when it leaves the oldest out`, () => {
    fixture.createThread(agent, { text: "Start." });
    const messages = Math.ceil((maxListed + 1) / maxLinks);
    for (let index = 0; index < messages; index++) {
      fixture.write(agent.identity, target(), {
        pull_requests: Array.from({ length: maxLinks }, (_, each) => ({
          repo: "o/r",
          number: index * maxLinks + each + 1,
        })),
      });
    }
    const { links, truncated } = rollup().pull_requests;
    expect([links.length, truncated]).toEqual([maxListed, true]);
    expect(links[0]?.number).toBe((messages - 1) * maxLinks + 1);
    expect(links.some((link) => link.number === 1)).toBe(false);
  });
});

describe("a session's list by pull request and branch", () => {
  it("keeps exactly the threads whose roll-up names the entry", () => {
    fixture.createThread(agent, { pull_requests: [pr135], branches: [feature] });
    fixture.createThread(agent, { text: "Two." });
    fixture.write(agent.identity, target(2), { pull_requests: [pr135] });
    fixture.write(agent.identity, target(2), { replaces: 2, text: "Not about it after all." });
    fixture.createThread(agent, { branches: [{ repo: "acme/agention", branch: "Feat/Links" }] });
    expect(listed({ pull_request: "acme/AGENTION#135" })).toEqual([1]);
    expect(listed({ pull_request: "acme/agention#136" })).toEqual([]);
    expect(listed({ branch: "ACME/agention:feat/links" })).toEqual([1]);
    expect(listed({ branch: "acme/agention:Feat/Links" })).toEqual([3]);
    expect(
      listed({ pull_request: "acme/agention#135", branch: "acme/agention:Feat/Links" }),
    ).toEqual([]);
  });
});

describe("a thread's summary", () => {
  const links = (number = 1) => read(number).thread.links;

  it("counts none for a thread naming none", () => {
    fixture.createThread(agent, { text: "Start." });
    expect(links()).toEqual({ pull_requests: 0, branches: 0 });
  });

  it("gives the one entry, as the roll-up lists it, while the thread names only one", () => {
    const url = "https://github.com/acme/agention/pull/135";
    fixture.createThread(agent, { pull_requests: [{ ...pr135, url }] });
    fixture.write(agent.identity, target(), {
      pull_requests: [{ repo: "ACME/AGENTION", number: 135 }],
    });
    const only = { repo: "ACME/AGENTION", number: 135, url };
    expect(links()).toEqual({ pull_requests: 1, branches: 0, pull_request: only });
    expect(rollup().pull_requests.links).toEqual([only]);
    fixture.createThread(agent, { branches: [feature] });
    expect(links(2)).toEqual({ pull_requests: 0, branches: 1, branch: feature });
  });

  it("counts each kind's distinct entries, with no entry once there are two", () => {
    fixture.createThread(agent, { pull_requests: [pr135], branches: [feature] });
    fixture.write(agent.identity, target(), { pull_requests: [pr135, pr136] });
    expect(links()).toEqual({ pull_requests: 2, branches: 1 });
  });

  it("counts only what live messages name", () => {
    fixture.createThread(agent, { text: "Start." });
    fixture.write(agent.identity, target(), { pull_requests: [pr135, pr136] });
    fixture.write(agent.identity, target(), { replaces: 2, pull_requests: [pr136] });
    expect(links()).toEqual({ pull_requests: 1, branches: 0, pull_request: pr136 });
  });

  it("is the same in every list and wait that carries the summary", () => {
    fixture.createThread(agent, { pull_requests: [pr135] });
    // The operator waits for the agent's message, and the agent for the
    // operator's.
    const operatorWait = pollEverySession(fixture.store, fixture.operator, 0, 50);
    fixture.write(fixture.operator, target(), { text: "Seen it." });
    const expected = { pull_requests: 1, branches: 0, pull_request: pr135 };
    const session = listSessionThreads(
      fixture.store,
      agent.identity,
      agent.target,
      sessionThreadsQuery.parse({}),
    );
    // A thread naming none, which the thread naming one is listed below.
    fixture.createThread(agent, { text: "Beside it." });
    const neighbors = findThreadNeighbors(
      fixture.store,
      fixture.operator,
      target(2),
      threadsView.parse({ sort: "created" }),
    );
    expect(neighbors.below?.number).toBe(1);
    const first = (threads: ThreadSummary[]) => threads.find((each) => each.number === 1);
    const summaries = [
      first(session.threads),
      first(operatorList({}).threads),
      neighbors.below,
      pollThreads(fixture.store, agent.identity, agent.target, 0, 50).result.threads[0],
      operatorWait.result.threads[0],
    ];
    for (const summary of summaries) {
      expect(summary?.links).toEqual(expected);
    }
  });
});

// operatorList lists the operator's threads by the query given, as its route
// reads it.
function operatorList(query: Record<string, string | string[]>) {
  return listThreads(fixture.store, fixture.operator, threadsQuery.parse(query));
}

const numbers = (query: Record<string, string | string[]>) =>
  operatorList(query)
    .threads.map((thread) => `${thread.session}/${thread.number}`)
    .sort();

describe("the operator's list by pull request and branch", () => {
  it("keeps the threads of every session naming any of the entries chosen", () => {
    const other = fixture.registerAgent("reviewer", "side");
    fixture.createThread(agent, { pull_requests: [pr135] });
    fixture.createThread(agent, { pull_requests: [pr136], branches: [feature] });
    fixture.createThread(other, { pull_requests: [{ repo: "acme/agention", number: 135 }] });
    fixture.createThread(agent, { text: "None." });
    expect(numbers({ pull_request: "acme/agention#135" })).toEqual(["main/1", "side/1"]);
    expect(numbers({ pull_request: ["acme/agention#135", "acme/agention#136"] })).toEqual([
      "main/1",
      "main/2",
      "side/1",
    ]);
    expect(numbers({ branch: "Acme/Agention:feat/links" })).toEqual(["main/2"]);
    expect(
      numbers({ pull_request: "acme/agention#135", branch: "acme/agention:feat/links" }),
    ).toEqual([]);
  });

  it("refuses a short form that does not parse, and an entry named twice", () => {
    for (const query of [
      { pull_request: "acme/agention" },
      { branch: "acme/agention:a..b" },
      { pull_request: ["acme/agention#1", "Acme/Agention#1"] },
      { branch: ["acme/agention:main", "acme/agention:main"] },
    ]) {
      expect([query, threadsQuery.safeParse(query).success]).toEqual([query, false]);
    }
    expect(
      threadsQuery.safeParse({ branch: ["acme/agention:main", "acme/agention:Main"] }).success,
    ).toBe(true);
  });
});

describe("the counts of pull requests and branches", () => {
  const counts = (query: Record<string, string | string[] | boolean> = {}) =>
    countThreads(fixture.store, fixture.operator, threadFilters.parse(query));

  it("count the distinct threads naming each entry, as its latest mention wrote it", () => {
    fixture.createThread(agent, { pull_requests: [pr135], branches: [feature] });
    fixture.write(agent.identity, target(), { pull_requests: [pr135] });
    fixture.createThread(agent, { pull_requests: [{ repo: "acme/AGENTION", number: 135 }] });
    expect(counts().pull_request).toEqual({
      pull_requests: [{ repo: "acme/AGENTION", number: 135, total: 2 }],
      truncated: false,
    });
    expect(counts().branch).toEqual({
      branches: [{ ...feature, total: 1 }],
      truncated: false,
    });
  });

  it("list the most recently mentioned first, and only what live messages name", () => {
    fixture.createThread(agent, { pull_requests: [pr136] });
    fixture.createThread(agent, { pull_requests: [pr135] });
    fixture.write(agent.identity, target(1), { pull_requests: [{ repo: "o/r", number: 1 }] });
    fixture.write(agent.identity, target(1), { replaces: 2, text: "Not that one." });
    expect(counts().pull_request.pull_requests.map((each) => each.number)).toEqual([135, 136]);
    fixture.write(agent.identity, target(1), { pull_requests: [pr136] });
    expect(counts().pull_request.pull_requests.map((each) => each.number)).toEqual([136, 135]);
  });

  it("count with their own kind's filter off and every other filter on", () => {
    const other = fixture.registerAgent("reviewer", "side");
    fixture.createThread(agent, { pull_requests: [pr135], branches: [feature] });
    fixture.createThread(other, { pull_requests: [pr135, pr136] });
    const chosen = counts({ pull_request: "acme/agention#136" });
    expect(chosen.pull_request.pull_requests).toEqual([
      { repo: pr135.repo, number: 135, total: 2 },
      { repo: pr136.repo, number: 136, total: 1 },
    ]);
    // The branch filter keeps only the first thread, so pull request 136,
    // which only the other names, is not listed.
    expect(counts({ branch: "acme/agention:feat/links" }).pull_request.pull_requests).toEqual([
      { repo: pr135.repo, number: 135, total: 1 },
    ]);
    expect(counts({ agent: "reviewer" }).branch.branches).toEqual([]);
  });

  it("list one message's entries in its order, after those of later messages", () => {
    // Orders by key would put 10 before 2 and 9, and b before c.
    fixture.createThread(agent, {
      pull_requests: [9, 10, 2].map((number) => ({ repo: "o/r", number })),
      branches: [{ repo: "o/r", branch: "c" }],
    });
    fixture.write(agent.identity, target(), { branches: [{ repo: "o/r", branch: "b" }] });
    expect(counts().pull_request.pull_requests.map((each) => each.number)).toEqual([9, 10, 2]);
    expect(counts().branch.branches.map((each) => each.branch)).toEqual(["b", "c"]);
  });

  it(`list at most ${maxListed} of each, saying when they leave the oldest out`, () => {
    fixture.createThread(agent, { text: "Start." });
    const messages = Math.ceil((maxListed + 1) / maxLinks);
    // Each message's branches in an order their keys do not follow: 20, 19,
    // and so on, which key order puts 1, 10, 11, and on.
    const named = (index: number) =>
      Array.from({ length: maxLinks }, (_, each) => `m${index}-${maxLinks - each}`);
    for (let index = 0; index < messages; index++) {
      fixture.write(agent.identity, target(), {
        branches: named(index).map((branch) => ({ repo: "o/r", branch })),
      });
    }
    const { branches, truncated } = counts().branch;
    expect([branches.length, truncated]).toEqual([maxListed, true]);
    expect(branches.slice(0, maxLinks).map((each) => each.branch)).toEqual(named(messages - 1));
    expect(branches.some((each) => each.branch.startsWith("m0-"))).toBe(false);
  });
});
