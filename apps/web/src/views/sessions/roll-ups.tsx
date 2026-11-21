import type { SessionSummary, ThreadsView } from "@wayfarerlabs/agention-api";
import { plural } from "../../format.tsx";
import { UnreadCount } from "../../icons.tsx";
import { Link, listHref, unfiltered } from "../../router.tsx";

// What the sessions view shows of the sessions under a session's row, an
// agent's header or a group's head: their threads' roll-up, as the thread
// list's headers show theirs (how many threads and the envelope with how many
// are unread), with a link to those threads on the thread list, and their
// unread updates as a mark of their own, so the envelope means unread threads
// everywhere. Whether any is blocked on the operator shows once, in the
// thread list's words: a row's and an agent's open asks say it, and a
// group's head, which has none, shows Blocked on you.

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

// rollupWords says a roll-up for assistive technology, after what it heads,
// blocked aside: "3 threads, 1 unread, 2 new updates".
export function rollupWords(rollup: SessionsRollup): string[] {
  return [
    plural(rollup.threads, "thread"),
    ...(rollup.unread > 0 ? [`${rollup.unread} unread`] : []),
    ...(rollup.unread_updates > 0 ? [plural(rollup.unread_updates, "new update")] : []),
  ];
}

// openAsksWords says what open asks wait on the operator, in the thread
// list's words, for the eye and for assistive technology: "Blocked on you"
// first while any blocks its agent's work, then how many are open.
export function openAsksWords(count: number, blocking: boolean): string[] {
  return [...(blocking ? ["Blocked on you"] : []), plural(count, "open ask")];
}

// OpenAsksFlag shows open asks in those words, in the danger tone while any
// blocks, as the thread list's Blocked on you does, and the attention tone
// otherwise.
export function OpenAsksFlag({ count, blocking }: { count: number; blocking: boolean }) {
  return (
    <span className={blocking ? "flag danger" : "flag attention"}>
      {openAsksWords(count, blocking).join(" · ")}
    </span>
  );
}

// SessionsRollupMarks shows a roll-up's marks for the eye, its threads' count
// aside, which ThreadsLink shows, and blocked aside: the envelope and the
// unread updates.
export function SessionsRollupMarks({ rollup }: { rollup: SessionsRollup }) {
  return (
    <>
      <UnreadCount unread={rollup.unread} />
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
    <Link
      className="threads-link"
      to={listHref({ ...unfiltered, ...narrowing })}
      aria-label={`${shown} of ${label}`}
    >
      {shown}
    </Link>
  );
}

// StrandedLink opens the thread list on the stranded threads among those a
// ThreadsLink beside it opens, flagging how many there are, or only
// "Stranded" while that is not known, as a ThreadsLink does.
export function StrandedLink({
  stranded,
  narrowing,
  label,
}: {
  // How many are stranded, or undefined while that is not known, as when
  // sessions were left out.
  stranded: number | undefined;
  // The narrowing of the ThreadsLink beside it.
  narrowing: Partial<ThreadsView>;
  // What the link's threads are of, as a ThreadsLink's label is.
  label: string;
}) {
  const [shown, spoken] =
    stranded === undefined
      ? ["Stranded", "Stranded threads"]
      : [`${stranded} stranded`, plural(stranded, "stranded thread")];
  return (
    <Link
      className="stranded-link"
      to={listHref({ ...unfiltered, ...narrowing, agent_read: "stranded" })}
      aria-label={`${spoken} of ${label}`}
    >
      <span className="flag warning">{shown}</span>
    </Link>
  );
}
