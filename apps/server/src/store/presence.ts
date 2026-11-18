import type { Store } from "./store.ts";

// A session's presence: when an approved credential of it last called, kept to
// the minute, from which the reads derive whether it is quiet and whether its
// threads are stranded.

// The step last seen moves in: a call stamps it only once that moves it this
// far, so a polling agent writes about once a minute.
export const seenStep = 60_000;

// markSeen stamps the session a registration acts for as seen now, when that
// moves its last seen a minute or more, or when its last seen is after now,
// so a clock stepped back never holds it still. The agent mount calls it on
// every call by an approved key, before the call's own work, in a transaction
// of its own, so a call refused later still counts. A registration that is
// not approved as it runs, pending or revoked since its token was verified,
// stamps nothing.
export function markSeen(store: Store, registrationId: number): void {
  const { db } = store;
  db.transaction(() => {
    db.prepare(
      `UPDATE sessions SET last_seen_at = :now
       WHERE id = (
           SELECT session_id FROM registrations WHERE id = :registration AND status = 'approved'
         )
         AND (last_seen_at IS NULL OR last_seen_at <= :now - :step OR last_seen_at > :now)`,
    ).run({ now: store.clock(), registration: registrationId, step: seenStep });
  });
}
