import type { MonitorCondition, SessionSummary } from "@wayfarerlabs/agention-api";
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

  it("shows the sessions at a prompt or stopped by something, and the agents holding any", () => {
    const kept = (filtered: boolean) => {
      const arranged = arrange({ ...view, needsYou: filtered }, [builder, reviewer], []);
      return arranged.kind === "agents"
        ? arranged.agents.map((entry) => [entry.agent, entry.shown.length])
        : undefined;
    };
    expect(kept(true)).toEqual([["builder", 4]]);
    expect(kept(false)).toEqual([
      ["builder", 10],
      ["reviewer", 1],
    ]);
    const arranged = arrange(view, [builder, reviewer], []);
    expect(
      arranged.kind === "agents" && arranged.agents[0]?.shown.map((each) => each.session),
    ).toEqual(["at_prompt-usage_limit", "other_prompt", "permission_prompt", "waiting-error"]);
    // An agent's sessions are still all of them, which its header counts.
    expect(arranged.kind === "agents" && arranged.agents[0]?.sessions).toHaveLength(10);
  });

  it("hides rows alone, a group keeping every agent and session in it for its head", () => {
    const work = { id: 1, name: "Work" };
    const inWork = (session: SessionSummary) => ({ ...session, group: work });
    const agents = [
      { ...builder, sessions: [inWork(watched("permission_prompt")), watched("running")] },
      { ...reviewer, sessions: [inWork(watched("running"))] },
    ];
    const arranged = arrange({ ...view, group: "session_group", sort: "manual" }, agents, []);
    // No group holds nothing that needs the operator, so it shows no head;
    // Work keeps reviewer for its head's facts, though reviewer shows no row.
    expect(
      arranged.kind === "groups" &&
        arranged.groups.map((fold) => [
          fold.group?.name,
          fold.agents.map((entry) => [entry.agent, entry.sessions.length, entry.shown.length]),
        ]),
    ).toEqual([
      [
        "Work",
        [
          ["builder", 1, 1],
          ["reviewer", 1, 0],
        ],
      ],
    ]);
  });

  it("orders as it would without it, by every session", () => {
    const at = (created_at: string, monitor: MonitorCondition) => ({
      ...watched(monitor),
      created_at,
    });
    // builder's earliest session needs nothing, and its other is newer than
    // reviewer's one, so builder would come first by its sessions shown.
    const agents = [
      {
        ...builder,
        sessions: [
          at("2026-10-01T00:00:00.000Z", "running"),
          { ...at("2026-10-05T00:00:00.000Z", "permission_prompt"), session: "asking" },
        ],
      },
      { ...reviewer, sessions: [at("2026-10-03T00:00:00.000Z", "other_prompt")] },
    ];
    const order = (needsYou: boolean) => {
      const arranged = arrange({ ...view, sort: "registered", needsYou }, agents, []);
      return arranged.kind === "agents" && arranged.agents.map((entry) => entry.agent);
    };
    expect(order(true)).toEqual(["reviewer", "builder"]);
    expect(order(false)).toEqual(["reviewer", "builder"]);
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
