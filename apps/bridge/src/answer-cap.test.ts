import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxListedAsks } from "@wayfarerlabs/agention-api";
import { maxErrorBytes, maxResultBytes } from "./fit.ts";
import { type Answer, BridgeHarness, serverJson, type TestBridge } from "./test-harness.ts";

let harness: BridgeHarness;
let bridge: TestBridge;

beforeEach(async () => {
  harness = await new BridgeHarness().start();
  bridge = await harness.bridge();
  await bridge.ok("register");
  await harness.approve(harness.keyOnDisk());
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.close();
});

// Twenty references whose URLs take the given number of characters each.
function references(urlLength: number) {
  return Array.from({ length: 20 }, (_, i) => ({
    label: `Reference ${i}`,
    url: `https://example.com/${"a".repeat(urlLength - 20)}`,
  }));
}

// Four bytes of UTF-8 each.
const astral = (n: number) => "\u{1F600}".repeat(n);

async function startThread(requestId: string, fields: Record<string, unknown> = {}) {
  return bridge.ok("thread_create", { request_id: requestId, title: "A question", ...fields });
}

// startLongThreads starts threads whose summaries take about 2,500 bytes each.
async function startLongThreads(count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await startThread(`r${i}`, { title: astral(200), asks: [{ question: astral(300) }] });
  }
}

function withinCap(answer: Answer): void {
  const limit = answer.isError ? maxErrorBytes : maxResultBytes;
  expect(Buffer.byteLength(answer.text)).toBeLessThanOrEqual(limit);
}

function sequencesOf(messages: unknown): number[] {
  return (messages as { seq: number }[]).map((message) => message.seq);
}

function numbersOf(threads: unknown): number[] {
  return (threads as { number: number }[]).map((thread) => thread.number);
}

describe("a result over the cap", () => {
  it("is asked for again in smaller pages of messages", async () => {
    await startThread("r1");
    for (let i = 0; i < 8; i++) {
      await harness.operatorWrites(1, { text: "Notes.", detail: "m".repeat(9_000) });
    }
    const answer = await bridge.call("thread_get", { thread: 1 });
    withinCap(answer);
    expect(sequencesOf((answer.json as { messages: unknown }).messages)).toEqual([1, 2, 3, 4]);
  });

  it("is asked for again down to one message", async () => {
    await startThread("r1");
    for (let i = 0; i < 3; i++) {
      await harness.operatorWrites(1, { text: "Notes.", detail: "m".repeat(20_000) });
    }
    const answer = await bridge.call("thread_get", { thread: 1, after: 1 });
    withinCap(answer);
    expect(sequencesOf((answer.json as { messages: unknown }).messages)).toEqual([2]);
  });

  it("is asked for again in smaller pages of threads, which continue", async () => {
    await startLongThreads(20);
    const first = await bridge.call("thread_list", {});
    withinCap(first);
    const page = first.json as { threads: unknown; next: string };
    expect(numbersOf(page.threads)).toHaveLength(10);
    const rest = await bridge.ok("thread_list", { cursor: page.next });
    expect([...numbersOf(page.threads), ...numbersOf(rest.threads)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it("from a wait is asked for again in smaller pages, which since continues", async () => {
    await startLongThreads(20);
    for (let i = 1; i <= 20; i++) {
      await harness.operatorWrites(i, { text: "Answer." });
    }
    const first = await bridge.call("message_wait", { wait_seconds: 0 });
    withinCap(first);
    const page = first.json as { threads: unknown; since: string };
    expect(numbersOf(page.threads)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    const rest = await bridge.ok("message_wait", { since: page.since, wait_seconds: 0 });
    expect(numbersOf(rest.threads)).toEqual(Array.from({ length: 10 }, (_, i) => i + 11));
  });

  it("from a wait is asked for again in smaller pages that wait no more", async () => {
    await startLongThreads(20);
    for (let i = 1; i <= 20; i++) {
      await harness.operatorWrites(i, { text: "Answer." });
    }
    const waits: (string | null)[] = [];
    harness.beforeRequest = (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/wait")) {
        waits.push(url.searchParams.get("wait"));
      }
    };
    withinCap(await bridge.call("message_wait", { wait_seconds: 20 }));
    expect(waits).toEqual(["20", "0"]);
  });

  it("from a wait answers within one budget, however slowly the server answers", async () => {
    await startLongThreads(20);
    for (let i = 1; i <= 20; i++) {
      await harness.operatorWrites(i, { text: "Answer." });
    }
    // Requests travel in real time; the faked clock holds each wait request
    // for 30 seconds, the time a server has to answer, before the server
    // answers it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    harness.beforeRequest = async (request) => {
      if (new URL(request.url).pathname.endsWith("/wait")) {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    };
    let answered = false;
    const waiting = bridge.call("message_wait", { wait_seconds: 20 });
    void waiting.then(() => (answered = true));
    await delay(200);
    // The first answer is over the cap, so the bridge asks for a smaller page.
    await vi.advanceTimersByTimeAsync(30_000);
    await delay(500);
    await vi.advanceTimersByTimeAsync(19_999);
    await delay(200);
    expect(answered).toBe(false);
    // Twenty seconds of wait and 30 to answer: the budget ends the call.
    await vi.advanceTimersByTimeAsync(1);
    await delay(200);
    expect(answered).toBe(true);
    const answer = await waiting;
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("did not answer in time");
    await vi.advanceTimersByTimeAsync(30_000);
  });

  it("stops asking again from a server that ignores the page size", async () => {
    await startThread("r1");
    const path = "/api/agent/s/builder/main/threads/1";
    let asked = 0;
    harness.beforeRequest = (request) => {
      if (request.method !== "GET" || new URL(request.url).pathname !== path) {
        return undefined;
      }
      asked++;
      const messages = [1, 2, 3].map((seq) => ({
        seq,
        text: "Notes.",
        detail: "m".repeat(20_000),
      }));
      return serverJson({ thread: { number: 1, last_seq: 3 }, messages, cursors: {} });
    };
    const answer = await bridge.call("thread_get", { thread: 1 });
    withinCap(answer);
    expect(asked).toBe(2);
    expect((answer.json as { omitted: unknown }).omitted).toBeDefined();
  });

  it("leaves out the questions threads lead with, when a server ignores the page size", async () => {
    await startThread("r1");
    const path = "/api/agent/s/builder/main/threads";
    harness.beforeRequest = (request) => {
      if (request.method !== "GET" || new URL(request.url).pathname !== path) {
        return undefined;
      }
      // Twenty threads, each leading with a question of about 2,400 bytes.
      const threads = Array.from({ length: 20 }, (_, i) => ({
        number: i + 1,
        open_asks: {
          asks: [{ number: 1, seq: 1 }],
          lead: { number: 1, seq: 1, question: astral(600) },
        },
      }));
      return serverJson({ threads });
    };
    const answer = await bridge.call("thread_list", {});
    withinCap(answer);
    const result = answer.json as {
      threads: { open_asks: { lead: object } }[];
      omitted: string[];
    };
    expect(result.omitted.length).toBeGreaterThan(0);
    for (const omitted of result.omitted) {
      expect(omitted).toMatch(/^threads\.\d+\.open_asks\.lead\.question$/);
      const index = Number(omitted.split(".")[1]);
      expect(result.threads[index]?.open_asks.lead).not.toHaveProperty("question");
    }
  });

  it("fits a message's text and detail each at its bound whole, the detail in ASCII", async () => {
    // A summary of four-byte characters, and Markdown lines of ASCII.
    const text = astral(1_000);
    const line = "- A finding, with the evidence for it and what it means for the choice.\n";
    const detail = line.repeat(Math.ceil(20_000 / line.length)).slice(0, 20_000);
    await startThread("r1", { text, detail, asks: [{ question: "Which?" }] });
    const answer = await bridge.call("thread_get", { thread: 1 });
    withinCap(answer);
    const result = answer.json as { messages: object[]; omitted?: string[] };
    expect(result.omitted).toBeUndefined();
    expect(result.messages).toMatchObject([{ seq: 1, text, detail }]);
  });

  it("leaves out the largest text when even one message is too long", async () => {
    await startThread("r1");
    // Three bytes each: 60,000 bytes of detail.
    await bridge.ok("message_send", {
      thread: 1,
      request_id: "r2",
      seen_through: 1,
      text: "Summary.",
      detail: "\u20ac".repeat(20_000),
      asks: [{ question: "Still on?" }],
    });
    const answer = await bridge.call("thread_get", { thread: 1, after: 1, limit: 1 });
    withinCap(answer);
    const result = answer.json as { messages: object[]; omitted: string[] };
    expect(result.omitted).toEqual(["messages.0.detail"]);
    expect(result.messages).toMatchObject([
      { seq: 2, text: "Summary.", asks: [{ question: "Still on?" }] },
    ]);
    expect(result.messages[0]).not.toHaveProperty("detail");
  });

  it("leaves out a message's files when they alone are too long", async () => {
    await startThread("r1");
    const path = "/api/agent/s/builder/main/threads/1";
    harness.beforeRequest = (request) => {
      if (request.method !== "GET" || new URL(request.url).pathname !== path) {
        return undefined;
      }
      // Ten files, under names longer than any this release allows, as a
      // later release's might be.
      const attachments = Array.from({ length: 10 }, (_, i) => ({
        name: `${i}${"n".repeat(4_500)}`,
        file: "AAAAAAAAAAAAAAAAAAAAAA",
        size: 1,
        type: "text/plain",
      }));
      return serverJson({
        thread: { number: 1, last_seq: 1 },
        messages: [{ seq: 1, text: "Files.", attachments }],
        cursors: {},
      });
    };
    const answer = await bridge.call("thread_get", { thread: 1 });
    withinCap(answer);
    const result = answer.json as { messages: object[]; omitted: string[] };
    expect(result.omitted).toEqual(["messages.0.attachments"]);
    expect(result.messages).toEqual([{ seq: 1, text: "Files." }]);
  });

  it("leaves out references when they alone are too long", async () => {
    await startThread("r1", { text: "Details.", references: references(2_048) });
    const answer = await bridge.call("thread_get", { thread: 1 });
    withinCap(answer);
    const result = answer.json as { messages: object[]; omitted: string[] };
    expect(result.omitted).toEqual(["messages.0.references"]);
    expect(result.messages).toMatchObject([{ seq: 1, text: "Details." }]);
  });

  it("counts bytes of UTF-8, not UTF-16 code units", async () => {
    // Three bytes each, but one code unit: 20,000 code units, 60,000 bytes.
    await startThread("r1", { text: "Summary.", detail: "\u20ac".repeat(20_000) });
    const answer = await bridge.call("thread_get", { thread: 1, limit: 1 });
    expect(answer.text.length).toBeLessThan(maxResultBytes);
    withinCap(answer);
    expect((answer.json as { omitted: string[] }).omitted).toEqual(["messages.0.detail"]);
  });

  it("leaves out the largest fields in turn, until it fits", async () => {
    // References of about 41,800 bytes, then 40,500 bytes of detail, which
    // is still over the cap once the references are left out.
    await startThread("r1", {
      text: "Summary.",
      detail: "\u20ac".repeat(13_500),
      references: references(2_048),
      asks: [{ question: "q", suggestions: [{ label: "a", description: "d".repeat(300) }] }],
    });
    const answer = await bridge.call("thread_get", { thread: 1 });
    withinCap(answer);
    const result = answer.json as { messages: object[]; omitted: string[] };
    expect(result.omitted).toEqual(["messages.0.references", "messages.0.detail"]);
    expect(result.messages[0]).toMatchObject({
      text: "Summary.",
      asks: [{ suggestions: [{ label: "a" }] }],
    });
  });

  it("fits ten withdrawals of asks with ten questions, every reason at its bound", async () => {
    const asks = Array.from({ length: 10 }, () => ({ question: astral(300) }));
    await startThread("r1", { asks });
    const withdrawals = asks.map((_, i) => ({ ask: i + 1, reason: astral(300) }));
    await bridge.ok("message_send", { thread: 1, request_id: "w", seen_through: 1, withdrawals });
    const answer = await bridge.call("thread_get", { thread: 1 });
    withinCap(answer);
    const result = answer.json as { messages: object[]; omitted?: string[] };
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({ withdrawals });
  });

  it("leaves out the largest fields of a message's asks, each named by its place", async () => {
    // Ten asks, each with a fallback of about 4,000 bytes: over the cap
    // until several fallbacks are left out.
    const asks = Array.from({ length: 10 }, (_, i) => ({
      question: `Question ${i + 1}?`,
      fallback: astral(1_000),
    }));
    await startThread("r1", { asks });
    const answer = await bridge.call("thread_get", { thread: 1 });
    withinCap(answer);
    const result = answer.json as { messages: { asks: object[] }[]; omitted: string[] };
    expect(result.omitted.length).toBeGreaterThan(0);
    result.omitted.forEach((omitted, i) => {
      expect(omitted).toBe(`messages.0.asks.${i}.fallback`);
      expect(result.messages[0]?.asks[i]).not.toHaveProperty("fallback");
    });
    expect(result.messages[0]?.asks.at(-1)).toHaveProperty("fallback");
    expect(result.messages[0]?.asks).toMatchObject(asks.map(({ question }) => ({ question })));
  });

  // Each of these alone is past the cap, in an answer otherwise small.
  const over = astral(11_000);
  it.each<[string, { thread?: object; message?: object }]>([
    ["thread.title", { thread: { title: over } }],
    ["messages.0.answers.0.labels", { message: { answers: [{ ask: 1, labels: [over] }] } }],
    ["messages.0.answers.0.question", { message: { answers: [{ ask: 1, question: over }] } }],
    [
      "messages.0.asks.0.answer.labels",
      { message: { asks: [{ number: 1, question: "Which?", answer: { labels: [over] } }] } },
    ],
    // A withdrawal's reason is bounded short; a server past the bound still
    // fits.
    ["thread.withdrawal.reason", { thread: { withdrawal: { ask: 1, seq: 2, reason: over } } }],
    [
      "messages.0.asks.0.withdrawal.reason",
      {
        message: {
          asks: [{ number: 1, question: "Which?", withdrawal: { seq: 2, reason: over } }],
        },
      },
    ],
    ["messages.0.withdrawals.0.reason", { message: { withdrawals: [{ ask: 1, reason: over }] } }],
  ])("leaves out %s, as every other text", async (path, { thread = {}, message = {} }) => {
    await startThread("r1");
    const threadPath = "/api/agent/s/builder/main/threads/1";
    harness.beforeRequest = (request) => {
      if (request.method !== "GET" || new URL(request.url).pathname !== threadPath) {
        return undefined;
      }
      return serverJson({
        thread: { number: 1, last_seq: 2, ...thread },
        messages: [{ seq: 2, ...message }],
        cursors: {},
      });
    };
    const answer = await bridge.call("thread_get", { thread: 1, after: 1, limit: 1 });
    withinCap(answer);
    expect((answer.json as { omitted: string[] }).omitted).toEqual([path]);
  });

  // Building thousands of asks takes hundreds of round trips through the bridge.
  it("keeps a thread with thousands of open asks within the cap", { timeout: 30_000 }, async () => {
    const asks = Array.from({ length: 10 }, () => ({ question: astral(300) }));
    await startThread("r1", { asks });
    for (let seq = 1; seq < 200; seq++) {
      await bridge.ok("message_send", {
        thread: 1,
        request_id: `m${seq}`,
        seen_through: seq,
        asks,
      });
    }
    const answer = await bridge.call("thread_get", { thread: 1 });
    withinCap(answer);
    const { thread } = answer.json as {
      thread: { open_asks: { asks: unknown[]; count: number } };
    };
    expect(thread.open_asks.count).toBe(2_000);
    expect(thread.open_asks.asks).toHaveLength(maxListedAsks);
    withinCap(await bridge.call("thread_list", {}));
  });
});

describe("a stale error over the error limit", () => {
  it("keeps the leading missed messages that fit, and says where the rest are", async () => {
    await startThread("r1");
    for (let i = 0; i < 3; i++) {
      await harness.operatorWrites(1, { text: "Notes.", detail: "m".repeat(4_000) });
    }
    const answer = await bridge.call("message_send", {
      thread: 1,
      request_id: "r2",
      seen_through: 1,
      text: "Late.",
    });
    expect(answer.isError).toBe(true);
    withinCap(answer);
    const { error } = answer.json as { error: { code: string; message: string; missed: unknown } };
    expect(error.code).toBe("stale");
    expect(sequencesOf(error.missed)).toEqual([2, 3]);
    expect(error.message).toContain("thread_get, after 3");
  });

  it("counts bytes of UTF-8 too", async () => {
    await startThread("r1");
    for (let i = 0; i < 2; i++) {
      // 2,000 code units, 6,000 bytes.
      await harness.operatorWrites(1, { text: "Notes.", detail: "\u20ac".repeat(2_000) });
    }
    const answer = await bridge.call("message_send", {
      thread: 1,
      request_id: "r2",
      seen_through: 1,
      text: "Late.",
    });
    expect(answer.text.length).toBeLessThan(maxErrorBytes);
    withinCap(answer);
    const { error } = answer.json as { error: { missed: unknown } };
    expect(sequencesOf(error.missed)).toEqual([2]);
  });

  it("says where to read the missed messages when none fits", async () => {
    await startThread("r1");
    await harness.operatorWrites(1, { text: "Notes.", detail: "m".repeat(12_000) });
    const answer = await bridge.call("message_send", {
      thread: 1,
      request_id: "r2",
      seen_through: 1,
      text: "Late.",
    });
    withinCap(answer);
    const { error } = answer.json as { error: { code: string; message: string; missed: unknown } };
    expect(error.code).toBe("stale");
    expect(error.missed).toEqual([]);
    expect(error.message).toContain("thread_get, after 1");
  });
});
