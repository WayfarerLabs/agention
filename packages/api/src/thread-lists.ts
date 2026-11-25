import { z } from "zod";
import { cursor, pageLimit, queryBoolean, queryNumber } from "./bounds.ts";
import { branchShortForm, pullRequestShortForm } from "./code-links.ts";
import { singleLineText } from "./text.ts";
import { threadStatus, threadSummary, topic } from "./threads.ts";

// A session's lists of threads: its own thread list and its wait for unread
// messages, and the filters the operator's list takes as a session's does.

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
export const searchText = singleLineText({ min: 1, max: 200 });
export const titleSearchFilter = searchText.describe(
  "Only threads whose title holds every word of this text, each as the start of a word, " +
    "ignoring case and accents.",
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

// The threads with unread messages, and the position to wait from next.
export const waitResult = z.object({ threads: z.array(threadSummary), since: cursor });
export type WaitResult = z.infer<typeof waitResult>;
