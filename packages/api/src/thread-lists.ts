import { z } from "zod";
import {
  branchLink,
  branchShortForm,
  type CodeLink,
  parseBranch,
  parsePullRequest,
  pullRequestLink,
  pullRequestShortForm,
  shortFormKey,
} from "./code-links.ts";
import {
  askNumber,
  cursor,
  maxListed,
  pageLimit,
  queryBoolean,
  queryList,
  queryNumber,
  sequence,
  threadNumber,
} from "./bounds.ts";
import { groupId, groupRef, maxGroups, tagName } from "./groups-and-tags.ts";
import { name, sessionPathPattern, topicPathPattern } from "./names.ts";
import { type Presence, presence } from "./sessions.ts";
import { singleLineText } from "./text.ts";
import {
  cursors,
  effort,
  impact,
  marks,
  maxAnswers,
  type Priority,
  priority,
  type ThreadStatus,
  threadStatus,
  threadSummary,
  topic,
} from "./threads.ts";

// Lists of threads, and the marks that move many threads at once.

// A list holds the threads not archived for the caller: those it never
// archived, and those a later message from the other party brought back.
// Every other narrowing is a filter, each off unless turned on. Filters
// combine with AND; the values given for one that takes several combine with
// OR.

export const includeArchivedFilter = z
  .boolean()
  .default(false)
  .describe("Also list threads you archived that nothing new has brought back.");
// Search text, each word matched as the start of a word, ignoring case and
// accents. A session's list searches titles; the operator's searches what
// messages say too, since it reaches every session.
const searchText = singleLineText({ min: 1, max: 200 });
export const titleSearchFilter = searchText.describe(
  "Only threads whose title holds every word of this text, each as the start of a word, " +
    "ignoring case and accents.",
);
export const messageSearchFilter = searchText.describe(
  "Only threads whose title, or the text and detail of one of whose live messages, holds " +
    "every word of this text, each as the start of a word, ignoring case and accents.",
);
export const statusFilter = threadStatus.describe(
  "Only threads of this status, which rolls up the asks on their live messages and those a " +
    "live message withdraws: open while any is open; otherwise withdrawn when every one was " +
    "withdrawn, and answered when there are any; none when there are none.",
);
export const unreadFilter = z
  .boolean()
  .default(false)
  .describe(
    "Only threads with messages from the other party that you have neither read nor archived.",
  );
// The filters on an open ask's impact, priority and effort each take some of
// its levels, in the order the operator is offered them.
export const impactFilter = impact
  .extract(["blocking", "assuming"])
  .describe("Only threads holding an open ask with this impact.");
export const overdueFilter = z
  .boolean()
  .default(false)
  .describe("Only threads holding an open ask past its answer-by time.");
export const priorityFilter = priority
  .extract(["normal", "high", "urgent"])
  .describe("Only threads holding an open ask at this priority or higher.");
export const effortFilter = effort
  .extract(["quick", "under_15m", "under_1h"])
  .describe("Only threads holding an open ask that states this effort or less.");
export const agentReadFilter = z
  .enum(["unread", "stranded"])
  .describe(
    "Only threads holding a message of yours that the session has not read: unread for any " +
      "such thread, stranded for one nothing will bring to it soon: the session has no active " +
      "credential or is not connected; or it cannot be nudged, and is quiet or has stopped; or " +
      "it can be nudged, and the latest nudge since your message was not sent, or was sent " +
      "with no check-in within the quiet time, or none was sent within it.",
  );

// The filters on the pull requests and branches a thread's live messages
// name, which match an entry's repository ignoring case and its number or
// branch exactly.
export const pullRequestFilter = pullRequestShortForm.describe(
  "Only threads whose live messages name this pull request, as owner/name#number.",
);
export const branchFilter = branchShortForm.describe(
  "Only threads whose live messages name this branch, as owner/name:branch.",
);

// A session's threads, as its own agent lists them.
export const sessionThreadsQuery = z.object({
  include_archived: queryBoolean(includeArchivedFilter),
  search: titleSearchFilter.optional(),
  status: statusFilter.optional(),
  unread: queryBoolean(unreadFilter),
  topic: topic.optional(),
  pull_request: pullRequestFilter.optional(),
  branch: branchFilter.optional(),
  cursor: cursor.optional(),
  limit: queryNumber(pageLimit),
});
export type SessionThreadsQuery = z.infer<typeof sessionThreadsQuery>;

// The orders of the operator's list, each in its own direction, in the order
// the operator is offered them. priority, the default: threads with open asks
// first, by their most pressing ask, then the rest by latest message, newest
// first. due: threads with an open ask that has an answer-by first, soonest
// first, then the rest of those with open asks in priority order, then the
// others by latest message, newest first. effort: threads with an open ask
// that states an effort first, quickest first, then as due does. latest: every
// thread by its latest message, newest first. created: every thread by when it
// was created, newest first, which within a session is the order of its
// threads' numbers.
export const threadSort = z.enum(["priority", "due", "effort", "latest", "created"]);
export type ThreadSort = z.infer<typeof threadSort>;
export const defaultSort: ThreadSort = "priority";

// Reversing an order reverses the threads it ranks, and leaves those it does
// not rank after them, as they were: priority ranks the threads with open asks;
// due, those whose ask has an answer-by; effort, those whose ask states an
// effort; latest and created rank every thread.
export const reverseOrder = z
  .boolean()
  .default(false)
  .describe("Reverse the threads the order ranks, keeping those it does not rank after them.");

// A session as the operator's list names it, as agent/session.
export const sessionPath = z
  .string()
  .regex(sessionPathPattern, "must be agent/session, each 1 to 63 of a-z, 0-9, _ and -");

// A topic as the operator's list names it, with its session, as
// agent/session/topic.
export const topicPath = z
  .string()
  .regex(
    topicPathPattern,
    "must be agent/session/topic, each 1 to 63 of a-z, 0-9, _ and -, starting with a letter or " +
      "digit",
  );

// A filter of several values names each once.
function distinctValues<T extends z.ZodType<string[]>>(values: T) {
  return values.refine((list) => new Set(list).size === list.length, "names a value twice");
}

// The most agents, sessions and topics the list narrows to at once, of each.
export const maxNarrowed = 50;

export const agentsFilter = distinctValues(z.array(name).min(1).max(maxNarrowed)).describe(
  "Only threads of these agents.",
);
export const sessionsFilter = distinctValues(z.array(sessionPath).min(1).max(maxNarrowed)).describe(
  "Only threads of these sessions, each written agent/session.",
);
export const topicsFilter = distinctValues(z.array(topicPath).min(1).max(maxNarrowed)).describe(
  "Only threads on these topics, each written agent/session/topic.",
);

// No group, as a value of the group filter of its own.
export const noGroup = "none";

// The operator's session groups, each by its id, since a group can be renamed,
// and no group as none.
export const sessionGroupsFilter = z
  .array(z.union([z.literal(noGroup), queryNumber(groupId)]))
  .min(1)
  .max(maxNarrowed)
  .refine((list) => new Set(list).size === list.length, "names a value twice")
  .describe("Only threads of sessions in these groups, each by its id, or none for no group.");
export type SessionGroupsFilter = z.infer<typeof sessionGroupsFilter>;

// The operator's tags: a thread is kept when its session or its agent
// carries one.
export const tagsFilter = distinctValues(z.array(tagName).min(1).max(maxNarrowed)).describe(
  "Only threads whose session or agent carries one of these tags.",
);

// A filter of several pull requests or branches names each entry once, two
// short forms naming the same entry when their keys match.
function distinctEntries<T extends z.ZodType<string[]>>(
  values: T,
  parse: (text: string) => CodeLink | undefined,
) {
  return values.refine(
    (list) => new Set(list.map((text) => shortFormKey(text, parse))).size === list.length,
    "names an entry twice",
  );
}

// The pull requests and branches the operator's list narrows to, several of
// each, as the session's list takes one.
export const pullRequestsFilter = distinctEntries(
  z.array(pullRequestShortForm).min(1).max(maxNarrowed),
  parsePullRequest,
).describe(
  "Only threads whose live messages name one of these pull requests, each written " +
    "owner/name#number, its repository matched ignoring case.",
);
export const branchesFilter = distinctEntries(
  z.array(branchShortForm).min(1).max(maxNarrowed),
  parseBranch,
).describe(
  "Only threads whose live messages name one of these branches, each written " +
    "owner/name:branch, its repository matched ignoring case.",
);

// The operator's filters, across sessions: search, which reaches what
// messages say; status, unread and archived, as a session's list takes them;
// the properties of open asks, which one open ask must meet together; read
// by the session, unread or stranded; agents, sessions and topics, several
// of each, a topic named with its session; the operator's session groups
// and tags, several of each; and the pull requests and branches the threads'
// live messages name, several of each. They come in the order the operator
// is offered them, which a list's address in the web UI keeps.
const listFilters = {
  search: messageSearchFilter.optional(),
  status: statusFilter.optional(),
  priority: priorityFilter.optional(),
  impact: impactFilter.optional(),
  overdue: queryBoolean(overdueFilter),
  effort: effortFilter.optional(),
  unread: queryBoolean(unreadFilter),
  agent_read: agentReadFilter.optional(),
  agent: queryList(agentsFilter).optional(),
  session: queryList(sessionsFilter).optional(),
  topic: queryList(topicsFilter).optional(),
  session_group: queryList(sessionGroupsFilter).optional(),
  tag: queryList(tagsFilter).optional(),
  pull_request: queryList(pullRequestsFilter).optional(),
  branch: queryList(branchesFilter).optional(),
  include_archived: queryBoolean(includeArchivedFilter),
};

// How the operator's list may be grouped, in the order the operator is
// offered them: by session group, no group being one of its own, and within
// each by session; by session; by session, and within each by topic, threads
// without one under none; or by agent, and within each by session.
export const threadGrouping = z
  .enum(["session_group", "session", "topic", "agent"])
  .describe(
    "Group the list, each group's threads together: session_group by session group, then " +
      "session; session by session; topic by session, then topic; agent by agent, then " +
      "session. Only topic carries each session's topics in the roll-ups.",
  );
export type ThreadGrouping = z.infer<typeof threadGrouping>;

// The list's filters, which every query of the operator's list takes, and
// its counts alone, to count what each value of each would hold.
export const threadFilters = z.object(listFilters);
export type ThreadFilters = z.infer<typeof threadFilters>;

// The operator's one thread list as it is shown: every filter, in an order,
// perhaps reversed, perhaps grouped. It is the list's query without the page,
// and the web UI's address names a list by it.
export const threadsView = z.object({
  ...listFilters,
  sort: threadSort.default(defaultSort),
  reverse: queryBoolean(reverseOrder),
  group: threadGrouping.optional(),
});
export type ThreadsView = z.infer<typeof threadsView>;

// The operator's one thread list, a page at a time.
export const threadsQuery = threadsView.extend({
  cursor: cursor.optional(),
  limit: queryNumber(pageLimit),
});
export type ThreadsQuery = z.infer<typeof threadsQuery>;

// The filters on the properties of open asks, which one open ask must meet
// together.
const askFilters = ["priority", "impact", "overdue", "effort"] as const;
export type AskFilter = (typeof askFilters)[number];
type AskFilterValues = Pick<ThreadFilters, AskFilter>;

// Every filter on open asks off, as a change to a query that turns them off.
const filtersOff = threadFilters.parse({});
export const asksOff = Object.fromEntries(
  askFilters.map((filter) => [filter, filtersOff[filter]]),
) as AskFilterValues;

// asksOn names the filters on open asks a query turns on.
export const asksOn = (query: AskFilterValues): AskFilter[] =>
  askFilters.filter((filter) => query[filter] !== asksOff[filter]);

// keepsAsks says whether a query keeps only threads holding an open ask
// meeting its filters on open asks, as it does while any is on, so only open
// threads.
export const keepsAsks = (query: AskFilterValues): boolean => asksOn(query).length > 0;

// statusKept says which status a query keeps threads of: the one it names,
// or open while a filter on open asks is on.
export const statusKept = (
  query: AskFilterValues & Pick<ThreadFilters, "status">,
): ThreadStatus | undefined => query.status ?? (keepsAsks(query) ? "open" : undefined);

// How long a wait for an unread message lasts, in seconds: by default none,
// so a caller that leaves it out checks at once.
export const waitSeconds = z.number().int().min(0).max(25).default(0);

export const waitQuery = z.object({
  since: cursor.optional(),
  wait: queryNumber(waitSeconds),
  limit: queryNumber(pageLimit),
});
export type WaitQuery = z.infer<typeof waitQuery>;

// A page of threads; next, when present, continues the list.
export const threadPage = z.object({
  threads: z.array(threadSummary),
  next: cursor.optional(),
});
export type ThreadPage = z.infer<typeof threadPage>;

// listed bounds a list of agents, sessions or topics; what holds it says
// whether it left any out.
const listed = <T extends z.ZodType>(item: T) => z.array(item).max(maxListed);

// valueCounts counts a filter taking one of values: any, with it off, and
// each value.
function valueCounts<T extends string>(values: readonly T[]) {
  const each = Object.fromEntries(values.map((value) => [value, sequence]));
  return z.object({ any: sequence, ...(each as Record<T, typeof sequence>) });
}

// How many threads each value of each filter but search keeps with every
// other filter as it is, so the operator sees what a choice gives before
// making it; for a filter taking one value, that is what the list would hold
// with the value chosen. Any status, and every status but open, is counted
// with the properties of open asks off, as choosing it turns them off; a
// property's value is counted with status open, as choosing it chooses open,
// and its any with the status as it is. agent, session and topic list
// each one holding a thread, each with its own count whatever that filter's
// own choices are; threads without a topic are no value of topic. Each lists
// in name order: agents by name, sessions by their name then their agent's,
// topics by their session's name, their own, then their agent's.
// session_group lists each group holding a thread, in the operator's order, each with
// its own count whatever the group filter's choices are, and none counts the
// threads of sessions in no group likewise; tag lists each tag carried by a
// session holding a thread, or by its agent, in name order, likewise.
// pull_request and branch list each entry a live message of a thread names,
// with how many threads name it whatever that filter's own choices are, as
// its latest mention wrote it; since they gather without end, only those
// naming a thread the other filters keep, the most recently mentioned first.
// reset is what the list holds with no filter on.
export const threadCounts = z.object({
  status: valueCounts(threadStatus.options),
  priority: valueCounts(priorityFilter.options),
  impact: valueCounts(impactFilter.options),
  overdue: z.object({ any: sequence, overdue: sequence }),
  effort: valueCounts(effortFilter.options),
  unread: z.object({ any: sequence, unread: sequence }),
  agent_read: valueCounts(agentReadFilter.options),
  include_archived: z.object({ hide: sequence, show: sequence }),
  agent: z.object({
    agents: listed(z.object({ agent: name, total: sequence })),
    truncated: z.boolean(),
  }),
  session: z.object({
    sessions: listed(z.object({ agent: name, session: name, total: sequence })),
    truncated: z.boolean(),
  }),
  topic: z.object({
    topics: listed(z.object({ agent: name, session: name, topic: name, total: sequence })),
    truncated: z.boolean(),
  }),
  session_group: z.object({
    groups: z.array(groupRef.extend({ total: sequence })).max(maxGroups),
    none: sequence,
  }),
  tag: z.object({
    tags: listed(z.object({ tag: tagName, total: sequence })),
    truncated: z.boolean(),
  }),
  pull_request: z.object({
    pull_requests: listed(pullRequestLink.omit({ url: true }).extend({ total: sequence })),
    truncated: z.boolean(),
  }),
  branch: z.object({
    branches: listed(branchLink.omit({ url: true }).extend({ total: sequence })),
    truncated: z.boolean(),
  }),
  reset: sequence,
});
export type ThreadCounts = z.infer<typeof threadCounts>;

// What a group of the list holds, rolled up: how many threads; how many with
// unread messages; whether any holds a blocking ask open to the caller; the
// highest priority of an open ask; and whether every one is archived for the
// caller.
export const rollup = z.object({
  threads: sequence,
  unread: sequence,
  blocked: z.boolean(),
  priority: priority.optional(),
  archived: z.boolean(),
});
export type Rollup = z.infer<typeof rollup>;

// composeRollup rolls up the groups a group holds, from their own roll-ups:
// counts sum, blocked holds when any is, the priority is the highest, and
// archived holds when all are.
export function composeRollup(parts: readonly Rollup[]): Rollup {
  const rank = (each: Priority | undefined) =>
    each === undefined ? priority.options.length : priority.options.indexOf(each);
  const top = priority.options[Math.min(...parts.map((each) => rank(each.priority)))];
  return {
    threads: parts.reduce((sum, each) => sum + each.threads, 0),
    unread: parts.reduce((sum, each) => sum + each.unread, 0),
    blocked: parts.some((each) => each.blocked),
    ...(top === undefined ? {} : { priority: top }),
    archived: parts.every((each) => each.archived),
  };
}

// composePresence gives an agent's presence from its sessions': quiet when
// every one is, last seen when the latest was, connected when any is, and
// not connected only when every one says it is not. A session whose bridge
// predates monitoring says neither, and may be running, so beside one the
// agent says neither too, unless another session is connected.
export function composePresence(parts: readonly Presence[]): Presence {
  const seen = parts.flatMap((each) =>
    each.last_seen_at === undefined ? [] : [each.last_seen_at],
  );
  const latest = seen.reduce<string | undefined>(
    (best, each) => (best === undefined || Date.parse(each) > Date.parse(best) ? each : best),
    undefined,
  );
  const connected = parts.some((each) => each.connected === true)
    ? true
    : parts.length > 0 && parts.every((each) => each.connected === false)
      ? false
      : undefined;
  return {
    ...(latest === undefined ? {} : { last_seen_at: latest }),
    quiet: parts.every((each) => each.quiet),
    ...(connected === undefined ? {} : { connected }),
  };
}

// The roll-ups of a grouped list: each session holding a thread the list
// keeps, with its group when it is in one, its roll-up, its presence and,
// grouped by topic, its topics' roll-ups, the threads without a topic under
// none, in the order of the groups. An agent's roll-up and presence compose
// from its sessions', and a group's roll-up from its sessions'. It lists at
// most maxListed sessions, and as many topics in all, the first in order,
// and says when it leaves any out.
export const threadGroups = z.object({
  sessions: listed(
    z.object({
      agent: name,
      session: name,
      group: groupRef.optional(),
      rollup,
      presence,
      topics: listed(z.object({ topic: name.optional(), rollup })).optional(),
    }),
  ),
  truncated: z.boolean(),
});
export type ThreadGroups = z.infer<typeof threadGroups>;

// A thread as the operator's list shows it, with its session's group when it
// is in one.
export const listedThread = threadSummary.extend({ group: groupRef.optional() });

// The operator's thread list: a page, each thread with its session's group
// when it is in one; how many threads the list holds; and, grouped, the
// roll-ups of its groups. A grouped list orders its threads by their group,
// then by the sort, so a group's threads arrive together, each group placed
// by its first thread under the sort: by session group, each session's
// group, no group being one of its own, and each session within it; by
// session, each session; by topic, each session, and each topic within it;
// by agent, each agent, and each session within it. as_of is where the list
// stands among every message, which an action on the threads matching its
// filters is bounded by.
export const threadList = threadPage.extend({
  threads: z.array(listedThread),
  total: sequence,
  groups: threadGroups.optional(),
  as_of: cursor.describe(
    "The position, among every message, of the latest message when the list was read. An " +
      "action on every thread matching the list's filters takes it, so it acts on nothing " +
      "newer.",
  ),
});
export type ThreadList = z.infer<typeof threadList>;

// The rows just above and below a thread in the operator's list, as the list
// with the same filters, order, direction and grouping shows them, the thread
// standing at its own place in that order though the filters would leave it
// out. Neither is there at that end of the list.
export const threadNeighbors = z.object({
  above: listedThread.optional(),
  below: listedThread.optional(),
});
export type ThreadNeighbors = z.infer<typeof threadNeighbors>;

// The threads with unread messages, and the position to wait from next.
export const waitResult = z.object({ threads: z.array(threadSummary), since: cursor });
export type WaitResult = z.infer<typeof waitResult>;

// The operator's wait, across every session: since is a position in every
// session's messages at once, which no session's own wait gives out.
export const operatorWaitQuery = z.object({
  since: cursor
    .optional()
    .describe(
      "The since of the last answer, to be told only of messages newer than those it covered. " +
        "Without it, or with one past every message, every thread with unread messages counts.",
    ),
  wait: queryNumber(waitSeconds).describe(
    "How many seconds to wait for an unread message when none is there yet, 0 to answer at once.",
  ),
  limit: queryNumber(pageLimit).describe("The most threads one answer holds."),
});
export type OperatorWaitQuery = z.infer<typeof operatorWaitQuery>;

export const operatorWaitResult = z.object({
  threads: z
    .array(threadSummary)
    .describe(
      "The threads, in any session, whose latest message is newer than since and that hold " +
        "messages from the agent you have neither read nor archived, oldest activity first. " +
        "Empty when the wait ended with none.",
    ),
  since: cursor.describe(
    "The position to wait from next: pass it as since, and no message this answer covered " +
      "wakes you again. When the answer holds limit threads, it continues with those left out.",
  ),
});
export type OperatorWaitResult = z.infer<typeof operatorWaitResult>;

const threadTarget = z.object({ agent: name, session: name, thread: threadNumber });

// Many threads marked at once, each through the message the list showed, so a
// message that arrived since stays unread and keeps its thread out of the archive.
export const bulkMarkInput = z.object({
  threads: z
    .array(threadTarget.extend({ through: sequence }))
    .min(1)
    .max(100),
});
export type BulkMarkInput = z.infer<typeof bulkMarkInput>;

export const bulkReadResult = z.object({ threads: z.array(threadTarget.extend({ cursors })) });
export type BulkReadResult = z.infer<typeof bulkReadResult>;

// Bulk archive skips each thread holding an ask open to the caller, naming
// the asks by number, and archives the rest.
export const bulkArchiveResult = z.object({
  archived: z.array(threadTarget.extend({ marks })),
  skipped: z.array(threadTarget.extend({ open_asks: z.array(sequence) })),
});
export type BulkArchiveResult = z.infer<typeof bulkArchiveResult>;

// What the operator does to many threads at once, the same to each.
export const threadAction = z
  .enum(["read", "unread", "read_and_archive", "decline_read_and_archive"])
  .describe(
    "read marks each thread read through its message; unread marks it unread from the latest " +
      "live message of the other party at or before that message, leaving out a thread with " +
      "none; read_and_archive marks it read and archives it through that message, keeping " +
      "out each thread holding an ask open to you at or before it; decline_read_and_archive " +
      "first declines every ask open to you at or before that message, in messages of yours " +
      `holding at most ${maxAnswers} answers each, then marks it read and archives it through ` +
      "the last of them, keeping out a thread holding such an ask and a newer message, which " +
      "you have not seen.",
  );
export type ThreadAction = z.infer<typeof threadAction>;

// The most threads one action reaches, named one by one or matching filters.
export const maxActionThreads = 500;

// A thread an action names, through the latest message the caller saw of it.
const actedThread = threadTarget.extend({ through: sequence.min(1) });

// One action on threads named one by one, each through the message the list
// showed, each named once.
export const threadActionInput = z.object({
  action: threadAction,
  threads: z
    .array(actedThread)
    .min(1)
    .max(maxActionThreads)
    .refine(
      (threads) =>
        new Set(threads.map(({ agent, session, thread }) => `${agent}/${session}/${thread}`))
          .size === threads.length,
      "names a thread twice",
    )
    .describe(
      "The threads, each once and through the latest message you saw of it. A message that " +
        "arrived since stays unread and keeps its thread out of the archive.",
    ),
});
export type ThreadActionInput = z.infer<typeof threadActionInput>;

// One action on every thread the list's filters keep, as of the position the
// list answered with: each thread through its latest message at or before
// that position, leaving out a thread with none, so what arrived since the
// list was read is not acted on unseen, and a retry reaches the same messages.
// Which threads the filters keep is decided as it runs, and it acts only when
// they number as many as the caller expected, since a thread can come to
// match without a new message.
export const matchingThreadActionInput = z.object({
  action: threadAction,
  filters: threadFilters.describe(
    "The thread list's filters, as listing threads takes them. The action reaches every " +
      `thread they keep when it runs, and is refused when that is more than ${maxActionThreads}.`,
  ),
  as_of: cursor.describe(
    "The as_of of the thread list you acted from. Each thread is acted on only through its " +
      "latest message at or before it, and a thread with none is left out.",
  ),
  expected: sequence.describe(
    "How many threads you chose to act on: the list's total as you saw it. The action is " +
      "refused as stale, acting on none, when the threads it would act on number otherwise, " +
      "so read the list again and choose again.",
  ),
});
export type MatchingThreadActionInput = z.infer<typeof matchingThreadActionInput>;

// What an action on threads did: the threads it applied to, the asks it
// declined, and the threads it kept out of the archive.
export const threadActionResult = z.object({
  acted: z
    .array(threadTarget)
    .describe(
      "The threads the action applied to: marked, or marked and archived. A thread unread " +
        "leaves out has no message of the other party to mark unread from.",
    ),
  declined: z
    .array(threadTarget.extend({ asks: z.array(askNumber) }))
    .describe("For decline_read_and_archive, each thread whose asks it declined, and those asks."),
  kept: z
    .array(threadTarget.extend({ open_asks: z.array(askNumber) }))
    .describe(
      "The threads left as they were, each with the asks open to you that kept it: for " +
        "read_and_archive, those holding one; for decline_read_and_archive, those holding one " +
        "and a message newer than the one acted through.",
    ),
});
export type ThreadActionResult = z.infer<typeof threadActionResult>;
