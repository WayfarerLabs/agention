import {
  agentReadFilter,
  type AskFilter,
  asksOff,
  asksOn,
  composeRollup,
  defaultSort,
  effortFilter,
  formatTimestamp,
  type GroupRef,
  impactFilter,
  keepsAsks,
  maxListed,
  noGroup,
  priority,
  priorityFilter,
  type Rollup,
  type SessionThreadsQuery,
  type ThreadCounts,
  type ThreadFilters,
  threadFilters,
  type ThreadGrouping,
  type ThreadGroups,
  type ThreadList,
  type ThreadPage,
  type ThreadSort,
  type ThreadSummary,
  type ThreadsQuery,
  threadStatus,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import { authorizeScope, type Identity, sessionScope } from "../identity.ts";
import { decodeCursor, encodeCursor } from "./opaque-cursors.ts";
import type { Store } from "./store.ts";
import {
  askOrder,
  effortRank,
  type Lead,
  noAnswerBy,
  pageOf,
  priorityRank,
  type ThreadRow,
  threadsSeen,
  toThreadSummary,
  type ViewerAndCutoff,
  viewerAndCutoff,
} from "./thread-reads.ts";
import { authorizeSession, type SessionTarget } from "./threads.ts";

// Every list is a query over the threads as the viewer sees them (seen, read
// as th), kept by the parts its query sets, then ordered. One definition of
// each part serves the list, its total, the counts of its filters' values and
// its groups.

// The tags each session carries, its own and its agent's, each once.
const carriedTags = `(
  SELECT session_id, name FROM session_tags
  UNION SELECT s.id, a.name FROM agent_tags a JOIN sessions s ON s.agent_id = a.agent_id
)`;

// A part of a list: which threads it keeps, over seen as th, and whether a
// list's filters turn it on.
interface Part {
  keeps: string;
  on: (query: ThreadFilters) => boolean;
}

// Search keeps the threads whose title holds every word of the search, or,
// searching what messages say too, those one of whose live messages does in
// its text and detail together. A replaced message's words stay in the
// index, which keeps no copy of them, so its rows join the live messages.
const searching = (query: ThreadFilters) => query.search !== undefined;
const titleSearch = "th.id IN (SELECT rowid FROM thread_titles WHERE thread_titles MATCH :search)";
const messageSearch = `th.id IN (
  SELECT message_texts.thread_id FROM message_texts
  JOIN live_messages l ON l.thread_id = message_texts.thread_id AND l.seq = message_texts.seq
  WHERE message_texts MATCH :search
)`;

// The parts of the operator's list. A list keeps the threads not archived for
// the viewer unless it includes archived ones, and each filter that is on
// adds its own part. While any filter on asks is on, it keeps the threads
// leading with an open ask, which only an ask meeting every one of them can
// be, and so only open threads.
const listParts = {
  not_archived: { keeps: "NOT th.archived", on: (query) => !query.include_archived },
  search: { keeps: `${titleSearch} OR ${messageSearch}`, on: searching },
  status: { keeps: "th.status = :status", on: (query) => query.status !== undefined },
  unread: { keeps: "th.unread > 0", on: (query) => query.unread },
  // A live message by the viewer beyond the other party's read mark, and for
  // stranded, while the session is quiet, has no active credential or has
  // stopped.
  agent_read: {
    keeps: "IIF(:agent_read = 'stranded', th.stranded, th.unread_by_other)",
    on: (query) => query.agent_read !== undefined,
  },
  agent: {
    keeps: "th.agent_name IN (SELECT value FROM json_each(:agent))",
    on: (query) => query.agent !== undefined,
  },
  session: {
    keeps: "th.agent_name || '/' || th.session_name IN (SELECT value FROM json_each(:session))",
    on: (query) => query.session !== undefined,
  },
  topic: {
    keeps: `th.agent_name || '/' || th.session_name || '/' || th.topic
      IN (SELECT value FROM json_each(:topic))`,
    on: (query) => query.topic !== undefined,
  },
  // A session in no group counts as in the group 0, which no group's id is.
  session_group: {
    keeps: "COALESCE(th.group_id, 0) IN (SELECT value FROM json_each(:session_group))",
    on: (query) => query.session_group !== undefined,
  },
  tag: {
    keeps: `th.session_id IN (
      SELECT session_id FROM ${carriedTags} WHERE name IN (SELECT value FROM json_each(:tag))
    )`,
    on: (query) => query.tag !== undefined,
  },
  asks: { keeps: "th.lead_number IS NOT NULL", on: keepsAsks },
} satisfies Record<string, Part>;

type Parts = Record<keyof typeof listParts, Part>;

// The parts of a session's list, which its agent reads: its search stays on
// titles.
const sessionParts: Parts = { ...listParts, search: { keeps: titleSearch, on: searching } };

// What each filter on asks keeps of open asks, over open_asks as o, at the
// value the query binds for it.
const askKeeps: Record<AskFilter, string> = {
  priority: `${priorityRank("o.priority")} <= ${priorityRank(":priority")}`,
  impact: "o.impact = :impact",
  overdue: "o.answer_by < :now",
  effort: `${effortRank("o.effort")} <= ${effortRank(":effort")}`,
};

// The filters with none on.
const unfiltered = threadFilters.parse({});

// where is the condition a query's list keeps threads by: that of every part
// its filters turn on, of the operator's list unless the parts given are
// another's.
function where(query: ThreadFilters, parts: Parts = listParts): string {
  const on: Part[] = Object.values(parts).filter((part) => part.on(query));
  return on.length === 0 ? "1" : on.map((part) => `(${part.keeps})`).join(" AND ");
}

// askConditions is what an open ask must meet for the filters on asks.
function askConditions(filters: readonly AskFilter[]): string {
  return filters.length === 0 ? "1" : filters.map((filter) => askKeeps[filter]).join(" AND ");
}

// The order a thread's open asks are taken in to find the one it leads with,
// over open_asks as o, for each order of the list: due puts asks with an
// answer-by first, soonest first; effort those stating an effort first,
// quickest first; and then, as for the others, the most pressing first.
const leadOrders: Record<ThreadSort, string> = {
  priority: askOrder,
  due: `o.answer_by IS NULL, o.answer_by, ${askOrder}`,
  effort: `o.effort IS NULL, ${effortRank("o.effort")}, ${askOrder}`,
  latest: askOrder,
  created: askOrder,
};

// leadOf says which open ask a thread leads with: of the asks a query's
// filters on asks keep, the first in the order's own. Reversing the order
// changes no thread's lead.
function leadOf(query: ThreadFilters, sort: ThreadSort): Lead {
  return { keeps: askConditions(asksOn(query)), order: leadOrders[sort] };
}

// ftsQuery writes search text as a full-text query that holds no syntax of
// its own: each word, split on white space, quoted as a prefix term, and all
// of them required. The search filter refuses text without a character other
// than white space, so the query holds a word: one with none is a syntax
// error to the full-text index.
export function ftsQuery(text: string): string {
  return text
    .split(/\s+/u)
    .filter((word) => word !== "")
    .map((word) => `"${word.replaceAll('"', '""')}"*`)
    .join(" ");
}

type Parameters = Record<string, string | number | null>;

// The threads a list reaches, over threads as t: those of every session the
// viewer reaches, bound by sessionScope; or those of one session.
export const reached =
  "(:all_sessions = 1 OR t.session_id IN (SELECT value FROM json_each(:session_ids)))";
const inSession = "t.session_id = :session_id";

// parametersOf gives the values a query's parts and filters bind, beside the
// viewer and the quiet cut-off, and the time, which overdue compares answer-by
// times with.
function parametersOf(query: ThreadFilters, viewing: ViewerAndCutoff, now: number): Parameters {
  return {
    ...viewing,
    now,
    search: query.search === undefined ? null : ftsQuery(query.search),
    status: query.status ?? null,
    agent_read: query.agent_read ?? null,
    priority: query.priority ?? null,
    impact: query.impact ?? null,
    effort: query.effort ?? null,
    agent: JSON.stringify(query.agent ?? []),
    session: JSON.stringify(query.session ?? []),
    topic: JSON.stringify(query.topic ?? []),
    session_group: JSON.stringify(
      (query.session_group ?? []).map((group) => (group === noGroup ? 0 : group)),
    ),
    tag: JSON.stringify(query.tag ?? []),
  };
}

// listStatement prepares one of a list's statements. Each takes every
// parameter a list binds, of which it names only those its query's parts
// and filters use, so it allows the others; every other statement keeps
// node:sqlite's refusal of a parameter it does not name.
function listStatement(db: Database, sql: string) {
  const statement = db.prepare(sql);
  statement.setAllowUnknownNamedParameters(true);
  return statement;
}

// The order of a list is one tuple of keys per thread, ascending, so a page
// ends at a position the next continues after. Its first key is the thread's
// tier: 0 for the threads the order ranks, which come first; 1 for those
// leading with an open ask that it does not rank; and 2 for the rest. The
// keys after it are the tier's own. Ties break on the thread's number, and
// across sessions first on the session, so a session's own list gives out
// positions that say nothing about any other. Overdue follows from answer-by
// and is no key of its own, so pages never shift as time passes.

// The slots for the keys after a thread's tier, over ranked: room for the
// longest tier's keys, due's and effort's.
const slots = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"] as const;

// A tier's keys, at most one for each slot, so the types refuse an order
// with more keys than a position holds.
type KeysFor<Slots extends readonly string[]> = { readonly [Slot in keyof Slots]?: string };
type TierKeys = KeysFor<typeof slots>;

// A thread's own keys, over ranked, in order: its tier, then the tier's own.
const keys = ["k0", ...slots] as const;
const listOrder = keys.join(", ");

// The keys of a thread leading with an open ask, in the priority order of
// asks: by that ask's priority, then blocking first, then earliest answer-by
// (none last), then oldest, ties oldest first.
const pressing = (session: string) =>
  [
    "lead_priority_rank",
    "1 - lead_blocking",
    `COALESCE(lead_answer_by, ${noAnswerBy})`,
    "lead_since",
    session,
    "number",
  ] as const;

// The keys of a thread by its latest message, newest first, ties newest
// first.
const latestFirst = (session: string): TierKeys => ["-updated_at", `-${session}`, "-number"];

// What each order ranks, over seen, and the keys it ranks those threads by,
// in its own direction. priority ranks the threads leading with an open ask;
// due, those whose lead ask has an answer-by, soonest first; effort, those
// whose lead ask states an effort, quickest first; latest, every thread by
// its latest message; and created, every thread by its row id, newest first.
// A thread's row id is one past the largest when it is created, so it keeps
// the order of creation whatever the clock did, and within a session that is
// the order of the threads' numbers, which are given out the same way. It
// is unique, so it needs no tie.
const orders: Record<ThreadSort, { ranks: string; keys: (session: string) => TierKeys }> = {
  priority: { ranks: "lead_number IS NOT NULL", keys: pressing },
  due: {
    ranks: "lead_answer_by IS NOT NULL",
    keys: (session) => ["lead_answer_by", ...pressing(session)],
  },
  effort: {
    ranks: "lead_effort_rank IS NOT NULL",
    keys: (session) => ["lead_effort_rank", ...pressing(session)],
  },
  latest: { ranks: "1", keys: latestFirst },
  created: { ranks: "1", keys: () => ["-id"] },
};

// ranked orders the threads of seen: first those the order ranks, by its keys,
// each negated when it is reversed, so reversing reverses them, ties
// included; then those leading with an open ask it does not rank, in priority
// order; then the rest by latest message, newest first. Reversing moves
// neither of the last two.
function ranked(sort: ThreadSort, reverse: boolean, bySession: boolean): string {
  const session = bySession ? "session_id" : "0";
  const { ranks, keys: ranking } = orders[sort];
  const tiers = [
    ranking(session).map((key) => (reverse ? `-(${key})` : key)),
    pressing(session),
    latestFirst(session),
  ];
  const keyed = slots.map(
    (slot, index) =>
      `CASE k0 ${tiers.map((tier, t) => `WHEN ${t} THEN ${tier[index] ?? "0"}`).join(" ")} END
        AS ${slot}`,
  );
  return `
  ranked AS (
    SELECT tiered.*, ${keyed.join(", ")}
    FROM (
      SELECT seen.*,
        CASE WHEN ${ranks} THEN 0 WHEN lead_number IS NOT NULL THEN 1 ELSE 2 END AS k0
      FROM seen
    ) tiered
  )`;
}

// The levels each grouping groups its threads by, over ranked as th,
// outermost first, each by what partitions its groups: by session group, the
// session's group, no group being one of its own, then the session, then its
// topic; by session, the session, then its topic; by agent, the agent, then
// its session. A session sits in at most one group and belongs to one agent,
// so it settles the levels above it.
// Each level is numbered from the outermost, 0, which names its keys.
type Level = 0 | 1 | 2;
const levelsOf: Record<ThreadGrouping, readonly { level: Level; partition: string }[]> = {
  session_group: [
    { level: 0, partition: "th.group_id" },
    { level: 1, partition: "th.session_id" },
    { level: 2, partition: "th.session_id, th.topic" },
  ],
  session: [
    { level: 0, partition: "th.session_id" },
    { level: 1, partition: "th.session_id, th.topic" },
  ],
  agent: [
    { level: 0, partition: "th.agent_name" },
    { level: 1, partition: "th.agent_name, th.session_id" },
  ],
};

// A grouped list orders its threads by the group they are in at each level,
// outermost first, then by their own keys. A group's place is its first
// thread's keys. As a moved thread does in the flat list, a change that moves
// a group ahead of a page's cursor skips that group's remaining threads for
// the rest of that pass, and one that moves it behind repeats them; the next
// load from the first page shows the list whole.
type ThreadKey = (typeof keys)[number];
type OrderKey = ThreadKey | `level${Level}_${ThreadKey}`;
const levelKeys = (level: Level) => keys.map((key) => `level${level}_${key}` as const);

// The keys a list orders its threads by, grouped or not.
const keysOf = (grouping: ThreadGrouping | undefined): readonly OrderKey[] =>
  grouping === undefined
    ? keys
    : [...levelsOf[grouping].flatMap(({ level }) => levelKeys(level)), ...keys];

// placing selects the threads a query keeps, over ranked as th, with the
// places of their groups when grouped.
function placing(query: ThreadFilters, parts: Parts, grouping: ThreadGrouping | undefined): string {
  if (grouping === undefined) {
    return `SELECT th.* FROM ranked th WHERE ${where(query, parts)}`;
  }
  const levels = levelsOf[grouping];
  const firsts = levels.flatMap(({ level }) =>
    keys.map((key) => `first_value(th.${key}) OVER level${level} AS level${level}_${key}`),
  );
  const windows = levels.map(
    ({ level, partition }) => `level${level} AS (PARTITION BY ${partition} ORDER BY ${listOrder})`,
  );
  return `SELECT th.*, ${firsts.join(", ")}
    FROM ranked th WHERE ${where(query, parts)}
    WINDOW ${windows.join(", ")}`;
}

type RankedRow = ThreadRow & Record<OrderKey, number>;

interface PageQuery<T> {
  // Which threads, over threads as t, and whether they span sessions.
  scope: string;
  bySession: boolean;
  parameters: Parameters;
  query: ThreadFilters;
  // The parts the list keeps its threads by.
  parts: Parts;
  sort: ThreadSort;
  reverse: boolean;
  grouping?: ThreadGrouping | undefined;
  cursor: string | undefined;
  limit: number;
  // What the list shows of each thread.
  describe: (row: ThreadRow, now: number) => T;
}

// pageThreads reads a page of the threads a query keeps, in order. A cursor
// is a position in that order, tagged with the order, its direction and the
// grouping, so one from another is refused.
function pageThreads<T>(
  db: Database,
  now: number,
  page: PageQuery<T>,
): { threads: T[]; next?: string } {
  const direction = page.reverse ? "reversed" : "own";
  const tag = `threads.${page.sort}.${direction}.${page.grouping ?? "flat"}`;
  const order = keysOf(page.grouping);
  const position =
    page.cursor === undefined
      ? undefined
      : decodeCursor(tag, page.cursor, Array(order.length).fill("number"), "cursor");
  const rows = listStatement(
    db,
    `${threadsSeen(page.scope, leadOf(page.query, page.sort))}, ${ranked(page.sort, page.reverse, page.bySession)},
     kept AS (${placing(page.query, page.parts, page.grouping)})
     SELECT * FROM kept
     WHERE :after = 0 OR (${order.join(", ")}) > (${order.map((key) => `:${key}`).join(", ")})
     ORDER BY ${order.join(", ")}
     LIMIT :limit`,
  ).all({
    ...page.parameters,
    after: position === undefined ? 0 : 1,
    ...Object.fromEntries(order.map((key, index) => [key, position?.[index] ?? 0])),
    limit: page.limit + 1,
  }) as unknown as RankedRow[];
  const { rows: shown, more } = pageOf(rows, page.limit);
  const last = shown.at(-1);
  return {
    threads: shown.map((row) => page.describe(row, now)),
    ...(more && last !== undefined
      ? {
          next: encodeCursor(
            tag,
            order.map((key) => last[key]),
          ),
        }
      : {}),
  };
}

// listSessionThreads pages through one session's threads, as its agent lists
// them, most pressing first.
export function listSessionThreads(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  { topic, ...query }: SessionThreadsQuery,
): ThreadPage {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:read", target, now);
    // The filters a session's list does not take stay off, and its topic is
    // the session's own.
    const filters: ThreadFilters = {
      ...unfiltered,
      ...query,
      topic: topic === undefined ? undefined : [`${target.agent}/${target.session}/${topic}`],
    };
    return pageThreads(db, now, {
      scope: inSession,
      bySession: false,
      parameters: {
        ...parametersOf(filters, viewerAndCutoff(store, identity.actor, now), now),
        session_id: sessionId,
      },
      query: filters,
      parts: sessionParts,
      sort: defaultSort,
      reverse: false,
      cursor: query.cursor,
      limit: query.limit,
      describe: toThreadSummary,
    });
  });
}

// What a list's statements need besides its query: the database, the viewer
// and the quiet cut-off, the time, and the sessions the viewer reaches.
interface Reach {
  db: Database;
  viewing: ViewerAndCutoff;
  now: number;
  scope: Parameters;
}

// reachOf is what a list's statements need for the identity, now.
function reachOf(store: Store, identity: Identity, now: number): Reach {
  return {
    db: store.db,
    viewing: viewerAndCutoff(store, identity.actor, now),
    now,
    scope: sessionScope(identity),
  };
}

// totalOf counts the threads a query's list holds, across every session the
// viewer reaches.
function totalOf(reach: Reach, query: ThreadFilters): number {
  const { total } = listStatement(
    reach.db,
    `${threadsSeen(reached, leadOf(query, defaultSort))}
     SELECT count(*) AS total FROM seen th WHERE ${where(query)}`,
  ).get({ ...reach.scope, ...parametersOf(query, reach.viewing, reach.now) }) as { total: number };
  return total;
}

// countUnreadThreads counts the threads the operator's list holds with only
// Unread on: those not archived for the viewer that hold an unread message.
// The caller runs it in its transaction, having authorized the identity.
export function countUnreadThreads(store: Store, identity: Identity, now: number): number {
  return totalOf(reachOf(store, identity, now), { ...unfiltered, unread: true });
}

// listThreads pages through the threads of every session the identity
// reaches that the filters keep, in the order the query names, reversed when
// it says so, and grouped when it names a grouping. Beside the page it counts
// the threads the list holds and, grouped, rolls up every group.
export function listThreads(store: Store, identity: Identity, query: ThreadsQuery): ThreadList {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    authorizeScope(db, identity, "threads:read", now);
    const reach = reachOf(store, identity, now);
    const page = pageThreads(db, now, {
      scope: reached,
      bySession: true,
      parameters: { ...reach.scope, ...parametersOf(query, reach.viewing, now) },
      query,
      parts: listParts,
      sort: query.sort,
      reverse: query.reverse,
      grouping: query.group,
      cursor: query.cursor,
      limit: query.limit,
      describe: withGroup,
    });
    const total = totalOf(reach, query);
    return {
      ...page,
      total,
      ...(query.group === undefined ? {} : { groups: rollUpGroups(reach, query, query.group) }),
    };
  });
}

// withGroup describes a thread as the operator's list shows it, with its
// session's group when it is in one.
function withGroup(row: ThreadRow, now: number): ThreadSummary & { group?: GroupRef } {
  return {
    ...toThreadSummary(row, now),
    ...(row.group_id === null ? {} : { group: { id: row.group_id, name: row.group_name ?? "" } }),
  };
}

// listedOf keeps the first maxListed rows of those read with one extra,
// saying whether it left any out.
function listedOf<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, maxListed), truncated: rows.length > maxListed };
}

// countThreads counts, for each value of each filter but search, the threads
// it keeps with every other filter as it is. Each value of a filter taking
// one is counted by the list's own total with that value chosen, so one rule
// says what the list keeps. Agents, sessions, topics, groups and tags are each
// counted in one statement, grouped by them, with that filter's own condition
// off: every agent, session, topic and group holding a thread, no group
// among them, and every tag a session holding a thread or its agent carries.
// Each lists at most maxListed, in name order, and says when it leaves any
// out; there are never more groups than that.
export function countThreads(store: Store, identity: Identity, query: ThreadFilters): ThreadCounts {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    authorizeScope(db, identity, "threads:read", now);
    const reach = reachOf(store, identity, now);
    const parameters = {
      ...reach.scope,
      ...parametersOf(query, reach.viewing, now),
      listed: maxListed + 1,
    };
    const total = (change: Partial<ThreadFilters>) => totalOf(reach, { ...query, ...change });
    // each counts every value of a filter, as the change choosing it says.
    const each = <V extends string>(
      values: readonly V[],
      choosing: (value: V) => Partial<ThreadFilters>,
    ) =>
      Object.fromEntries(values.map((value) => [value, total(choosing(value))])) as Record<
        V,
        number
      >;

    // Each agent and session holding a thread, with the threads it keeps.
    const agents = listedOf(
      listStatement(
        db,
        `${threadsSeen(reached, leadOf(query, defaultSort))}
         SELECT th.agent_name AS agent,
           count(*) FILTER (WHERE ${where({ ...query, agent: undefined })}) AS total
         FROM seen th GROUP BY th.agent_name ORDER BY th.agent_name LIMIT :listed`,
      ).all(parameters) as { agent: string; total: number }[],
    );
    const sessions = listedOf(
      listStatement(
        db,
        `${threadsSeen(reached, leadOf(query, defaultSort))}
         SELECT th.agent_name AS agent, th.session_name AS session,
           count(*) FILTER (WHERE ${where({ ...query, session: undefined })}) AS total
         FROM seen th GROUP BY th.agent_name, th.session_name
         ORDER BY th.session_name, th.agent_name LIMIT :listed`,
      ).all(parameters) as { agent: string; session: string; total: number }[],
    );
    // Each topic holding a thread, with the threads it keeps.
    const topics = listedOf(
      listStatement(
        db,
        `${threadsSeen(reached, leadOf(query, defaultSort))}
         SELECT th.agent_name AS agent, th.session_name AS session, th.topic,
           count(*) FILTER (WHERE ${where({ ...query, topic: undefined })}) AS total
         FROM seen th WHERE th.topic IS NOT NULL
         GROUP BY th.agent_name, th.session_name, th.topic
         ORDER BY th.session_name, th.topic, th.agent_name LIMIT :listed`,
      ).all(parameters) as { agent: string; session: string; topic: string; total: number }[],
    );
    // Each group holding a thread, no group among them, with the threads it
    // keeps.
    const groups = listStatement(
      db,
      `${threadsSeen(reached, leadOf(query, defaultSort))}
       SELECT th.group_id AS id, th.group_name AS name,
         count(*) FILTER (WHERE ${where({ ...query, session_group: undefined })}) AS total
       FROM seen th GROUP BY th.group_id ORDER BY th.group_name, th.group_id`,
    ).all(parameters) as { id: number | null; name: string | null; total: number }[];
    // Each tag a session holding a thread carries, or its agent does, with
    // the threads it keeps.
    const tags = listedOf(
      listStatement(
        db,
        `${threadsSeen(reached, leadOf(query, defaultSort))}
         SELECT carried.name AS tag,
           count(*) FILTER (WHERE ${where({ ...query, tag: undefined })}) AS total
         FROM seen th JOIN ${carriedTags} carried ON carried.session_id = th.session_id
         GROUP BY carried.name ORDER BY carried.name LIMIT :listed`,
      ).all(parameters) as { tag: string; total: number }[],
    );

    // Choosing a status other than open turns the filters on open asks off,
    // and choosing a value of one of them chooses open.
    const statusChosen = (status: ThreadFilters["status"]) =>
      status === "open" ? { status } : { status, ...asksOff };
    const askChosen = (change: Partial<ThreadFilters>) => ({ ...change, status: "open" as const });
    return {
      status: {
        any: total(statusChosen(undefined)),
        ...each(threadStatus.options, statusChosen),
      },
      priority: {
        any: total({ priority: undefined }),
        ...each(priorityFilter.options, (priority) => askChosen({ priority })),
      },
      impact: {
        any: total({ impact: undefined }),
        ...each(impactFilter.options, (impact) => askChosen({ impact })),
      },
      overdue: {
        any: total({ overdue: false }),
        overdue: total(askChosen({ overdue: true })),
      },
      effort: {
        any: total({ effort: undefined }),
        ...each(effortFilter.options, (effort) => askChosen({ effort })),
      },
      unread: { any: total({ unread: false }), unread: total({ unread: true }) },
      agent_read: {
        any: total({ agent_read: undefined }),
        ...each(agentReadFilter.options, (agent_read) => ({ agent_read })),
      },
      include_archived: {
        hide: total({ include_archived: false }),
        show: total({ include_archived: true }),
      },
      agent: { agents: agents.rows, truncated: agents.truncated },
      session: { sessions: sessions.rows, truncated: sessions.truncated },
      topic: { topics: topics.rows, truncated: topics.truncated },
      session_group: {
        groups: groups.flatMap(({ id, name, total }) =>
          id === null ? [] : [{ id, name: name ?? "", total }],
        ),
        none: groups.find((group) => group.id === null)?.total ?? 0,
      },
      tag: { tags: tags.rows, truncated: tags.truncated },
      reset: totalOf(reach, unfiltered),
    };
  });
}

interface GroupRow {
  agent: string;
  session: string;
  group_id: number | null;
  group_name: string | null;
  topic: string | null;
  threads: number;
  unread: number;
  blocked: number;
  priority_rank: number | null;
  archived: number;
  last_seen_at: number | null;
  quiet: number;
  // The place of the group's first thread in the list.
  place: number;
}

// rollUpGroups rolls up each session holding a thread the list keeps and,
// grouped by session group or by session, each of its topics: how many
// threads, how many with unread messages, whether any holds a blocking ask
// open to the viewer, the highest priority of an open ask, and whether all
// are archived for the viewer; each session also carries its presence and its
// group. Groups come in the grouped list's order, each placed by its first
// thread: by session group, the groups, the sessions within each, and the
// topics within each session; by session, the sessions, and the topics
// within each; by agent, the agents, and the sessions within each. It lists
// the first maxListed sessions, and as many topics in all, and says when it
// leaves any out.
function rollUpGroups(reach: Reach, query: ThreadsQuery, grouping: ThreadGrouping): ThreadGroups {
  const byTopic = grouping !== "agent";
  const rows = listStatement(
    reach.db,
    `${threadsSeen(reached, leadOf(query, query.sort))}, ${ranked(query.sort, query.reverse, true)}
     SELECT th.agent_name AS agent, th.session_name AS session,
       th.group_id, th.group_name,
       ${byTopic ? "th.topic" : "NULL"} AS topic,
       count(*) AS threads,
       count(*) FILTER (WHERE th.unread > 0) AS unread,
       max(th.ask_blocking AND t.audience_actor_id = :viewer) AS blocked,
       min(th.ask_priority_rank) AS priority_rank,
       min(th.archived) AS archived,
       max(th.last_seen_at) AS last_seen_at,
       max(th.quiet) AS quiet,
       min(th.place) AS place
     FROM (SELECT ranked.*, row_number() OVER (ORDER BY ${listOrder}) AS place FROM ranked) th
     JOIN threads t ON t.id = th.id
     WHERE ${where(query)}
     GROUP BY th.agent_name, th.session_name${byTopic ? ", th.topic" : ""}`,
  ).all({
    ...reach.scope,
    ...parametersOf(query, reach.viewing, reach.now),
  }) as unknown as GroupRow[];
  // What holds each session: by session group, its group, no group being one
  // of its own; by agent, its agent; by session, nothing above it.
  const holders: Record<ThreadGrouping, (row: GroupRow) => string> = {
    session_group: (row) => `group:${row.group_id ?? ""}`,
    session: () => "",
    agent: (row) => `agent:${row.agent}`,
  };
  const holder = holders[grouping];
  const sessions = new Map<string, { holder: string; place: number; topics: GroupRow[] }>();
  const holderPlaces = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.agent}/${row.session}`;
    const session = sessions.get(key) ?? { holder: holder(row), place: row.place, topics: [] };
    session.place = Math.min(session.place, row.place);
    session.topics.push(row);
    sessions.set(key, session);
    holderPlaces.set(
      session.holder,
      Math.min(holderPlaces.get(session.holder) ?? row.place, row.place),
    );
  }
  const holderPlace = (session: { holder: string }) => holderPlaces.get(session.holder) ?? 0;
  const ordered = [...sessions.values()].sort(
    (a, b) => holderPlace(a) - holderPlace(b) || a.place - b.place,
  );
  let topicsLeft = maxListed;
  let truncated = ordered.length > maxListed;
  const listed = ordered.slice(0, maxListed).map(({ topics }) => {
    const byPlace = topics.sort((a, b) => a.place - b.place);
    const [first] = byPlace;
    const session = {
      agent: first?.agent ?? "",
      session: first?.session ?? "",
      ...(first === undefined || first.group_id === null
        ? {}
        : { group: { id: first.group_id, name: first.group_name ?? "" } }),
      rollup: composeRollup(byPlace.map(rollupOf)),
      presence: {
        ...(first === undefined || first.last_seen_at === null
          ? {}
          : { last_seen_at: formatTimestamp(first.last_seen_at) }),
        quiet: first?.quiet === 1,
      },
    };
    if (!byTopic) {
      return session;
    }
    const kept = byPlace.slice(0, Math.max(topicsLeft, 0));
    topicsLeft -= kept.length;
    truncated ||= kept.length < byPlace.length;
    return {
      ...session,
      topics: kept.map((row) => ({
        ...(row.topic === null ? {} : { topic: row.topic }),
        rollup: rollupOf(row),
      })),
    };
  });
  return { sessions: listed, truncated };
}

function rollupOf(row: GroupRow): Rollup {
  const top = row.priority_rank === null ? undefined : priority.options[row.priority_rank];
  return {
    threads: row.threads,
    unread: row.unread,
    blocked: row.blocked === 1,
    ...(top === undefined ? {} : { priority: top }),
    archived: row.archived === 1,
  };
}
