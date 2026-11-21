import {
  type AnswerRead,
  type AskRead,
  type AskSummary,
  type Cursors,
  type Effort,
  effort,
  formatTimestamp,
  type Impact,
  type Marks,
  maxListedAsks,
  type Message,
  type Priority,
  priority,
  type Reference,
  type Suggestion,
  type ThreadStatus,
  type ThreadSummary,
  type Withdrawal,
  type WorkOutcome,
  type WorkState,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import { authorOf } from "./directory.ts";
import { seenStep } from "./presence.ts";
import type { Store } from "./store.ts";

// Reads of threads and messages, as a viewer sees them now. Everything about a
// thread beyond its stored title and roles comes from the live_messages and
// open_asks views, so these queries derive and never store it.

// rankIn ranks a column by its value's place in levels, from 0; any other
// value ranks null. The levels are the API's own, never input.
function rankIn(column: string, levels: readonly string[]): string {
  return `CASE ${column} ${levels.map((level, rank) => `WHEN '${level}' THEN ${rank}`).join(" ")} END`;
}

// priorityRank ranks a priority, most pressing first, as priority.options
// lists them. Every value ranks: the asks table's CHECK holds an ask's to
// those levels, and a priority filter takes only some of them.
export const priorityRank = (column: string): string => rankIn(column, priority.options);

// effortRank ranks an effort, quickest first, as effort.options lists them;
// null when unstated. Every stated value ranks, as for priorityRank.
export const effortRank = (column: string): string => rankIn(column, effort.options);

// A sort key past every answer-by time, so asks without one sort last.
export const noAnswerBy = Number.MAX_SAFE_INTEGER;

// The open-asks order of a thread's asks, over open_asks as o: by priority,
// then blocking first, then earliest answer-by, then lowest number, which
// within a thread is oldest first, a message's own asks in the order given.
export const askOrder =
  `${priorityRank("o.priority")}, o.impact <> 'blocking', ` +
  `COALESCE(o.answer_by, ${noAnswerBy}), o.number`;

// Which open ask a thread leads with: the first, in order, of those keeps
// admits, both over open_asks as o.
export interface Lead {
  keeps: string;
  order: string;
}

// The most pressing of every open ask.
const mostPressing: Lead = { keeps: "1", order: askOrder };

// The parameters every query threadsSeen starts binds: the viewer's actor,
// and the quiet cut-off, the time before which a session last seen is quiet.
export interface ViewerAndCutoff {
  viewer: number;
  quiet_before: number;
}

// viewerAndCutoff gives the viewer and the quiet cut-off now. A session is
// quiet once unseen for the server's threshold and the step its stamp may lag
// by, so a session that keeps calling never is.
export function viewerAndCutoff(store: Store, viewer: number, now: number): ViewerAndCutoff {
  return { viewer, quiet_before: now - store.quietAfter - seenStep };
}

// quietOf says whether the sessions read as sessions are quiet: never seen,
// or last seen before the quiet cut-off a ViewerAndCutoff binds.
export function quietOf(sessions: string): string {
  return `(${sessions}.last_seen_at IS NULL OR ${sessions}.last_seen_at < :quiet_before)`;
}

// threadsSeen starts a query over the threads that scope admits, as the
// viewer sees them now: a WITH clause defining `seen`, with the names, the
// viewer's marks, the other party, the unread count (live messages by the
// other party after both the read and the archive mark, since an archived
// message is never unread), how many live messages it holds, whether the
// thread is archived for the viewer (the archive mark reaches its latest
// message, so all its messages are), its topic, the roll-ups of its open
// asks, the open ask it leads with (lead_*, absent when lead admits none),
// its status (rolling up the asks on a live message or that a live message
// withdraws: open while any is open; otherwise withdrawn when every one is
// withdrawn, answered when there are any, and none when there are none)
// with, while withdrawn, the latest live withdrawal, the first of its
// message's, its session's presence and the state and outcome it last
// reported, whether the other party has not read a live message of the
// viewer's, and whether the thread is stranded: so, while the session is
// quiet, has no active credential or has stopped. scope reads the threads as
// t, their sessions as s and their agents as g. Callers bind a
// ViewerAndCutoff and whatever lead's conditions name, and select from seen.
export function threadsSeen(scope: string, lead: Lead = mostPressing): string {
  return `
    WITH base AS (
      SELECT
        t.id, t.session_id, t.number, t.title, t.created_at, t.last_seq,
        g.name AS agent_name, s.name AS session_name,
        IIF(t.requester_actor_id = :viewer, t.audience_actor_id, t.requester_actor_id)
          AS other_actor_id,
        t.audience_actor_id = :viewer AS audience,
        latest.created_at AS updated_at, latest.session_pos AS latest_pos,
        COALESCE(mark.read_seq, 0) AS read_seq,
        COALESCE(mark.archived_seq, 0) AS archived_seq,
        EXISTS (
          SELECT 1 FROM registrations r WHERE r.session_id = t.session_id AND r.status = 'approved'
        ) AS credential_active,
        s.last_seen_at,
        ${quietOf("s")} AS quiet,
        reported.state AS session_state, reported.outcome AS session_outcome
      FROM threads t
      JOIN sessions s ON s.id = t.session_id
      JOIN agents g ON g.id = s.agent_id
      JOIN messages latest ON latest.thread_id = t.id AND latest.seq = t.last_seq
      LEFT JOIN thread_marks mark ON mark.actor_id = :viewer AND mark.thread_id = t.id
      LEFT JOIN session_updates reported ON reported.session_id = t.session_id
        AND reported.seq = (
          SELECT max(u.seq) FROM session_updates u WHERE u.session_id = t.session_id
        )
      WHERE ${scope}
    ),
    placed AS (
      SELECT o.*, asking.created_at AS asked_at,
        row_number() OVER (PARTITION BY o.thread_id ORDER BY ${askOrder}) AS place,
        (${lead.keeps}) AS kept,
        row_number() OVER (PARTITION BY o.thread_id, (${lead.keeps}) ORDER BY ${lead.order})
          AS kept_place
      FROM open_asks o
      JOIN messages asking ON asking.thread_id = o.thread_id AND asking.seq = o.seq
      WHERE o.thread_id IN (SELECT id FROM base)
    ),
    open_summary AS (
      SELECT o.thread_id,
        json_group_array(json_object('number', o.number, 'seq', o.seq) ORDER BY o.place)
          FILTER (WHERE o.place <= ${maxListedAsks}) AS open_list,
        count(*) AS open_count,
        -- A later message's asks always take higher numbers, so the earliest
        -- open ask has both the lowest number and the lowest sequence.
        min(o.number) AS earliest_number, min(o.seq) AS earliest_seq,
        min(${priorityRank("o.priority")}) AS ask_priority_rank,
        min(o.answer_by) AS ask_answer_by,
        max(o.impact = 'blocking') AS ask_blocking,
        max(IIF(o.lead, o.number, NULL)) AS lead_number,
        max(IIF(o.lead, ${priorityRank("o.priority")}, NULL)) AS lead_priority_rank,
        max(IIF(o.lead, o.impact = 'blocking', NULL)) AS lead_blocking,
        max(IIF(o.lead, o.answer_by, NULL)) AS lead_answer_by,
        max(IIF(o.lead, ${effortRank("o.effort")}, NULL)) AS lead_effort_rank,
        max(IIF(o.lead, o.asked_at, NULL)) AS lead_since,
        max(IIF(o.lead, json_object('number', o.number, 'seq', o.seq, 'question', o.question,
          'impact', o.impact, 'priority', o.priority, 'effort', o.effort,
          'answer_by', o.answer_by), NULL)) AS lead_ask
      FROM (SELECT placed.*, kept AND kept_place = 1 AS lead FROM placed) o
      GROUP BY o.thread_id
    ),
    rolled_asks AS (
      SELECT a.thread_id, count(*) AS rolled_count,
        count(*) FILTER (WHERE a.withdrawn) AS withdrawn_count
      FROM (
        SELECT a.thread_id,
          EXISTS (
            SELECT 1 FROM live_messages l WHERE l.thread_id = a.thread_id AND l.seq = a.seq
          ) AS live,
          EXISTS (
            SELECT 1 FROM withdrawals w
            JOIN live_messages lw ON lw.thread_id = w.thread_id AND lw.seq = w.seq
            WHERE w.thread_id = a.thread_id AND w.ask = a.number
          ) AS withdrawn
        FROM asks a
        WHERE a.thread_id IN (SELECT id FROM base)
      ) a
      WHERE a.live OR a.withdrawn
      GROUP BY a.thread_id
    ),
    joined AS (
      SELECT base.*,
        (
          SELECT count(*) FROM live_messages l
          WHERE l.thread_id = base.id AND l.actor_id <> :viewer
            AND l.seq > max(base.read_seq, base.archived_seq)
        ) AS unread,
        (SELECT count(*) FROM live_messages l WHERE l.thread_id = base.id) AS message_count,
        base.archived_seq > 0 AND base.archived_seq = base.last_seq AS archived,
        (
          SELECT l.topic FROM live_messages l
          WHERE l.thread_id = base.id AND l.topic IS NOT NULL ORDER BY l.seq DESC LIMIT 1
        ) AS topic,
        r.open_list, COALESCE(r.open_count, 0) AS open_count,
        r.earliest_number, r.earliest_seq,
        r.ask_priority_rank, r.ask_answer_by,
        COALESCE(r.ask_blocking, 0) AS ask_blocking,
        r.lead_number, r.lead_priority_rank, r.lead_blocking, r.lead_answer_by,
        r.lead_effort_rank, r.lead_since, r.lead_ask,
        CASE
          WHEN r.open_count > 0 THEN 'open'
          WHEN rolled.rolled_count IS NULL THEN 'none'
          WHEN rolled.withdrawn_count = rolled.rolled_count THEN 'withdrawn'
          ELSE 'answered'
        END AS status,
        EXISTS (
          SELECT 1 FROM live_messages l
          WHERE l.thread_id = base.id AND l.actor_id = :viewer AND l.seq > COALESCE((
            SELECT m.read_seq FROM thread_marks m
            WHERE m.actor_id = base.other_actor_id AND m.thread_id = base.id
          ), 0)
        ) AS unread_by_other
      FROM base
      LEFT JOIN open_summary r ON r.thread_id = base.id
      LEFT JOIN rolled_asks rolled ON rolled.thread_id = base.id
    ),
    seen AS (
      SELECT joined.*,
        IIF(joined.status = 'withdrawn', (
          SELECT json_object('ask', w.ask, 'seq', w.seq, 'reason', w.reason) FROM withdrawals w
          JOIN live_messages lw ON lw.thread_id = w.thread_id AND lw.seq = w.seq
          WHERE w.thread_id = joined.id ORDER BY w.seq DESC, w.ask LIMIT 1
        ), NULL) AS latest_withdrawal,
        joined.unread_by_other AND (
          joined.quiet OR NOT joined.credential_active OR joined.session_state IS 'stopped'
        ) AS stranded
      FROM joined
    )`;
}

export interface ThreadRow {
  id: number;
  session_id: number;
  number: number;
  title: string;
  created_at: number;
  last_seq: number;
  agent_name: string;
  session_name: string;
  other_actor_id: number;
  audience: number;
  updated_at: number;
  latest_pos: number;
  read_seq: number;
  archived_seq: number;
  credential_active: number;
  last_seen_at: number | null;
  quiet: number;
  session_state: WorkState | null;
  session_outcome: WorkOutcome | null;
  unread_by_other: number;
  status: ThreadStatus;
  unread: number;
  message_count: number;
  archived: number;
  topic: string | null;
  open_list: string | null;
  open_count: number;
  earliest_number: number | null;
  earliest_seq: number | null;
  ask_priority_rank: number | null;
  ask_answer_by: number | null;
  ask_blocking: number;
  lead_number: number | null;
  lead_priority_rank: number | null;
  lead_blocking: number | null;
  lead_answer_by: number | null;
  lead_effort_rank: number | null;
  lead_since: number | null;
  lead_ask: string | null;
  latest_withdrawal: string | null;
  stranded: number;
}

function askSummaryOf(json: string, now: number): AskSummary {
  const ask = JSON.parse(json) as {
    number: number;
    seq: number;
    question: string;
    impact: Impact;
    priority: Priority;
    effort: Effort | null;
    answer_by: number | null;
  };
  return {
    number: ask.number,
    seq: ask.seq,
    question: ask.question,
    impact: ask.impact,
    priority: ask.priority,
    ...(ask.effort === null ? {} : { effort: ask.effort }),
    ...(ask.answer_by === null ? {} : { answer_by: formatTimestamp(ask.answer_by) }),
    overdue: ask.answer_by !== null && ask.answer_by < now,
  };
}

// toThreadSummary describes a row of seen. An ask is overdue once its
// answer-by time is before now. The thread's audience also sees its
// session's presence, with the state and outcome it last reported, and
// whether the thread is stranded.
export function toThreadSummary(row: ThreadRow, now: number): ThreadSummary {
  const rank = row.ask_priority_rank === null ? undefined : priority.options[row.ask_priority_rank];
  return {
    agent: row.agent_name,
    session: row.session_name,
    number: row.number,
    title: row.title,
    created_at: formatTimestamp(row.created_at),
    updated_at: formatTimestamp(row.updated_at),
    last_seq: row.last_seq,
    ...(row.topic === null ? {} : { topic: row.topic }),
    read_through: row.read_seq,
    unread: row.unread,
    message_count: row.message_count,
    archived: row.archived === 1,
    open_asks: {
      asks:
        row.open_list === null
          ? []
          : (JSON.parse(row.open_list) as { number: number; seq: number }[]),
      count: row.open_count,
      ...(row.earliest_number === null || row.earliest_seq === null
        ? {}
        : { earliest: { number: row.earliest_number, seq: row.earliest_seq } }),
      ...(row.lead_ask === null ? {} : { lead: askSummaryOf(row.lead_ask, now) }),
      ...(rank === undefined ? {} : { priority: rank }),
      ...(row.ask_answer_by === null ? {} : { answer_by: formatTimestamp(row.ask_answer_by) }),
      blocking: row.ask_blocking === 1,
      overdue: row.ask_answer_by !== null && row.ask_answer_by < now,
    },
    status: row.status,
    ...(row.latest_withdrawal === null
      ? {}
      : { withdrawal: JSON.parse(row.latest_withdrawal) as Withdrawal & { seq: number } }),
    credential_active: row.credential_active === 1,
    ...(row.audience === 1
      ? {
          presence: {
            ...(row.last_seen_at === null
              ? {}
              : { last_seen_at: formatTimestamp(row.last_seen_at) }),
            quiet: row.quiet === 1,
            ...(row.session_state === null ? {} : { state: row.session_state }),
            ...(row.session_outcome === null ? {} : { outcome: row.session_outcome }),
          },
          stranded: row.stranded === 1,
        }
      : {}),
  };
}

// readThread reads one thread as the viewer sees it now.
export function readThread(
  store: Store,
  threadId: number,
  viewer: number,
  now: number,
): ThreadSummary {
  const row = store.db
    .prepare(`${threadsSeen("t.id = :thread")} SELECT * FROM seen`)
    .get({ thread: threadId, ...viewerAndCutoff(store, viewer, now) }) as unknown as ThreadRow;
  return toThreadSummary(row, now);
}

export interface ThreadParties {
  id: number;
  requester_actor_id: number;
  audience_actor_id: number;
}

// partyCursors reads how far the thread's requester and audience have each
// read it.
export function partyCursors(db: Database, thread: ThreadParties): Cursors {
  return db
    .prepare(
      `SELECT
         COALESCE((SELECT read_seq FROM thread_marks WHERE actor_id = :requester
           AND thread_id = :thread), 0) AS requester,
         COALESCE((SELECT read_seq FROM thread_marks WHERE actor_id = :audience
           AND thread_id = :thread), 0) AS audience`,
    )
    .get({
      thread: thread.id,
      requester: thread.requester_actor_id,
      audience: thread.audience_actor_id,
    }) as { requester: number; audience: number };
}

// marksOf reads an actor's own marks on a thread.
export function marksOf(db: Database, actor: number, threadId: number): Marks {
  const row = db
    .prepare("SELECT read_seq, archived_seq FROM thread_marks WHERE actor_id = ? AND thread_id = ?")
    .get(actor, threadId) as { read_seq: number; archived_seq: number } | undefined;
  return { read_through: row?.read_seq ?? 0, archived_through: row?.archived_seq ?? 0 };
}

interface MessageRow {
  seq: number;
  actor_id: number;
  created_at: number;
  text: string | null;
  detail: string | null;
  message_references: string | null;
  replaces_seq: number | null;
  topic: string | null;
  live: number;
  replaced_by: number | null;
}

interface AskRow {
  number: number;
  seq: number;
  question: string;
  suggestions: string;
  multiple: number;
  impact: Impact;
  priority: Priority;
  effort: Effort | null;
  answer_by: number | null;
  fallback: string | null;
  open: number;
  answer_seq: number | null;
  answer_declined: number | null;
  answer_picks: string | null;
  answer_text: string | null;
  withdrawal_seq: number | null;
  withdrawal_reason: string | null;
}

interface AnswerRow {
  seq: number;
  ask: number;
  declined: number;
  picks: string | null;
  text: string | null;
  ask_seq: number;
  ask_question: string;
  ask_suggestions: string;
  ask_live: number;
}

// answerParts describes a stored answer: whether it declined, the picked
// indexes with the labels the ask gave them, and the answerer's own words.
function answerParts(
  declined: number,
  picks: string | null,
  text: string | null,
  suggestions: string,
) {
  const indexes = picks === null ? undefined : (JSON.parse(picks) as number[]);
  const offered = JSON.parse(suggestions) as Suggestion[];
  return {
    declined: declined === 1,
    ...(indexes === undefined
      ? {}
      : { picks: indexes, labels: indexes.map((index) => offered[index]?.label ?? "") }),
    ...(text === null ? {} : { text }),
  };
}

function toAsk(row: AskRow): AskRead {
  return {
    number: row.number,
    question: row.question,
    suggestions: JSON.parse(row.suggestions) as Suggestion[],
    multiple: row.multiple === 1,
    impact: row.impact,
    priority: row.priority,
    ...(row.effort === null ? {} : { effort: row.effort }),
    ...(row.answer_by === null ? {} : { answer_by: formatTimestamp(row.answer_by) }),
    ...(row.fallback === null ? {} : { fallback: row.fallback }),
    open: row.open === 1,
    ...(row.answer_seq === null || row.answer_declined === null
      ? {}
      : {
          answer: {
            seq: row.answer_seq,
            ...answerParts(row.answer_declined, row.answer_picks, row.answer_text, row.suggestions),
          },
        }),
    ...(row.withdrawal_seq === null || row.withdrawal_reason === null
      ? {}
      : { withdrawal: { seq: row.withdrawal_seq, reason: row.withdrawal_reason } }),
  };
}

function toAnswer(row: AnswerRow): AnswerRead {
  return {
    ask: row.ask,
    question: row.ask_question,
    ask_seq: row.ask_seq,
    ask_live: row.ask_live === 1,
    ...answerParts(row.declined, row.picks, row.text, row.ask_suggestions),
  };
}

// groupBySeq gathers rows by the message they belong to.
function groupBySeq<T extends { seq: number }>(rows: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    grouped.set(row.seq, [...(grouped.get(row.seq) ?? []), row]);
  }
  return grouped;
}

// readMessages reads up to limit messages after the given sequence, in order,
// as they read now: whether each is live and what replaced it; each ask's
// number, whether it is open, and its live answer or live withdrawal; each
// answer's ask, with its question, and whether that ask is still live; and
// each withdrawal, all as the two views define them. An ask has at most one
// live answer or live withdrawal, and never both, since each needs an open
// ask and a replacement answers or withdraws again the asks its message did.
export function readMessages(
  db: Database,
  threadId: number,
  after: number,
  limit: number,
): Message[] {
  const rows = db
    .prepare(
      `SELECT m.seq, m.actor_id, m.created_at, m.text, m.detail, m.message_references,
         m.replaces_seq, m.topic,
         EXISTS (SELECT 1 FROM live_messages l
           WHERE l.thread_id = m.thread_id AND l.seq = m.seq) AS live,
         (SELECT r.seq FROM messages r
          WHERE r.thread_id = m.thread_id AND r.replaces_seq = m.seq) AS replaced_by
       FROM messages m WHERE m.thread_id = :thread AND m.seq > :after
       ORDER BY m.seq LIMIT :limit`,
    )
    .all({ thread: threadId, after, limit }) as unknown as MessageRow[];
  const last = rows.at(-1)?.seq;
  if (last === undefined) {
    return [];
  }
  const span = { thread: threadId, after, last };
  const asks = groupBySeq(
    db
      .prepare(
        `SELECT a.*,
           EXISTS (SELECT 1 FROM open_asks o
             WHERE o.thread_id = a.thread_id AND o.number = a.number) AS open,
           n.seq AS answer_seq, n.declined AS answer_declined, n.picks AS answer_picks,
           n.text AS answer_text, w.seq AS withdrawal_seq, w.reason AS withdrawal_reason
         FROM asks a
         LEFT JOIN answers n ON n.thread_id = a.thread_id AND n.ask = a.number
           AND EXISTS (SELECT 1 FROM live_messages l
             WHERE l.thread_id = n.thread_id AND l.seq = n.seq)
         LEFT JOIN withdrawals w ON w.thread_id = a.thread_id AND w.ask = a.number
           AND EXISTS (SELECT 1 FROM live_messages l
             WHERE l.thread_id = w.thread_id AND l.seq = w.seq)
         WHERE a.thread_id = :thread AND a.seq > :after AND a.seq <= :last
         ORDER BY a.number`,
      )
      .all(span) as unknown as AskRow[],
  );
  const answers = groupBySeq(
    db
      .prepare(
        `SELECT n.*, a.seq AS ask_seq, a.question AS ask_question,
           a.suggestions AS ask_suggestions,
           EXISTS (SELECT 1 FROM live_messages l
             WHERE l.thread_id = a.thread_id AND l.seq = a.seq) AS ask_live
         FROM answers n JOIN asks a ON a.thread_id = n.thread_id AND a.number = n.ask
         WHERE n.thread_id = :thread AND n.seq > :after AND n.seq <= :last
         ORDER BY n.seq, n.ask`,
      )
      .all(span) as unknown as AnswerRow[],
  );
  const withdrawals = groupBySeq(
    db
      .prepare(
        `SELECT seq, ask, reason FROM withdrawals
         WHERE thread_id = :thread AND seq > :after AND seq <= :last
         ORDER BY seq, ask`,
      )
      .all(span) as unknown as (Withdrawal & { seq: number })[],
  );
  return rows.map((row) => {
    const own = asks.get(row.seq);
    const answered = answers.get(row.seq);
    const withdrew = withdrawals.get(row.seq);
    return {
      seq: row.seq,
      author: authorOf(db, row.actor_id),
      created_at: formatTimestamp(row.created_at),
      live: row.live === 1,
      ...(row.replaced_by === null ? {} : { replaced_by: row.replaced_by }),
      ...(row.replaces_seq === null ? {} : { replaces: row.replaces_seq }),
      ...(row.text === null ? {} : { text: row.text }),
      ...(row.detail === null ? {} : { detail: row.detail }),
      ...(row.message_references === null
        ? {}
        : { references: JSON.parse(row.message_references) as Reference[] }),
      ...(row.topic === null ? {} : { topic: row.topic }),
      ...(own === undefined ? {} : { asks: own.map(toAsk) }),
      ...(answered === undefined ? {} : { answers: answered.map(toAnswer) }),
      ...(withdrew === undefined
        ? {}
        : { withdrawals: withdrew.map(({ ask, reason }) => ({ ask, reason })) }),
    };
  });
}

// pageOf splits rows read with one extra past the limit into a page and
// whether more follow.
export function pageOf<T>(rows: T[], limit: number): { rows: T[]; more: boolean } {
  return rows.length > limit ? { rows: rows.slice(0, limit), more: true } : { rows, more: false };
}
