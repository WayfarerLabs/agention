import type { Store } from "./store.ts";

// A session's presence: when an approved credential of it last called, kept to
// the minute, from which the reads derive whether it is quiet and whether its
// threads are stranded; and the agent API version that call stated, from
// which the sessions view reads whether its plugin is behind the server.

// The step last seen moves in: a call stamps it only once that moves it this
// far, so a polling agent writes about once a minute.
export const seenStep = 60_000;

// markSeen marks the session a registration acts for as seen now, speaking
// agentApiVersion, which the agent mount has already checked it serves. It
// stamps the last seen when that moves it a minute or more, or when the last
// seen is after now, so a clock stepped back never holds it still, and records
// the version whenever it differs from the one recorded, whatever the minute;
// a call that changes neither writes nothing. The agent mount calls it on
// every call by an approved key, before the call's own work, in a transaction
// of its own, so a call refused later still counts. A registration that is
// not approved as it runs, pending or revoked since its token was verified,
// marks nothing.
export function markSeen(store: Store, registrationId: number, agentApiVersion: number): void {
  const { db } = store;
  const due = "(last_seen_at IS NULL OR last_seen_at <= :now - :step OR last_seen_at > :now)";
  db.transaction(() => {
    db.prepare(
      `UPDATE sessions SET
         last_seen_at = CASE WHEN ${due} THEN :now ELSE last_seen_at END,
         agent_api_version = :version
       WHERE id = (
           SELECT session_id FROM registrations WHERE id = :registration AND status = 'approved'
         )
         AND (${due} OR agent_api_version IS NOT :version)`,
    ).run({
      now: store.clock(),
      registration: registrationId,
      step: seenStep,
      version: agentApiVersion,
    });
  });
}
