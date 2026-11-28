import { messageSendInput } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { archiveThread, markRead, markUnread } from "./marks.ts";
import { type Agent, Fixture, requestId, threadTarget } from "./test-fixture.ts";
import { sendMessage } from "./threads.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
  fixture.createThread(agent, {
    asks: [{ question: "Ship it?", suggestions: [{ label: "Yes" }] }],
  });
});

afterEach(() => {
  fixture.close();
});

const target = () => threadTarget(agent, 1);

function thread() {
  return fixture.thread(fixture.operator, target());
}

function caught(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the operation to fail");
}

describe("racing writes", () => {
  it("land one and fail the other as stale with the message it missed", () => {
    fixture.write(agent.identity, target(), { text: "first", seen_through: 1 });
    const error = caught(() =>
      fixture.write(fixture.operator, target(), { text: "second", seen_through: 1 }),
    );
    expect(error.code).toBe("stale");
    expect(error.missed?.map((message) => [message.seq, message.text])).toEqual([[2, "first"]]);
    expect(thread().thread.last_seq).toBe(2);
  });

  it.each([
    ["revised", { asks: [{ question: "Which, then?" }], replaces: 1 }, { replaces: 1 }],
    ["withdrew", { withdrawals: [{ ask: 1, reason: "Moot." }] }, { withdrawals: [{ ask: 1 }] }],
  ])(
    "fail as stale, not as a misfit, when the landed message %s the ask answered",
    (_, landed, missed) => {
      fixture.write(agent.identity, target(), { ...landed, seen_through: 1 });
      const error = caught(() =>
        fixture.write(fixture.operator, target(), {
          answers: [{ ask: 1, picks: [0] }],
          seen_through: 1,
        }),
      );
      expect(error.code).toBe("stale");
      expect(error.missed).toMatchObject([{ seq: 2, ...missed }]);
    },
  );

  it("fail as stale, not as already answered, when the landed message answered the ask", () => {
    fixture.write(fixture.operator, target(), {
      answers: [{ ask: 1, declined: true }],
      seen_through: 1,
    });
    const error = caught(() =>
      fixture.write(fixture.operator, target(), {
        answers: [{ ask: 1, picks: [0] }],
        seen_through: 1,
      }),
    );
    expect(error.code).toBe("stale");
  });

  it("fail as stale, not as already replaced, when the landed message replaced the same one", () => {
    fixture.write(agent.identity, target(), { text: "Draft." });
    fixture.write(agent.identity, target(), { text: "Better.", replaces: 2, seen_through: 2 });
    const error = caught(() =>
      fixture.write(agent.identity, target(), { text: "Best.", replaces: 2, seen_through: 2 }),
    );
    expect(error.code).toBe("stale");
  });

  it("let a stale write retry with the same request id once it has seen the missed messages", () => {
    fixture.write(agent.identity, target(), { text: "first" });
    const id = requestId();
    expect(
      caught(() =>
        fixture.write(fixture.operator, target(), {
          request_id: id,
          text: "reply",
          seen_through: 1,
        }),
      ).code,
    ).toBe("stale");
    const landed = fixture.write(fixture.operator, target(), {
      request_id: id,
      text: "reply",
      seen_through: 2,
    });
    expect(landed.seq).toBe(3);
  });

  it("refuse a seen_through beyond the latest message", () => {
    const error = caught(() =>
      fixture.write(fixture.operator, target(), { text: "m", seen_through: 2 }),
    );
    expect([error.code, error.field]).toEqual(["invalid_input", "seen_through"]);
  });

  it("return the earliest missed messages, a page at a time", () => {
    for (let i = 0; i < 60; i++) {
      fixture.write(agent.identity, target(), { text: `m${i}` });
    }
    const first = caught(() =>
      fixture.write(fixture.operator, target(), { text: "x", seen_through: 1 }),
    );
    expect(first.missed?.map((message) => message.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 2),
    );
    const second = caught(() =>
      fixture.write(fixture.operator, target(), { text: "x", seen_through: 51 }),
    );
    expect(second.missed?.map((message) => message.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 52),
    );
  });
});

describe("marks", () => {
  it("never conflict with a write, and a write reads through its own message", () => {
    fixture.write(agent.identity, target(), { text: "m" });
    markRead(fixture.store, fixture.operator, target(), { through: 2 });
    markUnread(fixture.store, fixture.operator, target(), { from: 2 });
    archiveThread(fixture.store, agent.identity, target(), { through: 2 });
    fixture.write(agent.identity, target(), { text: "after the marks", seen_through: 2 });
    expect(thread().cursors).toEqual({ requester: 3, audience: 1 });
    expect(thread().thread.last_seq).toBe(3);
  });
});

describe("request ids", () => {
  it("replay the original result for a retry with the same content", () => {
    const id = requestId();
    const first = fixture.write(fixture.operator, target(), { request_id: id, text: "once" });
    fixture.write(agent.identity, target(), { text: "later" });
    const again = sendMessage(
      fixture.store,
      fixture.operator,
      target(),
      messageSendInput.parse({ request_id: id, text: "once", seen_through: 1 }),
    );
    expect(again).toEqual(first);
    expect(thread().messages).toHaveLength(3);
  });

  it("replay a create without starting a second thread", () => {
    const id = requestId();
    const first = fixture.createThread(agent, { request_id: id, title: "Once" });
    expect(first).toEqual({ number: 2, seq: 1 });
    expect(fixture.createThread(agent, { request_id: id, title: "Once" })).toEqual(first);
    expect(fixture.createThread(agent).number).toBe(3);
  });

  it("refuse a reused id with different content", () => {
    const id = requestId();
    fixture.write(fixture.operator, target(), { request_id: id, text: "once" });
    const error = caught(() =>
      fixture.write(fixture.operator, target(), { request_id: id, text: "twice" }),
    );
    expect([error.code, error.field]).toEqual(["request_id_conflict", "request_id"]);
  });

  it("tell writes apart by their detail too, a create's and a message's", () => {
    const created = requestId();
    const thread = { request_id: created, title: "Once", text: "Summary.", detail: "At length." };
    const started = fixture.createThread(agent, thread);
    expect(fixture.createThread(agent, thread)).toEqual(started);
    expect(
      caught(() => fixture.createThread(agent, { ...thread, detail: "Otherwise." })).code,
    ).toBe("request_id_conflict");
    const sent = requestId();
    const message = { request_id: sent, text: "Summary.", detail: "At length." };
    const first = fixture.write(fixture.operator, target(), message);
    expect(fixture.write(fixture.operator, target(), message)).toEqual(first);
    for (const other of [{ detail: "Otherwise." }, { detail: undefined }]) {
      const error = caught(() =>
        fixture.write(fixture.operator, target(), { ...message, ...other }),
      );
      expect([error.code, error.field]).toEqual(["request_id_conflict", "request_id"]);
    }
  });

  it("refuse the same id and content on another thread", () => {
    fixture.createThread(agent);
    const id = requestId();
    fixture.write(fixture.operator, target(), { request_id: id, text: "same" });
    const error = caught(() =>
      fixture.write(fixture.operator, threadTarget(agent, 2), { request_id: id, text: "same" }),
    );
    expect(error.code).toBe("request_id_conflict");
  });

  it("refuse a message reusing the id of a create", () => {
    const id = requestId();
    fixture.createThread(agent, { request_id: id });
    const error = caught(() =>
      fixture.write(agent.identity, threadTarget(agent, 2), { request_id: id, text: "m" }),
    );
    expect(error.code).toBe("request_id_conflict");
  });

  it("belong to their actor, so two actors may use the same id", () => {
    const id = requestId();
    fixture.write(agent.identity, target(), { request_id: id, text: "agent" });
    const landed = fixture.write(fixture.operator, target(), { request_id: id, text: "operator" });
    expect(landed.seq).toBe(3);
  });
});
