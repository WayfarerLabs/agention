import type {
  BulkArchiveResult,
  BulkMarkInput,
  BulkReadResult,
  Cursors,
  CursorsResult,
  MarkInput,
  Marks,
  MarksResult,
  UnreadInput,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import { invalidInput } from "../errors.ts";
import { authorizeScope, type Identity } from "../identity.ts";
import { statusOnWrite } from "./sessions.ts";
import type { Store } from "./store.ts";
import { marksOf, partyCursors } from "./thread-reads.ts";
import {
  authorizeSession,
  raiseReadMark,
  requireThread,
  type StoredThread,
  type ThreadTarget,
} from "./threads.ts";

// Marking read, marking unread and archiving move only the caller's own marks
// on a thread. They write no message, so none of them conflicts with a write,
// and they wake no one. Each is a write to the thread all the same, so a
// session's own marks it working while idle (statusOnWrite).

// checkThrough refuses a mark beyond the thread's latest message.
export function checkThrough(thread: StoredThread, through: number, field?: string): void {
  if (through > thread.last_seq) {
    throw invalidInput(
      field === undefined ? "through" : `${field}.through`,
      "is beyond the thread's latest message",
    );
  }
}

// readThrough raises the identity's read cursor on a thread of an authorized
// session, inside the caller's transaction, and returns both parties' cursors.
// field names the thread in errors, when it is one of several.
function readThrough(
  db: Database,
  identity: Identity,
  sessionId: number,
  number: number,
  through: number,
  field?: string,
): Cursors {
  const thread = requireThread(db, sessionId, number, field);
  checkThrough(thread, through, field);
  raiseReadMark(db, identity.actor, thread.id, through);
  return partyCursors(db, thread);
}

// markRead raises the identity's read cursor to through; it never lowers it.
export function markRead(
  store: Store,
  identity: Identity,
  target: ThreadTarget,
  input: MarkInput,
): CursorsResult {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:write", target, now);
    const cursors = readThrough(db, identity, sessionId, target.thread, input.through);
    statusOnWrite(db, identity, sessionId, {}, now);
    return { cursors };
  });
}

// lowerReadMark lowers an actor's read cursor on a thread to just before the
// message it starts from; it never raises it.
export function lowerReadMark(db: Database, actor: number, threadId: number, from: number) {
  db.prepare(
    `UPDATE thread_marks SET read_seq = :seq
     WHERE actor_id = :actor AND thread_id = :thread AND read_seq > :seq`,
  ).run({ seq: from - 1, actor, thread: threadId });
}

// markUnread lowers the identity's read cursor to just before the message it
// starts from, so that message and every later one by another actor are
// unread again. It never raises the cursor, so it cannot claim a message the
// identity has not seen.
export function markUnread(
  store: Store,
  identity: Identity,
  target: ThreadTarget,
  input: UnreadInput,
): CursorsResult {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:write", target, now);
    const thread = requireThread(db, sessionId, target.thread);
    if (input.from > thread.last_seq) {
      throw invalidInput("from", "is beyond the thread's latest message");
    }
    lowerReadMark(db, identity.actor, thread.id, input.from);
    statusOnWrite(db, identity, sessionId, {}, now);
    return { cursors: partyCursors(db, thread) };
  });
}

// openAsksThrough lists the numbers of the asks open to the identity, as the
// thread's audience, on messages at or before through.
export function openAsksThrough(
  db: Database,
  identity: Identity,
  thread: StoredThread,
  through: number,
): number[] {
  if (identity.actor !== thread.audience_actor_id) {
    return [];
  }
  const rows = db
    .prepare("SELECT number FROM open_asks WHERE thread_id = ? AND seq <= ? ORDER BY number")
    .all(thread.id, through) as { number: number }[];
  return rows.map((row) => row.number);
}

// archiveThrough finds a thread of an authorized session and archives it
// through a message (archiveFound). field names the thread in errors, when it
// is one of several.
function archiveThrough(
  db: Database,
  identity: Identity,
  sessionId: number,
  number: number,
  through: number,
  field?: string,
): { marks: Marks } | { openAsks: number[] } {
  const thread = requireThread(db, sessionId, number, field);
  checkThrough(thread, through, field);
  return archiveFound(db, identity, thread, through);
}

// archiveFound raises the identity's archive mark on a thread found already
// to through, at most its latest message, carried on over the identity's own
// messages that directly follow it, or, when an ask open to it sits at or
// before through, archives nothing and returns those asks. Carried on,
// archiving through the last message another party wrote archives the thread
// though the identity replied since.
export function archiveFound(
  db: Database,
  identity: Identity,
  thread: StoredThread,
  through: number,
): { marks: Marks } | { openAsks: number[] } {
  const openAsks = openAsksThrough(db, identity, thread, through);
  if (openAsks.length > 0) {
    return { openAsks };
  }
  const { carried } = db
    .prepare(
      `SELECT COALESCE(
         (SELECT min(seq) - 1 FROM messages WHERE thread_id = ? AND seq > ? AND actor_id <> ?),
         ?
       ) AS carried`,
    )
    .get(thread.id, through, identity.actor, thread.last_seq) as { carried: number };
  db.prepare(
    `INSERT INTO thread_marks (actor_id, thread_id, archived_seq) VALUES (?, ?, ?)
     ON CONFLICT (actor_id, thread_id) DO UPDATE
       SET archived_seq = max(archived_seq, excluded.archived_seq)`,
  ).run(identity.actor, thread.id, carried);
  return { marks: marksOf(db, identity.actor, thread.id) };
}

// archiveThread raises the identity's archive mark to through, carried on over
// the identity's own messages that directly follow it; it never lowers it. A
// thread is archived while the mark reaches its latest message, so a later
// message from another party brings it back out of the archive. It is refused
// while an ask open to the identity sits at or before through, so the
// audience answers or declines first; since an answer is never retracted and
// every new ask arrives after the mark, a thread holding an ask open to the
// identity is never archived for it.
export function archiveThread(
  store: Store,
  identity: Identity,
  target: ThreadTarget,
  input: MarkInput,
): MarksResult {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:write", target, now);
    const outcome = archiveThrough(db, identity, sessionId, target.thread, input.through);
    if ("openAsks" in outcome) {
      const [number] = outcome.openAsks;
      throw invalidInput(
        "through",
        `ask ${number} is open to you; answer or decline it before archiving`,
      );
    }
    statusOnWrite(db, identity, sessionId, {}, now);
    return outcome;
  });
}

// bulkRead marks several threads read in one transaction, each through the
// message given: every one or, when any fails, none.
export function bulkRead(store: Store, identity: Identity, input: BulkMarkInput): BulkReadResult {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    authorizeScope(db, identity, "threads:write", now);
    return {
      threads: input.threads.map((target, index) => {
        const field = `threads.${index}`;
        const sessionId = authorizeSession(db, identity, "threads:write", target, now, field);
        const cursors = readThrough(db, identity, sessionId, target.thread, target.through, field);
        return { agent: target.agent, session: target.session, thread: target.thread, cursors };
      }),
    };
  });
}

// bulkArchive archives several threads in one transaction, each through the
// message given, and skips each thread holding an ask open to the identity at
// or before it, naming the asks by number. Any other refusal archives none.
export function bulkArchive(
  store: Store,
  identity: Identity,
  input: BulkMarkInput,
): BulkArchiveResult {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    authorizeScope(db, identity, "threads:write", now);
    const result: BulkArchiveResult = { archived: [], skipped: [] };
    input.threads.forEach((target, index) => {
      const field = `threads.${index}`;
      const sessionId = authorizeSession(db, identity, "threads:write", target, now, field);
      const outcome = archiveThrough(db, identity, sessionId, target.thread, target.through, field);
      const named = { agent: target.agent, session: target.session, thread: target.thread };
      if ("openAsks" in outcome) {
        result.skipped.push({ ...named, open_asks: outcome.openAsks });
      } else {
        result.archived.push({ ...named, marks: outcome.marks });
      }
    });
    return result;
  });
}
