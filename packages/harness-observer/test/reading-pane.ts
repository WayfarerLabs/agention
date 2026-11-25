import type { Pane, Snapshot } from "../src/pane.ts";

// readingPane is a pane for tests that only read it: its snapshots come from
// a function, and a paste or a key fails the test.
export function readingPane(snapshot: () => Promise<Snapshot>): Pane {
  const unwritten = async () => {
    throw new Error("this pane is only read");
  };
  return { snapshot, paste: unwritten, key: unwritten };
}
