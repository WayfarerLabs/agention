import {
  type AgentMessageSendInput,
  type Ask,
  type Answer,
  type Attachment,
  pageLimit,
  parseTimestamp,
  type Reference,
  type ThreadCreateInput,
  type ThreadGetQuery,
  type ThreadGetResult,
  type Withdrawal,
  type WriteResult,
  type WriteStatus,
} from "@wayfarerlabs/agention-api";
import { type Scope, type ThreadStartInput } from "@wayfarerlabs/agention-server-api";
import type { Database } from "../database/database.ts";
import { ApiError, invalidInput, notAllowed, notFound } from "../errors.ts";
import { authorize, type Identity } from "../identity.ts";
import {
  checkAttachments,
  insertAttachments,
  type ResolvedAttachment,
  threadFileTotals,
} from "./attachments.ts";
import { findOperator, resolveSession, sessionActorId } from "./directory.ts";
import { writeDigest } from "./digest.ts";
import { statusOnWrite } from "./sessions.ts";
import type { Store } from "./store.ts";
import { marksOf, partyCursors, readMessages, readThread } from "./thread-reads.ts";

// Store operations take inputs their schema has already parsed, so bounds and
// shape are checked before any transaction opens. Each write reads the clock
// and authorizes inside its transaction, then runs its checks in a fixed
// order: replay of a request id, roles, staleness, then the rules that depend
// on the thread's messages, the files it attaches last. A write that lands
// then applies what it says of its session's status (statusOnWrite), in the
// same transaction, so a write that fails changes no status. A replay changes
// nothing: the write it repeats applied its status with it.

export interface SessionTarget {
  agent: string;
  session: string;
}

export interface ThreadTarget extends SessionTarget {
  thread: number;
}

// The messages a stale write returns, at most a default page; a writer that
// missed more is stale again on its next attempt and sees the rest.
const missedLimit = pageLimit.parse(undefined);

// authorizeSession resolves a session target and authorizes the identity for
// it with the scope the operation requires, so an unknown session and someone
// else's look the same.
export function authorizeSession(
  db: Database,
  identity: Identity,
  scope: Scope,
  target: SessionTarget,
  now: number,
  field?: string,
): number {
  const sessionId = resolveSession(db, target.agent, target.session);
  return authorize(db, identity, scope, sessionId, now, field);
}

export interface StoredThread {
  id: number;
  session_id: number;
  number: number;
  requester_actor_id: number;
  audience_actor_id: number;
  last_seq: number;
}

export function findThread(
  db: Database,
  sessionId: number,
  number: number,
): StoredThread | undefined {
  return db
    .prepare(
      `SELECT id, session_id, number, requester_actor_id, audience_actor_id, last_seq
       FROM threads WHERE session_id = ? AND number = ?`,
    )
    .get(sessionId, number) as unknown as StoredThread | undefined;
}

// requireThread finds a thread of an authorized session, or fails as
// not_found, naming field when the thread is one of several.
export function requireThread(
  db: Database,
  sessionId: number,
  number: number,
  field?: string,
): StoredThread {
  const thread = findThread(db, sessionId, number);
  if (thread === undefined) {
    throw notFound(field);
  }
  return thread;
}

function credentialOf(identity: Identity): number | null {
  return identity.credential.kind === "registration" ? identity.credential.registrationId : null;
}

// Replay: an earlier message by the same actor with the same request id is the
// same write when its digest matches, and a conflict otherwise. The same write
// answers with its original result, which names only that message.
function replayed(
  db: Database,
  actor: number,
  requestId: string,
  digest: Uint8Array,
): WriteResult | undefined {
  const prior = db
    .prepare(
      `SELECT m.seq, m.digest, t.number
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.actor_id = ? AND m.request_id = ?`,
    )
    .get(actor, requestId) as { seq: number; digest: Uint8Array; number: number } | undefined;
  if (prior === undefined) {
    return undefined;
  }
  if (!Buffer.from(prior.digest).equals(digest)) {
    throw new ApiError(
      "request_id_conflict",
      "this request id was already used for a different write",
      { field: "request_id" },
    );
  }
  return { number: prior.number, seq: prior.seq };
}

// The parts a message carries.
interface Parts {
  text?: string | undefined;
  detail?: string | undefined;
  references?: Reference[] | undefined;
  attachments?: Attachment[] | undefined;
  asks?: Ask[] | undefined;
  answers?: Answer[] | undefined;
  withdrawals?: Withdrawal[] | undefined;
  topic?: string | undefined;
  replaces?: number | undefined;
}

// raiseReadMark moves an actor's read cursor on a thread forward to through;
// it never moves back.
export function raiseReadMark(db: Database, actor: number, threadId: number, through: number) {
  db.prepare(
    `INSERT INTO thread_marks (actor_id, thread_id, read_seq) VALUES (?, ?, ?)
     ON CONFLICT (actor_id, thread_id) DO UPDATE
       SET read_seq = max(read_seq, excluded.read_seq)`,
  ).run(actor, threadId, through);
}

// keepArchived moves an actor's archive mark on a thread to its own new
// message when the thread was archived for it, so writing keeps a thread
// archived. A thread is archived while the mark reaches its latest message,
// which before this one was seq - 1.
function keepArchived(db: Database, actor: number, threadId: number, seq: number) {
  db.prepare(
    `UPDATE thread_marks SET archived_seq = :seq
     WHERE actor_id = :actor AND thread_id = :thread AND archived_seq > 0
       AND archived_seq = :seq - 1`,
  ).run({ seq, actor, thread: threadId });
}

// appendMessage writes a message at the thread's next sequence and the
// session's next position, with its asks, numbered on from the thread's
// highest, its answers, its withdrawals and its attachments, which marks
// each file it names attached, and moves the writer's read
// cursor to it: a writer has read through its own message. A writer for whom
// the thread is archived keeps it archived. Its caller's transaction holds it
// all, so a message and its rows land together or not at all.
function appendMessage(
  db: Database,
  thread: { id: number; session_id: number },
  seq: number,
  identity: Identity,
  write: {
    requestId: string;
    digest: Uint8Array;
    parts: Parts;
    attachments: ResolvedAttachment[];
    now: number;
  },
): void {
  const { parts } = write;
  const { last_pos: position } = db
    .prepare("UPDATE sessions SET last_pos = last_pos + 1 WHERE id = ? RETURNING last_pos")
    .get(thread.session_id) as { last_pos: number };
  db.prepare(
    `INSERT INTO messages (thread_id, seq, session_id, session_pos, actor_id, registration_id,
       created_at, request_id, digest, text, detail, message_references, replaces_seq, topic)
     VALUES (:thread_id, :seq, :session_id, :session_pos, :actor_id, :registration_id,
       :created_at, :request_id, :digest, :text, :detail, :message_references, :replaces_seq,
       :topic)`,
  ).run({
    thread_id: thread.id,
    seq,
    session_id: thread.session_id,
    session_pos: position,
    actor_id: identity.actor,
    registration_id: credentialOf(identity),
    created_at: write.now,
    request_id: write.requestId,
    digest: write.digest,
    text: parts.text ?? null,
    detail: parts.detail ?? null,
    message_references: parts.references === undefined ? null : JSON.stringify(parts.references),
    replaces_seq: parts.replaces ?? null,
    topic: parts.topic ?? null,
  });
  if (parts.asks !== undefined) {
    const { highest } = db
      .prepare("SELECT COALESCE(MAX(number), 0) AS highest FROM asks WHERE thread_id = ?")
      .get(thread.id) as { highest: number };
    const insert = db.prepare(
      `INSERT INTO asks (thread_id, number, seq, question, suggestions, multiple, impact,
         priority, effort, answer_by, fallback)
       VALUES (:thread_id, :number, :seq, :question, :suggestions, :multiple, :impact,
         :priority, :effort, :answer_by, :fallback)`,
    );
    parts.asks.forEach((ask, index) => {
      insert.run({
        thread_id: thread.id,
        number: highest + index + 1,
        seq,
        question: ask.question,
        suggestions: JSON.stringify(ask.suggestions),
        multiple: Number(ask.multiple),
        impact: ask.impact,
        priority: ask.priority,
        effort: ask.effort ?? null,
        answer_by: ask.answer_by === undefined ? null : parseTimestamp(ask.answer_by),
        fallback: ask.fallback ?? null,
      });
    });
  }
  if (parts.answers !== undefined) {
    const insert = db.prepare(
      `INSERT INTO answers (thread_id, seq, ask, declined, picks, text)
       VALUES (:thread_id, :seq, :ask, :declined, :picks, :text)`,
    );
    for (const answer of parts.answers) {
      insert.run({
        thread_id: thread.id,
        seq,
        ask: answer.ask,
        declined: Number(answer.declined),
        picks: answer.picks === undefined ? null : JSON.stringify(answer.picks),
        text: answer.text ?? null,
      });
    }
  }
  if (parts.withdrawals !== undefined) {
    const insert = db.prepare(
      `INSERT INTO withdrawals (thread_id, seq, ask, reason) VALUES (:thread_id, :seq, :ask, :reason)`,
    );
    for (const withdrawal of parts.withdrawals) {
      insert.run({ thread_id: thread.id, seq, ask: withdrawal.ask, reason: withdrawal.reason });
    }
  }
  insertAttachments(db, thread.id, seq, write.attachments);
  db.prepare("UPDATE threads SET last_seq = ? WHERE id = ?").run(seq, thread.id);
  raiseReadMark(db, identity.actor, thread.id, seq);
  keepArchived(db, identity.actor, thread.id, seq);
}

// checkReferences refuses a reference to a thread that is not in the session.
function checkReferences(db: Database, sessionId: number, references: Reference[] | undefined) {
  references?.forEach((reference, index) => {
    if (
      reference.thread !== undefined &&
      db
        .prepare("SELECT 1 FROM threads WHERE session_id = ? AND number = ?")
        .get(sessionId, reference.thread) === undefined
    ) {
      throw invalidInput(`references.${index}.thread`, "names no thread in this session");
    }
  });
}

interface StoredMessage {
  seq: number;
  actor_id: number;
  live: number;
}

function findMessage(db: Database, threadId: number, seq: number): StoredMessage | undefined {
  return db
    .prepare(
      `SELECT m.seq, m.actor_id,
         EXISTS (SELECT 1 FROM live_messages l WHERE l.thread_id = m.thread_id AND l.seq = m.seq)
           AS live
       FROM messages m WHERE m.thread_id = ? AND m.seq = ?`,
    )
    .get(threadId, seq) as unknown as StoredMessage | undefined;
}

interface StoredAsk {
  number: number;
  suggestions: string;
  multiple: number;
  live: number;
  open: number;
}

function findAsk(db: Database, threadId: number, number: number): StoredAsk | undefined {
  return db
    .prepare(
      `SELECT a.number, a.suggestions, a.multiple,
         EXISTS (SELECT 1 FROM live_messages l WHERE l.thread_id = a.thread_id AND l.seq = a.seq)
           AS live,
         EXISTS (SELECT 1 FROM open_asks o WHERE o.thread_id = a.thread_id AND o.number = a.number)
           AS open
       FROM asks a WHERE a.thread_id = ? AND a.number = ?`,
    )
    .get(threadId, number) as unknown as StoredAsk | undefined;
}

// numbered names asks by number in a sentence: "ask 3", "asks 3 and 4".
function numbered(asks: number[]): string {
  const last = asks.at(-1);
  return asks.length === 1 ? `ask ${last}` : `asks ${asks.slice(0, -1).join(", ")} and ${last}`;
}

// checkParts applies the rules that depend on the thread's messages: what a
// message replaces, what it answers and withdraws, and what it references.
function checkParts(db: Database, thread: StoredThread, actor: number, parts: Parts): void {
  let answeredAgain: number[] = [];
  let withdrawnAgain: number[] = [];
  let stillOpen: number[] = [];
  if (parts.replaces !== undefined) {
    const replaced = findMessage(db, thread.id, parts.replaces);
    if (replaced === undefined) {
      throw invalidInput("replaces", "names no message in this thread");
    }
    if (replaced.actor_id !== actor) {
      throw notAllowed("replaces", "only a message's author replaces it");
    }
    if (replaced.live !== 1) {
      throw invalidInput("replaces", "names a message another message already replaced");
    }
    answeredAgain = (
      db
        .prepare(
          `SELECT n.ask FROM answers n
           JOIN asks a ON a.thread_id = n.thread_id AND a.number = n.ask
           JOIN live_messages l ON l.thread_id = a.thread_id AND l.seq = a.seq
           WHERE n.thread_id = ? AND n.seq = ? ORDER BY n.ask`,
        )
        .all(thread.id, parts.replaces) as { ask: number }[]
    ).map((row) => row.ask);
    withdrawnAgain = (
      db
        .prepare("SELECT ask FROM withdrawals WHERE thread_id = ? AND seq = ? ORDER BY ask")
        .all(thread.id, parts.replaces) as { ask: number }[]
    ).map((row) => row.ask);
    stillOpen = (
      db
        .prepare("SELECT number FROM open_asks WHERE thread_id = ? AND seq = ? ORDER BY number")
        .all(thread.id, parts.replaces) as { number: number }[]
    ).map((row) => row.number);
  }

  // Each answer names an open ask, except that a replacement answers again
  // every ask the message it replaces answered that is still live: an answer
  // is changed, never retracted. One to an ask its requester since revised
  // or retracted goes with the message it rode in. A replacement may answer
  // open asks besides.
  const answers = parts.answers ?? [];
  for (const number of answeredAgain) {
    if (!answers.some((answer) => answer.ask === number)) {
      throw invalidInput(
        "answers",
        `replaces a message that answered ask ${number}, so it must answer it again`,
      );
    }
  }
  answers.forEach((answer, index) => {
    const field = `answers.${index}`;
    const asked = findAsk(db, thread.id, answer.ask);
    if (asked !== undefined && asked.live !== 1) {
      throw invalidInput(`${field}.ask`, "names an ask its requester since revised or retracted");
    }
    if (asked === undefined || (asked.open !== 1 && !answeredAgain.includes(answer.ask))) {
      throw invalidInput(`${field}.ask`, "names no open ask in this thread");
    }
    checkAnswer(answer, asked, field);
  });

  // Each withdrawal names an open ask, the replaced message's own included,
  // except that a replacement withdraws again every ask the message it
  // replaces withdrew, with the same reason or a new one, whether or not the
  // ask's own message is still live: a withdrawal is never undone, and the
  // thread's status counts an ask a live message withdraws.
  const withdrawals = parts.withdrawals ?? [];
  const missing = withdrawnAgain.filter(
    (number) => !withdrawals.some((withdrawal) => withdrawal.ask === number),
  );
  if (missing.length > 0) {
    throw invalidInput(
      "withdrawals",
      `replaces a message that withdrew ${numbered(missing)}, so it must withdraw ` +
        `${missing.length === 1 ? "it" : "them"} again`,
    );
  }
  withdrawals.forEach((withdrawal, index) => {
    if (withdrawnAgain.includes(withdrawal.ask)) {
      return;
    }
    if (findAsk(db, thread.id, withdrawal.ask)?.open !== 1) {
      throw invalidInput(`withdrawals.${index}.ask`, "names no open ask in this thread");
    }
  });

  // A replacement of a message holding open asks asks each again or
  // withdraws it by name, so none is dropped unexplained: its asks and its
  // withdrawals of those asks number at least as many as it holds open. Its
  // asks are numbered anew, so the count is what can be checked.
  const withdrawnHere = withdrawals.filter((withdrawal) => stillOpen.includes(withdrawal.ask));
  if ((parts.asks?.length ?? 0) + withdrawnHere.length < stillOpen.length) {
    throw invalidInput(
      "asks",
      stillOpen.length === 1
        ? `replaces a message holding open ${numbered(stillOpen)}, so it must ask it again or ` +
            "withdraw it"
        : `replaces a message holding open ${numbered(stillOpen)}, so its asks and its ` +
            `withdrawals of them must number at least ${stillOpen.length}, asking each again ` +
            "or withdrawing it",
    );
  }
  checkReferences(db, thread.session_id, parts.references);
}

// checkAnswer fits an answer to its ask: picks that are distinct and among
// the ask's suggested answers, none on an ask that suggests none, and at most
// one on an ask that allows a single answer. The audience's words go beside
// any picks as notes, or are the whole answer without them. A decline fits
// every ask.
function checkAnswer(answer: Answer, asked: StoredAsk, field: string): void {
  const { picks } = answer;
  if (picks === undefined) {
    return;
  }
  const offered = (JSON.parse(asked.suggestions) as unknown[]).length;
  if (offered === 0) {
    throw invalidInput(`${field}.picks`, "the ask suggests no answers; answer in your own words");
  }
  if (new Set(picks).size !== picks.length) {
    throw invalidInput(`${field}.picks`, "picks the same suggested answer twice");
  }
  if (picks.some((pick) => pick >= offered)) {
    throw invalidInput(`${field}.picks`, "picks an answer the ask does not suggest");
  }
  if (asked.multiple !== 1 && picks.length > 1) {
    throw invalidInput(`${field}.picks`, "picks several answers, but the ask allows only one");
  }
}

// The parties of a thread, by their actors.
interface Roles {
  requester: number;
  audience: number;
}

// addThread starts a thread in a session with its first message, for either
// party that starts threads. Inside the transaction, once the request is
// authorized and is no replay of an earlier one, roles decides who the
// requester and the audience are, and throws notAllowed for an identity that
// may not start this thread. The thread takes the session's next number, its
// first message raises the writer's read mark through it, and the session's
// long polls wake once it commits. The status the input reports is part of
// the write, its digest included.
function addThread(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  operation: string,
  input: Parts & WriteStatus & { request_id: string; title: string },
  roles: (db: Database, sessionId: number) => Roles,
): WriteResult {
  const { db } = store;
  const { request_id: requestId, title, state, outcome: stoppedWith, note, ...parts } = input;
  const report = { state, outcome: stoppedWith, note };
  const outcome = db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:write", target, now);
    const digest = writeDigest(operation, { session: sessionId }, { title, ...parts, ...report });
    const prior = replayed(db, identity.actor, requestId, digest);
    if (prior !== undefined) {
      return { sessionId, appended: false, result: prior };
    }
    const { requester, audience } = roles(db, sessionId);
    checkReferences(db, sessionId, parts.references);
    const attachments = checkAttachments(
      db,
      { sessionId, replaced: undefined, actor: identity.actor, now },
      parts.attachments,
    );
    const { number } = db
      .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS number FROM threads WHERE session_id = ?")
      .get(sessionId) as { number: number };
    const { id } = db
      .prepare(
        `INSERT INTO threads (session_id, number, requester_actor_id, audience_actor_id, title,
           created_at, last_seq)
         VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id`,
      )
      .get(sessionId, number, requester, audience, title, now) as { id: number };
    appendMessage(db, { id, session_id: sessionId }, 1, identity, {
      requestId,
      digest,
      parts,
      attachments,
      now,
    });
    statusOnWrite(db, identity, sessionId, report, now);
    return { sessionId, appended: true, result: { number, seq: 1 } };
  });
  if (outcome.appended) {
    store.notifier.notify(outcome.sessionId);
  }
  return outcome.result;
}

// createThread starts a thread in the session the identity is acting as, with
// its first message: the session is the requester and the operator the
// audience.
export function createThread(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  input: ThreadCreateInput,
): WriteResult {
  return addThread(store, identity, target, "thread_create", input, (db, sessionId) => {
    if (identity.actor !== sessionActorId(db, sessionId)) {
      throw notAllowed(undefined, "only a session starts threads, and only in itself");
    }
    const operator = findOperator(db);
    if (operator === undefined) {
      throw new Error("an agent holds a credential, but no operator exists");
    }
    return { requester: identity.actor, audience: operator.actorId };
  });
}

// startThread starts a thread on a session for the operator, with their first
// message: the session stays the requester and the operator the audience, so
// the operator writes what the session reads as their words and replies to,
// and the requester's parts, asks and a topic, never come from them. The
// thread starts whether or not the session is there to read it.
export function startThread(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  input: ThreadStartInput,
): WriteResult {
  return addThread(store, identity, target, "thread_start", input, (db, sessionId) => {
    if (identity.actor !== findOperator(db)?.actorId) {
      throw notAllowed(undefined, "only the operator starts threads on a session");
    }
    return { requester: sessionActorId(db, sessionId), audience: identity.actor };
  });
}

// sendMessage appends a message to a thread, with what it reports of its
// session's status, which only the agent mount takes.
export function sendMessage(
  store: Store,
  identity: Identity,
  target: ThreadTarget,
  input: AgentMessageSendInput,
): WriteResult {
  const { db } = store;
  const {
    seen_through: seenThrough,
    request_id: requestId,
    state,
    outcome: stoppedWith,
    note,
    ...parts
  } = input;
  const report = { state, outcome: stoppedWith, note };
  const outcome = db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:write", target, now);
    const thread = requireThread(db, sessionId, target.thread);
    const digest = writeDigest(
      "message_send",
      { session: sessionId, thread: target.thread },
      { ...parts, ...report },
    );
    const prior = replayed(db, identity.actor, requestId, digest);
    if (prior !== undefined) {
      return { sessionId, appended: false, result: prior };
    }

    // Roles, which depend on who the actor is, not on the thread's messages.
    const requester = identity.actor === thread.requester_actor_id;
    const audience = identity.actor === thread.audience_actor_id;
    if (!requester && !audience) {
      throw notAllowed(undefined, "only the thread's requester and audience write to it");
    }
    if (parts.asks !== undefined && !requester) {
      throw notAllowed("asks", "only the requester asks");
    }
    if (parts.topic !== undefined && !requester) {
      throw notAllowed("topic", "only the requester sets the topic");
    }
    if (parts.answers !== undefined && !audience) {
      throw notAllowed("answers", "only the audience answers");
    }
    if (parts.withdrawals !== undefined && !requester) {
      throw notAllowed("withdrawals", "only the requester withdraws asks");
    }

    // Staleness, before the message rules, so a write another message
    // overtook always fails as stale and its writer sees what it missed.
    if (seenThrough > thread.last_seq) {
      throw invalidInput("seen_through", "is beyond the thread's latest message");
    }
    if (seenThrough < thread.last_seq) {
      throw new ApiError("stale", "other messages landed after the latest one you saw", {
        missed: readMessages(db, thread.id, seenThrough, missedLimit),
      });
    }

    checkParts(db, thread, identity.actor, parts);
    const attachments = checkAttachments(
      db,
      {
        sessionId: thread.session_id,
        replaced:
          parts.replaces === undefined ? undefined : { threadId: thread.id, seq: parts.replaces },
        actor: identity.actor,
        now,
      },
      parts.attachments,
    );
    const seq = thread.last_seq + 1;
    appendMessage(db, thread, seq, identity, { requestId, digest, parts, attachments, now });
    statusOnWrite(db, identity, sessionId, report, now);
    return { sessionId, appended: true, result: { number: thread.number, seq } };
  });
  if (outcome.appended) {
    store.notifier.notify(outcome.sessionId);
  }
  return outcome.result;
}

// getThread reads a thread, a page of its messages, both parties' read
// cursors, the caller's own marks and the totals of the thread's files.
export function getThread(
  store: Store,
  identity: Identity,
  target: ThreadTarget,
  query: ThreadGetQuery,
): ThreadGetResult {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:read", target, now);
    const stored = requireThread(db, sessionId, target.thread);
    return {
      thread: readThread(store, stored.id, identity.actor, now),
      messages: readMessages(db, stored.id, query.after, query.limit),
      cursors: partyCursors(db, stored),
      marks: marksOf(db, identity.actor, stored.id),
      files: threadFileTotals(db, stored.id),
    };
  });
}
