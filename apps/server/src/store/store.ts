import type { Database } from "../database/database.ts";
import { SessionNotifier } from "./notifier.ts";

// How long a session goes unseen before it is quiet, by default.
export const defaultQuietAfter = 15 * 60_000;

// Store is what every store operation runs against: the database, the clock
// that stamps what it writes, the notifier that wakes long polls, how long a
// session goes unseen before it reads as quiet, and the ids of the uploads
// this process is receiving, which the sweep leaves alone. Only agention
// serve takes uploads, and one server serves a database, so the set is the
// process's own.
export interface Store {
  readonly db: Database;
  readonly clock: () => number;
  readonly notifier: SessionNotifier;
  readonly quietAfter: number;
  readonly uploadsInFlight: Set<number>;
}

export function createStore(
  db: Database,
  options: { clock?: () => number; quietAfter?: number } = {},
): Store {
  return {
    db,
    clock: options.clock ?? Date.now,
    notifier: new SessionNotifier(),
    quietAfter: options.quietAfter ?? defaultQuietAfter,
    uploadsInFlight: new Set(),
  };
}
