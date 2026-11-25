import {
  formatTimestamp,
  type MonitorCondition,
  type MonitorProfile,
  type MonitorState,
  type SessionPresence,
  type StoppedBy,
} from "@wayfarerlabs/agention-api";
import type { Store } from "./store.ts";

// A session's presence: when its agent last checked in, kept to the minute,
// with the agent API version it checked in with, and when its bridge last
// made a background request. The reads derive from them whether it is quiet,
// whether it is connected and whether its threads are stranded, and describe
// it to the operator, with its bridge's latest report, as presenceOf does.

// The step last seen moves in: a check-in stamps it only once that moves it
// this far, so a polling agent writes about once a minute.
export const seenStep = 60_000;

// How long a background request keeps a session connected. A bridge makes
// one at least every 25 seconds while it runs, so a session stops showing
// connected within a minute of its bridge ending.
export const connectedFor = 60_000;

// The agent API version that brought monitoring. A session whose agent last
// checked in through an older bridge, while no bridge is connected, follows
// the rule of the bridges before it: it is never shown disconnected, since
// such a bridge cannot report a connection.
export const monitoringVersion = 8;

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

// A session's latest report as a read selects it from monitor_reports, every
// column null when no bridge has reported.
export interface MonitorRow {
  monitored: number | null;
  profile: MonitorProfile | null;
  condition: MonitorCondition | null;
  since: number | null;
  stopped_by: StoppedBy["reason"] | null;
  resets_at: number | null;
}

// monitorStateOf describes a report the row holds, as the operator sees it.
// The table's checks hold a monitored row's profile, condition and since,
// and a reset time only beside a usage limit.
export function monitorStateOf(row: MonitorRow): MonitorState {
  if (row.monitored !== 1 || row.profile === null || row.condition === null || row.since === null) {
    return { monitored: false };
  }
  const stoppedBy =
    row.stopped_by === null
      ? undefined
      : row.stopped_by === "usage_limit"
        ? {
            reason: row.stopped_by,
            ...(row.resets_at === null ? {} : { resets_at: formatTimestamp(row.resets_at) }),
          }
        : { reason: row.stopped_by };
  return {
    monitored: true,
    profile: row.profile,
    condition: row.condition,
    since: formatTimestamp(row.since),
    ...(stoppedBy === undefined ? {} : { stopped_by: stoppedBy }),
  };
}

// The columns of a session's presence, as a read selects them: when its
// agent last checked in, whether it is quiet and connected, as quietOf and
// connectedOf say, and its bridge's latest report.
export interface PresenceRow extends MonitorRow {
  last_seen_at: number | null;
  quiet: number;
  connected: number | null;
}

// presenceOf describes a session's presence as the operator sees it. A
// report shows only while its bridge is connected, so a bridge that ended
// never leaves its last one standing as current.
export function presenceOf(row: PresenceRow): SessionPresence {
  return {
    ...(row.last_seen_at === null ? {} : { last_seen_at: formatTimestamp(row.last_seen_at) }),
    quiet: row.quiet === 1,
    ...(row.connected === null ? {} : { connected: row.connected === 1 }),
    ...(row.connected === 1 && row.monitored !== null ? { monitor: monitorStateOf(row) } : {}),
  };
}
