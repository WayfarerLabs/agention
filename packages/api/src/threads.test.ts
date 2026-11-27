import { describe, expect, it } from "vitest";
import { invalidInputBody } from "./errors.ts";
import { namePattern } from "./names.ts";
import { sessionThreadsQuery } from "./thread-lists.ts";
import { messageSendInput, threadCreateInput, unreadInput } from "./threads.ts";

const ask = {
  question: "Which database?",
  suggestions: [{ label: "SQLite" }, { label: "Postgres", description: "Run a server." }],
};

const create = { request_id: "r-1", title: "Pick a database" };
const send = { request_id: "s-1", seen_through: 1 };
const upload = "AbCdEfGhIjKlMnOpQr_-09";
const otherUpload = "ZyXwVuTsRqPoNmLkJi_-87";

function fieldOf(result: { error?: Parameters<typeof invalidInputBody>[0] | undefined }) {
  return result.error === undefined ? undefined : invalidInputBody(result.error).error.field;
}

describe("threadCreateInput", () => {
  it("needs only a title, applies the ask's defaults and ignores unknown fields", () => {
    expect(threadCreateInput.parse({ ...create, later: true })).toEqual(create);
    expect(threadCreateInput.parse({ ...create, asks: [ask] })).toEqual({
      ...create,
      asks: [
        {
          question: "Which database?",
          suggestions: [
            { label: "SQLite", description: "" },
            { label: "Postgres", description: "Run a server." },
          ],
          multiple: false,
          impact: "none",
          priority: "normal",
        },
      ],
    });
  });

  it("takes no answer, withdraws nothing and replaces nothing", () => {
    const parsed = threadCreateInput.parse({
      ...create,
      answers: [{ ask: 1, declined: true }],
      withdrawals: [{ ask: 1, reason: "Moot." }],
      replaces: 1,
    });
    expect(parsed).toEqual(create);
  });

  it.each([
    ["an empty title", { title: "" }, "title"],
    ["a title on two lines", { title: "a\nb" }, "title"],
    ["empty text", { text: "" }, "text"],
    ["an empty question", { asks: [{ question: "" }] }, "asks.0.question"],
    ["a question on two lines", { asks: [{ question: "a\nb" }] }, "asks.0.question"],
    [
      "repeated suggestions",
      { asks: [{ question: "q", suggestions: [{ label: "a" }, { label: "a" }] }] },
      "asks.0.suggestions",
    ],
    [
      "suggestions equal once normalized",
      {
        asks: [
          {
            question: "q",
            suggestions: [{ label: `e${String.fromCharCode(0x301)}` }, { label: "\u00e9" }],
          },
        ],
      },
      "asks.0.suggestions",
    ],
    [
      "eleven suggestions",
      {
        asks: [
          {
            question: "q",
            suggestions: Array.from({ length: 11 }, (_, i) => ({ label: `s${i}` })),
          },
        ],
      },
      "asks.0.suggestions",
    ],
    [
      "several picks over one suggestion",
      { asks: [{ question: "q", suggestions: [{ label: "a" }], multiple: true }] },
      "asks.0.suggestions",
    ],
    ["an unknown priority", { asks: [{ question: "q", priority: "critical" }] }, "asks.0.priority"],
    [
      "an effort of no known length",
      { asks: [{ question: "q", effort: "soon" }] },
      "asks.0.effort",
    ],
    [
      "an answer-by time without an offset",
      { asks: [{ question: "q", answer_by: "2026-11-01T12:00:00" }] },
      "asks.0.answer_by",
    ],
    ["a title of white space", { title: " \t " }, "title"],
    ["text of white space", { text: " \n\n " }, "text"],
    ["detail without text", { detail: "What was found." }, "detail"],
    ["empty detail", { text: "Summary.", detail: "" }, "detail"],
    ["detail of white space", { text: "Summary.", detail: " \n " }, "detail"],
    ["a question of white space", { asks: [{ question: "  " }] }, "asks.0.question"],
    [
      "a suggested answer of white space",
      { asks: [{ question: "q", suggestions: [{ label: " " }] }] },
      "asks.0.suggestions.0.label",
    ],
    [
      "a reference label of white space",
      { references: [{ label: " ", thread: 1 }] },
      "references.0.label",
    ],
    ["a request id with a space", { request_id: "a b" }, "request_id"],
  ])("refuses %s", (_, change, field) => {
    expect(fieldOf(threadCreateInput.safeParse({ ...create, ...change }))).toBe(field);
  });
});

describe("messageSendInput", () => {
  it.each([
    ["text", { text: "More." }],
    ["text and its detail", { text: "More.", detail: "## Findings\n\nAt length." }],
    ["references", { references: [{ label: "CI", url: "https://example.com/run/1" }] }],
    ["asks", { asks: [ask, { question: "And when?" }] }],
    ["a decline", { answers: [{ ask: 1, declined: true }] }],
    [
      "answers to several asks",
      {
        answers: [
          { ask: 2, declined: true },
          { ask: 1, picks: [0] },
        ],
      },
    ],
    ["an answer of picks", { answers: [{ ask: 1, picks: [0, 1] }] }],
    [
      "an answer in the audience's own words",
      { answers: [{ ask: 1, text: "Neither.\nToo slow." }] },
    ],
    ["an answer of picks and own words", { answers: [{ ask: 1, picks: [0], text: "And more." }] }],
    ["a topic", { topic: "auth" }],
    [
      "withdrawals",
      {
        withdrawals: [
          { ask: 2, reason: "Merged." },
          { ask: 1, reason: "Moot." },
        ],
      },
    ],
    ["a replacement alone", { replaces: 1 }],
  ])("takes a message carrying only %s", (_, part) => {
    expect(messageSendInput.safeParse({ ...send, ...part }).success).toBe(true);
  });

  it.each([
    ["nothing", {}, undefined],
    ["detail alone", { detail: "What was found." }, "detail"],
    ["detail beside asks but no text", { detail: "Options.", asks: [ask] }, "detail"],
    [
      "detail beside answers but no text",
      { detail: "Why.", answers: [{ ask: 1, declined: true }] },
      "detail",
    ],
    ["detail in a replacement without text", { detail: "Why.", replaces: 1 }, "detail"],
    ["an empty list of references", { text: "m", references: [] }, "references"],
    ["an answer with neither picks nor own words", { answers: [{ ask: 1 }] }, "answers.0"],
    [
      "a decline with picks",
      { answers: [{ ask: 1, declined: true, picks: [0] }] },
      "answers.0.picks",
    ],
    [
      "a decline with own words",
      { answers: [{ ask: 1, declined: true, text: "No." }] },
      "answers.0.text",
    ],
    ["empty picks", { answers: [{ ask: 1, picks: [] }] }, "answers.0.picks"],
    ["a pick past the tenth", { answers: [{ ask: 1, picks: [10] }] }, "answers.0.picks.0"],
    ["own words of white space", { answers: [{ ask: 1, text: " \n " }] }, "answers.0.text"],
    ["an empty list of asks", { asks: [] }, "asks"],
    ["eleven asks", { asks: Array(11).fill(ask) }, "asks"],
    ["an empty list of answers", { answers: [] }, "answers"],
    [
      "eleven answers",
      { answers: Array.from({ length: 11 }, (_, i) => ({ ask: i + 1, declined: true })) },
      "answers",
    ],
    [
      "two answers to one ask",
      {
        answers: [
          { ask: 2, declined: true },
          { ask: 2, picks: [0] },
        ],
      },
      "answers.1.ask",
    ],
    ["an answer to ask 0", { answers: [{ ask: 0, declined: true }] }, "answers.0.ask"],
    ["an empty list of withdrawals", { withdrawals: [] }, "withdrawals"],
    [
      "eleven withdrawals",
      { withdrawals: Array.from({ length: 11 }, (_, i) => ({ ask: i + 1, reason: "r" })) },
      "withdrawals",
    ],
    [
      "two withdrawals of one ask",
      {
        withdrawals: [
          { ask: 2, reason: "Merged." },
          { ask: 2, reason: "Moot." },
        ],
      },
      "withdrawals.1.ask",
    ],
    ["a withdrawal without a reason", { withdrawals: [{ ask: 1 }] }, "withdrawals.0.reason"],
    ["a reason of white space", { withdrawals: [{ ask: 1, reason: " " }] }, "withdrawals.0.reason"],
    [
      "a reason on two lines",
      { withdrawals: [{ ask: 1, reason: "a\nb" }] },
      "withdrawals.0.reason",
    ],
    ["a negative seen_through", { text: "m", seen_through: -1 }, "seen_through"],
    ["a fractional replacement", { replaces: 1.5 }, "replaces"],
  ])("refuses %s", (_, change, field) => {
    const result = messageSendInput.safeParse({ ...send, ...change });
    expect(result.success).toBe(false);
    expect(fieldOf(result)).toBe(field);
  });
});

describe("attachments", () => {
  it.each([
    ["an upload", [{ upload }]],
    ["an upload under a name", [{ upload, name: "build log.txt" }]],
    ["a kept file", [{ keep: "photo.jpg" }]],
    [
      "uploads and kept files together",
      [{ keep: "photo.jpg" }, { upload, name: "notes.md" }, { upload: otherUpload }],
    ],
  ])("are taken as %s, and a message may carry files alone", (_, attachments) => {
    expect(messageSendInput.parse({ ...send, attachments })).toEqual({ ...send, attachments });
    expect(threadCreateInput.parse({ ...create, attachments })).toEqual({
      ...create,
      attachments,
    });
  });

  it.each([
    ["an empty list", [], "attachments"],
    ["eleven files", Array.from({ length: 11 }, (_, i) => ({ keep: `f${i}` })), "attachments"],
    ["neither an upload nor a kept file", [{ name: "a.txt" }], "attachments.0"],
    ["both an upload and a kept file", [{ upload, keep: "a.txt" }], "attachments.0.keep"],
    ["a name for a kept file", [{ keep: "a.txt", name: "b.txt" }], "attachments.0.name"],
    ["an invalid reference", [{ upload: "short" }], "attachments.0.upload"],
    ["an invalid name", [{ upload, name: "a/b" }], "attachments.0.name"],
    ["an invalid kept name", [{ keep: ".." }], "attachments.0.keep"],
    ["one upload named twice", [{ upload }, { upload, name: "b" }], "attachments.1.upload"],
    ["two files kept under one name", [{ keep: "a" }, { keep: "a" }], "attachments.1.keep"],
    [
      "an upload named as a kept file",
      [{ keep: "a.txt" }, { upload, name: "a.txt" }],
      "attachments.1.name",
    ],
    [
      "names equal once normalized",
      [{ upload, name: "\u00e9" }, { keep: `e${String.fromCharCode(0x301)}` }],
      "attachments.1.keep",
    ],
  ])("refuse %s", (_, attachments, field) => {
    expect(fieldOf(messageSendInput.safeParse({ ...send, attachments }))).toBe(field);
    expect(fieldOf(threadCreateInput.safeParse({ ...create, attachments }))).toBe(field);
  });

  it("tell names apart by case", () => {
    const attachments = [{ keep: "A.txt" }, { upload, name: "a.txt" }];
    expect(messageSendInput.safeParse({ ...send, attachments }).success).toBe(true);
  });
});

describe("a topic", () => {
  it.each(["auth", "billing-api", "v2_rollout", "7", "t".repeat(63)])(
    "is taken as a name, such as %j",
    (topic) => {
      expect(threadCreateInput.safeParse({ ...create, topic }).success).toBe(true);
      expect(messageSendInput.safeParse({ ...send, topic }).success).toBe(true);
      expect(sessionThreadsQuery.safeParse({ topic }).success).toBe(true);
    },
  );

  it.each(["", "a/b", "Auth", " auth", "auth ", "-auth", "t".repeat(64)])(
    "is refused wherever one is taken, as %j is",
    (topic) => {
      expect(fieldOf(threadCreateInput.safeParse({ ...create, topic }))).toBe("topic");
      expect(fieldOf(messageSendInput.safeParse({ ...send, topic }))).toBe("topic");
      expect(fieldOf(sessionThreadsQuery.safeParse({ topic }))).toBe("topic");
    },
  );
});

describe("unreadInput", () => {
  it("takes the message to mark unread from", () => {
    expect(unreadInput.parse({ from: 3 })).toEqual({ from: 3 });
  });

  it.each([
    ["nothing", {}],
    ["the start of the thread", { from: 0 }],
  ])("refuses %s", (_, input) => {
    expect(fieldOf(unreadInput.safeParse(input))).toBe("from");
  });
});

describe("bounds", () => {
  const astral = "\u{1F600}";

  // Each case gives a field's largest accepted value and the next one up.
  it.each([
    ["title", threadCreateInput, create, (n: number) => ({ title: astral.repeat(n) }), 200],
    ["text", messageSendInput, send, (n: number) => ({ text: astral.repeat(n) }), 1_000],
    [
      "a thread's first text",
      threadCreateInput,
      create,
      (n: number) => ({ text: astral.repeat(n) }),
      1_000,
    ],
    [
      "detail",
      messageSendInput,
      send,
      (n: number) => ({ text: "t", detail: astral.repeat(n) }),
      20_000,
    ],
    [
      "a thread's first detail",
      threadCreateInput,
      create,
      (n: number) => ({ text: "t", detail: "\n".repeat(n - 1) + astral }),
      20_000,
    ],
    [
      "question",
      threadCreateInput,
      create,
      (n: number) => ({ asks: [{ question: astral.repeat(n) }] }),
      300,
    ],
    [
      "suggestion label",
      threadCreateInput,
      create,
      (n: number) => ({ asks: [{ question: "q", suggestions: [{ label: "l".repeat(n) }] }] }),
      100,
    ],
    [
      "suggestion description",
      threadCreateInput,
      create,
      (n: number) => ({
        asks: [{ question: "q", suggestions: [{ label: "l", description: "d".repeat(n) }] }],
      }),
      300,
    ],
    [
      "fallback",
      threadCreateInput,
      create,
      (n: number) => ({ asks: [{ question: "q", fallback: "\n".repeat(n) }] }),
      1_000,
    ],
    ["search text", sessionThreadsQuery, {}, (n: number) => ({ search: astral.repeat(n) }), 200],
    [
      "picks",
      messageSendInput,
      send,
      (n: number) => ({
        answers: [{ ask: 1, picks: Array.from({ length: n }, (_, i) => i % 10) }],
      }),
      10,
    ],
    [
      "a withdrawal's reason",
      messageSendInput,
      send,
      (n: number) => ({ withdrawals: [{ ask: 1, reason: astral.repeat(n) }] }),
      300,
    ],
    [
      "withdrawals",
      messageSendInput,
      send,
      (n: number) => ({
        withdrawals: Array.from({ length: n }, (_, i) => ({ ask: i + 1, reason: "r" })),
      }),
      10,
    ],
    [
      "an answer's own words",
      messageSendInput,
      send,
      (n: number) => ({ answers: [{ ask: 1, text: "\n".repeat(n - 1) + astral }] }),
      4_000,
    ],
    [
      "reference label",
      threadCreateInput,
      create,
      (n: number) => ({ references: [{ label: "l".repeat(n), identifier: "i" }] }),
      100,
    ],
    [
      "reference identifier",
      threadCreateInput,
      create,
      (n: number) => ({ references: [{ label: "l", identifier: "i".repeat(n) }] }),
      200,
    ],
    [
      "reference URL",
      threadCreateInput,
      create,
      (n: number) => ({
        references: [{ label: "l", url: `https://example.com/${"u".repeat(n - 20)}` }],
      }),
      2_048,
    ],
    [
      "references",
      threadCreateInput,
      create,
      (n: number) => ({ references: Array(n).fill({ label: "l", thread: 1 }) }),
      20,
    ],
    [
      "attachments",
      messageSendInput,
      send,
      (n: number) => ({ attachments: Array.from({ length: n }, (_, i) => ({ keep: `f${i}` })) }),
      10,
    ],
    [
      "an attachment's name",
      threadCreateInput,
      create,
      (n: number) => ({ attachments: [{ upload, name: astral.repeat(n) }] }),
      200,
    ],
    [
      "a kept file's name",
      messageSendInput,
      send,
      (n: number) => ({ attachments: [{ keep: astral.repeat(n) }] }),
      200,
    ],
    ["request id", threadCreateInput, create, (n: number) => ({ request_id: "r".repeat(n) }), 64],
    [
      "seen_through",
      messageSendInput,
      send,
      (n: number) => ({ text: "m", seen_through: n }),
      Number.MAX_SAFE_INTEGER,
    ],
  ] as const)("%s", (_, schema, base, value, max) => {
    expect(schema.safeParse({ ...base, ...value(max) }).success).toBe(true);
    expect(schema.safeParse({ ...base, ...value(max + 1) }).success).toBe(false);
  });

  it("advertises them in the JSON Schema the bridge's tools carry", () => {
    const createSchema = threadCreateInput.toJSONSchema({ io: "input" });
    expect(createSchema.properties).toMatchObject({
      title: { minLength: 1, maxLength: 200 },
      text: { minLength: 1, maxLength: 1_000 },
      detail: { minLength: 1, maxLength: 20_000 },
      topic: { pattern: namePattern.source },
      references: { minItems: 1, maxItems: 20 },
      attachments: {
        minItems: 1,
        maxItems: 10,
        items: {
          properties: {
            upload: { pattern: "^[A-Za-z0-9_-]{22}$" },
            name: { minLength: 1, maxLength: 200 },
            keep: { minLength: 1, maxLength: 200 },
          },
        },
      },
      asks: {
        minItems: 1,
        maxItems: 10,
        items: {
          properties: {
            question: { minLength: 1, maxLength: 300 },
            suggestions: { maxItems: 10, items: { properties: { label: { maxLength: 100 } } } },
            fallback: { maxLength: 1_000 },
          },
        },
      },
    });
    const sendSchema = messageSendInput.toJSONSchema({ io: "input" });
    expect(sendSchema.properties).toMatchObject({
      seen_through: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      text: { minLength: 1, maxLength: 1_000 },
      detail: { minLength: 1, maxLength: 20_000 },
      answers: {
        minItems: 1,
        maxItems: 10,
        items: {
          properties: {
            picks: { minItems: 1, maxItems: 10 },
            text: { minLength: 1, maxLength: 4_000 },
          },
        },
      },
      withdrawals: {
        minItems: 1,
        maxItems: 10,
        items: { properties: { reason: { minLength: 1, maxLength: 300 } } },
      },
    });
  });
});
