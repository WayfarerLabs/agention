import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Snapshot } from "../src/pane.ts";

// The captured screens of the harnesses the profiles serve, one text file per
// screen, named for the harness, its version and what the screen shows. A
// file holds the snapshot's fields, one per line, then a line "---", then the
// screen's rows:
//
//   width 160
//   cursor 2 42 visible
//   host-has-terminal true
//   keys-blocked false
//   one-pane true
//   ---
//   ...
//
// A snapshot's time and latest key are the reader's to supply.
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
  const fields = new Map(
    lines.slice(0, end).map((line) => [line.split(" ")[0], line.split(" ").slice(1)] as const),
  );
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
    width: Number(field("width")[0]),
    cursor: { x: Number(x), y: Number(y), visible: visible === "visible" },
    hostHasTerminal: field("host-has-terminal")[0] === "true",
    keysBlocked: field("keys-blocked")[0] === "true",
    lastTyped: undefined,
    onePane: field("one-pane")[0] === "true",
    at,
  };
}

// formatCapture writes a snapshot as a capture file's text.
export function formatCapture(snapshot: Snapshot): string {
  const { cursor } = snapshot;
  const header = [
    `width ${snapshot.width}`,
    `cursor ${cursor.x} ${cursor.y} ${cursor.visible ? "visible" : "hidden"}`,
    `host-has-terminal ${snapshot.hostHasTerminal}`,
    `keys-blocked ${snapshot.keysBlocked}`,
    `one-pane ${snapshot.onePane}`,
  ];
  return [...header, "---", ...snapshot.lines].join("\n") + "\n";
}
