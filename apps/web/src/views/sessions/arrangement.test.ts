import type { MonitorCondition } from "@wayfarerlabs/agention-api";
import { describe, expect, it } from "vitest";
import { observed, sessionSummary } from "../../test-support.tsx";
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
          for (const needsYou of [false, true]) {
            const view = { group, sort, reverse, needsYou };
            expect(read(sessionsQuery(view))).toEqual(view);
          }
        }
      }
    }
  });

  it("leaves out the parts at their default", () => {
    const plain = { reverse: false, needsYou: false };
    expect(sessionsQuery({ group: "session_group", sort: "manual", ...plain })).toBe("");
    expect(sessionsQuery({ group: "agent", sort: "alphabetic", ...plain })).toBe("?group=agent");
    expect(
      sessionsQuery({ group: "session_group", sort: "manual", ...plain, needsYou: true }),
    ).toBe("?needs_you=true");
  });

  it("reads a part it cannot take at its default", () => {
    const defaults = { group: "session_group", sort: "manual", reverse: false, needsYou: false };
    expect(read("group=topic&sort=due")).toEqual(defaults);
    expect(read("sort=manual&reverse=true")).toEqual(defaults);
    expect(read("needs_you=yes")).toEqual(defaults);
    expect(read("group=agent&group=session").group).toBe("session_group");
  });

  it("keeps the sort through another grouping while that offers it, and the filter always", () => {
    const view = { group: "agent", sort: "registered", reverse: true, needsYou: true } as const;
    expect(regrouped(view, "session_group")).toEqual({ ...view, group: "session_group" });
    expect(
      regrouped(
        { group: "session_group", sort: "manual", reverse: false, needsYou: true },
        "session",
      ),
    ).toEqual({ group: "session", sort: "alphabetic", reverse: false, needsYou: true });
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
      { group: "session", sort: "alphabetic", reverse: false, needsYou: false },
      [of("builder-x", "a"), of("builder", "main", "b")],
      [],
    );
    expect(
      arranged.kind === "sessions" &&
        arranged.sessions.map(({ agent, session }) => `${agent}/${session.session}`),
    ).toEqual(["builder/b", "builder/main", "builder-x/a"]);
  });
});

describe("the Needs you filter", () => {
  const watched = (condition: MonitorCondition, stopped?: Parameters<typeof observed>[1]) =>
    sessionSummary({
      session: stopped === undefined ? condition : `${condition}-${stopped.reason}`,
      presence: { quiet: false, connected: true, monitor: observed(condition, stopped) },
    });
  const builder = {
    agent: "builder",
    tags: [],
    sessions: [
      watched("permission_prompt"),
      watched("other_prompt"),
      watched("at_prompt", { reason: "usage_limit" }),
      watched("waiting", { reason: "error" }),
      watched("at_prompt"),
      watched("running"),
      watched("waiting"),
      watched("unknown"),
      sessionSummary({ session: "old" }),
      sessionSummary({
        session: "off",
        presence: { quiet: false, connected: true, monitor: { monitored: false } },
      }),
    ],
    truncated: false,
  };
  const reviewer = {
    agent: "reviewer",
    tags: [],
    sessions: [watched("running")],
    truncated: false,
  };
  const view = { group: "agent", sort: "alphabetic", reverse: false, needsYou: true } as const;

  it("keeps the sessions at a prompt or stopped by something, and the agents holding any", () => {
    const kept = (filtered: boolean) => {
      const arranged = arrange({ ...view, needsYou: filtered }, [builder, reviewer], []);
      return arranged.kind === "agents"
        ? arranged.agents.map((entry) => [entry.agent, entry.sessions.length])
        : undefined;
    };
    expect(kept(true)).toEqual([["builder", 4]]);
    expect(kept(false)).toEqual([
      ["builder", 10],
      ["reviewer", 1],
    ]);
    const arranged = arrange(view, [builder, reviewer], []);
    expect(
      arranged.kind === "agents" && arranged.agents[0]?.sessions.map((each) => each.session),
    ).toEqual(["at_prompt-usage_limit", "other_prompt", "permission_prompt", "waiting-error"]);
  });

  it("folds by group as it would without it, though it keeps no session in a group", () => {
    const grouped = { ...reviewer, sessions: [sessionSummary({ group: { id: 1, name: "Work" } })] };
    const arranged = arrange(
      { ...view, group: "session_group", sort: "manual" },
      [builder, grouped],
      [],
    );
    expect(arranged.kind === "groups" && arranged.groups.map((fold) => fold.group)).toEqual([
      undefined,
    ]);
  });
});
