import { describe, expect, it } from "vitest";
import { refusedFiltersOn } from "./notifications.ts";
import { threadFilters } from "./thread-lists.ts";

describe("the filters a notifying view refuses", () => {
  it("names each when it is on and none at its default", () => {
    expect(refusedFiltersOn(threadFilters.parse({}))).toEqual([]);
    expect(refusedFiltersOn(threadFilters.parse({ search: "deploy" }))).toEqual(["search"]);
    expect(refusedFiltersOn(threadFilters.parse({ overdue: true }))).toEqual(["overdue"]);
    expect(refusedFiltersOn(threadFilters.parse({ overdue: false }))).toEqual([]);
    expect(refusedFiltersOn(threadFilters.parse({ agent_read: "stranded" }))).toEqual([
      "agent_read",
    ]);
    expect(
      refusedFiltersOn(
        threadFilters.parse({ search: "deploy", overdue: true, agent_read: "unread" }),
      ),
    ).toEqual(["search", "overdue", "agent_read"]);
  });

  it("names neither unread nor including archived threads", () => {
    expect(
      refusedFiltersOn(
        threadFilters.parse({ unread: true, include_archived: true, impact: "blocking" }),
      ),
    ).toEqual([]);
  });
});
