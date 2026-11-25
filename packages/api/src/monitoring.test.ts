import { describe, expect, it } from "vitest";
import { invalidInputBody } from "./errors.ts";
import { monitorPollQuery, monitorReport } from "./monitoring.ts";

function fieldOf(result: { error?: Parameters<typeof invalidInputBody>[0] | undefined }) {
  return result.error === undefined ? undefined : invalidInputBody(result.error).error.field;
}

const since = "2026-11-24T10:00:00.000Z";

describe("monitorReport", () => {
  it.each([
    ["no pane", { monitored: false }],
    ["a condition", { monitored: true, profile: "codex", condition: "running", since }],
    [
      "a usage limit with its reset",
      {
        monitored: true,
        profile: "claude-code",
        condition: "at_prompt",
        since,
        stopped_by: { reason: "usage_limit", resets_at: "2026-11-24T15:00:00.000Z" },
      },
    ],
    [
      "a block at a permission prompt",
      {
        monitored: true,
        profile: "generic-strict",
        condition: "permission_prompt",
        since,
        stopped_by: { reason: "block" },
      },
    ],
  ])("takes %s", (_, report) => {
    expect(monitorReport.parse(report)).toEqual(report);
  });

  it.each(["codex", "my-harness", "generic-strict", "v2-profile-3", "c".repeat(40)])(
    "takes the profile %j, any name of its shape",
    (profile) => {
      const report = { monitored: true, profile, condition: "waiting", since };
      expect(monitorReport.parse(report)).toEqual(report);
    },
  );

  it.each([
    "",
    "Codex",
    "1codex",
    "-codex",
    "codex-",
    "code--x",
    "code x",
    "codex_2",
    "c".repeat(41),
  ])("refuses the profile %j, no name of its shape", (profile) => {
    const report = { monitored: true, profile, condition: "waiting", since };
    expect(fieldOf(monitorReport.safeParse(report))).toBe("profile");
  });

  it("keeps no field it does not know, so no text rides along", () => {
    expect(monitorReport.parse({ monitored: false, screen: "$ rm -rf", profile: "codex" })).toEqual(
      { monitored: false },
    );
    expect(
      monitorReport.parse({
        monitored: true,
        profile: "codex",
        condition: "waiting",
        since,
        stopped_by: { reason: "error", resets_at: since, message: "Overloaded" },
      }),
    ).toEqual({
      monitored: true,
      profile: "codex",
      condition: "waiting",
      since,
      stopped_by: { reason: "error" },
    });
  });

  it.each([
    ["no monitored", { profile: "codex" }, "monitored"],
    ["a condition without a profile", { monitored: true, condition: "running", since }, "profile"],
    [
      "a condition it does not know",
      { monitored: true, profile: "codex", condition: "thinking", since },
      "condition",
    ],
    ["no since", { monitored: true, profile: "codex", condition: "running" }, "since"],
    [
      "a since that is no time",
      { monitored: true, profile: "codex", condition: "running", since: "soon" },
      "since",
    ],
    [
      "a reason it does not know",
      {
        monitored: true,
        profile: "codex",
        condition: "waiting",
        since,
        stopped_by: { reason: "tired" },
      },
      "stopped_by.reason",
    ],
    [
      "a reset that is no time",
      {
        monitored: true,
        profile: "codex",
        condition: "waiting",
        since,
        stopped_by: { reason: "usage_limit", resets_at: "at 3pm" },
      },
      "stopped_by.resets_at",
    ],
    [
      "a stop beside running",
      {
        monitored: true,
        profile: "codex",
        condition: "running",
        since,
        stopped_by: { reason: "error" },
      },
      "stopped_by",
    ],
    [
      "a stop beside unknown",
      {
        monitored: true,
        profile: "codex",
        condition: "unknown",
        since,
        stopped_by: { reason: "block" },
      },
      "stopped_by",
    ],
  ])("refuses %s", (_, report, field) => {
    expect(fieldOf(monitorReport.safeParse(report))).toBe(field);
  });
});

describe("monitorPollQuery", () => {
  it("reads the claim and the wait from query text, waiting 25 seconds unclaimed by default", () => {
    expect(monitorPollQuery.parse({ bridge: "b".repeat(16) })).toEqual({
      bridge: "b".repeat(16),
      claim: false,
      wait: 25,
    });
    expect(monitorPollQuery.parse({ bridge: "b".repeat(64), claim: "true", wait: "0" })).toEqual({
      bridge: "b".repeat(64),
      claim: true,
      wait: 0,
    });
  });

  it.each([
    [{ bridge: "b".repeat(15) }, "bridge"],
    [{ bridge: "b".repeat(65) }, "bridge"],
    [{ bridge: "bridge id with spaces" }, "bridge"],
    [{ bridge: "b".repeat(16), claim: "yes" }, "claim"],
    [{ bridge: "b".repeat(16), wait: "26" }, "wait"],
  ])("refuses %j", (query, field) => {
    expect(fieldOf(monitorPollQuery.safeParse(query))).toBe(field);
  });
});
