import type { Database } from "../database/database.ts";
import { OperatorWaits } from "./operator-waits.ts";
import { SessionNotifier } from "./notifier.ts";

// How long a session goes unseen before it is quiet, by default.
export const defaultQuietAfter = 15 * 60_000;

// AuditWake holds the one listener that hears when a transaction has recorded
// audit events: the audit log's dispatcher, once agention serve starts it.
// Until then waking reaches no one, as in the command line's commands, whose
// events the server's dispatcher finds by polling.
export class AuditWake {
  #listener: (() => void) | undefined;

  readonly wake = (): void => {
    this.#listener?.();
  };

  listen(listener: (() => void) | undefined): void {
    this.#listener = listener;
  }
}

// Store is what every store operation runs against: the database, the clock
// that stamps what it writes, the notifier that wakes long polls, the
// operator's waits across every session each credential holds, how long a
// session goes unseen before it reads as quiet, the ids of the uploads this
// process is receiving, which the sweep leaves alone, and the wake of the
// audit log's dispatcher. Only agention serve takes uploads, and one server
// serves a database, so the set is the process's own, as the waits are.
export interface Store {
  readonly db: Database;
  readonly clock: () => number;
  readonly notifier: SessionNotifier;
  readonly operatorWaits: OperatorWaits;
  readonly quietAfter: number;
  readonly uploadsInFlight: Set<number>;
  readonly auditWake: AuditWake;
}

export function createStore(
  db: Database,
  options: { clock?: () => number; quietAfter?: number } = {},
): Store {
  return {
    db,
    clock: options.clock ?? Date.now,
    notifier: new SessionNotifier(),
    operatorWaits: new OperatorWaits(),
    quietAfter: options.quietAfter ?? defaultQuietAfter,
    uploadsInFlight: new Set(),
    auditWake: new AuditWake(),
  };
}
