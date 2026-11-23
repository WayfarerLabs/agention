import { describe, expect, it } from "vitest";
import { invalidInputBody } from "./errors.ts";
import { sessionUpdateInput } from "./sessions.ts";

function fieldOf(result: { error?: Parameters<typeof invalidInputBody>[0] | undefined }) {
  return result.error === undefined ? undefined : invalidInputBody(result.error).error.field;
}

describe("sessionUpdateInput", () => {
  it.each([
    ["a state", { state: "working" }],
    ["stopped with its outcome", { state: "stopped", outcome: "stalled" }],
    ["a title alone", { title: "Retire the invoices table" }],
    ["a goal alone", { goal: "Move billing to the ledger" }],
    ["a percent alone", { percent: 0 }],
    ["a note alone", { note: "Backfill started." }],
    [
      "every field",
      { state: "stopped", outcome: "completed", title: "t", goal: "g", percent: 100, note: "n" },
    ],
  ])("takes %s", (_, input) => {
    expect(sessionUpdateInput.parse(input)).toEqual(input);
  });

  it("ignores fields it does not know", () => {
    expect(sessionUpdateInput.parse({ state: "idle", later: true })).toEqual({
      state: "idle",
    });
  });

  it.each([
    ["nothing", {}, undefined],
    ["only an outcome", { outcome: "completed" }, "outcome"],
    ["stopped without an outcome", { state: "stopped" }, "outcome"],
    ["an outcome beside working", { state: "working", outcome: "completed" }, "outcome"],
    ["an outcome beside idle", { state: "idle", outcome: "withdrawn" }, "outcome"],
    ["an outcome without a state", { outcome: "stalled", note: "Stuck." }, "outcome"],
    ["a state it does not know", { state: "paused" }, "state"],
    ["an outcome it does not know", { state: "stopped", outcome: "failed" }, "outcome"],
    ["a title on two lines", { title: "a\nb" }, "title"],
    ["a title too long", { title: "t".repeat(201) }, "title"],
    ["an empty goal", { goal: "" }, "goal"],
    ["a goal too long", { goal: "g".repeat(301) }, "goal"],
    ["a note too long", { note: "n".repeat(301) }, "note"],
    ["a percent below 0", { percent: -1 }, "percent"],
    ["a percent above 100", { percent: 101 }, "percent"],
    ["a fractional percent", { percent: 12.5 }, "percent"],
  ])("refuses %s", (_, input, field) => {
    const result = sessionUpdateInput.safeParse(input);
    expect(result.success).toBe(false);
    expect(fieldOf(result)).toBe(field);
  });

  it("takes text at its bounds", () => {
    const input = {
      title: "\u{1F600}".repeat(200),
      goal: "\u{1F600}".repeat(300),
      note: "\u{1F600}".repeat(300),
      percent: 100,
    };
    expect(sessionUpdateInput.parse(input)).toEqual(input);
  });
});
