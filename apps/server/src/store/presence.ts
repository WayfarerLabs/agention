import type { Store } from "./store.ts";

// A session's presence: when its agent last checked in, kept to the minute,
// with the agent API version it checked in with, and when its bridge last
// made a background request. The reads derive from them whether it is quiet,
// whether it is connected and whether its threads are stranded.

// The step last seen moves in: a check-in stamps it only once that moves it
// this far, so a polling agent writes about once a minute.
export const seenStep = 60_000;

// How long a background request keeps a session connected. A bridge makes
// one at least every 25 seconds while it runs, so a session stops showing
// connected within a minute of its bridge ending.
export const connectedFor = 60_000;

// markCheckedIn stamps the agent of the session a registration acts for as
// checked in now, with the agent API version of its call, when that moves
// its last check-in a minute or more, when its last check-in is after now,
// so a clock stepped back never holds it still, or when the version differs
// from the last one's, so a session pinned to an older bridge is read by its
// rule at once. The agent mount calls it on every call by an approved key
// but its bridge's background ones, before the call's own work, in a
// transaction of its own, so a call refused later still counts. A
// registration that is not approved as it runs, pending or revoked since its
// token was verified, stamps nothing.
export function markCheckedIn(store: Store, registrationId: number, version: number): void {
  const { db } = store;
  db.transaction(() => {
    db.prepare(
      `UPDATE sessions SET last_seen_at = :now, last_seen_version = :version
       WHERE id = (
           SELECT session_id FROM registrations WHERE id = :registration AND status = 'approved'
         )
         AND (last_seen_at IS NULL OR last_seen_at <= :now - :step OR last_seen_at > :now
           OR last_seen_version IS NOT :version)`,
    ).run({ now: store.clock(), registration: registrationId, step: seenStep, version });
  });
}

// markBackground stamps the session a registration acts for as connected
// now, on every background request of its bridge, as markCheckedIn stamps a
// check-in, and never as a check-in. A registration that is not approved as
// it runs stamps nothing.
export function markBackground(store: Store, registrationId: number): void {
  const { db } = store;
  db.transaction(() => {
    db.prepare(
      `UPDATE sessions SET background_at = :now
       WHERE id = (
         SELECT session_id FROM registrations WHERE id = :registration AND status = 'approved'
       )`,
    ).run({ now: store.clock(), registration: registrationId });
  });
}
