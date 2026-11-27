import type { MonitorCondition, NudgeState } from "@wayfarerlabs/agention-api";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  absenceOf,
  absenceWords,
  ConditionClause,
  conditionWords,
  dueTime,
  nudgeWords,
  type Observed,
  observedOf,
  sinceTime,
  terminalNeedsYou,
  type Whereabouts,
} from "./format.tsx";
import { observed } from "./test-support.tsx";

const conditions: MonitorCondition[] = [
  "unknown",
  "permission_prompt",
  "other_prompt",
  "running",
  "at_prompt",
  "waiting",
];
const atRest: MonitorCondition[] = ["permission_prompt", "other_prompt", "at_prompt", "waiting"];
const resets = "2026-10-27T15:00:00.000Z";

describe("a session's condition", () => {
  it("needs the operator at a permission prompt or another prompt, or stopped by something", () => {
    for (const condition of conditions) {
      expect([condition, terminalNeedsYou(observed(condition))]).toEqual([
        condition,
        condition === "permission_prompt" || condition === "other_prompt",
      ]);
    }
    for (const condition of atRest) {
      for (const reason of ["usage_limit", "block", "error"] as const) {
        expect(terminalNeedsYou(observed(condition, { reason }))).toBe(true);
      }
    }
    expect(terminalNeedsYou(undefined)).toBe(false);
  });

  it("reads differently for each condition and each reason, a reason leading any prompt beside it", () => {
    const plain = conditions.map((condition) => conditionWords(observed(condition)));
    expect(new Set(plain).size).toBe(conditions.length);
    for (const reason of ["usage_limit", "block", "error"] as const) {
      // At rest in nothing it recognizes, the reason stands alone; beside a
      // prompt, it leads, so each prompt reads apart.
      const alone = conditionWords(observed("waiting", { reason }));
      const beside = atRest.map((condition) => conditionWords(observed(condition, { reason })));
      expect(new Set(beside).size).toBe(atRest.length);
      for (const words of beside) {
        expect(words.startsWith(alone)).toBe(true);
      }
      expect(plain).not.toContain(alone);
    }
    // A usage limit says when it resets, where the host showed it.
    const limit = conditionWords(
      observed("at_prompt", { reason: "usage_limit", resets_at: resets }),
    );
    expect(limit).toContain(dueTime(resets));
    expect(conditionWords(observed("at_prompt", { reason: "usage_limit" }))).not.toContain(
      dueTime(resets),
    );
  });

  it("says a usage limit's reset is due once its time has passed", () => {
    const limit = observed("at_prompt", { reason: "usage_limit", resets_at: resets });
    const hour = 3600 * 1000;
    const before = conditionWords(limit, Date.parse(resets) - hour);
    const after = conditionWords(limit, Date.parse(resets) + hour);
    expect(before).toContain(dueTime(resets, Date.parse(resets) - hour));
    expect(after).toContain(dueTime(resets, Date.parse(resets) + hour));
    expect(after).not.toBe(before);
  });

  it("reads a newer server's condition as unknown, needing nothing, and its reason as something that stopped it", () => {
    // What a newer server may send that this page's types do not know.
    const novel = { ...observed("running"), condition: "thinking" } as unknown as Observed;
    expect(conditionWords(novel)).toBe(conditionWords(observed("unknown")));
    expect(terminalNeedsYou(novel)).toBe(false);
    const stopped = observed("waiting", { reason: "quota" } as unknown as Observed["stopped_by"]);
    const known = (["usage_limit", "block", "error"] as const).map((reason) =>
      conditionWords(observed("waiting", { reason })),
    );
    expect(known).not.toContain(conditionWords(stopped));
    expect(conditionWords(stopped)).not.toContain("undefined");
    expect(conditionWords(stopped)).not.toBe(conditionWords(observed("waiting")));
    expect(terminalNeedsYou(stopped)).toBe(true);
  });

  it("is observed only while the bridge monitors a terminal", () => {
    expect(observedOf({ quiet: false, connected: true })).toBeUndefined();
    expect(
      observedOf({ quiet: false, connected: true, monitor: { monitored: false } }),
    ).toBeUndefined();
    expect(observedOf({ quiet: false, connected: true, monitor: observed("running") })).toEqual(
      observed("running"),
    );
  });
});

describe("a session's condition as a clause", () => {
  afterEach(cleanup);
  const clause = (state: Observed) =>
    render(<ConditionClause observed={state} />).container.textContent;

  it("says the condition is unknown, as for one this page does not know, but names what stopped it", () => {
    const unknown = clause(observed("unknown"));
    const novel = { ...observed("running"), condition: "thinking" } as unknown as Observed;
    expect(clause(novel)).toBe(unknown);
    expect(unknown).not.toContain(conditionWords(observed("unknown")));
    // A condition this page does not know, at rest beside what stopped it.
    const stopped: Observed = { ...novel, stopped_by: { reason: "error" } };
    for (const known of [observed("running"), stopped]) {
      expect(clause(known)).toContain(conditionWords(known));
    }
  });
});

describe("why a session is away", () => {
  const away = (presence: Whereabouts["presence"], state?: "stopped") =>
    absenceOf({
      ...(state === undefined ? {} : { state, outcome: "stalled" as const }),
      presence,
      credential_active: true,
    });
  const asking = observed("permission_prompt");

  it("carries what its terminal shows beside why, where its bridge observes one", () => {
    const quiet = away({ quiet: true, connected: true, monitor: asking });
    expect(quiet).toMatchObject({ kind: "quiet", observed: asking });
    const stopped = away({ quiet: false, connected: true, monitor: asking }, "stopped");
    expect(stopped).toMatchObject({ kind: "stopped", observed: asking });
    expect(
      away({ quiet: true, connected: true, monitor: { monitored: false } }),
    ).not.toHaveProperty("observed");
    expect(away({ quiet: false, connected: false })).toEqual({ kind: "disconnected" });
    expect(away({ quiet: false, connected: true, monitor: asking })).toBeUndefined();
  });

  it("names what its terminal shows after why, as a tag says it", () => {
    const quiet = away({ quiet: true, connected: true, monitor: asking });
    const unwatched = away({ quiet: true, connected: true });
    if (quiet === undefined || unwatched === undefined) {
      throw new Error("not away");
    }
    const words = absenceWords(quiet);
    expect(words.startsWith(absenceWords(unwatched))).toBe(true);
    expect(words.endsWith(conditionWords(asking))).toBe(true);
  });
});

describe("why a session that can be nudged is away", () => {
  const canBeNudged = { ...observed("at_prompt"), nudge: true };
  const at = "2026-10-27T11:59:00.000Z";
  const id = "3f9a0c1d2e4b";
  const away = (overrides: Partial<Whereabouts> = {}, last_nudge?: NudgeState) =>
    absenceOf({
      presence: {
        quiet: true,
        connected: true,
        monitor: canBeNudged,
        ...(last_nudge === undefined ? {} : { last_nudge }),
      },
      credential_active: true,
      ...overrides,
    });

  it("is not for waiting at its prompt, quiet or stopped, while a nudge will bring it", () => {
    expect(away()).toBeUndefined();
    expect(away({ state: "stopped", outcome: "completed" })).toBeUndefined();
    expect(away({}, { at, id, outcome: "sent", answered: true })).toBeUndefined();
  });

  it("is for a latest nudge with no check-in since, whatever its outcome", () => {
    for (const outcome of ["sent", "stopped", "failed"] as const) {
      const nudge = { at, id, outcome, answered: false };
      expect(away({}, nudge)).toEqual({ kind: "nudge", nudge, observed: canBeNudged });
    }
  });

  it("says, of a stranded thread, that its latest nudge failed or was stopped, though answered since", () => {
    const since = { stranded: true, nudged_since_unread: true };
    for (const outcome of ["stopped", "failed"] as const) {
      const nudge = { at, id, outcome, answered: true };
      expect(away(since, nudge)).toEqual({ kind: "nudge", nudge, observed: canBeNudged });
    }
    expect(away(since, { at, id, outcome: "sent", answered: true })).toMatchObject({
      kind: "no_nudge",
    });
  });

  it("never names, of a stranded thread, a nudge from before the earliest message it has not read", () => {
    for (const outcome of ["stopped", "failed"] as const) {
      const nudge = { at, id, outcome, answered: true };
      expect(away({ stranded: true, nudged_since_unread: false }, nudge)).toMatchObject({
        kind: "no_nudge",
      });
    }
  });

  it("says why no nudge came to a stranded thread where nudge text left at the prompt held it off", () => {
    const held = absenceOf({
      presence: {
        quiet: true,
        connected: true,
        monitor: { ...canBeNudged, unable: { reason: "nudge_text_left", since: at } },
      },
      credential_active: true,
      stranded: true,
    });
    expect(held).toMatchObject({ kind: "no_nudge", unable: "nudge_text_left" });
    const none = away({ stranded: true });
    if (held === undefined || none === undefined) {
      throw new Error("not away");
    }
    expect(absenceWords(held)).not.toBe(absenceWords(none));
  });

  it("says none came for a stranded thread, and puts a missing credential first", () => {
    expect(away({ stranded: true })).toMatchObject({ kind: "no_nudge" });
    expect(
      away({ credential_active: false }, { at, id, outcome: "sent", answered: false }),
    ).toMatchObject({
      kind: "credential",
    });
  });

  // ignored is an ignored thread's session, whose agent checked in at seen.
  const seen = "2026-10-27T12:00:00.000Z";
  const ignored = (last_nudge?: NudgeState) =>
    absenceOf({
      presence: {
        last_seen_at: seen,
        quiet: false,
        connected: true,
        monitor: canBeNudged,
        ...(last_nudge === undefined ? {} : { last_nudge }),
      },
      credential_active: true,
      ignored: true,
    });

  it("says when the agent of an ignored thread checked in, whatever its latest nudge", () => {
    const shown = { kind: "ignored", last_seen_at: seen, observed: canBeNudged };
    expect(ignored()).toEqual(shown);
    expect(ignored({ at, id, outcome: "sent", answered: true })).toEqual(shown);
  });

  it("reads an ignored thread apart from every other outcome, with the check-in's time", () => {
    const answered: NudgeState = { at, id, outcome: "sent", answered: true };
    const passed = ignored(answered);
    const none = away({ stranded: true });
    if (passed === undefined || none === undefined) {
      throw new Error("not away");
    }
    const words = absenceWords({ ...passed, observed: undefined });
    expect(words).toContain(sinceTime(seen));
    const others = [
      absenceWords({ ...none, observed: undefined }),
      ...[
        answered,
        { ...answered, answered: false },
        { ...answered, outcome: "failed" as const },
        { ...answered, outcome: "stopped" as const },
      ].map(nudgeWords),
    ];
    expect(others).not.toContain(words);
  });

  it("reads each outcome its own way, with its time", () => {
    const outcomes: NudgeState[] = [
      { at, id, outcome: "sent", answered: false },
      { at, id, outcome: "sent", answered: true },
      { at, id, outcome: "failed", answered: false },
      { at, id, outcome: "stopped", answered: false },
    ];
    const words = outcomes.map(nudgeWords);
    expect(new Set(words).size).toBe(4);
    for (const each of words) {
      expect(each).toContain(sinceTime(at));
    }
    const unresponsive = away({}, outcomes[0]);
    const unsent = away({}, outcomes[2]);
    if (unresponsive === undefined || unsent === undefined) {
      throw new Error("not away");
    }
    expect(absenceWords(unresponsive).startsWith(words[0] ?? "")).toBe(true);
    expect(absenceWords(unsent).startsWith(words[2] ?? "")).toBe(true);
  });
});
