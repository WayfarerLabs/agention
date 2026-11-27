import { pushPayload } from "@wayfarerlabs/agention-api";
import { describe, expect, it } from "vitest";
import { isReason, payloadOf, threadOf } from "./push-data.ts";

// The service worker's hand checks of what it reads, at their boundaries.

const longest = "a".repeat(63);
const thread = { agent: "api", session: "main", thread: 1 };

describe("threadOf", () => {
  it.each([
    ["the shortest names", { agent: "a", session: "0", thread: 1 }],
    ["the longest names and number", { agent: longest, session: longest, thread: 2 ** 53 - 1 }],
    ["names with hyphens and underscores", { agent: "a-b_c", session: "x_y-z", thread: 7 }],
  ])("reads %s", (_, value) => {
    expect(threadOf(value)).toEqual(value);
  });

  it("keeps only the thread of a value with other fields", () => {
    expect(threadOf({ ...thread, title: "Ship it?", why: "blocking", url: "https://x" })).toEqual(
      thread,
    );
  });

  it.each([
    ["an empty name", { ...thread, agent: "" }],
    ["a 64-character name", { ...thread, session: "a".repeat(64) }],
    ["a capital letter", { ...thread, agent: "Api" }],
    ["a leading hyphen", { ...thread, session: "-main" }],
    ["a slash", { ...thread, agent: "api/threads" }],
    ["a path's dots", { ...thread, session: ".." }],
    ["a space", { ...thread, agent: "a pi" }],
    ["an encoded character", { ...thread, agent: "a%2Fb" }],
    ["a non-ASCII letter", { ...thread, agent: "café" }],
    // A Cyrillic a in place of the Latin one.
    ["a look-alike letter", { ...thread, session: `m${String.fromCodePoint(0x430)}in` }],
    ["a name that is not a string", { ...thread, agent: 1 }],
    ["thread 0", { ...thread, thread: 0 }],
    ["thread -1", { ...thread, thread: -1 }],
    ["thread 1.5", { ...thread, thread: 1.5 }],
    ["thread 2^53", { ...thread, thread: 2 ** 53 }],
    ["thread 1e21", { ...thread, thread: 1e21 }],
    ["thread NaN", { ...thread, thread: Number.NaN }],
    ["thread Infinity", { ...thread, thread: Number.POSITIVE_INFINITY }],
    ["a thread number as a string", { ...thread, thread: "1" }],
    ["no agent", { session: "main", thread: 1 }],
    ["no session", { agent: "api", thread: 1 }],
    ["no thread", { agent: "api", session: "main" }],
  ])("reads no thread from %s", (_, value) => {
    expect(threadOf(value)).toBeUndefined();
  });

  it.each([null, undefined, "api/main/1", 1, true, [], ["api", "main", 1]])(
    "reads no thread from %j",
    (value) => {
      expect(threadOf(value)).toBeUndefined();
    },
  );
});

describe("isReason", () => {
  it.each(["blocking", "urgent", "open", "message"])("takes %s", (value) => {
    expect(isReason(value)).toBe(true);
  });

  it.each([
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "valueOf",
    "",
    "Blocking",
    "blocking ",
    1,
    null,
    undefined,
    {},
  ])("refuses %j", (value) => {
    expect(isReason(value)).toBe(false);
  });
});

describe("payloadOf", () => {
  const data = (text: string) => ({ text: () => text });
  const json = (value: unknown) => data(JSON.stringify(value));
  const payload = { ...thread, title: "Ship it?", why: "blocking" };

  // Whatever the worker shows, the API's schema of a payload takes too, as
  // the same notification.
  const read = (pushed: { text: () => string }) => {
    const shown = payloadOf(pushed);
    if (shown !== undefined) {
      expect(pushPayload.parse(JSON.parse(pushed.text()))).toEqual(shown);
    }
    return shown;
  };

  it.each(["blocking", "urgent", "open", "message"])("reads a payload of why %s", (why) => {
    expect(read(json({ ...payload, why }))).toEqual({ ...payload, why });
  });

  it("reads an empty title, and keeps only the payload's fields", () => {
    expect(
      read(json({ ...payload, title: "", body: "text", url: "https://x", extra: {} })),
    ).toEqual({ ...payload, title: "" });
  });

  it("reads nothing from a push without data", () => {
    expect(payloadOf(null)).toBeUndefined();
  });

  it.each(["", "{", "not json", '{"agent":"api",}'])("reads nothing from text %j", (text) => {
    expect(read(data(text))).toBeUndefined();
  });

  it.each([null, 1, "text", true, [], [payload]])("reads nothing from JSON %j", (value) => {
    expect(read(json(value))).toBeUndefined();
  });

  it.each([
    ["no title", { ...thread, why: "blocking" }],
    ["a title that is not a string", { ...payload, title: 1 }],
    ["a null title", { ...payload, title: null }],
    ["no why", { ...thread, title: "Ship it?" }],
    ["why toString", { ...payload, why: "toString" }],
    ["why __proto__", { ...payload, why: "__proto__" }],
    ["why constructor", { ...payload, why: "constructor" }],
    ["an unknown why", { ...payload, why: "later" }],
    ["a bad thread", { ...payload, thread: 0 }],
    ["a bad name", { ...payload, agent: "a/b" }],
  ])("reads nothing from a payload with %s", (_, value) => {
    expect(read(json(value))).toBeUndefined();
  });

  it("reads nothing from fields only under __proto__, which JSON makes an own field", () => {
    const text = `{"__proto__":${JSON.stringify(payload)}}`;
    expect(read(data(text))).toBeUndefined();
  });
});
