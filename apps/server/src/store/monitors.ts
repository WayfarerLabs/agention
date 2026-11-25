import {
  formatTimestamp,
  type MonitorAnswer,
  type MonitorCondition,
  type MonitorPollQuery,
  type MonitorProfile,
  type MonitorQuery,
  type MonitorReport,
  type MonitorState,
  parseTimestamp,
  type StoppedBy,
} from "@wayfarerlabs/agention-api";
import type { Identity } from "../identity.ts";
import type { Store } from "./store.ts";
import { authorizeSession, type SessionTarget } from "./threads.ts";
import { longPoll } from "./wait.ts";

// Monitoring: the background connection a session's bridge holds, and the
// latest report it sends of what it observes. One bridge acts for a session
// at a time (BridgeHolders).

// pollMonitor is a bridge's background long poll on its own session. It
// answers once its wait ends, or at once when another bridge acts for the
// session: one that took it over while this one waited, or one that holds it
// when this one polls without claiming it. A claim takes the session from
// any other bridge and ends that one's open poll. The poll ends too when the
// credential is revoked, the client disconnects or the server shuts down,
// as an agent's wait does.
export async function pollMonitor(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: MonitorPollQuery,
  signal?: AbortSignal,
): Promise<MonitorAnswer> {
  const authorized = () =>
    authorizeSession(store.db, identity, "threads:read", target, store.clock());
  const sessionId = store.db.transaction(authorized);
  const admitted = store.bridges.admit(sessionId, query.bridge, query.claim);
  if (admitted === "took") {
    store.notifier.notify(sessionId);
  }
  return longPoll(
    store,
    query.wait,
    () => ({
      result: { replaced: !store.bridges.holds(store.db.transaction(authorized), query.bridge) },
      channel: sessionId,
    }),
    signal,
    (answer) => answer.replaced,
  );
}

// reportMonitor keeps a bridge's report as its session's latest, replacing
// the one before, when the bridge acts for the session, and keeps nothing
// from one another bridge has replaced. A bridge that is the first to send
// anything since the server started acts for the session from then on.
export function reportMonitor(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: MonitorQuery,
  report: MonitorReport,
): MonitorAnswer {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:write", target, now);
    if (store.bridges.admit(sessionId, query.bridge, false) === "replaced") {
      return { replaced: true };
    }
    const observed =
      report.monitored === false
        ? { profile: null, condition: null, since: null, stopped_by: null, resets_at: null }
        : {
            profile: report.profile,
            condition: report.condition,
            since: parseTimestamp(report.since),
            stopped_by: report.stopped_by?.reason ?? null,
            resets_at:
              report.stopped_by?.reason === "usage_limit" &&
              report.stopped_by.resets_at !== undefined
                ? parseTimestamp(report.stopped_by.resets_at)
                : null,
          };
    db.prepare(
      `INSERT INTO monitor_reports (session_id, monitored, profile, condition, since, stopped_by,
         resets_at, reported_at)
       VALUES (:session, :monitored, :profile, :condition, :since, :stopped_by, :resets_at, :now)
       ON CONFLICT (session_id) DO UPDATE SET
         monitored = excluded.monitored, profile = excluded.profile,
         condition = excluded.condition, since = excluded.since,
         stopped_by = excluded.stopped_by, resets_at = excluded.resets_at,
         reported_at = excluded.reported_at`,
    ).run({ session: sessionId, monitored: Number(report.monitored), now, ...observed });
    return { replaced: false };
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
