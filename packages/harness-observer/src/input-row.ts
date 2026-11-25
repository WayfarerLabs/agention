import type { Snapshot } from "./pane.ts";
import type { InputLine } from "./profile.ts";

// markedInput reads the harness's input line where the cursor shows on a row
// that starts with its prompt marker, at or after the marker's end, and is
// undefined anywhere else. Its text is what follows the marker, or empty
// where that is one of the harness's hints with the cursor right after the
// marker. Each character of the markers the profiles know is one column
// wide, as their captures show, so a marker's width is its count of code
// points.
export function markedInput(
  snapshot: Snapshot,
  marker: string,
  hints: readonly RegExp[] = [],
): InputLine | undefined {
  const row = cursorRow(snapshot);
  const start = [...marker].length;
  if (row === undefined || !row.startsWith(marker) || snapshot.cursor.x < start) {
    return undefined;
  }
  const typed = row.slice(marker.length);
  const hint = snapshot.cursor.x === start && hints.some((pattern) => pattern.test(typed));
  return inputLine(snapshot, start, hint ? "" : typed);
}

// rowInput reads the cursor's whole row as the input line, for a profile that
// does not know its harness's prompt marker, or is undefined where the cursor
// is hidden or off the screen.
export function rowInput(snapshot: Snapshot): InputLine | undefined {
  const row = cursorRow(snapshot);
  return row === undefined ? undefined : inputLine(snapshot, 0, row);
}

// cursorRow is the text of the row the cursor shows on, with the spaces a
// capture trims put back up to the cursor, or undefined where the cursor is
// hidden or off the screen.
function cursorRow(snapshot: Snapshot): string | undefined {
  const { cursor, lines } = snapshot;
  const row = cursor.visible ? lines[cursor.y] : undefined;
  return row?.padEnd(cursor.x);
}

// inputLine is the input line holding a text from a column. Its width is its
// length only where it is all printable ASCII: terminals disagree on how many
// columns a wide character, such as a CJK ideograph or an emoji, or a
// combining mark takes, so any other text has no end the cursor can be
// known to be at, and no room.
function inputLine(snapshot: Snapshot, from: number, text: string): InputLine {
  if (!printableAscii.test(text)) {
    return { text, cursorAtEnd: false, room: 0 };
  }
  const end = from + text.length;
  return {
    text,
    cursorAtEnd: snapshot.cursor.x === end,
    room: Math.max(0, snapshot.width - 1 - end),
  };
}

export const printableAscii = /^[\x20-\x7e]*$/;
