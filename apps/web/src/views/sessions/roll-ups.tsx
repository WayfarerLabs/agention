import type { SessionSummary, ThreadsView } from "@wayfarerlabs/agention-api";
import { plural } from "../../format.tsx";
import { FilterLink, type Scope, UnreadLink } from "../filter-links.tsx";

// What the sessions view shows of the sessions under a session's row, an
// agent's header or a group's head: their threads' roll-up, as the thread
// list's headers show theirs (how many threads and the envelope with how many
// are unread), and their unread updates as a mark of their own, so the
// envelope means unread threads everywhere. Whether any is blocked on the
// operator shows once, as Blocked on you, beside a row's and an agent's open
// asks, and on a group's head, which has none. Every mark that stands for
// threads links to them on the thread list, narrowed to the threads of what
// it sits on and the mark's own filter, with no other filter on: the count
// to them all, the envelope to the unread, Blocked on you to those blocking
// on an ask, and the open asks to the open threads. The unread updates stand
// for the log, not for threads.

// What sessions hold, rolled up: how many threads the operator has not
// archived, how many of those hold messages they have not read, whether any
// blocking ask is open in them, and how many log entries they have not read.
export interface SessionsRollup {
  threads: number;
  unread: number;
  blocked: boolean;
  unread_updates: number;
}

// rollupOfSession is a session's roll-up, from its summary.
export function rollupOfSession(session: SessionSummary): SessionsRollup {
  return {
    threads: session.threads.total,
    unread: session.threads.unread,
    blocked: session.open_asks.blocking_count > 0,
    unread_updates: session.unread_updates,
  };
}

// composeSessions rolls up sessions from their summaries: counts sum and
// blocked holds when any is.
export function composeSessions(sessions: readonly SessionSummary[]): SessionsRollup {
  const parts = sessions.map(rollupOfSession);
  return {
    threads: parts.reduce((sum, each) => sum + each.threads, 0),
    unread: parts.reduce((sum, each) => sum + each.unread, 0),
    blocked: parts.some((each) => each.blocked),
    unread_updates: parts.reduce((sum, each) => sum + each.unread_updates, 0),
  };
}

// OpenAsksLink flags how many asks are open on the operator, in the
// attention tone, linking to the open threads.
export function OpenAsksLink({ count, narrowing, label, list }: Scope & { count: number }) {
  const asks = plural(count, "open ask");
  return (
    <FilterLink
      narrowing={{ ...narrowing, status: "open" }}
      spoken={`${asks} of ${label}`}
      list={list}
    >
      <span className="flag attention">{asks}</span>
    </FilterLink>
  );
}

// SessionsRollupMarks shows a roll-up's marks on a header, its threads' count
// aside, which ThreadsLink shows, and blocked aside: the envelope and the
// unread updates.
export function SessionsRollupMarks({ rollup, ...scope }: Scope & { rollup: SessionsRollup }) {
  return (
    <>
      <UnreadLink unread={rollup.unread} {...scope} />
      {rollup.unread_updates > 0 && (
        <span className="flag accent">{plural(rollup.unread_updates, "new update")}</span>
      )}
    </>
  );
}

// ThreadsLink opens the thread list narrowed to the threads a roll-up holds,
// with no other filter, saying how many it holds, or only "Threads" while
// that is not known.
export function ThreadsLink({
  rollup,
  narrowing,
  label,
}: {
  rollup: SessionsRollup | undefined;
  narrowing: Partial<ThreadsView>;
  // What the link's threads are of, for assistive technology, such as
  // "builder".
  label: string;
}) {
  const shown = rollup === undefined ? "Threads" : plural(rollup.threads, "thread");
  return (
    <FilterLink className="threads-link" narrowing={narrowing} spoken={`${shown} of ${label}`}>
      {shown}
    </FilterLink>
  );
}

// AgentReadLink opens the thread list on the stranded threads, or the
// ignored ones, among those a ThreadsLink beside it opens, flagging how many
// there are, such as "2 stranded", or only "Stranded" while that is not
// known, as a ThreadsLink does.
export function AgentReadLink({
  read,
  count,
  narrowing,
  label,
}: {
  // Which threads it opens on, as the thread list's filter names them.
  read: "stranded" | "ignored";
  // How many there are, or undefined while that is not known, as when
  // sessions were left out.
  count: number | undefined;
  // The narrowing of the ThreadsLink beside it.
  narrowing: Partial<ThreadsView>;
  // What the link's threads are of, as a ThreadsLink's label is.
  label: string;
}) {
  const named = `${read.charAt(0).toUpperCase()}${read.slice(1)}`;
  const [shown, spoken] =
    count === undefined
      ? [named, `${named} threads`]
      : [`${count} ${read}`, plural(count, `${read} thread`)];
  return (
    <FilterLink
      className="agent-read-link"
      narrowing={{ ...narrowing, agent_read: read }}
      spoken={`${spoken} of ${label}`}
    >
      <span className="flag warning">{shown}</span>
    </FilterLink>
  );
}
