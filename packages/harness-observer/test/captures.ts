import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Snapshot } from "../src/pane.ts";

// The captured screens of the harnesses the profiles serve, one text file per
// screen, named for the harness, its version and what the screen shows. A
// file holds the snapshot's fields a profile reads, one per line, then a line
// "---", then the screen's rows:
//
//   width 160
//   cursor 2 42 visible
//   faint 42 2 23
//   ---
//   ...
//
// Each "faint" line, of which there may be none or several, is a run of
// faint text by its row and the code points of that row it spans, from up
// to but not including to, for a capture taken with the screen's
// attributes; a capture with no such line was taken without them, and its
// snapshot has no faint runs to say.
// A capture is of a pane the observer would read, so it reads as one pane
// whose harness holds the terminal and takes keys, with no client attached;
// its time is the reader's to supply.
export const capturesDirectory = path.join(import.meta.dirname, "..", "src", "captures");

// captureNames lists every capture, by file name without ".txt".
export function captureNames(): string[] {
  return readdirSync(capturesDirectory)
    .filter((file) => file.endsWith(".txt"))
    .map((file) => file.slice(0, -".txt".length))
    .sort();
}

// readCapture reads a capture as a snapshot taken at a time.
export function readCapture(name: string, at = 0): Snapshot {
  const text = readFileSync(path.join(capturesDirectory, `${name}.txt`), "utf8");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const end = lines.indexOf("---");
  const header = lines.slice(0, end).map((line) => line.split(" "));
  const fields = new Map(header.map(([key, ...value]) => [key, value] as const));
  const faint = header
    .filter(([key]) => key === "faint")
    .map(([, row, from, to]) => ({ row: Number(row), from: Number(from), to: Number(to) }));
  const field = (key: string): string[] => {
    const value = fields.get(key);
    if (end < 0 || value === undefined) {
      throw new Error(`the capture ${name} has no ${key}`);
    }
    return value;
  };
  const [x, y, visible] = field("cursor");
  return {
    lines: lines.slice(end + 1),
    ...(faint.length > 0 && { faint }),
    width: Number(field("width")[0]),
    cursor: { x: Number(x), y: Number(y), visible: visible === "visible" },
    hostHasTerminal: true,
    onePane: true,
    keysBlocked: false,
    lastTyped: undefined,
    at,
  };
}

// formatCapture writes a snapshot as a capture file's text.
export function formatCapture(snapshot: Snapshot): string {
  const { cursor } = snapshot;
  const header = [
    `width ${snapshot.width}`,
    `cursor ${cursor.x} ${cursor.y} ${cursor.visible ? "visible" : "hidden"}`,
    ...(snapshot.faint ?? []).map((run) => `faint ${run.row} ${run.from} ${run.to}`),
  ];
  return [...header, "---", ...snapshot.lines].join("\n") + "\n";
}
