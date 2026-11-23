import type { WaitQuery, WaitResult } from "@wayfarerlabs/agention-api";
import type { OperatorWaitQuery, OperatorWaitResult } from "@wayfarerlabs/agention-server-api";
import { performance } from "node:perf_hooks";
import { authorizeScope, type Identity, sessionScope } from "../identity.ts";
import { type Channel, everySession } from "./notifier.ts";
import { decodeCursor, encodeCursor } from "./opaque-cursors.ts";
import type { Store } from "./store.ts";
import { reached } from "./thread-lists.ts";
import {
  pageOf,
  type ThreadRow,
  threadsSeen,
  toThreadSummary,
  viewerAndCutoff,
} from "./thread-reads.ts";
import { authorizeSession, type SessionTarget } from "./threads.ts";

// pollThreads reads, in one transaction, the session's threads with unread
// messages whose latest message is past `since`, oldest activity first, and
// the position the result covers: the latest message of the last thread
// returned when the page is full, else the session's latest position. Passing
// that position back waits only for newer messages, so an agent that leaves a
// thread unread is not woken for it again, and a full page continues with the
// threads it left out. A since beyond the session's latest position is not one
// this session gave out, so it counts as none and everything unread is
// delivered again rather than silently skipped.
export function pollThreads(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  since: number,
  limit: number,
): { sessionId: number; result: WaitResult } {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const sessionId = authorizeSession(db, identity, "threads:read", target, now);
    const { last_pos: latest } = db
      .prepare("SELECT last_pos FROM sessions WHERE id = ?")
      .get(sessionId) as { last_pos: number };
    const rows = db
      .prepare(
        `${threadsSeen("t.session_id = :session")}
         SELECT * FROM seen WHERE unread > 0 AND latest_pos > :since
         ORDER BY latest_pos LIMIT :limit`,
      )
      .all({
        session: sessionId,
        since: since > latest ? 0 : since,
        limit: limit + 1,
        ...viewerAndCutoff(store, identity.actor, now),
      }) as unknown as ThreadRow[];
    const page = pageOf(rows, limit);
    const last = page.rows.at(-1);
    const covered = page.more && last !== undefined ? last.latest_pos : latest;
    return {
      sessionId,
      result: {
        threads: page.rows.map((row) => toThreadSummary(row, now)),
        since: encodeCursor("since", [covered]),
      },
    };
  });
}

// What one poll of a long poll found: the answer as it stands, the channel
// whose notification may change it, and when the credential it was
// authorized with expires, if it does.
interface Polled<R> {
  result: R;
  channel: Channel;
  expiresAt?: number | undefined;
}

// longPoll runs a long poll of waitSeconds. It answers at once when poll finds
// threads; otherwise it waits on poll's channel and polls again after each
// notification there, until threads appear, the wait ends or signal aborts.
// It also polls again once the credential expires, so an expiry ends the wait
// as a revocation does. Every poll authorizes, so a credential revoked while
// waiting ends the wait with its refusal as soon as revocation wakes it.
async function longPoll<R extends { threads: readonly unknown[] }>(
  store: Store,
  waitSeconds: number,
  poll: () => Polled<R>,
  signal: AbortSignal | undefined,
): Promise<R> {
  const deadline = performance.now() + waitSeconds * 1000;
  for (;;) {
    const { result, channel, expiresAt } = poll();
    const remaining = deadline - performance.now();
    if (result.threads.length > 0 || remaining <= 0 || signal?.aborted) {
      return result;
    }
    const untilExpiry = expiresAt === undefined ? Infinity : expiresAt - store.clock();
    const outcome = await store.notifier.wait(channel, Math.min(remaining, untilExpiry), signal);
    if (outcome === "aborted" || (outcome === "timeout" && untilExpiry >= remaining)) {
      return result;
    }
  }
}

// waitForThreads is an agent's long poll on its own session, over
// pollThreads, woken by the session's notifications.
export async function waitForThreads(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  query: WaitQuery,
  signal?: AbortSignal,
): Promise<WaitResult> {
  const [since] =
    query.since === undefined
      ? [0]
      : (decodeCursor("since", query.since, ["number"], "since") as [number]);
  return longPoll(
    store,
    query.wait,
    () => {
      const { sessionId, result } = pollThreads(store, identity, target, since, query.limit);
      return { result, channel: sessionId };
    },
    signal,
  );
}

// The list name of the cursor the wait across sessions gives out, so a
// session's own since is never taken for one.
const everySessionSince = "every_session_since";

// pollEverySession reads, in one transaction, the threads of every session
// the identity reaches that hold messages the viewer has not read and whose
// latest message is past since, oldest activity first, as pollThreads reads
// one session's. Here since is a position among every session's messages at
// once, from message_positions. The position the result covers is that of
// the last thread's latest message when the page is full, else the latest
// message's, and a since beyond the latest counts as none, as pollThreads
// counts its own. It answers too when the credential expires.
export function pollEverySession(
  store: Store,
  identity: Identity,
  since: number,
  limit: number,
): { result: OperatorWaitResult; expiresAt: number | undefined } {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const expiresAt = authorizeScope(db, identity, "threads:read", now);
    const { latest } = db
      .prepare("SELECT COALESCE(max(pos), 0) AS latest FROM message_positions")
      .get() as { latest: number };
    // Positions only grow, so a thread holds a message past since exactly when
    // its latest message is past it, and the scope reads only the newer ones.
    const rows = db
      .prepare(
        `${threadsSeen(
          `${reached} AND t.id IN (SELECT thread_id FROM message_positions WHERE pos > :since)`,
        )}
         SELECT seen.*, p.pos AS position FROM seen
         JOIN message_positions p ON p.thread_id = seen.id AND p.seq = seen.last_seq
         WHERE seen.unread > 0
         ORDER BY p.pos LIMIT :limit`,
      )
      .all({
        since: since > latest ? 0 : since,
        limit: limit + 1,
        ...sessionScope(identity),
        ...viewerAndCutoff(store, identity.actor, now),
      }) as unknown as (ThreadRow & { position: number })[];
    const page = pageOf(rows, limit);
    const last = page.rows.at(-1);
    const covered = page.more && last !== undefined ? last.position : latest;
    return {
      result: {
        threads: page.rows.map((row) => toThreadSummary(row, now)),
        since: encodeCursor(everySessionSince, [covered]),
      },
      expiresAt,
    };
  });
}

// waitForEverySession is the operator's long poll across every session, over
// pollEverySession, woken by every session's notifications and by the end of
// a credential that reaches them all.
export async function waitForEverySession(
  store: Store,
  identity: Identity,
  query: OperatorWaitQuery,
  signal?: AbortSignal,
): Promise<OperatorWaitResult> {
  const [since] =
    query.since === undefined
      ? [0]
      : (decodeCursor(everySessionSince, query.since, ["number"], "since") as [number]);
  return longPoll(
    store,
    query.wait,
    () => ({ ...pollEverySession(store, identity, since, query.limit), channel: everySession }),
    signal,
  );
}
