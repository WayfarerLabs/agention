import type { MonitorCondition } from "@wayfarerlabs/agention-api";
import { describe, expect, it } from "vitest";
import {
  absenceOf,
  absenceWords,
  conditionWords,
  dueTime,
  needsYou,
  observedOf,
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
      expect([condition, needsYou(observed(condition))]).toEqual([
        condition,
        condition === "permission_prompt" || condition === "other_prompt",
      ]);
    }
    for (const condition of atRest) {
      for (const reason of ["usage_limit", "block", "error"] as const) {
        expect(needsYou(observed(condition, { reason }))).toBe(true);
      }
    }
    expect(needsYou(undefined)).toBe(false);
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
