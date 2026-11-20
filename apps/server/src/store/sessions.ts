import {
  formatTimestamp,
  maxListed,
  type PublicKey,
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
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import type { Database } from "../database/database.ts";
import { invalidInput, notAllowed } from "../errors.ts";
import { authorizeAdministration, type Identity } from "../identity.ts";
import { findOperator, sessionActorId } from "./directory.ts";
import { decodeCursor, encodeCursor } from "./opaque-cursors.ts";
import type { Store } from "./store.ts";
import { pageOf, quietOf, threadsSeen, viewerAndCutoff } from "./thread-reads.ts";
import { authorizeSession, type SessionTarget } from "./threads.ts";

// What a session reports of its work, and the operator's view of the
// sessions. A session's status lives only in its log: each entry holds the
// whole status after it, so the current status is the latest entry, and
// nothing about it is stored on the session.

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
  created_at: number;
}

// The latest entry of a session's log, found through the primary key.
function latestUpdate(db: Database, sessionId: number): UpdateRow | undefined {
  return db
    .prepare(
      `SELECT seq, state, outcome, title, goal, percent, note, created_at FROM session_updates
       WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(sessionId) as unknown as UpdateRow | undefined;
}

// merged applies an update to the current status, which is undefined before
// the session first reports. A state replaces the state, with the outcome
// beside stopped and none beside the others; a session that first reports
// without one is working, since it is running. A title, goal or percent sets
// its field, and a goal other than the current one clears the percent unless
// the update gives one. A field left out is unchanged.
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
  };
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
    const sessionId = authorizeSession(db, identity, target, now);
    const { credential } = identity;
    if (identity.actor !== sessionActorId(db, sessionId) || credential.kind !== "registration") {
      throw notAllowed(undefined, "only a session reports its status, and only its own");
    }
    const current = latestUpdate(db, sessionId);
    const status = merged(current, input);
    if (current !== undefined && sameStatus(current, status) && input.note === undefined) {
      return toStatus(status);
    }
    db.prepare(
      `INSERT INTO session_updates (session_id, seq, registration_id, state, outcome, title, goal,
         percent, note, created_at)
       VALUES (:session_id, :seq, :registration_id, :state, :outcome, :title, :goal, :percent,
         :note, :created_at)`,
    ).run({
      session_id: sessionId,
      seq: (current?.seq ?? 0) + 1,
      registration_id: credential.registrationId,
      ...status,
      note: input.note ?? null,
      created_at: now,
    });
    return toStatus(status);
  });
}

// authorizeLogReader authorizes the identity for the session's log, which
// only the operator reads and marks, and resolves the session.
function authorizeLogReader(
  db: Database,
  identity: Identity,
  target: SessionTarget,
  now: number,
): number {
  const sessionId = authorizeSession(db, identity, target, now);
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
    const sessionId = authorizeLogReader(db, identity, target, store.clock());
    const rows = db
      .prepare(
        `SELECT seq, state, outcome, title, goal, percent, note, created_at FROM session_updates
         WHERE session_id = :session AND (:before IS NULL OR seq < :before)
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
    const sessionId = authorizeLogReader(db, identity, target, store.clock());
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

interface SessionRow {
  id: number;
  agent_id: number;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  quiet: number;
  latest_seq: number | null;
  state: WorkState | null;
  outcome: WorkOutcome | null;
  title: string | null;
  goal: string | null;
  percent: number | null;
  note: string | null;
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
// carries its presence, quiet as threadsSeen reads it; its approved
// registrations; its status, with the latest entry's note; how many of its
// log's entries the operator has not read; how many of its threads they have
// not archived, with how many of those are stranded; and how many asks are
// open in all its threads, with how many of those are blocking. The operator
// can never archive a thread holding an ask open to them, as archiveThread
// refuses, so the thread list shows every thread these asks are in. The
// thread counts and the ask counts each come from one statement for every
// session of the page.
export function listSessions(store: Store, identity: Identity, query: SessionsQuery): SessionsPage {
  const { db } = store;
  const position =
    query.cursor === undefined
      ? undefined
      : decodeCursor("sessions", query.cursor, ["string"], "cursor");
  return db.transaction(() => {
    const now = store.clock();
    authorizeAdministration(db, identity, now);
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
             u.seq AS latest_seq, u.state, u.outcome, u.title, u.goal, u.percent, u.note,
             COALESCE(m.read_seq, 0) AS read_seq,
             row_number() OVER (PARTITION BY s.agent_id ORDER BY ${sessionOrder}) AS place
           FROM sessions s
           LEFT JOIN session_updates u ON u.session_id = s.id
             AND u.seq = (SELECT max(seq) FROM session_updates WHERE session_id = s.id)
           LEFT JOIN session_marks m ON m.actor_id = :viewer AND m.session_id = s.id
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
             SELECT session_id, count(*) AS total, count(*) FILTER (WHERE stranded) AS stranded
             FROM seen WHERE NOT archived GROUP BY session_id`,
          )
          .all({ ...viewing, session_ids: sessionIds }) as {
          session_id: number;
          total: number;
          stranded: number;
        }[]
      ).map((row) => [row.session_id, { total: row.total, stranded: row.stranded }]),
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
    const byAgent = groupBy(sessions, (session) => session.agent_id);
    const toSummary = (row: SessionRow): SessionSummary => ({
      session: row.name,
      created_at: formatTimestamp(row.created_at),
      presence: {
        ...(row.last_seen_at === null ? {} : { last_seen_at: formatTimestamp(row.last_seen_at) }),
        quiet: row.quiet === 1,
      },
      registrations: (registrations.get(row.id) ?? []).map((registration) => ({
        id: registration.id,
        code: registrationCode(registration.public_key),
      })),
      ...(row.state === null
        ? {}
        : {
            status: {
              ...toStatus({ ...row, state: row.state }),
              ...(row.note === null ? {} : { note: row.note }),
            },
          }),
      unread_updates: (row.latest_seq ?? 0) - row.read_seq,
      threads: threads.get(row.id) ?? { total: 0, stranded: 0 },
      open_asks: asks.get(row.id) ?? { count: 0, blocking_count: 0 },
    });
    const last = page.rows.at(-1);
    return {
      agents: page.rows.map((agent) => {
        const listed = byAgent.get(agent.id) ?? [];
        return {
          agent: agent.name,
          sessions: listed.slice(0, maxListed).map(toSummary),
          truncated: listed.length > maxListed,
        };
      }),
      ...(page.more && last !== undefined ? { next: encodeCursor("sessions", [last.name]) } : {}),
    };
  });
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
