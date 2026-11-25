import {
  agentMessageSendInput,
  maxListed,
  maxLinks,
  sessionThreadsQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";
import { listSessionThreads } from "./thread-lists.ts";
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
