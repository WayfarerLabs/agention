import type { Database } from "../database/database.ts";
import { SessionNotifier } from "./notifier.ts";

// How long a session goes unseen before it is quiet, by default.
export const defaultQuietAfter = 15 * 60_000;

// Store is what every store operation runs against: the database, the clock
// that stamps what it writes, the notifier that wakes long polls, and how
// long a session goes unseen before it reads as quiet.
export interface Store {
  readonly db: Database;
  readonly clock: () => number;
  readonly notifier: SessionNotifier;
  readonly quietAfter: number;
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
  };
}
