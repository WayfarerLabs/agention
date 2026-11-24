import { describe, expect, it } from "vitest";
import { sessionSummary } from "../../test-support.tsx";
import {
  arrange,
  regrouped,
  sessionGroupings,
  sessionsQuery,
  sessionsViewOf,
  sortsOf,
} from "./arrangement.ts";

const read = (query: string) => sessionsViewOf(new URLSearchParams(query));

describe("the sessions view's address", () => {
  it("writes every arrangement so that it reads back the same", () => {
    for (const group of sessionGroupings) {
      for (const sort of sortsOf(group)) {
        for (const reverse of sort === "manual" ? [false] : [false, true]) {
          const view = { group, sort, reverse };
          expect(read(sessionsQuery(view))).toEqual(view);
        }
      }
    }
  });

  it("leaves out the parts at their default", () => {
    expect(sessionsQuery({ group: "session_group", sort: "manual", reverse: false })).toBe("");
    expect(sessionsQuery({ group: "agent", sort: "alphabetic", reverse: false })).toBe(
      "?group=agent",
    );
  });

  it("reads a part it cannot take at its default", () => {
    expect(read("group=topic&sort=due")).toEqual({
      group: "session_group",
      sort: "manual",
      reverse: false,
    });
    expect(read("sort=manual&reverse=true")).toEqual({
      group: "session_group",
      sort: "manual",
      reverse: false,
    });
    expect(read("group=agent&group=session").group).toBe("session_group");
  });

  it("keeps the sort through another grouping while that offers it", () => {
    const view = { group: "agent", sort: "registered", reverse: true } as const;
    expect(regrouped(view, "session_group")).toEqual({ ...view, group: "session_group" });
    expect(
      regrouped({ group: "session_group", sort: "manual", reverse: false }, "session"),
    ).toEqual({ group: "session", sort: "alphabetic", reverse: false });
  });
});

describe("the sessions view's arrangement", () => {
  it("sorts sessions alone by their agent, then by their own name", () => {
    const of = (agent: string, ...sessions: string[]) => ({
      agent,
      tags: [],
      sessions: sessions.map((session) => sessionSummary({ session })),
      truncated: false,
    });
    const arranged = arrange(
      { group: "session", sort: "alphabetic", reverse: false },
      [of("builder-x", "a"), of("builder", "main", "b")],
      [],
    );
    expect(
      arranged.kind === "sessions" &&
        arranged.sessions.map(({ agent, session }) => `${agent}/${session.session}`),
    ).toEqual(["builder/b", "builder/main", "builder-x/a"]);
  });
});
