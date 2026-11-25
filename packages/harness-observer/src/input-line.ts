import type { Snapshot } from "./pane.ts";
import type { InputLine } from "./profile.ts";

// inputLine reads the input line on the cursor's row, its text starting at a
// column: 0 for a profile that knows no prompt marker, or the marker's width.
// It returns undefined where the cursor is hidden, off the screen, or before
// that column.
export function inputLine(snapshot: Snapshot, start: number): InputLine | undefined {
  const { cursor, lines, width } = snapshot;
  const row = lines[cursor.y];
  if (!cursor.visible || row === undefined || cursor.x < start) {
    return undefined;
  }
  const length = columns(row);
  return {
    text: [...row].slice(start).join(""),
    cursorAtEnd: cursor.x >= length,
    room: Math.max(0, width - Math.max(cursor.x, length)),
  };
}

// markedInput reads the input line of a harness whose input row starts with
// a prompt marker, or returns undefined where the cursor's row does not. A
// harness that draws a hint in its empty input, dimmed, with the cursor right
// after the marker, gives a test for its hints; a screen holds no colors, so
// a hint reads as an empty input only where the test knows it.
export function markedInput(
  snapshot: Snapshot,
  marker: string,
  isHint: (text: string) => boolean,
): InputLine | undefined {
  if (!snapshot.lines[snapshot.cursor.y]?.startsWith(marker)) {
    return undefined;
  }
  const start = columns(marker);
  const input = inputLine(snapshot, start);
  if (input !== undefined && snapshot.cursor.x === start && isHint(input.text)) {
    return { text: "", cursorAtEnd: true, room: Math.max(0, snapshot.width - start) };
  }
  return input;
}

// columns counts a text's code points, which is its width in columns for
// every narrow character; a wide character, such as a CJK ideograph, takes
// two columns on screen but counts as one here.
export function columns(text: string): number {
  return [...text].length;
}
