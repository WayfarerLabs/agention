import { describe, expect, it } from "vitest";
import { genericLenient, genericStrict } from "./generic-profiles.ts";
import type { Snapshot } from "./pane.ts";

function snapshot(row: string, x: number, visible = true): Snapshot {
  return {
    lines: ["a harness", row, ""],
    width: 20,
    cursor: { x, y: 1, visible },
    hostHasTerminal: true,
    keysBlocked: false,
    lastTyped: undefined,
    onePane: true,
    at: 0,
  };
}

describe("the generic profiles", () => {
  it("find the input line when the cursor shows with nothing after it", () => {
    const screen = { kind: "input", input: { text: "> draft", cursorAtEnd: true, room: 12 } };
    expect(genericStrict.screen(snapshot("> draft", 8))).toEqual(screen);
    expect(genericLenient.screen(snapshot("> draft", 8))).toEqual(screen);
  });

  it("differ on a cursor showing before the end of its row", () => {
    expect(genericStrict.screen(snapshot("> draft", 4))).toEqual({ kind: "other" });
    expect(genericLenient.screen(snapshot("> draft", 4))).toEqual({
      kind: "input",
      input: { text: "> draft", cursorAtEnd: false, room: 13 },
    });
  });

  it("find no input line where the cursor is hidden, or off the screen", () => {
    for (const profile of [genericStrict, genericLenient]) {
      expect(profile.screen(snapshot("> 1. Yes", 8, false))).toEqual({ kind: "other" });
      expect(profile.screen({ ...snapshot("", 0), cursor: { x: 0, y: 3, visible: true } })).toEqual(
        { kind: "other" },
      );
    }
  });

  it("count a character outside the Basic Multilingual Plane as one column", () => {
    expect(genericStrict.screen(snapshot("> \u{1f600}", 3))).toEqual({
      kind: "input",
      input: { text: "> \u{1f600}", cursorAtEnd: true, room: 17 },
    });
  });
});
