import {
  type MonitorAnswer,
  type MonitorNudgeAnswer,
  type MonitorNudgeQuery,
  type MonitorPollAnswer,
  type MonitorPollQuery,
  type MonitorReport,
  type MonitorReportQuery,
  type NudgeOutcome,
  parseTimestamp,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import type { Identity } from "../identity.ts";
import type { Store } from "./store.ts";
import { nudgeDueSince } from "./thread-reads.ts";
import { authorizeSession, type SessionTarget } from "./threads.ts";
import { longPoll } from "./wait.ts";

// Monitoring: the background connection a session's bridge holds, the
// latest report it sends of what it observes, and the nudges it claims. One
// bridge acts for a session at a time (BridgeHolders).

// pollMonitor is a bridge's background long poll on its own session. It
// answers once its wait ends; at once when another bridge acts for the
// session: one that took it over while this one waited, or one that holds it
// when this one polls without claiming it; and when whether a nudge is due,
// as nudgeDue says, differs from what the poll's query says the bridge
// knows, as the poll starts or once something wakes it, so a bridge told one
// is due holds its poll while it still is. A replaced bridge is never told
// one is due. Working out the answer writes nothing. A claim takes the
// session from any other bridge, deletes the session's report, so nothing
// stale shows until this bridge reports, and ends the other bridge's open
// poll. The poll ends too when the credential is revoked, the client
// disconnects or the server shuts down, as an agent's wait does. What can
// make a nudge due notifies the session's channel, which wakes the poll to
// look again: a report that leaves the session ready for one, and a message.
// So does an attempt deferred after its claim, which makes the nudge due
// again. What ends one being due, a check-in, a mark of the agent's own or a
// claim, wakes nothing, so a bridge told one is due learns it lapsed when its claim
// is refused, since a claim checks again, or when its poll's wait ends.
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
// or limited is due none; and a message makes one due, as nudgeDueSince
// says: one of its threads holds a live message by anyone but its agent that
// its agent has not read, written after the agent last checked in, and no
// nudge was claimed since that check-in. The session's own rows decide it,
// so it holds across a server restart, a bridge restart and a takeover
// alike. markCheckedIn stamps any check-in before the latest claim or nudge,
// so the agent checking in while the nudge is under way counts as answering
// it.
function nudgeDue(db: Database, sessionId: number, now: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM sessions s
         JOIN monitor_reports r ON r.session_id = s.id AND r.nudge = 1
           AND r.condition = 'at_prompt'
           AND NOT (r.stopped_by IS 'usage_limit' AND COALESCE(r.resets_at > :now, 1))
         WHERE s.id = :session AND ${nudgeDueSince("s")} IS NOT NULL`,
      )
      .get({ session: sessionId, now }) !== undefined
  );
}

// claimNudge is a bridge's claim of the nudge due for its session, by its
// attempt's id, in one transaction. It goes ahead only from the bridge that
// acts for the session, as reportMonitor admits one, while a nudge is due: it
// records the claim, at the server's time, with the attempt's id, its outcome
// not yet known, so none is due again until the agent checks in or the
// attempt is deferred, whatever bridge asks or however the server restarts.
// A claim before it whose outcome never came, its bridge having ended, counts
// as sent, and settles as the latest nudge first.
export function claimNudge(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: MonitorNudgeQuery,
  id: string,
): MonitorNudgeAnswer {
  return forActingBridge(store, identity, target, query, (db, sessionId, now) => {
    const go = nudgeDue(db, sessionId, now);
    if (go) {
      settleClaim(db, sessionId, "sent");
      db.prepare("UPDATE sessions SET nudge_claimed_at = ?, nudge_claim_id = ? WHERE id = ?").run(
        now,
        id,
        sessionId,
      );
    }
    return { go, wakes: false };
  });
}

// recordNudgeOutcome is a bridge's report of how an attempt it claimed, or may
// have, ended, in one transaction. From the bridge that acts for the session
// it fills in only the claim that attempt's id names, so sending it again, or
// for a claim the server never took, changes nothing: sent, stopped or
// failed settle the claim as the session's latest nudge, which then counts
// until the agent checks in; deferred releases it, leaving the latest nudge
// as it was, so the nudge is due again, and wakes the bridge's poll to say
// so. It never says go.
export function recordNudgeOutcome(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: MonitorNudgeQuery,
  id: string,
  outcome: NudgeOutcome,
): MonitorNudgeAnswer {
  return forActingBridge(store, identity, target, query, (db, sessionId) => {
    const claimed = db
      .prepare("SELECT 1 FROM sessions WHERE id = ? AND nudge_claim_id IS ?")
      .get(sessionId, id);
    if (claimed === undefined) {
      return { go: false, wakes: false };
    }
    if (outcome === "deferred") {
      db.prepare(
        "UPDATE sessions SET nudge_claimed_at = NULL, nudge_claim_id = NULL WHERE id = ?",
      ).run(sessionId);
      return { go: false, wakes: true };
    }
    settleClaim(db, sessionId, outcome);
    return { go: false, wakes: false };
  });
}

// settleClaim makes the session's claim, if any, its latest nudge, with how it
// ended, and clears the claim.
function settleClaim(db: Database, sessionId: number, outcome: Exclude<NudgeOutcome, "deferred">) {
  db.prepare(
    `UPDATE sessions SET nudged_at = nudge_claimed_at, nudge_id = nudge_claim_id,
       nudge_outcome = :outcome, nudge_claimed_at = NULL, nudge_claim_id = NULL
     WHERE id = :session AND nudge_claimed_at IS NOT NULL`,
  ).run({ session: sessionId, outcome });
}

// forActingBridge runs a nudge's write in one transaction, only where the
// bridge asking acts for the session, and answers whether the write lets it
// go ahead, waking the bridge's poll where the write made a nudge due. A
// replaced bridge's request changes nothing.
function forActingBridge(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: MonitorNudgeQuery,
  write: (db: Database, sessionId: number, now: number) => { go: boolean; wakes: boolean },
): MonitorNudgeAnswer {
  const { db, bridges } = store;
  const outcome = db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:write", target, now);
    if (bridges.admission(sessionId, query.bridge, false) === "replaced") {
      return "replaced";
    }
    return { sessionId, ...write(db, sessionId, now) };
  });
  if (outcome === "replaced") {
    return { replaced: true, go: false };
  }
  bridges.hold(outcome.sessionId, query.bridge);
  if (outcome.wakes) {
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
         resets_at, nudge, unable, unable_since)
       VALUES (:session, :monitored, :profile, :condition, :since, :stopped_by, :resets_at,
         :nudge, :unable, :unable_since)
       ON CONFLICT (session_id) DO UPDATE SET
         monitored = excluded.monitored, profile = excluded.profile,
         condition = excluded.condition, since = excluded.since,
         stopped_by = excluded.stopped_by, resets_at = excluded.resets_at,
         nudge = excluded.nudge, unable = excluded.unable, unable_since = excluded.unable_since`,
    ).run({
      session: sessionId,
      monitored: Number(report.monitored),
      ...observed,
      unable: report.unable?.reason ?? null,
      unable_since: report.unable === undefined ? null : parseTimestamp(report.unable.since),
    });
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
