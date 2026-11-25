import {
  type MonitorAnswer,
  type MonitorPollQuery,
  type MonitorReport,
  type MonitorReportQuery,
  parseTimestamp,
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
// any other bridge, deletes the session's report, so nothing stale shows
// until this bridge reports, and ends the other bridge's open poll. The poll
// ends too when the credential is revoked, the client disconnects or the
// server shuts down, as an agent's wait does.
export async function pollMonitor(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: MonitorPollQuery,
  signal?: AbortSignal,
): Promise<MonitorAnswer> {
  const { db, bridges } = store;
  const authorized = () => authorizeSession(db, identity, "threads:read", target, store.clock());
  const { sessionId, takes } = db.transaction(() => {
    const sessionId = authorized();
    const takes = bridges.admission(sessionId, query.bridge, query.claim) === "takes";
    if (takes && query.claim) {
      db.prepare("DELETE FROM monitor_reports WHERE session_id = ?").run(sessionId);
    }
    return { sessionId, takes };
  });
  if (takes) {
    bridges.hold(sessionId, query.bridge);
    store.notifier.notify(sessionId);
  }
  return longPoll(
    store,
    query.wait,
    () => ({
      result: {
        replaced: bridges.admission(db.transaction(authorized), query.bridge, false) === "replaced",
      },
      channel: sessionId,
    }),
    signal,
    (answer) => answer.replaced,
  );
}

// reportMonitor keeps a bridge's report as its session's latest, replacing
// the one before, when the bridge acts for the session and the report is
// numbered above the latest accepted from it; it keeps nothing from a bridge
// another has replaced, and ignores a report that arrives after a later one.
// A bridge that is the first to call since the server started acts for the
// session from then on.
export function reportMonitor(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: MonitorReportQuery,
  report: MonitorReport,
): MonitorAnswer {
  const { db, bridges } = store;
  const outcome = db.transaction(() => {
    const sessionId = authorizeSession(db, identity, "threads:write", target, store.clock());
    const admission = bridges.admission(sessionId, query.bridge, false);
    if (admission === "replaced") {
      return "replaced";
    }
    if (admission === "holds" && !bridges.newer(sessionId, query.seq)) {
      return "stale";
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
         resets_at)
       VALUES (:session, :monitored, :profile, :condition, :since, :stopped_by, :resets_at)
       ON CONFLICT (session_id) DO UPDATE SET
         monitored = excluded.monitored, profile = excluded.profile,
         condition = excluded.condition, since = excluded.since,
         stopped_by = excluded.stopped_by, resets_at = excluded.resets_at`,
    ).run({ session: sessionId, monitored: Number(report.monitored), ...observed });
    return { sessionId };
  });
  if (outcome === "replaced") {
    return { replaced: true };
  }
  if (outcome !== "stale") {
    bridges.hold(outcome.sessionId, query.bridge, query.seq);
  }
  return { replaced: false };
}
