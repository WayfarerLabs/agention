import { pendingLifetime } from "@wayfarerlabs/agention-api";
import { setImmediate as nextTurn } from "node:timers/promises";
import { removePending } from "./files.ts";
import type { Store } from "./store.ts";

// The sweep removes the uploads no message will name: those that completed
// longer than pendingLifetime ago, and those left incomplete that no upload
// in flight is still filling, which only a crash or a failed Abort leaves. A
// slow upload is never swept, however long a chunk takes to fill. It runs
// once as agention serve starts, before it listens, when nothing is in
// flight, so every incomplete upload goes, and then on a timer.

// How often the sweep runs after the first.
export const sweepInterval = 10 * 60_000;

// The pages each vacuum step returns to the disk: 8 MiB of 4 KiB pages, which
// holds the connection for about 15 ms.
const vacuumStepPages = 2048;

// sweepFiles removes what the sweep removes, each file in a transaction of
// its own, and then, when that freed pages, returns them to the disk a
// vacuum step at a time, yielding to other work between steps. A database
// not yet switched to incremental vacuuming keeps its free pages for reuse.
// It answers how many files it removed.
export async function sweepFiles(store: Store): Promise<number> {
  const { db } = store;
  const candidates = db.transaction(
    () =>
      db
        .prepare(
          `SELECT id FROM files WHERE attached_at IS NULL
             AND (completed_at IS NULL OR completed_at <= ?)`,
        )
        .all(store.clock() - pendingLifetime) as { id: number }[],
  );
  const swept = candidates.filter(({ id }) => !store.uploadsInFlight.has(id));
  for (const { id } of swept) {
    removePending(db, id);
  }
  if (db.incrementalVacuum) {
    // A step that returns nothing ends the pass, so no state of the file can
    // keep it stepping.
    for (let free = db.freePages(), before = Infinity; free > 0 && free < before;) {
      db.vacuumStep(vacuumStepPages);
      await nextTurn();
      [before, free] = [free, db.freePages()];
    }
  }
  return swept.length;
}

// sweepFilesRegularly runs the sweep now, resolving first once that pass is
// done, and then every sweepInterval on a timer that never holds the process
// open, until stop, which resolves once a pass under way is done. A pass that
// fails is logged, and the next tries again; a pass still running when the
// timer fires is not run twice.
export function sweepFilesRegularly(
  store: Store,
  log: (message: string) => void,
): { first: Promise<void>; stop: () => Promise<void> } {
  let running: Promise<void> | undefined;
  const pass = (): Promise<void> => {
    running ??= sweepFiles(store)
      .then(
        () => undefined,
        (error: unknown) => {
          log(`cannot sweep expired and unfinished uploads: ${(error as Error).message}`);
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const first = pass();
  const timer = setInterval(() => void pass(), sweepInterval);
  timer.unref();
  return {
    first,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
