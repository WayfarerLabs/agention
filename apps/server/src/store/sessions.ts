import {
  formatTimestamp,
  maxListed,
  type PublicKey,
  type Scope,
  type SessionLog,
  type SessionLogMark,
  type SessionLogMarkInput,
  type SessionLogQuery,
  type SessionStatus,
  type SessionsPage,
  type SessionsQuery,
  type SessionSummary,
  type SessionUpdate,
  type SessionUpdateInput,
  type WorkOutcome,
  type WorkState,
  type WriteStatus,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import type { Database } from "../database/database.ts";
import { invalidInput, notAllowed } from "../errors.ts";
import { authorizeScope, type Identity } from "../identity.ts";
import { findOperator, sessionActorId } from "./directory.ts";
import { decodeCursor, encodeCursor } from "./opaque-cursors.ts";
import type { Store } from "./store.ts";
import { type PresenceRow, presenceOf } from "./presence.ts";
import { connectedOf, pageOf, quietOf, threadsSeen, viewerAndCutoff } from "./thread-reads.ts";
import { authorizeSession, type SessionTarget } from "./threads.ts";

// What a session reports of its work, and the operator's view of the
// sessions. A session's status lives only in its log: each entry holds the
// whole status after it, so the current status is the latest entry, and
// nothing about it is stored on the session. The session reports it, with an
// update or beside a write to a thread, and the server infers one change of
// its own: a session that writes to a thread while idle is working.

// A session's status as the log stores it.
interface Status {
  state: WorkState;
  outcome: WorkOutcome | null;
  title: string | null;
  goal: string | null;
  percent: number | null;
}

interface UpdateRow extends Status {
  seq: number;
  note: string | null;
  inferred: number;
  created_at: number;
}

// The latest entry of a session's log, found through the primary key.
function latestUpdate(db: Database, sessionId: number): UpdateRow | undefined {
  return db
    .prepare(
      `SELECT seq, state, outcome, title, goal, percent, note, inferred, created_at
       FROM session_updates WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(sessionId) as unknown as UpdateRow | undefined;
}

// merged applies an update to the current status, which is undefined before
// the session first reports. A state replaces the state, with the outcome
// beside stopped and none beside the others; a session that first reports
// without one is working, since it is running. A title, goal or percent sets
// its field, and a goal other than the current one clears the percent unless
// the update gives one. A field left out is unchanged. A write's report is an
// update with only a state, an outcome and a note.
function merged(current: Status | undefined, input: SessionUpdateInput): Status {
  const goalChanged = input.goal !== undefined && input.goal !== (current?.goal ?? null);
  return {
    state: input.state ?? current?.state ?? "working",
    outcome: input.state === undefined ? (current?.outcome ?? null) : (input.outcome ?? null),
    title: input.title ?? current?.title ?? null,
    goal: input.goal ?? current?.goal ?? null,
    percent: input.percent ?? (goalChanged ? null : (current?.percent ?? null)),
  };
}

function sameStatus(a: Status, b: Status): boolean {
  return (
    a.state === b.state &&
    a.outcome === b.outcome &&
    a.title === b.title &&
    a.goal === b.goal &&
    a.percent === b.percent
  );
}

function toStatus(status: Status): SessionStatus {
  return {
    state: status.state,
    ...(status.outcome === null ? {} : { outcome: status.outcome }),
    ...(status.title === null ? {} : { title: status.title }),
    ...(status.goal === null ? {} : { goal: status.goal }),
    ...(status.percent === null ? {} : { percent: status.percent }),
  };
}

function toUpdate(row: UpdateRow): SessionUpdate {
  return {
    seq: row.seq,
    created_at: formatTimestamp(row.created_at),
    ...toStatus(row),
    ...(row.note === null ? {} : { note: row.note }),
    inferred: row.inferred === 1,
  };
}

// logStatus merges an update into the session's current status and logs the
// result, as the registration's, answering with the status after it. An
// update that changes nothing and carries no note logs nothing. inferred marks
// an entry the session did not report.
function logStatus(
  db: Database,
  sessionId: number,
  registrationId: number,
  input: SessionUpdateInput,
  now: number,
  inferred: boolean,
): SessionStatus {
  const current = latestUpdate(db, sessionId);
  const status = merged(current, input);
  if (current !== undefined && sameStatus(current, status) && input.note === undefined) {
    return toStatus(status);
  }
  db.prepare(
    `INSERT INTO session_updates (session_id, seq, registration_id, state, outcome, title, goal,
       percent, note, inferred, created_at)
     VALUES (:session_id, :seq, :registration_id, :state, :outcome, :title, :goal, :percent,
       :note, :inferred, :created_at)`,
  ).run({
    session_id: sessionId,
    seq: (current?.seq ?? 0) + 1,
    registration_id: registrationId,
    ...status,
    note: input.note ?? null,
    inferred: Number(inferred),
    created_at: now,
  });
  return toStatus(status);
}

// updateSession merges a session's update into its status and logs the
// result, answering with the status after it. Only the session reports its
// own status. An update that changes nothing and carries no note logs
// nothing, so repeating one is harmless; one with a note logs it again. The
// latest update wins, and none is ever stale, since only the session writes
// its status.
export function updateSession(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  input: SessionUpdateInput,
): SessionStatus {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    // A registration holds threads:write over its own session, the scope its
    // status rides on; only a registration reports one.
    const sessionId = authorizeSession(db, identity, "threads:write", target, now);
    const registrationId = ownRegistration(db, identity, sessionId);
    if (registrationId === undefined) {
      throw notOwnStatus();
    }
    return logStatus(db, sessionId, registrationId, input, now, false);
  });
}

// ownRegistration answers the registration behind the identity when it is the
// session's own, the only identity whose calls report or change the session's
// status, and undefined for any other.
function ownRegistration(db: Database, identity: Identity, sessionId: number): number | undefined {
  const { credential } = identity;
  return identity.actor === sessionActorId(db, sessionId) && credential.kind === "registration"
    ? credential.registrationId
    : undefined;
}

function notOwnStatus() {
  return notAllowed(undefined, "only a session reports its status, and only its own");
}

// statusOnWrite applies what a write to one of a session's threads says of the
// session's status, inside the write's transaction once the write has passed
// its checks, so the two land together or not at all. The session's own write
// that reports a state, an outcome or a note applies them exactly as an update
// with them would. One that reports nothing marks an idle session working,
// since a session that writes is doing something, and logs that change as an
// inferred entry; a stopped session stays stopped, since one that writes was
// started again and says so itself. The operator's writes say nothing of the
// session's status, and may report none.
export function statusOnWrite(
  db: Database,
  identity: Identity,
  sessionId: number,
  report: WriteStatus,
  now: number,
): void {
  const reported =
    report.state !== undefined || report.outcome !== undefined || report.note !== undefined;
  const registrationId = ownRegistration(db, identity, sessionId);
  if (registrationId === undefined) {
    if (reported) {
      throw notOwnStatus();
    }
    return;
  }
  if (reported) {
    logStatus(db, sessionId, registrationId, report, now, false);
  } else if (latestUpdate(db, sessionId)?.state === "idle") {
    logStatus(db, sessionId, registrationId, { state: "working" }, now, true);
  }
}

// authorizeLogReader authorizes the identity for the session's log, which
// only the operator reads and marks, with the scope the operation requires,
// and resolves the session.
function authorizeLogReader(
  db: Database,
  identity: Identity,
  scope: Scope,
  target: SessionTarget,
  now: number,
): number {
  const sessionId = authorizeSession(db, identity, scope, target, now);
  if (identity.actor !== findOperator(db)?.actorId) {
    throw notAllowed(undefined, "only the operator reads a session's log");
  }
  return sessionId;
}

// readMarkOf reads how far an actor has read a session's log.
function readMarkOf(db: Database, actor: number, sessionId: number): number {
  const row = db
    .prepare("SELECT read_seq FROM session_marks WHERE actor_id = ? AND session_id = ?")
    .get(actor, sessionId) as { read_seq: number } | undefined;
  return row?.read_seq ?? 0;
}

// sessionLog pages through a session's log for the operator, newest first,
// before the entry the query names, with how far they have read it.
export function sessionLog(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: SessionLogQuery,
): SessionLog {
  const { db } = store;
  return db.transaction(() => {
    const sessionId = authorizeLogReader(db, identity, "sessions:read", target, store.clock());
    const rows = db
      .prepare(
        `SELECT seq, state, outcome, title, goal, percent, note, inferred, created_at
         FROM session_updates WHERE session_id = :session AND (:before IS NULL OR seq < :before)
         ORDER BY seq DESC LIMIT :limit`,
      )
      .all({
        session: sessionId,
        before: query.before ?? null,
        limit: query.limit,
      }) as unknown as UpdateRow[];
    return {
      updates: rows.map(toUpdate),
      read_through: readMarkOf(db, identity.actor, sessionId),
    };
  });
}

// readSessionLog raises the operator's read mark on a session's log to
// through, at most its latest entry; it never lowers it.
export function readSessionLog(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  input: SessionLogMarkInput,
): SessionLogMark {
  const { db } = store;
  return db.transaction(() => {
    const sessionId = authorizeLogReader(db, identity, "sessions:write", target, store.clock());
    if (input.through > (latestUpdate(db, sessionId)?.seq ?? 0)) {
      throw invalidInput("through", "is beyond the session's latest update");
    }
    const { read_seq: readThrough } = db
      .prepare(
        `INSERT INTO session_marks (actor_id, session_id, read_seq) VALUES (?, ?, ?)
         ON CONFLICT (actor_id, session_id) DO UPDATE
           SET read_seq = max(read_seq, excluded.read_seq)
         RETURNING read_seq`,
      )
      .get(identity.actor, sessionId, input.through) as { read_seq: number };
    return { read_through: readThrough };
  });
}

interface SessionRow extends PresenceRow {
  id: number;
  agent_id: number;
  name: string;
  created_at: number;
  latest_seq: number | null;
  state: WorkState | null;
  outcome: WorkOutcome | null;
  title: string | null;
  goal: string | null;
  percent: number | null;
  note: string | null;
  updated_at: number | null;
  read_seq: number;
}

// The order of an agent's sessions: those working or idle first, then those
// that never reported, then stopped ones, each latest seen first, ties by
// name.
const sessionOrder = `
  CASE WHEN u.state IS NULL THEN 1 WHEN u.state = 'stopped' THEN 2 ELSE 0 END,
  s.last_seen_at IS NULL, s.last_seen_at DESC, s.name`;

// listSessions pages through the agents in name order for the operator, each
// with its sessions, at most maxListed of them, in their order. Each session
// carries its presence, quiet and connected as threadsSeen reads them, with
// its bridge's latest report while it is connected; its approved
// registrations; its status, with the latest entry's note and when that entry
// was written; how many of its log's entries the operator has not read; how
// many of its threads they have not archived, with how many of those hold
// messages they have not read and how many are stranded; and how many asks
// are open in all its threads, with how many of those are blocking. The
// operator can never archive a thread holding an ask open to them, as
// archiveThread refuses, so the thread list shows every thread these asks are
// in. The thread counts and the ask counts each come from one statement for
// every session of the page.
export function listSessions(store: Store, identity: Identity, query: SessionsQuery): SessionsPage {
  const { db } = store;
  const position =
    query.cursor === undefined
      ? undefined
      : decodeCursor("sessions", query.cursor, ["string"], "cursor");
  return db.transaction(() => {
    const now = store.clock();
    authorizeScope(db, identity, "sessions:read", now);
    const viewing = viewerAndCutoff(store, identity.actor, now);
    const agents = db
      .prepare(
        `SELECT id, name FROM agents WHERE :after = 0 OR name > :agent ORDER BY name LIMIT :limit`,
      )
      .all({
        after: position === undefined ? 0 : 1,
        agent: position?.[0] ?? "",
        limit: query.limit + 1,
      }) as { id: number; name: string }[];
    const page = pageOf(agents, query.limit);
    const sessions = db
      .prepare(
        `SELECT * FROM (
           SELECT s.id, s.agent_id, s.name, s.created_at, s.last_seen_at,
             ${quietOf("s")} AS quiet,
             ${connectedOf("s")} AS connected,
             r.monitored, r.profile, r.condition, r.since, r.stopped_by, r.resets_at,
             u.seq AS latest_seq, u.state, u.outcome, u.title, u.goal, u.percent, u.note,
             u.created_at AS updated_at,
             COALESCE(m.read_seq, 0) AS read_seq,
             row_number() OVER (PARTITION BY s.agent_id ORDER BY ${sessionOrder}) AS place
           FROM sessions s
           LEFT JOIN session_updates u ON u.session_id = s.id
             AND u.seq = (SELECT max(seq) FROM session_updates WHERE session_id = s.id)
           LEFT JOIN session_marks m ON m.actor_id = :viewer AND m.session_id = s.id
           LEFT JOIN monitor_reports r ON r.session_id = s.id
           WHERE s.agent_id IN (SELECT value FROM json_each(:agents))
         )
         WHERE place <= :listed ORDER BY agent_id, place`,
      )
      .all({
        ...viewing,
        agents: JSON.stringify(page.rows.map((agent) => agent.id)),
        listed: maxListed + 1,
      }) as unknown as SessionRow[];
    const sessionIds = JSON.stringify(sessions.map((session) => session.id));
    const registrations = groupBy(
      db
        .prepare(
          `SELECT id, public_key, session_id FROM registrations
           WHERE status = 'approved' AND session_id IN (SELECT value FROM json_each(?))
           ORDER BY id`,
        )
        .all(sessionIds) as { id: number; public_key: PublicKey; session_id: number }[],
      (registration) => registration.session_id,
    );
    const threads = new Map(
      (
        db
          .prepare(
            `${threadsSeen("t.session_id IN (SELECT value FROM json_each(:session_ids))")}
             SELECT session_id, count(*) AS total, count(*) FILTER (WHERE unread > 0) AS unread,
               count(*) FILTER (WHERE stranded) AS stranded
             FROM seen WHERE NOT archived GROUP BY session_id`,
          )
          .all({ ...viewing, session_ids: sessionIds }) as {
          session_id: number;
          total: number;
          unread: number;
          stranded: number;
        }[]
      ).map((row) => [
        row.session_id,
        { total: row.total, unread: row.unread, stranded: row.stranded },
      ]),
    );
    const asks = new Map(
      (
        db
          .prepare(
            `SELECT t.session_id, count(*) AS count,
               count(*) FILTER (WHERE a.impact = 'blocking') AS blocking_count
             FROM open_asks a JOIN threads t ON t.id = a.thread_id
             WHERE t.session_id IN (SELECT value FROM json_each(?))
             GROUP BY t.session_id`,
          )
          .all(sessionIds) as { session_id: number; count: number; blocking_count: number }[]
      ).map((row) => [row.session_id, { count: row.count, blocking_count: row.blocking_count }]),
    );
    const groups = new Map(
      (
        db
          .prepare(
            `SELECT m.session_id, g.id, g.name
             FROM session_group_members m JOIN session_groups g ON g.id = m.group_id
             WHERE m.session_id IN (SELECT value FROM json_each(?))`,
          )
          .all(sessionIds) as { session_id: number; id: number; name: string }[]
      ).map((row) => [row.session_id, { id: row.id, name: row.name }]),
    );
    const sessionTags = tagsOf(db, "session_tags", "session_id", sessionIds);
    const agentTags = tagsOf(
      db,
      "agent_tags",
      "agent_id",
      JSON.stringify(page.rows.map((agent) => agent.id)),
    );
    const byAgent = groupBy(sessions, (session) => session.agent_id);
    const toSummary = (row: SessionRow): SessionSummary => ({
      session: row.name,
      created_at: formatTimestamp(row.created_at),
      ...(groups.has(row.id) ? { group: groups.get(row.id) } : {}),
      tags: sessionTags.get(row.id) ?? [],
      presence: presenceOf(row),
      registrations: (registrations.get(row.id) ?? []).map((registration) => ({
        id: registration.id,
        code: registrationCode(registration.public_key),
      })),
      // The state and the time come from the latest entry, so both are
      // absent together, until the session first reports.
      ...(row.state === null || row.updated_at === null
        ? {}
        : {
            status: {
              ...toStatus({ ...row, state: row.state }),
              ...(row.note === null ? {} : { note: row.note }),
              updated_at: formatTimestamp(row.updated_at),
            },
          }),
      unread_updates: (row.latest_seq ?? 0) - row.read_seq,
      threads: threads.get(row.id) ?? { total: 0, unread: 0, stranded: 0 },
      open_asks: asks.get(row.id) ?? { count: 0, blocking_count: 0 },
    });
    const last = page.rows.at(-1);
    return {
      agents: page.rows.map((agent) => {
        const listed = byAgent.get(agent.id) ?? [];
        return {
          agent: agent.name,
          tags: agentTags.get(agent.id) ?? [],
          sessions: listed.slice(0, maxListed).map(toSummary),
          truncated: listed.length > maxListed,
        };
      }),
      ...(page.more && last !== undefined ? { next: encodeCursor("sessions", [last.name]) } : {}),
    };
  });
}

// tagsOf reads the tags of the agents or the sessions whose ids a JSON array
// gives, each one's in name order.
function tagsOf(
  db: Database,
  table: "agent_tags" | "session_tags",
  column: "agent_id" | "session_id",
  ids: string,
): Map<number, string[]> {
  const rows = db
    .prepare(
      `SELECT ${column} AS owner, name FROM ${table}
       WHERE ${column} IN (SELECT value FROM json_each(?)) ORDER BY name`,
    )
    .all(ids) as { owner: number; name: string }[];
  return new Map(
    [...groupBy(rows, (row) => row.owner)].map(([owner, held]) => [
      owner,
      held.map((row) => row.name),
    ]),
  );
}

// groupBy gathers items by a key, keeping their order within each.
function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = grouped.get(key);
    if (group === undefined) {
      grouped.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return grouped;
}
