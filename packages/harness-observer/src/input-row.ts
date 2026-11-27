import type { Snapshot } from "./pane.ts";

// atMarkedInput says whether the cursor shows on a row that starts with a
// harness's prompt marker, at or after the marker's end: the harness's input
// line. Each character of the markers the profiles know is one column wide,
// as their captures show, so a marker's width is its count of code points.
export function atMarkedInput(snapshot: Snapshot, marker: string): boolean {
  const { cursor, lines } = snapshot;
  return (
    cursor.visible && lines[cursor.y]?.startsWith(marker) === true && cursor.x >= [...marker].length
  );
}
