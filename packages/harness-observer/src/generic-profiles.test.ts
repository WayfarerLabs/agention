import { describe, expect, it } from "vitest";
import { genericLenient, genericStrict } from "./generic-profiles.ts";
import type { Snapshot } from "./pane.ts";

function snapshot(row: string, x: number, visible = true): Snapshot {
  return {
    lines: ["a harness", row, ""],
    width: 20,
    cursor: { x, y: 1, visible },
    hostHasTerminal: true,
    onePane: true,
    keysBlocked: false,
    lastTyped: undefined,
    at: 0,
  };
}

const other = { kind: "other" };

describe("the generic profiles", () => {
  it("find the input line, the whole row, when the cursor shows with nothing after it", () => {
    // The spaces a capture trims count up to the cursor; the cursor takes
    // the column after the text, so 20 columns leave 12 after "> draft".
    const atEnd = { kind: "input", input: { text: "> draft", cursorAtEnd: true, room: 12 } };
    expect(genericStrict.screen(snapshot("> draft", 7))).toEqual(atEnd);
    expect(genericStrict.screen(snapshot("> draft", 8))).toEqual({
      kind: "input",
      input: { text: "> draft ", cursorAtEnd: true, room: 11 },
    });
    expect(genericLenient.screen(snapshot("> draft", 7))).toEqual(atEnd);
  });

  it("differ on a cursor showing before the end of its row", () => {
    expect(genericStrict.screen(snapshot("> draft", 4))).toEqual(other);
    expect(genericLenient.screen(snapshot("> draft", 4))).toEqual({
      kind: "input",
      input: { text: "> draft", cursorAtEnd: false, room: 12 },
    });
  });

  it("leave no room on a full row", () => {
    const full = "x".repeat(19);
    expect(genericStrict.screen(snapshot(full, 19))).toMatchObject({ input: { room: 0 } });
  });

  it("find no input line where the cursor is hidden, or off the screen", () => {
    for (const profile of [genericStrict, genericLenient]) {
      expect(profile.screen(snapshot("> 1. Yes", 8, false))).toEqual(other);
      expect(profile.screen({ ...snapshot("", 0), cursor: { x: 0, y: 3, visible: true } })).toEqual(
        other,
      );
    }
  });

  // Each row's cursor is where a terminal puts it after the row's last
  // character, counting a wide character as two columns and a combining mark
  // as none; a count of code points would put it elsewhere.
  it.each([
    ["CJK ideographs", "> 日本語", 8],
    ["an emoji", "> ok \u{1f600}", 7],
    ["a combining mark", "> cafe\u0301", 6],
    ["a no-break space", "> a\u00a0b", 5],
  ])("never find the input line on a row holding %s with the strict profile", (_, row, x) => {
    expect(genericStrict.screen(snapshot(row, x))).toEqual(other);
    expect(genericStrict.screen(snapshot(row, 19))).toEqual(other);
    expect(genericLenient.screen(snapshot(row, x))).toMatchObject({
      kind: "input",
      input: { cursorAtEnd: false, room: 0 },
    });
  });
});
