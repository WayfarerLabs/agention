import {
  maxListedAsks,
  messageSendInput,
  threadCreateInput,
  threadGetQuery,
  threadStartInput,
  threadsQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { revokeRegistration } from "./registrations.ts";
import { type Agent, Fixture, hour, requestId, threadTarget } from "./test-fixture.ts";
import { listThreads } from "./thread-lists.ts";
import { createThread, getThread, sendMessage, startThread } from "./threads.ts";

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

function read(identity = fixture.operator, number = 1) {
  return fixture.thread(identity, target(number));
}

function messageAt(seq: number, identity = fixture.operator) {
  const found = read(identity).messages.find((message) => message.seq === seq);
  if (found === undefined) {
    throw new Error(`no message ${seq}`);
  }
  return found;
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

const choice = {
  question: "Which database?",
  suggestions: [{ label: "SQLite" }, { label: "Postgres" }, { label: "MySQL" }],
};

// asking starts thread 1 whose first message asks, as ask 1.
function asking(ask: Record<string, unknown> = choice): void {
  fixture.createThread(agent, { asks: [ask] });
}

// asksOf reads the asks a message carries.
const asksOf = (seq: number) => messageAt(seq).asks ?? [];

// openNumbers reads the numbers of the thread's open asks, most pressing first.
const openNumbers = () => read().thread.open_asks.asks.map((ask) => ask.number);

describe("createThread", () => {
  it("stores and returns text exactly as written", () => {
    const text = {
      title: "  Café <b>bold</b> \u{1F680} ",
      text: "# Heading\r\n\r\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n trailing  \n",
      detail: "\n## Found\r\n\n```diff\n-\told\n+\tnew\n```\n​<img src=x>  \n",
      references: [
        { label: "PR", identifier: "#12", url: "https://example.com/pr/12?x=1#y" },
        { label: "Ticket ", identifier: "ABC-1" },
      ],
      topic: "auth",
      ask: {
        question: "  Ship <i>it</i>? ",
        suggestions: [{ label: " A ", description: "e\u0301" }],
        fallback: "Proceed with A.\n\nThen B.",
      },
    };
    const { ask, ...fields } = text;
    fixture.createThread(agent, { ...fields, asks: [ask] });
    const { thread, messages } = read();
    expect(thread).toMatchObject({ title: text.title, topic: text.topic });
    expect(messages[0]).toMatchObject({
      text: text.text,
      detail: text.detail,
      references: text.references,
      topic: text.topic,
      asks: [{ number: 1, ...ask, suggestions: [{ label: " A ", description: "e\u0301" }] }],
    });
    fixture.write(fixture.operator, target(), { text: text.text, detail: text.detail });
    expect(messageAt(2)).toMatchObject({ text: text.text, detail: text.detail });
    // A message without detail reads without one, as without text.
    fixture.write(fixture.operator, target(), { text: "Short." });
    expect(messageAt(3)).not.toHaveProperty("detail");
  });

  it("answers with the thread's number and its first message, which may carry nothing", () => {
    expect(fixture.createThread(agent)).toEqual({ number: 1, seq: 1 });
    const { thread, messages, cursors, marks } = read(agent.identity);
    expect(thread).toMatchObject({
      agent: "builder",
      session: "main",
      number: 1,
      title: "A question",
      last_seq: 1,
      read_through: 1,
      unread: 0,
      open_asks: { asks: [], blocking: false, overdue: false },
      credential_active: true,
    });
    expect(messages).toEqual([
      {
        seq: 1,
        author: { kind: "session", agent: "builder", session: "main" },
        created_at: new Date(fixture.now).toISOString(),
        live: true,
      },
    ]);
    expect(cursors).toEqual({ requester: 1, audience: 0 });
    expect(marks).toEqual({ read_through: 1, archived_through: 0 });
    expect(read().thread).toMatchObject({ read_through: 0, unread: 1 });
  });

  it("numbers threads from 1 within each session", () => {
    const other = fixture.registerAgent("builder", "side");
    expect(fixture.createThread(agent).number).toBe(1);
    expect(fixture.createThread(agent).number).toBe(2);
    expect(fixture.createThread(other).number).toBe(1);
  });

  it("references only threads of its session", () => {
    const other = fixture.registerAgent("reviewer", "main");
    fixture.createThread(other);
    expect(
      failure(() => fixture.createThread(agent, { references: [{ label: "x", thread: 1 }] })),
    ).toEqual({ code: "invalid_input", field: "references.0.thread" });
    fixture.createThread(agent);
    fixture.createThread(agent, { references: [{ label: "Earlier", thread: 1 }] });
    expect(read(fixture.operator, 2).messages[0]?.references).toEqual([
      { label: "Earlier", thread: 1 },
    ]);
  });

  it("is refused to anyone but the session itself", () => {
    const input = threadCreateInput.parse({ request_id: requestId(), title: "t" });
    expect(
      failure(() => createThread(fixture.store, fixture.operator, agent.target, input)).code,
    ).toBe("not_allowed");
  });
});

describe("startThread", () => {
  it("makes the session the requester and the operator the audience, writing the first message", () => {
    fixture.createThread(agent);
    expect(
      fixture.startThread(agent, {
        title: "Rebase onto main",
        text: "Main moved; please rebase.",
        detail: "Three commits landed.",
      }),
    ).toEqual({ number: 2, seq: 1 });
    const operatorView = read(fixture.operator, 2);
    expect(operatorView.thread).toMatchObject({ title: "Rebase onto main", unread: 0 });
    expect(operatorView.marks).toEqual({ read_through: 1, archived_through: 0 });
    expect(operatorView.messages).toMatchObject([
      {
        seq: 1,
        author: { kind: "person", name: "operator" },
        text: "Main moved; please rebase.",
        detail: "Three commits landed.",
      },
    ]);
    expect(read(agent.identity, 2)).toMatchObject({
      thread: { unread: 1, read_through: 0 },
      cursors: { requester: 0, audience: 1 },
    });
    const registration = fixture.db
      .prepare(
        "SELECT registration_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.number = 2",
      )
      .get() as { registration_id: number | null };
    expect(registration.registration_id).toBeNull();
  });

  it("leaves the session the requester's parts and the operator the audience's", () => {
    fixture.startThread(agent);
    fixture.write(agent.identity, target(), { text: "Rebased.", asks: [{ question: "Push it?" }] });
    expect(failure(() => fixture.write(fixture.operator, target(), { topic: "release" }))).toEqual({
      code: "not_allowed",
      field: "topic",
    });
    fixture.write(fixture.operator, target(), { answers: [{ ask: 1, text: "Yes." }] });
    expect(read().thread.status).toBe("answered");
  });

  it("wakes the session's long polls", async () => {
    const woken = fixture.store.notifier.wait(agent.sessionId, 5000);
    fixture.startThread(agent);
    expect(await woken).toBe("notified");
  });

  it("answers a retry as it did, and a reused request id with other content as a conflict", () => {
    const id = requestId();
    const first = fixture.startThread(agent, { request_id: id });
    expect(fixture.startThread(agent, { request_id: id })).toEqual(first);
    expect(failure(() => fixture.startThread(agent, { request_id: id, text: "Other." }))).toEqual({
      code: "request_id_conflict",
      field: "request_id",
    });
    expect(fixture.startThread(agent).number).toBe(2);
  });

  it("starts a thread on a session with no credential, stranded from the start", () => {
    fixture.seen(agent);
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    expect(fixture.startThread(agent)).toEqual({ number: 1, seq: 1 });
    expect(read().thread).toMatchObject({ stranded: true, credential_active: false });
  });

  it("is the operator's alone, on a session they name", () => {
    const input = threadStartInput.parse({ request_id: requestId(), title: "t", text: "m" });
    expect(failure(() => startThread(fixture.store, agent.identity, agent.target, input))).toEqual({
      code: "not_allowed",
      field: undefined,
    });
    const other = fixture.registerAgent("reviewer", "main");
    expect(failure(() => startThread(fixture.store, agent.identity, other.target, input))).toEqual({
      code: "not_found",
      field: undefined,
    });
    const nowhere = { agent: "builder", session: "nowhere" };
    expect(failure(() => startThread(fixture.store, fixture.operator, nowhere, input))).toEqual({
      code: "not_found",
      field: undefined,
    });
  });
});

describe("writing a message", () => {
  it("lands with its asks and answers together, or not at all", () => {
    asking();
    // An ask the database refuses, past the schema: several picks over one
    // suggested answer.
    const ask = { ...choice, suggestions: [{ label: "SQLite", description: "" }], multiple: true };
    const input = messageSendInput.parse({
      request_id: requestId(),
      seen_through: 1,
      text: "And this?",
      asks: [{ question: "Fine?" }],
    });
    input.asks?.push(ask as never);
    expect(() => sendMessage(fixture.store, agent.identity, target(), input)).toThrow();
    expect(read().thread.last_seq).toBe(1);
    expect(read().messages).toHaveLength(1);
    expect(openNumbers()).toEqual([1]);
  });
});

describe("roles", () => {
  beforeEach(() => {
    asking();
  });

  it("keep asks and topics to the requester", () => {
    expect(failure(() => fixture.write(fixture.operator, target(), { asks: [choice] }))).toEqual({
      code: "not_allowed",
      field: "asks",
    });
    expect(failure(() => fixture.write(fixture.operator, target(), { topic: "auth" }))).toEqual({
      code: "not_allowed",
      field: "topic",
    });
  });

  it("keep answers to the audience", () => {
    expect(
      failure(() =>
        fixture.write(agent.identity, target(), { answers: [{ ask: 1, declined: true }] }),
      ),
    ).toEqual({ code: "not_allowed", field: "answers" });
  });

  it("keep replacement to the author", () => {
    fixture.write(agent.identity, target(), { text: "Mine." });
    expect(
      failure(() => fixture.write(fixture.operator, target(), { text: "Yours.", replaces: 2 })),
    ).toEqual({ code: "not_allowed", field: "replaces" });
  });

  it("let either party write text and references", () => {
    fixture.write(agent.identity, target(), { text: "From the agent." });
    fixture.write(fixture.operator, target(), {
      references: [{ label: "Doc", url: "https://example.com/doc" }],
    });
    expect(read().messages.map((message) => message.author.kind)).toEqual([
      "session",
      "session",
      "person",
    ]);
  });

  it("refuse a write from another session of the same agent", () => {
    const sibling = fixture.registerAgent("builder", "side");
    expect(failure(() => fixture.write(sibling.identity, target(), { text: "hi" })).code).toBe(
      "not_found",
    );
  });
});

describe("asks", () => {
  it("count from 1 within the thread, a message's own in the order given", () => {
    fixture.createThread(agent, { asks: [{ question: "a" }, { question: "b" }] });
    fixture.write(agent.identity, target(), { asks: [{ question: "c" }] });
    expect(asksOf(1).map((ask) => [ask.number, ask.question])).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(asksOf(2).map((ask) => ask.number)).toEqual([3]);
    // Each thread counts its own.
    fixture.createThread(agent, { asks: [{ question: "d" }] });
    expect(read(fixture.operator, 2).messages[0]?.asks?.map((ask) => ask.number)).toEqual([1]);
  });

  it("keep their numbers, and a replacement's asks take new ones", () => {
    fixture.createThread(agent, { asks: [{ question: "a" }, { question: "b" }] });
    fixture.write(fixture.operator, target(), { answers: [{ ask: 2, declined: true }] });
    fixture.write(agent.identity, target(), {
      asks: [{ question: "a, revised" }, { question: "b, revised" }],
      replaces: 1,
    });
    expect(asksOf(1).map((ask) => ask.number)).toEqual([1, 2]);
    expect(asksOf(3).map((ask) => ask.number)).toEqual([3, 4]);
    // Withdrawals ask nothing, and the numbers count on past the asks they
    // close.
    fixture.write(agent.identity, target(), {
      withdrawals: [
        { ask: 3, reason: "Done." },
        { ask: 4, reason: "Done." },
      ],
    });
    fixture.write(agent.identity, target(), { asks: [{ question: "c" }] });
    expect(asksOf(5).map((ask) => ask.number)).toEqual([5]);
    expect(openNumbers()).toEqual([5]);
  });
});

describe("answers", () => {
  const several = { ...choice, multiple: true };
  const open = { question: "What should the cache hold?" };

  it.each([
    ["one suggested answer", choice, { picks: [1] }],
    ["its own words instead of a pick", choice, { text: "Neither.\nBoth are too slow." }],
    ["one suggested answer with notes beside it", choice, { picks: [1], text: "Before noon." }],
    ["several suggested answers", several, { picks: [2, 0] }],
    [
      "picks and its own words where several are allowed",
      several,
      { picks: [0], text: "Also Redis." },
    ],
    ["its own words on an ask that suggests none", open, { text: "Sessions only." }],
    ["a decline", choice, { declined: true }],
    ["a decline on an ask that suggests none", open, { declined: true }],
  ])("answer an ask with %s, apart from the message's text", (_, ask, answer) => {
    asking(ask);
    fixture.write(fixture.operator, target(), {
      answers: [{ ask: 1, ...answer }],
      text: "More on **why**.",
    });
    const written = { declined: false, ...answer };
    expect(asksOf(1)[0]).toMatchObject({ open: false, answer: { seq: 2, ...written } });
    expect(messageAt(2)).toMatchObject({
      text: "More on **why**.",
      answers: [{ ask: 1, ask_seq: 1, ...written }],
    });
    expect(openNumbers()).toEqual([]);
  });

  it("read back an answer's picks with their labels, its own words and whether it declined", () => {
    asking(several);
    fixture.write(fixture.operator, target(), {
      answers: [{ ask: 1, picks: [2, 0], text: "And\nRedis." }],
    });
    expect(messageAt(2).answers).toEqual([
      {
        ask: 1,
        question: several.question,
        ask_seq: 1,
        ask_live: true,
        declined: false,
        picks: [2, 0],
        labels: ["MySQL", "SQLite"],
        text: "And\nRedis.",
      },
    ]);
    expect(asksOf(1)[0]?.answer).toEqual({
      seq: 2,
      declined: false,
      picks: [2, 0],
      labels: ["MySQL", "SQLite"],
      text: "And\nRedis.",
    });
  });

  it("read back a decline as carrying nothing else", () => {
    asking();
    fixture.write(fixture.operator, target(), { answers: [{ ask: 1, declined: true }] });
    expect(messageAt(2).answers).toEqual([
      { ask: 1, question: choice.question, ask_seq: 1, ask_live: true, declined: true },
    ]);
  });

  it("answer several asks in one message, from one message or several, together or apart", () => {
    fixture.createThread(agent, { asks: [choice, open, { question: "And the queue?" }] });
    fixture.write(agent.identity, target(), { asks: [{ question: "Deploy today?" }] });
    fixture.write(fixture.operator, target(), {
      answers: [
        { ask: 4, declined: true },
        { ask: 1, picks: [0] },
      ],
    });
    // Each answer carries the question of the ask it answers, wherever that
    // ask was asked.
    expect(
      messageAt(3).answers?.map((answer) => [answer.ask, answer.ask_seq, answer.question]),
    ).toEqual([
      [1, 1, choice.question],
      [4, 2, "Deploy today?"],
    ]);
    expect(asksOf(1).map((ask) => ask.answer?.seq)).toEqual([3, undefined, undefined]);
    expect(openNumbers()).toEqual([2, 3]);
    fixture.write(fixture.operator, target(), { answers: [{ ask: 3, text: "Later." }] });
    expect(openNumbers()).toEqual([2]);
  });

  it.each([
    ["several picks on a single-answer ask", choice, { picks: [0, 1] }, "picks"],
    ["the same pick twice", several, { picks: [0, 0] }, "picks"],
    ["a pick out of range", choice, { picks: [3] }, "picks"],
    ["a pick on an ask that suggests none", open, { picks: [0] }, "picks"],
    [
      "a pick with own words on an ask that suggests none",
      open,
      { picks: [0], text: "x" },
      "picks",
    ],
  ])("refuse %s, naming the answer", (_, ask, answer, field) => {
    fixture.createThread(agent, { asks: [{ question: "First?" }, ask] });
    expect(
      failure(() =>
        fixture.write(fixture.operator, target(), {
          answers: [
            { ask: 1, declined: true },
            { ask: 2, ...answer },
          ],
        }),
      ),
    ).toEqual({ code: "invalid_input", field: `answers.1.${field}` });
    expect(read().thread.last_seq).toBe(1);
  });

  it("refuse an ask already answered, and one that does not exist", () => {
    asking();
    fixture.write(fixture.operator, target(), { answers: [{ ask: 1, declined: true }] });
    for (const ask of [1, 9]) {
      expect(
        failure(() =>
          fixture.write(fixture.operator, target(), { answers: [{ ask, declined: true }] }),
        ),
      ).toEqual({ code: "invalid_input", field: "answers.0.ask" });
    }
  });

  it.each([
    ["revised", { asks: [{ question: "Which, then?" }], replaces: 1 }],
    ["withdrew", { withdrawals: [{ ask: 1, reason: "Moot." }] }],
  ])("refuse an ask its requester %s", (_, change) => {
    asking();
    fixture.write(agent.identity, target(), change);
    expect(
      failure(() =>
        fixture.write(fixture.operator, target(), { answers: [{ ask: 1, declined: true }] }),
      ),
    ).toEqual({ code: "invalid_input", field: "answers.0.ask" });
  });
});

describe("replacing", () => {
  it("ignores the replaced message from then on, and names what replaced it", () => {
    fixture.createThread(agent, { text: "First draft." });
    fixture.write(agent.identity, target(), { text: "Second draft.", replaces: 1 });
    expect(read().messages).toMatchObject([
      { seq: 1, live: false, replaced_by: 2, text: "First draft." },
      { seq: 2, live: true, replaces: 1, text: "Second draft." },
    ]);
    fixture.write(agent.identity, target(), { text: "Third draft.", replaces: 2 });
    expect(read().messages.map((message) => message.live)).toEqual([false, false, true]);
  });

  it("takes a whole message, detail included: what the replacement leaves out is gone", () => {
    fixture.createThread(agent, { text: "Summary.", detail: "The long form." });
    fixture.write(agent.identity, target(), {
      text: "Summary, revised.",
      detail: "The long form, revised.",
      replaces: 1,
    });
    fixture.write(agent.identity, target(), { text: "Summary alone.", replaces: 2 });
    const [first, second, third] = read().messages;
    expect(first).toMatchObject({ live: false, detail: "The long form." });
    expect(second).toMatchObject({ live: false, detail: "The long form, revised." });
    expect(third).toMatchObject({ live: true, text: "Summary alone." });
    expect(third).not.toHaveProperty("detail");
  });

  it("refuses a message already replaced, and one that does not exist", () => {
    fixture.createThread(agent, { text: "Draft." });
    fixture.write(agent.identity, target(), { text: "Better.", replaces: 1 });
    for (const replaces of [1, 9]) {
      expect(
        failure(() => fixture.write(agent.identity, target(), { text: "Again.", replaces })),
      ).toEqual({ code: "invalid_input", field: "replaces" });
    }
  });

  it.each([
    ["nothing", {}],
    ["no asks", { text: "Never mind." }],
    ["fewer asks", { asks: [{ question: "Which, then?" }] }],
    [
      "an ask, and a withdrawal of another message's ask",
      { asks: [{ question: "Which, then?" }], withdrawals: [{ ask: 3, reason: "Moot." }] },
    ],
  ])("refuses a replacement carrying %s of a message holding open asks", (_, change) => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }] });
    fixture.write(agent.identity, target(), { asks: [{ question: "Or?" }] });
    expect(
      failure(() => fixture.write(agent.identity, target(), { ...change, replaces: 1 })),
    ).toEqual({ code: "invalid_input", field: "asks" });
    expect(openNumbers()).toEqual([1, 2, 3]);
  });

  it("revises open asks with a replacement carrying as many, once others are withdrawn too", () => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }, { question: "Or?" }] });
    fixture.write(fixture.operator, target(), { answers: [{ ask: 3, declined: true }] });
    // Two asks open: as many asks revise them.
    fixture.write(agent.identity, target(), {
      asks: [{ question: "Which, then?" }, { question: "And, then?" }],
      replaces: 1,
    });
    expect(openNumbers()).toEqual([4, 5]);
    // Withdrawing one first leaves one to revise.
    fixture.write(agent.identity, target(), { withdrawals: [{ ask: 5, reason: "Moot." }] });
    fixture.write(agent.identity, target(), {
      asks: [{ question: "Which, at last?" }],
      replaces: 3,
    });
    expect(openNumbers()).toEqual([6]);
    // A message whose asks are all closed takes a replacement without any.
    fixture.write(agent.identity, target(), { withdrawals: [{ ask: 6, reason: "Moot too." }] });
    fixture.write(agent.identity, target(), { text: "Nothing to ask.", replaces: 5 });
    expect(openNumbers()).toEqual([]);
  });

  it("revises an ask, which asks again under a new number even once answered", () => {
    asking();
    fixture.write(fixture.operator, target(), { answers: [{ ask: 1, picks: [0] }] });
    fixture.write(agent.identity, target(), {
      asks: [{ ...choice, priority: "high" }],
      replaces: 1,
    });
    expect(read().thread.open_asks).toMatchObject({
      asks: [{ number: 2, seq: 3 }],
      priority: "high",
    });
    // The answer stays, and says its ask is not live.
    expect(messageAt(2).answers).toMatchObject([{ ask: 1, ask_live: false }]);
  });

  it("changes answers by answering the same asks again, and may answer open asks besides", () => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }, { question: "Or?" }] });
    fixture.write(fixture.operator, target(), {
      answers: [
        { ask: 1, picks: [0] },
        { ask: 2, declined: true },
      ],
    });
    fixture.write(fixture.operator, target(), {
      answers: [
        { ask: 1, text: "Actually, neither." },
        { ask: 2, text: "Yes." },
        { ask: 3, declined: true },
      ],
      replaces: 2,
    });
    expect(asksOf(1).map((ask) => ask.answer)).toEqual([
      { seq: 3, declined: false, text: "Actually, neither." },
      { seq: 3, declined: false, text: "Yes." },
      { seq: 3, declined: true },
    ]);
    expect(messageAt(2)).toMatchObject({ live: false, replaced_by: 3 });
    expect(openNumbers()).toEqual([]);
  });

  it.each([
    ["no answer at all", { text: "Never mind." }, "answers"],
    ["an answer to only some of its asks", { answers: [{ ask: 1, declined: true }] }, "answers"],
    ["an answer to another ask instead", { answers: [{ ask: 3, declined: true }] }, "answers"],
  ])("refuses an answering message's replacement carrying %s", (_, change, field) => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }] });
    fixture.write(fixture.operator, target(), {
      answers: [
        { ask: 1, declined: true },
        { ask: 2, declined: true },
      ],
    });
    fixture.write(agent.identity, target(), { asks: [{ question: "Another?" }] });
    expect(
      failure(() => fixture.write(fixture.operator, target(), { ...change, replaces: 2 })),
    ).toEqual({ code: "invalid_input", field });
  });

  it("refuses changing an answer once its ask was replaced", () => {
    asking();
    fixture.write(fixture.operator, target(), { answers: [{ ask: 1, declined: true }] });
    fixture.write(agent.identity, target(), { replaces: 1 });
    expect(
      failure(() =>
        fixture.write(fixture.operator, target(), {
          answers: [{ ask: 1, picks: [0] }],
          replaces: 2,
        }),
      ),
    ).toEqual({ code: "invalid_input", field: "answers.0.ask" });
  });

  it("changes answers once a sibling ask died, answering again only the live ones", () => {
    asking();
    fixture.write(agent.identity, target(), { asks: [{ question: "And?" }] });
    fixture.write(fixture.operator, target(), {
      answers: [
        { ask: 1, declined: true },
        { ask: 2, text: "Yes." },
      ],
    });
    fixture.write(agent.identity, target(), { asks: [{ question: "And, then?" }], replaces: 2 });
    // The answer to ask 2, which its requester revised, cannot ride again.
    expect(
      failure(() =>
        fixture.write(fixture.operator, target(), {
          answers: [
            { ask: 1, picks: [0] },
            { ask: 2, text: "Still yes." },
          ],
          replaces: 3,
        }),
      ),
    ).toEqual({ code: "invalid_input", field: "answers.1.ask" });
    fixture.write(fixture.operator, target(), {
      answers: [
        { ask: 1, picks: [0] },
        { ask: 3, text: "Then, no." },
      ],
      replaces: 3,
    });
    expect(messageAt(5).answers).toMatchObject([
      { ask: 1, ask_live: true },
      { ask: 3, ask_live: true },
    ]);
    expect(messageAt(3)).toMatchObject({ live: false, answers: [{ ask: 1 }, { ask: 2 }] });
    expect(openNumbers()).toEqual([]);
  });

  it("changes a message whose every answered ask died with no answers at all", () => {
    asking();
    fixture.write(fixture.operator, target(), {
      text: "Small data.",
      answers: [{ ask: 1, declined: true }],
    });
    fixture.write(agent.identity, target(), { replaces: 1 });
    fixture.write(fixture.operator, target(), { text: "Small data, still.", replaces: 2 });
    expect(messageAt(4)).toMatchObject({ live: true, replaces: 2, text: "Small data, still." });
    expect(messageAt(4).answers).toBeUndefined();
  });

  it("lets a message the audience edits answer an open ask", () => {
    asking();
    fixture.write(fixture.operator, target(), { text: "Thinking." });
    fixture.write(fixture.operator, target(), {
      text: "Thinking done.",
      answers: [{ ask: 1, picks: [0] }],
      replaces: 2,
    });
    expect(asksOf(1)[0]).toMatchObject({ open: false, answer: { seq: 3 } });
  });
});

describe("withdrawals", () => {
  const reason = "Merged at 14:02, so this no longer needs an answer.";

  it("close an open ask with the requester's reason, which the ask and the message carry", () => {
    asking();
    fixture.write(agent.identity, target(), { withdrawals: [{ ask: 1, reason }] });
    expect(asksOf(1)[0]).toMatchObject({ open: false, withdrawal: { seq: 2, reason } });
    expect(asksOf(1)[0]?.answer).toBeUndefined();
    expect(messageAt(2).withdrawals).toEqual([{ ask: 1, reason }]);
    expect(openNumbers()).toEqual([]);
  });

  it("close several asks of several messages in one message, in number order", () => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }] });
    fixture.write(agent.identity, target(), { asks: [{ question: "Or?" }] });
    fixture.write(agent.identity, target(), {
      withdrawals: [
        { ask: 3, reason: "Three." },
        { ask: 1, reason: "One." },
      ],
    });
    expect(messageAt(3).withdrawals).toEqual([
      { ask: 1, reason: "One." },
      { ask: 3, reason: "Three." },
    ]);
    expect(openNumbers()).toEqual([2]);
  });

  it.each([
    ["answered", [{ answers: [{ ask: 1, declined: true }] }]],
    ["revised", [{ asks: [{ question: "Which, then?" }], replaces: 1 }]],
    ["already withdrawn", [{ withdrawals: [{ ask: 1, reason: "Once." }] }]],
    ["that does not exist", []],
  ])("refuse an ask %s", (title, before) => {
    asking();
    for (const change of before) {
      const writer = "answers" in change ? fixture.operator : agent.identity;
      fixture.write(writer, target(), change);
    }
    const ask = title === "that does not exist" ? 9 : 1;
    expect(
      failure(() =>
        fixture.write(agent.identity, target(), { withdrawals: [{ ask, reason: "Again." }] }),
      ),
    ).toEqual({ code: "invalid_input", field: "withdrawals.0.ask" });
  });

  it("close asks of the message a replacement replaces, which revises the rest in one write", () => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }] });
    fixture.write(agent.identity, target(), {
      asks: [{ question: "Which, then?" }],
      withdrawals: [{ ask: 2, reason }],
      replaces: 1,
    });
    expect(openNumbers()).toEqual([3]);
    expect(asksOf(1).map((ask) => ask.withdrawal)).toEqual([undefined, { seq: 2, reason }]);
    expect(messageAt(2).withdrawals).toEqual([{ ask: 2, reason }]);
    expect(read().thread.status).toBe("open");
    // Withdrawing every open ask by name takes a replacement without any,
    // which withdraws again the ask its message withdrew.
    fixture.write(agent.identity, target(), {
      text: "Not needed now.",
      withdrawals: [
        { ask: 2, reason },
        { ask: 3, reason },
      ],
      replaces: 2,
    });
    expect(openNumbers()).toEqual([]);
    expect(read().thread.status).toBe("withdrawn");
  });

  it("are the requester's alone", () => {
    asking();
    expect(
      failure(() =>
        fixture.write(fixture.operator, target(), { withdrawals: [{ ask: 1, reason }] }),
      ),
    ).toEqual({ code: "not_allowed", field: "withdrawals" });
  });

  it("are never undone: a replacement withdraws again every ask its message withdrew", () => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }, { question: "Or?" }] });
    fixture.write(agent.identity, target(), {
      text: "Not needed now.",
      withdrawals: [
        { ask: 1, reason: "One." },
        { ask: 2, reason: "Two." },
      ],
    });
    for (const change of [
      { text: "Not needed now, edited." },
      { withdrawals: [{ ask: 1, reason: "One." }] },
      {
        withdrawals: [
          { ask: 1, reason: "One." },
          { ask: 3, reason: "Three." },
        ],
      },
    ]) {
      expect(
        failure(() => fixture.write(agent.identity, target(), { ...change, replaces: 2 })),
      ).toEqual({ code: "invalid_input", field: "withdrawals" });
    }
    // With a new reason, and an open ask withdrawn besides.
    fixture.write(agent.identity, target(), {
      withdrawals: [
        { ask: 1, reason: "One, put better." },
        { ask: 2, reason: "Two." },
        { ask: 3, reason: "Three." },
      ],
      replaces: 2,
    });
    expect(asksOf(1).map((ask) => [ask.open, ask.withdrawal])).toEqual([
      [false, { seq: 3, reason: "One, put better." }],
      [false, { seq: 3, reason: "Two." }],
      [false, { seq: 3, reason: "Three." }],
    ]);
    expect(messageAt(2)).toMatchObject({ live: false, withdrawals: [{ ask: 1 }, { ask: 2 }] });
  });

  it.each([
    [
      "withdrew it in the replacement of its own message",
      [{ text: "Never mind.", withdrawals: [{ ask: 1, reason }], replaces: 2 }],
    ],
    [
      "withdrew it before that message was retracted",
      [{ withdrawals: [{ ask: 1, reason }] }, { replaces: 2 }],
    ],
  ])(
    "must be withdrawn again even once the ask's own message is replaced: a message %s",
    (_, writes) => {
      fixture.createThread(agent, { text: "First." });
      fixture.write(agent.identity, target(), { asks: [{ question: "Ship it?" }] });
      for (const change of writes) {
        fixture.write(agent.identity, target(), change);
      }
      expect(read().thread).toMatchObject({ status: "withdrawn", withdrawal: { ask: 1, reason } });
      // A typo fixed in the withdrawing message, message 3, keeps the withdrawal.
      expect(
        failure(() =>
          fixture.write(agent.identity, target(), { text: "Never mind, edited.", replaces: 3 }),
        ),
      ).toEqual({ code: "invalid_input", field: "withdrawals" });
      fixture.write(agent.identity, target(), {
        text: "Never mind, edited.",
        withdrawals: [{ ask: 1, reason: "Moot, put better." }],
        replaces: 3,
      });
      expect(read().thread).toMatchObject({
        status: "withdrawn",
        withdrawal: { ask: 1, reason: "Moot, put better." },
      });
    },
  );

  it("are part of a write's content, so a request id reused with another reason conflicts", () => {
    asking();
    const input = (why: string) =>
      messageSendInput.parse({
        request_id: "withdrawing",
        seen_through: 1,
        withdrawals: [{ ask: 1, reason: why }],
      });
    expect(sendMessage(fixture.store, agent.identity, target(), input(reason))).toEqual({
      number: 1,
      seq: 2,
    });
    expect(sendMessage(fixture.store, agent.identity, target(), input(reason))).toEqual({
      number: 1,
      seq: 2,
    });
    expect(
      failure(() => sendMessage(fixture.store, agent.identity, target(), input("Another."))),
    ).toEqual({ code: "request_id_conflict", field: "request_id" });
  });
});

describe("status", () => {
  const status = (identity = fixture.operator) => {
    const { thread } = read(identity);
    return { status: thread.status, withdrawal: thread.withdrawal };
  };

  it("rolls up the asks on live messages, the same for either party", () => {
    fixture.createThread(agent, { text: "Hello." });
    expect(status()).toEqual({ status: "none", withdrawal: undefined });
    fixture.write(agent.identity, target(), { asks: [choice, { question: "And?" }] });
    expect(status()).toEqual({ status: "open", withdrawal: undefined });
    fixture.write(fixture.operator, target(), { answers: [{ ask: 1, picks: [0] }] });
    fixture.write(agent.identity, target(), { withdrawals: [{ ask: 2, reason: "Moot." }] });
    // Answered and withdrawn together are answered.
    expect(status()).toEqual({ status: "answered", withdrawal: undefined });
    expect(status(agent.identity)).toEqual(status());
  });

  it("counts the asks a replacement withdraws of its own message, withdrawn by name", () => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }] });
    fixture.write(agent.identity, target(), {
      text: "Answered elsewhere.",
      withdrawals: [
        { ask: 1, reason: "Merged." },
        { ask: 2, reason: "Moot." },
      ],
      replaces: 1,
    });
    expect(status()).toEqual({
      status: "withdrawn",
      withdrawal: { ask: 1, seq: 2, reason: "Merged." },
    });
  });

  it("is open while a replacement revises one ask and withdraws the other", () => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }] });
    fixture.write(agent.identity, target(), {
      asks: [{ question: "Which, then?" }],
      withdrawals: [{ ask: 2, reason: "Moot." }],
      replaces: 1,
    });
    expect(status()).toEqual({ status: "open", withdrawal: undefined });
  });

  it("names the first withdrawal of the latest withdrawing message", () => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }, { question: "Or?" }] });
    fixture.write(agent.identity, target(), { withdrawals: [{ ask: 1, reason: "One." }] });
    fixture.write(agent.identity, target(), {
      withdrawals: [
        { ask: 3, reason: "Three." },
        { ask: 2, reason: "Two." },
      ],
    });
    expect(status()).toEqual({
      status: "withdrawn",
      withdrawal: { ask: 2, seq: 3, reason: "Two." },
    });
  });

  it("is withdrawn while a live message withdraws every live ask, naming the latest", () => {
    fixture.createThread(agent, { asks: [choice, { question: "And?" }] });
    fixture.write(agent.identity, target(), { withdrawals: [{ ask: 2, reason: "Two." }] });
    expect(status().status).toBe("open");
    fixture.write(agent.identity, target(), { withdrawals: [{ ask: 1, reason: "One." }] });
    expect(status()).toEqual({
      status: "withdrawn",
      withdrawal: { ask: 1, seq: 3, reason: "One." },
    });
    // Replacing the withdrawing message withdraws again, under the new message.
    fixture.write(agent.identity, target(), {
      withdrawals: [{ ask: 1, reason: "One, again." }],
      replaces: 3,
    });
    expect(status()).toEqual({
      status: "withdrawn",
      withdrawal: { ask: 1, seq: 4, reason: "One, again." },
    });
  });

  it("counts a revised ask's replacement, not the ask", () => {
    asking();
    fixture.write(fixture.operator, target(), { answers: [{ ask: 1, declined: true }] });
    expect(status().status).toBe("answered");
    fixture.write(agent.identity, target(), { asks: [{ question: "Which, then?" }], replaces: 1 });
    expect(status().status).toBe("open");
    fixture.write(agent.identity, target(), { withdrawals: [{ ask: 2, reason: "Moot." }] });
    expect(status()).toEqual({
      status: "withdrawn",
      withdrawal: { ask: 2, seq: 4, reason: "Moot." },
    });
    // An ask a live message withdrew still counts once its own message is
    // replaced, while the revised ask 1 plays no part.
    fixture.write(agent.identity, target(), { text: "Nothing to ask.", replaces: 3 });
    expect(status()).toEqual({
      status: "withdrawn",
      withdrawal: { ask: 2, seq: 4, reason: "Moot." },
    });
  });
});

describe("topics", () => {
  it("come from the latest live message that sets one", () => {
    fixture.createThread(agent, { topic: "auth" });
    fixture.write(agent.identity, target(), { text: "More." });
    expect(read().thread.topic).toBe("auth");
    fixture.write(agent.identity, target(), { topic: "billing" });
    expect(read().thread.topic).toBe("billing");
  });

  it("are restored to the one before when the message that set it is replaced", () => {
    fixture.createThread(agent, { topic: "auth" });
    fixture.write(agent.identity, target(), { text: "Moving.", topic: "billing" });
    fixture.write(agent.identity, target(), { text: "Moving.", replaces: 2 });
    expect(read().thread.topic).toBe("auth");
    fixture.write(agent.identity, target(), { replaces: 1 });
    expect(read().thread.topic).toBeUndefined();
  });
});

describe("getThread", () => {
  it("pages messages after a sequence and reports both cursors and the caller's marks", () => {
    fixture.createThread(agent);
    for (let i = 0; i < 4; i++) {
      fixture.write(agent.identity, target(), { text: `m${i}`, asks: [{ question: `q${i}` }] });
    }
    fixture.write(fixture.operator, target(), { text: "seen" });
    const page = getThread(
      fixture.store,
      agent.identity,
      target(),
      threadGetQuery.parse({ after: "2", limit: "2" }),
    );
    expect(page.messages.map((message) => message.seq)).toEqual([3, 4]);
    // Each message on the page carries its own asks, and none of another's.
    expect(page.messages.map((message) => message.asks?.map((ask) => ask.number))).toEqual([
      [2],
      [3],
    ]);
    expect(page.cursors).toEqual({ requester: 5, audience: 6 });
    expect(page.marks).toEqual({ read_through: 5, archived_through: 0 });
    expect(page.thread).toMatchObject({ last_seq: 6, unread: 1 });
  });

  it("answers not_found for a thread number the session does not have", () => {
    fixture.createThread(agent);
    expect(failure(() => read(fixture.operator, 2)).code).toBe("not_found");
  });
});

describe("open asks", () => {
  it("roll up their count, highest priority, earliest answer-by and signals over every open ask, the lead's or not", () => {
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    fixture.createThread(agent, {
      asks: [{ question: "a", priority: "low", impact: "blocking", answer_by: at(1) }],
    });
    fixture.write(agent.identity, target(), {
      asks: [
        { question: "b", priority: "high", effort: "under_15m", answer_by: at(5) },
        { question: "c" },
      ],
    });
    const { open_asks: asks } = read().thread;
    expect(asks).toEqual({
      asks: [
        { number: 2, seq: 2 },
        { number: 3, seq: 2 },
        { number: 1, seq: 1 },
      ],
      count: 3,
      earliest: { number: 1, seq: 1 },
      lead: {
        number: 2,
        seq: 2,
        question: "b",
        impact: "none",
        priority: "high",
        effort: "under_15m",
        answer_by: at(5),
        overdue: false,
      },
      priority: "high",
      answer_by: at(1),
      blocking: true,
      overdue: false,
    });
    // The thread is overdue once its earliest answer-by passes, before its
    // lead ask is.
    fixture.advance(2 * hour);
    expect(read().thread.open_asks).toMatchObject({ overdue: true, lead: { overdue: false } });
    expect(read(agent.identity).thread.open_asks.overdue).toBe(true);
    fixture.advance(4 * hour);
    expect(read().thread.open_asks.lead?.overdue).toBe(true);
  });

  it("put a blocking ask before others of its priority, then the earliest answer-by, then the lowest number", () => {
    const at = (hours: number) => new Date(fixture.now + hours * hour).toISOString();
    fixture.createThread(agent, { asks: [{ question: "late", answer_by: at(5) }] });
    fixture.write(agent.identity, target(), {
      asks: [{ question: "none" }, { question: "soon", answer_by: at(1) }],
    });
    fixture.write(agent.identity, target(), {
      asks: [{ question: "blocked", impact: "blocking" }],
    });
    fixture.write(agent.identity, target(), { asks: [{ question: "none again" }] });
    expect(openNumbers()).toEqual([4, 3, 1, 2, 5]);
  });

  it("list at most the 50 most pressing, beside the count of all and the earliest, however many are open", () => {
    fixture.createThread(agent);
    const ask = (n: number) => ({
      question: `q${n}`,
      ...(n === 2999 ? { priority: "urgent" } : n <= 10 ? { priority: "low" } : {}),
    });
    for (let first = 1; first <= 3000; first += 10) {
      fixture.write(agent.identity, target(), {
        asks: Array.from({ length: 10 }, (_, i) => ask(first + i)),
      });
    }
    const { thread } = read();
    expect(thread.open_asks.count).toBe(3000);
    expect(thread.open_asks.asks).toHaveLength(maxListedAsks);
    // The most pressing comes first, then the rest in number order, and the
    // earliest, though too little pressed to be listed, is named apart.
    expect(thread.open_asks.asks.map((each) => each.number)).toEqual([
      2999,
      ...Array.from({ length: maxListedAsks - 1 }, (_, i) => i + 11),
    ]);
    expect(thread.open_asks.earliest).toEqual({ number: 1, seq: 2 });
    expect(Buffer.byteLength(JSON.stringify(thread))).toBeLessThan(4_000);
    const listed = listThreads(fixture.store, fixture.operator, threadsQuery.parse({}));
    expect(listed.threads[0]?.open_asks).toEqual(thread.open_asks);
  });
});
