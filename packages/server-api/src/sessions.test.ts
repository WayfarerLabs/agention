import { invalidInputBody } from "@wayfarerlabs/agention-api";
import { describe, expect, it } from "vitest";
import { sessionLogQuery, threadStartInput } from "./sessions.ts";

function fieldOf(result: { error?: Parameters<typeof invalidInputBody>[0] | undefined }) {
  return result.error === undefined ? undefined : invalidInputBody(result.error).error.field;
}

describe("sessionLogQuery", () => {
  it("reads its numbers from query text, starting from the latest by default", () => {
    expect(sessionLogQuery.parse({})).toEqual({ limit: 50 });
    expect(sessionLogQuery.parse({ before: "7", limit: "2" })).toEqual({ before: 7, limit: 2 });
    expect(fieldOf(sessionLogQuery.safeParse({ before: "0" }))).toBe("before");
  });
});

describe("threadStartInput", () => {
  const start = { request_id: "o-1", title: "Rebase onto main", text: "Main moved; rebase." };

  it("needs a title and text, and takes detail", () => {
    expect(threadStartInput.parse(start)).toEqual(start);
    const full = { ...start, detail: "At length." };
    expect(threadStartInput.parse(full)).toEqual(full);
    expect(fieldOf(threadStartInput.safeParse({ ...start, text: undefined }))).toBe("text");
  });

  it("carries no asks and no topic, which are the requester's, and no references", () => {
    const parsed = threadStartInput.parse({
      ...start,
      asks: [{ question: "Which?" }],
      topic: "release",
      references: [{ label: "PR", url: "https://example.com/pr/1" }],
    });
    expect(parsed).toEqual(start);
  });

  it("carries no attachments", () => {
    const attachments = [{ upload: "AbCdEfGhIjKlMnOpQr_-09" }];
    expect(threadStartInput.parse({ ...start, attachments })).toEqual(start);
  });
});
