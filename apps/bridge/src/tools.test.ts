import {
  agentApi,
  agentApiHeader,
  includeArchivedFilter,
  markInput,
  messageFields,
  sessionUpdateInput,
  statusFilter,
  threadCreateInput,
  titleSearchFilter,
  unreadFilter,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { existsSync } from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BridgeHarness, certificate, session, type TestBridge } from "./test-harness.ts";

let harness: BridgeHarness;

beforeEach(async () => {
  harness = await new BridgeHarness().start();
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.close();
});

const tools = [
  "register",
  "thread_create",
  "message_send",
  "thread_get",
  "thread_list",
  "thread_read",
  "thread_archive",
  "message_wait",
  "session_update",
  "file_upload",
  "file_get",
];

function newThread(requestId: string, fields: Record<string, unknown> = {}) {
  return { request_id: requestId, title: "A question", ...fields };
}

const ask = { question: "Ship it?", suggestions: [{ label: "Yes" }, { label: "Not yet" }] };

// approvedBridge starts a bridge whose session the operator has approved.
async function approvedBridge(): Promise<TestBridge> {
  const bridge = await harness.bridge();
  await bridge.ok("register");
  await harness.approve(harness.keyOnDisk());
  return bridge;
}

// The JSON Schema of an input, as the bridge's tools advertise it.
function propertiesOf(schema: z.ZodType): Record<string, unknown> {
  return (z.toJSONSchema(schema, { io: "input" }) as { properties: Record<string, unknown> })
    .properties;
}

describe("the tool list", () => {
  it("annotates every tool as neither read-only nor destructive, in a closed world", async () => {
    const bridge = await harness.bridge();
    const { tools: listed } = await bridge.client.listTools();
    expect(listed.map((tool) => tool.name)).toEqual(tools);
    for (const tool of listed) {
      expect([tool.name, tool.annotations]).toEqual([
        tool.name,
        { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      ]);
    }
  });

  it("declares to Claude Code the most each tool's result takes", async () => {
    const bridge = await harness.bridge();
    const { tools: listed } = await bridge.client.listTools();
    for (const tool of listed) {
      expect([tool.name, tool._meta]).toEqual([
        tool.name,
        { "anthropic/maxResultSizeChars": 40_765 },
      ]);
    }
  });

  it("advertises the API's own schemas and bounds, and no way to answer", async () => {
    const bridge = await harness.bridge();
    const { tools: listed } = await bridge.client.listTools();
    const schema = (name: string) => listed.find((tool) => tool.name === name)?.inputSchema;
    expect(schema("thread_create")?.properties).toEqual(propertiesOf(threadCreateInput));
    const { answers, ...sent } = propertiesOf(messageFields);
    expect(answers).toBeDefined();
    expect(schema("message_send")?.properties).toEqual({
      ...sent,
      thread: expect.any(Object),
    });
    expect(schema("thread_read")?.properties).toMatchObject(propertiesOf(markInput));
    expect(schema("thread_archive")?.properties).toMatchObject(propertiesOf(markInput));
    const filters = propertiesOf(
      z.object({
        include_archived: includeArchivedFilter,
        search: titleSearchFilter.optional(),
        status: statusFilter.optional(),
        unread: unreadFilter,
      }),
    );
    expect(schema("thread_list")?.properties).toMatchObject(filters);
    expect(schema("session_update")?.properties).toEqual(propertiesOf(sessionUpdateInput));
  });

  it("is served even without AGENTION_URL", async () => {
    const bridge = await harness.bridge({ AGENTION_URL: undefined });
    const { tools: listed } = await bridge.client.listTools();
    expect(listed).toHaveLength(tools.length);
  });
});

// everyToolRefuses calls every tool with valid arguments and expects each to
// answer in plain text naming the setting to fix, with no request made and no
// key created.
async function everyToolRefuses(bridge: TestBridge, setting: string): Promise<void> {
  let requests = 0;
  harness.beforeRequest = () => {
    requests++;
  };
  const calls: [string, Record<string, unknown>][] = [
    ["register", {}],
    ["thread_create", newThread("r1")],
    ["message_send", { thread: 1, request_id: "r2", seen_through: 1, text: "More." }],
    ["thread_get", { thread: 1 }],
    ["thread_list", {}],
    ["thread_read", { thread: 1, through: 1 }],
    ["thread_archive", { thread: 1, through: 1 }],
    ["message_wait", { wait_seconds: 0 }],
    ["session_update", { state: "working" }],
    ["file_upload", { path: path.join(harness.home, "notes.txt") }],
    ["file_get", { thread: 1, seq: 1, name: "notes.txt" }],
  ];
  for (const [tool, args] of calls) {
    const answer = await bridge.call(tool, args);
    expect([tool, answer.isError, answer.json]).toEqual([tool, true, undefined]);
    expect(answer.text).toContain(setting);
  }
  expect(requests).toBe(0);
  expect(existsSync(path.join(harness.home, ".config"))).toBe(false);
}

// Each test calls every tool, which under load can take longer than Vitest's
// default 5 seconds.
describe("a setting the bridge cannot work with", { timeout: 30_000 }, () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["plain HTTP", "http://localhost:8080"],
    ["with a path", "https://localhost:8443/agention"],
    ["with the default port", "https://localhost:443"],
    ["with user information", "https://agent@localhost:8443"],
    ["without a scheme", "localhost:8443"],
    ["an IP address", "https://127.0.0.1:8443"],
    ["a host of dots", "https://.."],
  ])("such as AGENTION_URL %s makes every tool say to set it", async (_, url) => {
    await everyToolRefuses(await harness.bridge({ AGENTION_URL: url }), "AGENTION_URL");
  });

  it("such as AGENTION_CONNECT without a port makes every tool say to set it", async () => {
    const bridge = await harness.bridge({ AGENTION_CONNECT: "127.0.0.1" });
    await everyToolRefuses(bridge, "AGENTION_CONNECT");
  });

  it("such as NODE_TLS_REJECT_UNAUTHORIZED=0 makes every tool say to unset it", async () => {
    const bridge = await harness.bridge({ NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    await everyToolRefuses(bridge, "NODE_TLS_REJECT_UNAUTHORIZED");
  });

  it.each([
    ["empty", ""],
    ["relative", "home/agent"],
    ["longer than any file system takes", `/${"a".repeat(5_000)}`],
  ])("such as a home directory that is %s makes every tool say to set HOME", async (_, home) => {
    await everyToolRefuses(await harness.bridge({}, home), "HOME");
  });
});

describe("an empty AGENTION_CONNECT", () => {
  it("connects at the origin's host, as when it is unset", async () => {
    const bridge = await harness.bridge({ AGENTION_CONNECT: "" });
    expect(await bridge.ok("register")).toMatchObject({ status: "pending" });
  });
});

describe("a server that cannot be reached", () => {
  it("is reported in plain text, naming its origin", async () => {
    const unreachable = "https://localhost:9";
    const bridge = await harness.bridge({ AGENTION_URL: unreachable });
    const answer = await bridge.call("register");
    expect(answer.isError).toBe(true);
    expect(answer.json).toBeUndefined();
    expect(answer.text).toContain(unreachable);
  });
});

describe("a redirect", () => {
  it("is refused, sending nothing to where it points", async () => {
    let reached = 0;
    const other = createServer({ cert: certificate.cert, key: certificate.key }, (_, response) => {
      reached++;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const { port } = other.address() as { port: number };
    harness.beforeRequest = (request) =>
      new Response(null, {
        status: 307,
        headers: { location: `https://localhost:${port}${new URL(request.url).pathname}` },
      });
    const bridge = await harness.bridge();
    const answer = await bridge.call("register");
    await new Promise((resolve) => other.close(resolve));
    expect([answer.isError, answer.json]).toEqual([true, undefined]);
    expect(answer.text).toContain("AGENTION_URL");
    expect(reached).toBe(0);
  });
});

describe("the agent API version", () => {
  // answerWith answers every request in place of the server: Agention's JSON
  // with the status given, stating the version given, or none.
  function answerWith(status: number, body: unknown, version?: string): void {
    harness.beforeRequest = () =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json",
          ...(version === undefined ? {} : { [agentApiHeader]: version }),
        },
      });
  }

  const pending = { status: "pending", code: "7KQ2M-X9D4R", expires_at: "2026-11-20T12:00:00Z" };

  it("is stated on every request the bridge makes", async () => {
    const stated: (string | null)[] = [];
    const bridge = await approvedBridge();
    harness.beforeRequest = (request) => {
      stated.push(request.headers.get(agentApiHeader));
    };
    await bridge.ok("register");
    await bridge.ok("thread_create", newThread("r1"));
    await bridge.ok("thread_get", { thread: 1 });
    await bridge.ok("thread_read", { thread: 1, through: 1 });
    await bridge.ok("session_update", { state: "working" });
    expect(stated.length).toBeGreaterThanOrEqual(5);
    expect(new Set(stated)).toEqual(new Set([String(agentApi.version)]));
  });

  it.each([
    ["none", undefined],
    ["an older one", String(agentApi.version - 1)],
    ["one that is no version", "two"],
  ])("refuses an answer stating %s, its body unused", async (_, version) => {
    const bridge = await harness.bridge();
    answerWith(200, pending, version);
    const refused = await bridge.call("register");
    expect([refused.isError, refused.json]).toEqual([true, undefined]);
    answerWith(404, { error: { code: "not_found", message: "not found" } }, version);
    const failed = await bridge.call("register");
    expect([failed.isError, failed.json]).toEqual([true, undefined]);
  });

  it("takes an answer stating its own version or a newer one, however long", async () => {
    const bridge = await harness.bridge();
    for (const version of [agentApi.version, agentApi.version + 1, "99999999999999999999"]) {
      answerWith(200, pending, String(version));
      expect(await bridge.ok("register")).toMatchObject({ status: "pending", code: pending.code });
    }
  });

  it("leaves an answer without Agention's JSON, such as a proxy's, to the problem it names", async () => {
    const bridge = await harness.bridge();
    harness.beforeRequest = () => new Response("Bad Gateway", { status: 502 });
    const proxied = await bridge.call("register");
    answerWith(200, pending);
    const older = await bridge.call("register");
    expect([proxied.isError, older.isError]).toEqual([true, true]);
    // Each is a problem of its own, which says what to do about it.
    expect(proxied.text).not.toEqual(older.text);
  });
});

describe("session_update", () => {
  it("reports the session's status, which the operator sees, and answers with it", async () => {
    const bridge = await approvedBridge();
    expect(
      await bridge.ok("session_update", {
        state: "working",
        title: "Retire invoices",
        goal: "Drop the table",
      }),
    ).toEqual({ state: "working", title: "Retire invoices", goal: "Drop the table" });
    expect(await bridge.ok("session_update", { percent: 40, note: "Backfill under way." })).toEqual(
      { state: "working", title: "Retire invoices", goal: "Drop the table", percent: 40 },
    );
    expect(
      await bridge.ok("session_update", { state: "stopped", outcome: "completed" }),
    ).toMatchObject({ state: "stopped", outcome: "completed" });
    const sessions = await harness.server.web("GET", "/sessions");
    expect(sessions.body).toMatchObject({
      agents: [
        {
          sessions: [
            {
              status: { state: "stopped", outcome: "completed", percent: 40 },
              unread_updates: 3,
            },
          ],
        },
      ],
    });
  });

  it.each([
    ["nothing", {}, undefined],
    ["only an outcome", { outcome: "completed" }, "outcome"],
    ["stopped without an outcome", { state: "stopped" }, "outcome"],
    ["an outcome beside idle", { state: "idle", outcome: "stalled" }, "outcome"],
    ["a percent above 100", { percent: 101 }, "percent"],
    ["a field it does not know", { state: "working", progress: 10 }, "progress"],
  ])("refuses %s before any request", async (_, input, field) => {
    const bridge = await approvedBridge();
    let requests = 0;
    harness.beforeRequest = () => {
      requests++;
    };
    const error = await bridge.error("session_update", input);
    expect([error.code, error.field]).toEqual(["invalid_input", field]);
    expect(requests).toBe(0);
  });
});

describe("before the operator approves", () => {
  it("each thread tool says to call register, and creates no key", async () => {
    const bridge = await harness.bridge();
    const error = await bridge.error("thread_list");
    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("register");
    expect(existsSync(harness.keyFile())).toBe(false);
  });

  it("a thread tool gives the code to approve", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    const error = await bridge.error("thread_list");
    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain(registrationCode(harness.keyOnDisk()));
  });
});

describe("a bridge started after approval", () => {
  it("learns the granted names without register", async () => {
    const first = await harness.bridge();
    await first.ok("register");
    await harness.approve(harness.keyOnDisk(), { agent: "reviewer", session: "nightly" });
    const restarted = await harness.bridge();
    expect(await restarted.ok("thread_create", newThread("r1"))).toMatchObject({ number: 1 });
    expect((await harness.server.web("GET", "/s/reviewer/nightly/threads/1")).status).toBe(200);
  });

  it("registers a key the server has not seen, as register would", async () => {
    const first = await harness.bridge();
    await first.ok("register");
    const key = harness.keyOnDisk();
    harness.server.fixture.db.prepare("DELETE FROM registrations").run();
    const restarted = await harness.bridge();
    expect((await restarted.error("thread_list")).code).toBe("unauthenticated");
    expect(harness.registrations()).toMatchObject([{ public_key: key, status: "pending" }]);
  });
});

describe("the thread tools", () => {
  it("start a thread and answer with the API's write result", async () => {
    const bridge = await approvedBridge();
    expect(
      await bridge.ok("thread_create", newThread("r1", { asks: [ask], topic: "release" })),
    ).toEqual({
      number: 1,
      seq: 1,
    });
  });

  it("send a message, and retry the same request id safely", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1"));
    const message = { thread: 1, request_id: "r2", seen_through: 1, text: "More." };
    const result = await bridge.ok("message_send", message);
    expect(result).toEqual({ number: 1, seq: 2 });
    expect(await bridge.ok("message_send", message)).toEqual(result);
    const conflict = await bridge.error("message_send", { ...message, text: "Other." });
    expect(conflict.code).toBe("request_id_conflict");
  });

  it("number the asks of a message as they are written", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1", { asks: [ask, ask] }));
    await bridge.ok("message_send", { thread: 1, request_id: "r2", seen_through: 1, asks: [ask] });
    const read = await bridge.ok("thread_get", { thread: 1 });
    expect(read.thread).toMatchObject({
      open_asks: {
        asks: [
          { number: 1, seq: 1 },
          { number: 2, seq: 1 },
          { number: 3, seq: 2 },
        ],
      },
    });
    expect(read.messages).toMatchObject([
      { seq: 1, asks: [{ number: 1, open: true }, { number: 2 }] },
      { seq: 2, asks: [{ number: 3 }] },
    ]);
  });

  it("revise an ask by replacing its message, which asks again under a new number", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1", { asks: [ask] }));
    await bridge.ok("message_send", {
      thread: 1,
      request_id: "r2",
      seen_through: 1,
      asks: [{ ...ask, priority: "urgent", effort: "under_15m" }],
      replaces: 1,
    });
    const read = await bridge.ok("thread_get", { thread: 1 });
    expect(read.thread).toMatchObject({
      open_asks: { asks: [{ number: 2, seq: 2 }], priority: "urgent" },
    });
    expect(read.messages).toMatchObject([
      { seq: 1, live: false, replaced_by: 2, asks: [{ number: 1, open: false }] },
      { seq: 2, live: true, replaces: 1, asks: [{ number: 2, effort: "under_15m" }] },
    ]);
  });

  it("withdraw an ask with its reason, never undone, and read the thread's status", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1", { asks: [ask] }));
    const reason = "The pull request merged.";
    await bridge.ok("message_send", {
      thread: 1,
      request_id: "r2",
      seen_through: 1,
      withdrawals: [{ ask: 1, reason }],
    });
    const read = await bridge.ok("thread_get", { thread: 1 });
    expect(read.thread).toMatchObject({
      status: "withdrawn",
      withdrawal: { ask: 1, seq: 2, reason },
      open_asks: { asks: [] },
    });
    expect(read.messages).toMatchObject([
      { seq: 1, asks: [{ number: 1, open: false, withdrawal: { seq: 2, reason } }] },
      { seq: 2, withdrawals: [{ ask: 1, reason }] },
    ]);
    expect((await bridge.ok("thread_list", { status: "withdrawn" })).threads).toMatchObject([
      { number: 1, status: "withdrawn" },
    ]);
    // A replacement withdraws it again; one asks again or withdraws each open
    // ask of the message it replaces, and one short of that is refused.
    expect(
      await bridge.error("message_send", {
        thread: 1,
        request_id: "r3",
        seen_through: 2,
        text: "Merged.",
        replaces: 2,
      }),
    ).toMatchObject({ code: "invalid_input", field: "withdrawals" });
    await bridge.ok("thread_create", newThread("r4", { asks: [ask, ask] }));
    expect(
      await bridge.error("message_send", {
        thread: 2,
        request_id: "r5",
        seen_through: 1,
        asks: [ask],
        replaces: 1,
      }),
    ).toMatchObject({ code: "invalid_input", field: "asks" });
    await bridge.ok("message_send", {
      thread: 2,
      request_id: "r6",
      seen_through: 1,
      asks: [ask],
      withdrawals: [{ ask: 2, reason }],
      replaces: 1,
    });
    const revised = await bridge.ok("thread_get", { thread: 2 });
    expect(revised.thread).toMatchObject({ open_asks: { asks: [{ number: 3, seq: 2 }] } });
  });

  it("send no answer, which only the audience gives", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1", { asks: [ask] }));
    let posts = 0;
    harness.beforeRequest = (request) => {
      if (request.method === "POST") {
        posts++;
      }
      return undefined;
    };
    const error = await bridge.error("message_send", {
      thread: 1,
      request_id: "r2",
      seen_through: 1,
      text: "More.",
      answers: [{ ask: 1, declined: true }],
    });
    expect(error).toMatchObject({ code: "invalid_input", field: "answers" });
    expect(posts).toBe(0);
  });

  it("read the operator's answers, each naming the ask it answers and its question", async () => {
    const bridge = await approvedBridge();
    const second = { ...ask, question: "And the docs?", multiple: true };
    await bridge.ok("thread_create", newThread("r1", { asks: [ask, second] }));
    const seq = await harness.operatorWrites(1, {
      answers: [
        { ask: 1, declined: true },
        { ask: 2, picks: [1], text: "Once the docs land." },
      ],
      text: "The docs are in review.",
    });
    const read = await bridge.ok("thread_get", { thread: 1, after: 1 });
    expect(read.messages).toEqual([
      expect.objectContaining({
        seq,
        text: "The docs are in review.",
        answers: [
          { ask: 1, question: ask.question, ask_seq: 1, ask_live: true, declined: true },
          {
            ask: 2,
            question: second.question,
            ask_seq: 1,
            ask_live: true,
            declined: false,
            picks: [1],
            labels: ["Not yet"],
            text: "Once the docs land.",
          },
        ],
      }),
    ]);
    expect(read.thread).toMatchObject({ unread: 1, open_asks: { asks: [] } });
  });

  it("mark a thread read and archive it", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1"));
    const seq = await harness.operatorWrites(1, { text: "Answer." });
    expect(await bridge.ok("thread_read", { thread: 1, through: seq })).toEqual({
      cursors: { requester: seq, audience: seq },
    });
    expect(await bridge.ok("thread_archive", { thread: 1, through: seq })).toEqual({
      marks: { read_through: seq, archived_through: seq },
    });
    expect((await bridge.ok("thread_list", {})).threads).toEqual([]);
    expect(
      (await bridge.ok("thread_list", { include_archived: true, search: "quest" })).threads,
    ).toMatchObject([{ number: 1, archived: true }]);
  });

  it("get a thread and a page of its messages", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1", { text: "Details." }));
    await harness.operatorWrites(1, { text: "First." });
    await harness.operatorWrites(1, { text: "Second." });
    const all = await bridge.ok("thread_get", { thread: 1 });
    expect(all).toMatchObject({ thread: { number: 1, last_seq: 3, unread: 2 } });
    expect((all.messages as { seq: number }[]).map((message) => message.seq)).toEqual([1, 2, 3]);
    const page = await bridge.ok("thread_get", { thread: 1, after: 1, limit: 1 });
    expect(page.messages).toMatchObject([{ seq: 2, text: "First." }]);
  });

  it("list threads, their own new ones included, by filters that combine", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1", { asks: [ask], topic: "release" }));
    await bridge.ok("thread_create", newThread("r2", { title: "Docs to write", topic: "docs" }));
    const numbers = async (args: Record<string, unknown>) =>
      ((await bridge.ok("thread_list", args)).threads as { number: number }[]).map(
        (thread) => thread.number,
      );
    expect(await numbers({})).toEqual([1, 2]);
    expect(await numbers({ status: "open" })).toEqual([1]);
    expect(await numbers({ status: "none" })).toEqual([2]);
    expect(await numbers({ topic: "release" })).toEqual([1]);
    expect(await numbers({ search: "docs" })).toEqual([2]);
    await harness.operatorWrites(2, { text: "Seen." });
    expect(await numbers({ unread: true })).toEqual([2]);
    expect(await numbers({ unread: true, status: "open" })).toEqual([]);
    const page = await bridge.ok("thread_list", { limit: 1 });
    expect(await numbers({ cursor: page.next })).toEqual([2]);
  });

  it("relay the API's errors as error results", async () => {
    const bridge = await approvedBridge();
    expect(await bridge.error("thread_get", { thread: 99 })).toEqual({
      code: "not_found",
      message: "not found",
    });
  });

  it("act in the session the operator granted", async () => {
    const bridge = await harness.bridge();
    await bridge.ok("register");
    await harness.approve(harness.keyOnDisk(), { agent: "reviewer", session: "nightly" });
    await bridge.ok("thread_create", newThread("r1"));
    expect((await harness.server.web("GET", `/s/reviewer/nightly/threads/1`)).status).toBe(200);
    expect((await harness.server.web("GET", `/s/builder/${session}/threads/1`)).status).toBe(404);
  });

  it("relay the server's answer once the key is revoked, which says to call register", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_list");
    await harness.revoke(harness.keyOnDisk());
    const error = await bridge.error("thread_list");
    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("register");
  });
});

describe("input outside the API's bounds", () => {
  const message = (fields: Record<string, unknown>) => ({
    thread: 1,
    request_id: "r2",
    seen_through: 1,
    ...fields,
  });

  it.each([
    ["thread_create", "a title too long", newThread("r1", { title: "t".repeat(201) }), "title"],
    ["thread_create", "text too long", newThread("r1", { text: "b".repeat(1_001) }), "text"],
    [
      "thread_create",
      "text larger than any request",
      newThread("r1", { text: "b".repeat(2_200_000) }),
      "text",
    ],
    [
      "thread_create",
      "detail too long",
      newThread("r1", { text: "b", detail: "d".repeat(20_001) }),
      "detail",
    ],
    ["thread_create", "detail without text", newThread("r1", { detail: "d" }), "detail"],
    ["thread_create", "a missing title", { request_id: "r1" }, "title"],
    [
      "thread_create",
      "several picks over one suggestion",
      newThread("r1", {
        asks: [{ question: "q", suggestions: [{ label: "a" }], multiple: true }],
      }),
      "asks.0.suggestions",
    ],
    [
      "thread_create",
      "a bad reference",
      newThread("r1", { references: [{ label: "x", url: "http://x" }] }),
      "references.0.url",
    ],
    ["message_send", "text too long", message({ text: "b".repeat(1_001) }), "text"],
    [
      "message_send",
      "detail too long",
      message({ text: "b", detail: "d".repeat(20_001) }),
      "detail",
    ],
    ["message_send", "detail without text", message({ detail: "d", asks: [ask] }), "detail"],
  ])(
    "%s answers invalid_input naming the field, before any request: %s",
    async (tool, _, input, field) => {
      const bridge = await approvedBridge();
      let requests = 0;
      harness.beforeRequest = () => {
        requests++;
      };
      expect(await bridge.error(tool, input)).toMatchObject({ code: "invalid_input", field });
      expect(requests).toBe(0);
    },
  );

  it("takes a message's text and detail each at its bound", async () => {
    const bridge = await approvedBridge();
    const text = "\u{1F600}".repeat(1_000);
    const detail = "\u{1F600}".repeat(20_000);
    expect(await bridge.ok("thread_create", newThread("r1", { text, detail }))).toEqual({
      number: 1,
      seq: 1,
    });
    expect(await bridge.ok("message_send", message({ text, detail }))).toEqual({
      number: 1,
      seq: 2,
    });
  });

  it.each([
    // A misspelling of replaces. cspell:disable-next-line
    ["thread_create", newThread("r1", { replcaes: 1 }), "replcaes"],
    ["thread_create", newThread("r1", { asks: [{ ...ask, prompt: "Ship?" }] }), "asks.0.prompt"],
    [
      "thread_create",
      newThread("r1", { references: [{ label: "x", identifier: "#1", link: "https://x" }] }),
      "references.0.link",
    ],
    ["message_send", { thread: 1, request_id: "r2", seen_through: 1, txt: "More." }, "txt"],
    ["thread_list", { sort: "latest" }, "sort"],
    ["thread_archive", { thread: 1, through: 1, everything: true }, "everything"],
    ["message_wait", { wait: 5 }, "wait"],
  ])(
    "refuses a field %s does not know, naming it, before any request",
    async (name, input, field) => {
      const bridge = await approvedBridge();
      let requests = 0;
      harness.beforeRequest = () => {
        requests++;
      };
      expect(await bridge.error(name, input)).toMatchObject({ code: "invalid_input", field });
      expect(requests).toBe(0);
    },
  );

  it("refuses a field register does not know", async () => {
    const bridge = await harness.bridge();
    expect(await bridge.error("register", { agent: "builder", name: "main" })).toMatchObject({
      code: "invalid_input",
      field: "name",
    });
  });

  it("in a message larger than any request is answered as invalid_input", async () => {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1"));
    const error = await bridge.error("message_send", {
      thread: 1,
      request_id: "r2",
      seen_through: 1,
      text: "m".repeat(2_200_000),
    });
    expect(error).toMatchObject({ code: "invalid_input", field: "text" });
  });
});

describe("message_wait", () => {
  async function bridgeWithThread(): Promise<TestBridge> {
    const bridge = await approvedBridge();
    await bridge.ok("thread_create", newThread("r1"));
    return bridge;
  }

  it("wakes when a message lands", async () => {
    const bridge = await bridgeWithThread();
    const started = performance.now();
    const waiting = bridge.ok("message_wait", { wait_seconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await harness.operatorWrites(1, { text: "Answer." });
    const answer = await waiting;
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(answer.threads).toMatchObject([{ number: 1, read_through: 1, unread: 1 }]);
  });

  it("checks at once by default, answering with nothing to report", async () => {
    const bridge = await bridgeWithThread();
    const started = performance.now();
    const answer = await bridge.ok("message_wait", {});
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(answer.threads).toEqual([]);
    expect(typeof answer.since).toBe("string");
  });

  it("answers with nothing once its wait ends", async () => {
    const bridge = await bridgeWithThread();
    const started = performance.now();
    const answer = await bridge.ok("message_wait", { wait_seconds: 1 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(answer.threads).toEqual([]);
    expect(typeof answer.since).toBe("string");
  });

  it("waits only for messages newer than since", async () => {
    const bridge = await bridgeWithThread();
    await harness.operatorWrites(1, { text: "Answer." });
    const first = await bridge.ok("message_wait", { wait_seconds: 0 });
    expect(first.threads).toMatchObject([{ number: 1, unread: 1 }]);
    const unchanged = await bridge.ok("message_wait", { since: first.since, wait_seconds: 1 });
    expect(unchanged.threads).toEqual([]);
    const waiting = bridge.ok("message_wait", { since: first.since, wait_seconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await harness.operatorWrites(1, { text: "More." });
    expect((await waiting).threads).toMatchObject([{ number: 1, unread: 2 }]);
  });

  // fakeClock fakes the clock the bridge paces its failures by; the test
  // still waits for requests in real time.
  const fakeClock = () =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

  // answeredAfter moves the faked clock on and says whether the call has
  // answered by then.
  async function answeredAfter(call: Promise<unknown>, milliseconds: number): Promise<boolean> {
    let answered = false;
    const settle = () => {
      answered = true;
    };
    void call.then(settle, settle);
    await vi.advanceTimersByTimeAsync(milliseconds);
    return answered;
  }

  it("answers a key revoked while it waits once the wait would have ended, from its start", async () => {
    const bridge = await bridgeWithThread();
    fakeClock();
    const waiting = bridge.error("message_wait", { wait_seconds: 20 });
    await delay(200);
    await vi.advanceTimersByTimeAsync(5_000);
    await harness.revoke(harness.keyOnDisk());
    await delay(200);
    expect(await answeredAfter(waiting, 14_999)).toBe(false);
    expect(await answeredAfter(waiting, 1)).toBe(true);
    const error = await waiting;
    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("register");
  });

  it("answers a server it cannot reach once its wait would have ended", async () => {
    const unreachable = "https://localhost:9";
    const bridge = await harness.bridge({ AGENTION_URL: unreachable });
    // register leaves a key on disk, so the wait asks the server for its names.
    await bridge.call("register");
    fakeClock();
    const waiting = bridge.call("message_wait", { wait_seconds: 20 });
    await delay(200);
    expect(await answeredAfter(waiting, 19_999)).toBe(false);
    expect(await answeredAfter(waiting, 1)).toBe(true);
    const answer = await waiting;
    expect([answer.isError, answer.json]).toEqual([true, undefined]);
    expect(answer.text).toContain(unreachable);
  });

  // On the real clock: on some Node versions a round trip itself waits on timers.
  it("answers invalid input at once, whatever its wait", async () => {
    const bridge = await bridgeWithThread();
    const started = performance.now();
    const error = await bridge.error("message_wait", { since: "garbage", wait_seconds: 20 });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(error).toMatchObject({ code: "invalid_input", field: "since" });
  });

  it("ends a held failure once the call is cancelled", async () => {
    const bridge = await harness.bridge({ AGENTION_URL: "https://localhost:9" });
    await bridge.call("register");
    fakeClock();
    const cancel = new AbortController();
    const waiting = bridge.client.callTool(
      { name: "message_wait", arguments: { wait_seconds: 20 } },
      { signal: cancel.signal },
    );
    await delay(200);
    expect(await answeredAfter(waiting, 10_000)).toBe(false);
    cancel.abort();
    await expect(waiting).rejects.toThrow();
    // The bridge lets go of the wait it held, leaving no timer behind.
    await delay(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers a failure at once when it waits no time", async () => {
    const bridge = await harness.bridge();
    fakeClock();
    const error = await bridge.error("message_wait", { wait_seconds: 0 });
    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("register");
  });

  it("refuses a wait longer than 25 seconds", async () => {
    const bridge = await bridgeWithThread();
    expect(await bridge.error("message_wait", { wait_seconds: 26 })).toMatchObject({
      code: "invalid_input",
      field: "wait_seconds",
    });
  });
});
