import type { WaitQuery, WaitResult } from "@wayfarerlabs/agention-api";
import { performance } from "node:perf_hooks";
import type { Identity } from "../identity.ts";
import { decodeCursor, encodeCursor } from "./opaque-cursors.ts";
import type { Store } from "./store.ts";
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
    const sessionId = authorizeSession(db, identity, target, now);
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

// waitForThreads is the long poll. It answers at once when pollThreads finds
// threads; otherwise it waits on the session's notifier and polls again after
// each commit there, until threads appear, the wait ends or signal aborts.
// Authorization runs on every poll, so a credential revoked while waiting ends
// the wait with unauthenticated as soon as revocation wakes it.
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
  const deadline = performance.now() + query.wait * 1000;
  for (;;) {
    const { sessionId, result } = pollThreads(store, identity, target, since, query.limit);
    const remaining = deadline - performance.now();
    if (result.threads.length > 0 || remaining <= 0 || signal?.aborted) {
      return result;
    }
    if ((await store.notifier.wait(sessionId, remaining, signal)) !== "notified") {
      return result;
    }
  }
}
