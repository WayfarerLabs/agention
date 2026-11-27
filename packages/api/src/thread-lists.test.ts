import { describe, expect, it } from "vitest";
import { invalidInputBody } from "./errors.ts";
import { sessionThreadsQuery, waitQuery } from "./thread-lists.ts";

function fieldOf(result: { error?: Parameters<typeof invalidInputBody>[0] | undefined }) {
  return result.error === undefined ? undefined : invalidInputBody(result.error).error.field;
}

describe("list queries", () => {
  it("read numbers and booleans from query text, every filter off by default", () => {
    expect(sessionThreadsQuery.parse({ limit: "100" })).toEqual({
      include_archived: false,
      unread: false,
      limit: 100,
    });
    expect(sessionThreadsQuery.parse({ status: "withdrawn" }).status).toBe("withdrawn");
    expect(waitQuery.parse({})).toEqual({ wait: 0, limit: 50 });
  });

  it.each([
    [sessionThreadsQuery, { limit: "101" }, "limit"],
    [sessionThreadsQuery, { cursor: "c".repeat(1_025) }, "cursor"],
    [waitQuery, { since: "s".repeat(1_025) }, "since"],
    [waitQuery, { wait: "26" }, "wait"],
    [sessionThreadsQuery, { status: "Open" }, "status"],
    [sessionThreadsQuery, { search: "release\nnotes" }, "search"],
    [sessionThreadsQuery, { search: " " }, "search"],
  ] as const)("refuses %j", (schema, query, field) => {
    expect(fieldOf(schema.safeParse(query))).toBe(field);
  });

  it("take a cursor of up to 1,024 characters", () => {
    expect(waitQuery.safeParse({ since: "s".repeat(1_024) }).success).toBe(true);
  });
});
