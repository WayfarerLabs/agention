import {
  type LastNudge,
  type MonitorAnswer,
  type MonitorPollAnswer,
  type MonitorPollQuery,
  type MonitorReport,
  type MonitorReportQuery,
  parseTimestamp,
} from "@wayfarerlabs/agention-api";
import type { Identity } from "../identity.ts";
import type { Store } from "./store.ts";
import { authorizeSession, type SessionTarget } from "./threads.ts";
import { longPoll } from "./wait.ts";

// Monitoring: the background connection a session's bridge holds, the
// latest report it sends of what it observes, and the nudges it tries. One
// bridge acts for a session at a time (BridgeHolders).

// pollMonitor is a bridge's background long poll on its own session. It
// answers once its wait ends; at once when another bridge acts for the
// session: one that took it over while this one waited, or one that holds it
// when this one polls without claiming it; and at once when a nudge is due,
// as offerNudge says, to the bridge that acts for the session. A claim takes
// the session from any other bridge, deletes the session's report, so
// nothing stale shows until this bridge reports, and ends the other bridge's
// open poll. The poll ends too when the credential is revoked, the client
// disconnects or the server shuts down, as an agent's wait does.
export async function pollMonitor(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: MonitorPollQuery,
  signal?: AbortSignal,
): Promise<MonitorPollAnswer> {
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
      result: db.transaction(() => {
        const replaced = bridges.admission(authorized(), query.bridge, false) === "replaced";
        return { replaced, nudge: !replaced && offerNudge(store, sessionId) };
      }),
      channel: sessionId,
    }),
    signal,
    (answer) => answer.replaced || answer.nudge,
  );
}

// offerNudge says whether a nudge is due for the session, and records the
// offer when one is, inside the caller's transaction. One is due when its
// bridge last reported that it can be nudged and that it is at its prompt,
// so a session busy or at any other screen is offered none, and its bridge
// asks again only while it waits at its prompt; one of its threads holds a
// live message by the operator that its agent has not read, written after
// the agent last checked in; and no nudge was tried since that check-in. The
// session's own rows decide it, so it holds across a server restart, a
// bridge restart and a takeover alike. The latest offer is the time a nudge
// the bridge reports next is recorded at, and markCheckedIn stamps any
// check-in before it, so the agent checking in while the nudge is under way
// counts as answering it.
function offerNudge(store: Store, sessionId: number): boolean {
  const { db } = store;
  const due =
    db
      .prepare(
        `SELECT 1 FROM sessions s
         JOIN monitor_reports r ON r.session_id = s.id AND r.nudge = 1
           AND r.condition = 'at_prompt'
         JOIN actors own ON own.session_id = s.id
         WHERE s.id = :session
           AND (s.nudged_at IS NULL OR s.nudged_at <= s.last_seen_at)
           AND EXISTS (
             SELECT 1 FROM threads t
             JOIN live_messages l ON l.thread_id = t.id
             JOIN actors writer ON writer.id = l.actor_id AND writer.person_id IS NOT NULL
             LEFT JOIN thread_marks mark ON mark.actor_id = own.id AND mark.thread_id = t.id
             WHERE t.session_id = s.id
               AND l.seq > max(COALESCE(mark.read_seq, 0), COALESCE(mark.archived_seq, 0))
               AND (s.last_seen_at IS NULL OR l.created_at > s.last_seen_at)
           )`,
      )
      .get({ session: sessionId }) !== undefined;
  if (due) {
    db.prepare("UPDATE sessions SET nudge_offered_at = ? WHERE id = ?").run(
      store.clock(),
      sessionId,
    );
  }
  return due;
}

// reportMonitor keeps a bridge's report as its session's latest, replacing
// the one before, when the bridge acts for the session and the report is
// numbered above the latest accepted from it; it keeps nothing from a bridge
// another has replaced, and ignores a report that arrives after a later one.
// A bridge that is the first to call since the server started acts for the
// session from then on. A report that says the session can now be nudged
// at its prompt, where its last did not, wakes the bridge's poll, so a nudge
// due already is offered at once; and one that brings a nudge, as
// recordNudge says, records it.
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
        ? {
            profile: null,
            condition: null,
            since: null,
            stopped_by: null,
            resets_at: null,
            nudge: 0,
          }
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
            nudge: Number(report.nudge === true),
          };
    const before = db
      .prepare("SELECT nudge, condition FROM monitor_reports WHERE session_id = ?")
      .get(sessionId) as { nudge: number; condition: string | null } | undefined;
    const ready = (row: { nudge: number; condition: string | null } | undefined) =>
      row?.nudge === 1 && row.condition === "at_prompt";
    db.prepare(
      `INSERT INTO monitor_reports (session_id, monitored, profile, condition, since, stopped_by,
         resets_at, nudge)
       VALUES (:session, :monitored, :profile, :condition, :since, :stopped_by, :resets_at,
         :nudge)
       ON CONFLICT (session_id) DO UPDATE SET
         monitored = excluded.monitored, profile = excluded.profile,
         condition = excluded.condition, since = excluded.since,
         stopped_by = excluded.stopped_by, resets_at = excluded.resets_at,
         nudge = excluded.nudge`,
    ).run({ session: sessionId, monitored: Number(report.monitored), ...observed });
    if (report.monitored && report.last_nudge !== undefined) {
      recordNudge(store, sessionId, report.last_nudge);
    }
    return { sessionId, wakes: ready(observed) && !ready(before) };
  });
  if (outcome === "replaced") {
    return { replaced: true };
  }
  if (outcome !== "stale") {
    bridges.hold(outcome.sessionId, query.bridge, query.seq);
    if (outcome.wakes) {
      store.notifier.notify(outcome.sessionId);
    }
  }
  return { replaced: false };
}

// recordNudge records the nudge a report brings as the session's latest,
// at the offer that led to it, by the server's clock, when the server offered
// one since the latest it recorded and the bridge's time for it differs from
// that one's, so a later report repeating a nudge, or one that brings a
// nudge from before, records nothing.
function recordNudge(store: Store, sessionId: number, nudge: LastNudge): void {
  store.db
    .prepare(
      `UPDATE sessions SET
         nudged_at = min(nudge_offered_at, :now), nudge_sent = :sent, nudge_bridge_at = :bridge_at
       WHERE id = :session AND nudge_offered_at IS NOT NULL
         AND (nudged_at IS NULL OR nudge_offered_at > nudged_at)
         AND nudge_bridge_at IS NOT :bridge_at`,
    )
    .run({
      session: sessionId,
      now: store.clock(),
      sent: Number(nudge.sent),
      bridge_at: parseTimestamp(nudge.at),
    });
}
