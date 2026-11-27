import {
  type MatchingThreadActionInput,
  maxActionThreads,
  type ThreadAction,
  type ThreadActionInput,
  type ThreadActionResult,
} from "@wayfarerlabs/agention-server-api";
import type { Database } from "../database/database.ts";
import { ApiError, invalidInput } from "../errors.ts";
import { authorizeScope, type Identity } from "../identity.ts";
import { archiveFound, checkThrough, lowerReadMark, openAsksThrough } from "./marks.ts";
import type { Store } from "./store.ts";
import { matchingThreads, readAsOf } from "./thread-lists.ts";
import {
  authorizeSession,
  declineAsks,
  raiseReadMark,
  requireThread,
  type StoredThread,
} from "./threads.ts";

// The operator's actions on many threads at once: marking them read or
// unread, archiving them, and declining their asks first. Each call is one
// transaction, so its threads are acted on together or, when any is refused,
// none is. Each thread is acted on through one message: on threads named one
// by one, the latest the list showed; on the threads matching filters, the
// latest at or before the list's as_of. Nothing newer is acted on, so marks
// leave newer messages unread, and declining, which writes a message, is
// done only on a thread with nothing newer, so it answers only asks the
// operator could see. Those declines are the one write that states no
// latest-seen and carries a request id the server makes, the exception ADR
// 0001 records; the sessions written to wake once the call commits.

type Target = ThreadActionInput["threads"][number];
type Named = ThreadActionResult["acted"][number];

// What a call is acting with: the database inside its transaction, the
// caller, the time, what it has done so far, and the sessions its declines
// wrote to.
interface Acting {
  db: Database;
  identity: Identity;
  now: number;
  done: ThreadActionResult;
  written: Set<number>;
}

// archiveAndRead archives a thread through a message, keeping out a thread
// holding an ask open to the caller at or before it, and marks the thread it
// archives read through that message too.
function archiveAndRead(acting: Acting, thread: StoredThread, named: Named, through: number): void {
  const { db, identity, done } = acting;
  const outcome = archiveFound(db, identity, thread, through);
  if ("openAsks" in outcome) {
    done.kept.push({ ...named, open_asks: outcome.openAsks });
    return;
  }
  raiseReadMark(db, identity.actor, thread.id, through);
  done.acted.push(named);
}

// unreadFrom finds the message marking a thread unread starts from: the
// latest live message of another party at or before through, if any.
function unreadFrom(
  db: Database,
  identity: Identity,
  thread: StoredThread,
  through: number,
): number | undefined {
  const { from } = db
    .prepare(
      `SELECT max(seq) AS "from" FROM live_messages
       WHERE thread_id = ? AND seq <= ? AND actor_id <> ?`,
    )
    .get(thread.id, through, identity.actor) as { from: number | null };
  return from ?? undefined;
}

// actOn does the action to one thread. field names the thread in errors,
// when the caller named it.
function actOn(acting: Acting, action: ThreadAction, target: Target, field?: string): void {
  const { db, identity, now, done } = acting;
  const sessionId = authorizeSession(db, identity, "threads:write", target, now, field);
  const thread = requireThread(db, sessionId, target.thread, field);
  checkThrough(thread, target.through, field);
  const named = { agent: target.agent, session: target.session, thread: target.thread };
  switch (action) {
    case "read":
      raiseReadMark(db, identity.actor, thread.id, target.through);
      done.acted.push(named);
      return;
    case "unread": {
      const from = unreadFrom(db, identity, thread, target.through);
      if (from !== undefined) {
        lowerReadMark(db, identity.actor, thread.id, from);
        done.acted.push(named);
      }
      return;
    }
    case "read_and_archive":
      archiveAndRead(acting, thread, named, target.through);
      return;
    case "decline_read_and_archive": {
      const asks = openAsksThrough(db, identity, thread, target.through);
      if (asks.length === 0) {
        archiveAndRead(acting, thread, named, target.through);
        return;
      }
      // A message the caller has not seen could change what it would
      // decline, and writing would read it, so the thread stays as it is.
      if (thread.last_seq > target.through) {
        done.kept.push({ ...named, open_asks: asks });
        return;
      }
      const seq = declineAsks(db, identity, thread, asks, now);
      acting.written.add(sessionId);
      done.declined.push({ ...named, asks });
      archiveAndRead(acting, { ...thread, last_seq: seq }, named, seq);
      return;
    }
  }
}

// act runs one call's actions in a transaction, having authorized the
// caller, and wakes the sessions its declines wrote to once it commits.
function act(store: Store, identity: Identity, each: (acting: Acting) => void): ThreadActionResult {
  const { db } = store;
  const acting = db.transaction(() => {
    const now = store.clock();
    authorizeScope(db, identity, "threads:write", now);
    const started: Acting = {
      db,
      identity,
      now,
      done: { acted: [], declined: [], kept: [] },
      written: new Set(),
    };
    each(started);
    return started;
  });
  for (const sessionId of acting.written) {
    store.notifier.notify(sessionId);
  }
  return acting.done;
}

// actOnThreads does one action to each thread named, through the message
// given for it.
export function actOnThreads(
  store: Store,
  identity: Identity,
  input: ThreadActionInput,
): ThreadActionResult {
  return act(store, identity, (acting) => {
    input.threads.forEach((target, index) => {
      actOn(acting, input.action, target, `threads.${index}`);
    });
  });
}

// actOnMatchingThreads does one action to every thread the operator's list
// keeps with the filters given, each through its latest message at or before
// the list's as_of, leaving out a thread with none, so a retry reaches the same
// messages. Which threads the filters keep is decided as it runs: a thread can
// come to match without a new message, as when a deadline passes or a tag
// changes, so it is refused as stale, acting on none, when they number other
// than the caller expected, and as invalid_input when they number more than
// maxActionThreads. The deadline, tag, pull request, and branch filters read
// state as it is, not as of as_of (the links of a message sent or replaced
// since then count as they are now), so the expected count catches a change in
// how many threads match, but not one thread trading places with another.
export function actOnMatchingThreads(
  store: Store,
  identity: Identity,
  input: MatchingThreadActionInput,
): ThreadActionResult {
  const position = readAsOf(input.as_of, "as_of");
  return act(store, identity, (acting) => {
    const matched = matchingThreads(
      store,
      identity,
      input.filters,
      position,
      acting.now,
      maxActionThreads,
    );
    if (matched.length > maxActionThreads) {
      throw invalidInput(
        "filters",
        `keep more than ${maxActionThreads} threads; narrow them, or act on fewer at a time`,
      );
    }
    if (matched.length !== input.expected) {
      throw new ApiError(
        "stale",
        `the filters keep ${matched.length} threads, not the ${input.expected} expected; ` +
          "read the list again and choose again",
        { field: "expected" },
      );
    }
    for (const target of matched) {
      actOn(acting, input.action, target);
    }
  });
}
