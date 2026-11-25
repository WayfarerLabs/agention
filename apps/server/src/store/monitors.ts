import {
  type MonitorAnswer,
  type MonitorNudge,
  type MonitorNudgeAnswer,
  type MonitorNudgeQuery,
  type MonitorPollAnswer,
  type MonitorPollQuery,
  type MonitorReport,
  type MonitorReportQuery,
  parseTimestamp,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import type { Identity } from "../identity.ts";
import type { Store } from "./store.ts";
import { authorizeSession, type SessionTarget } from "./threads.ts";
import { longPoll } from "./wait.ts";

// Monitoring: the background connection a session's bridge holds, the
// latest report it sends of what it observes, and the nudges it claims. One
// bridge acts for a session at a time (BridgeHolders).

// pollMonitor is a bridge's background long poll on its own session. It
// answers once its wait ends; at once when another bridge acts for the
// session: one that took it over while this one waited, or one that holds it
// when this one polls without claiming it; and at once when whether a nudge
// is due, as nudgeDue says, differs from what the poll's query says the
// bridge knows, so a bridge told one is due holds its poll while it still is
// and learns at once that it lapsed. A replaced bridge is never told one is
// due. Working out the answer writes nothing. A claim takes the session from
// any other bridge, deletes the session's report, so nothing stale shows
// until this bridge reports, and ends the other bridge's open poll. The poll
// ends too when the credential is revoked, the client disconnects or the
// server shuts down, as an agent's wait does. What can change whether a
// nudge is due notifies the session's channel, which wakes the poll to look
// again: a report that leaves the session ready for one, a message, a check-in
// stamp, a mark of the agent's own and a claim.
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
        return { replaced, nudge: !replaced && nudgeDue(db, sessionId, store.clock()) };
      }),
      channel: sessionId,
    }),
    signal,
    (answer) => answer.replaced || answer.nudge !== query.nudge,
  );
}

// nudgeDue says whether a nudge is due for the session now, reading and
// never writing. One is due when its bridge last reported that it can be
// nudged and that it is at its prompt, not stopped by a usage limit whose
// reset is unknown or still to come, so a session busy, at any other screen
// or limited is due none; one of its threads holds a live message by anyone
// but its agent that its agent has not read, by the rule its own unread
// count follows, written after the agent last checked in; and no nudge was
// claimed since that check-in. The session's own rows decide it, so it holds
// across a server restart, a bridge restart and a takeover alike.
// markCheckedIn stamps any check-in before the latest claim, so the agent
// checking in while the nudge is under way counts as answering it.
function nudgeDue(db: Database, sessionId: number, now: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM sessions s
         JOIN monitor_reports r ON r.session_id = s.id AND r.nudge = 1
           AND r.condition = 'at_prompt'
           AND NOT (r.stopped_by IS 'usage_limit' AND COALESCE(r.resets_at > :now, 1))
         JOIN actors own ON own.session_id = s.id
         WHERE s.id = :session
           AND (s.nudged_at IS NULL OR s.nudged_at <= s.last_seen_at)
           AND EXISTS (
             SELECT 1 FROM threads t
             JOIN live_messages l ON l.thread_id = t.id AND l.actor_id <> own.id
             LEFT JOIN thread_marks mark ON mark.actor_id = own.id AND mark.thread_id = t.id
             WHERE t.session_id = s.id
               AND l.seq > max(COALESCE(mark.read_seq, 0), COALESCE(mark.archived_seq, 0))
               AND (s.last_seen_at IS NULL OR l.created_at > s.last_seen_at)
           )`,
      )
      .get({ session: sessionId, now }) !== undefined
  );
}

// claimNudge is a bridge's claim of the nudge due for its session, or its
// report of how a nudge it claimed ended, each in one transaction. A claim
// goes ahead only from the bridge that acts for the session, as reportMonitor
// admits one, while a nudge is due: it records the claim as the session's
// latest nudge, at the server's time, its outcome not yet known, so none is
// due again until the agent checks in, whatever bridge asks or however the
// server restarts; and wakes the session's poll. An outcome from that bridge
// fills in the latest nudge's where none is recorded yet, so sending it again
// changes nothing. A replaced bridge's claim or outcome changes nothing.
export function claimNudge(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: MonitorNudgeQuery,
  body: MonitorNudge,
): MonitorNudgeAnswer {
  const { db, bridges } = store;
  const outcome = db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:write", target, now);
    if (bridges.admission(sessionId, query.bridge, false) === "replaced") {
      return "replaced";
    }
    if (body.phase === "done") {
      db.prepare(
        `UPDATE sessions SET nudge_sent = :sent
         WHERE id = :session AND nudged_at IS NOT NULL AND nudge_sent IS NULL`,
      ).run({ session: sessionId, sent: Number(body.sent) });
      return { sessionId, go: false };
    }
    const go = nudgeDue(db, sessionId, now);
    if (go) {
      db.prepare("UPDATE sessions SET nudged_at = ?, nudge_sent = NULL WHERE id = ?").run(
        now,
        sessionId,
      );
    }
    return { sessionId, go };
  });
  if (outcome === "replaced") {
    return { replaced: true, go: false };
  }
  bridges.hold(outcome.sessionId, query.bridge);
  if (outcome.go) {
    store.notifier.notify(outcome.sessionId);
  }
  return { replaced: false, go: outcome.go };
}

// reportMonitor keeps a bridge's report as its session's latest, replacing
// the one before, when the bridge acts for the session and the report is
// numbered above the latest accepted from it; it keeps nothing from a bridge
// another has replaced, and ignores a report that arrives after a later one.
// A bridge that is the first to call since the server started acts for the
// session from then on. A report that says the session can be nudged at its
// prompt wakes the bridge's poll, so a nudge due already is told at once.
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
    return { sessionId, wakes: observed.nudge === 1 && observed.condition === "at_prompt" };
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
