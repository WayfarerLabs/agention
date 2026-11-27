import { setImmediate as nextTurn } from "node:timers/promises";
import type { Store } from "../store/store.ts";

// Retention: events older than the retention period are removed, oldest
// first, and only once every sink's cursor has passed them, which the delete
// trigger also holds. With no cursor, age alone decides. Removal follows the
// sequence, never the time: it stops at the first event too new to remove,
// even where a clock stepped back put a later time before it.

// The default retention, in days, and the bounds of --audit-retention-days;
// 0 keeps events forever.
export const defaultRetentionDays = 365;
export const maxRetentionDays = 36_500;

const day = 24 * 60 * 60 * 1000;

// The most events one transaction removes, so a large backlog never holds
// the database for long.
const batchSize = 1000;

// pruneAuditEvents removes the events past retention, a batch to a
// transaction, yielding to other work between batches, and answers how many
// it removed. The delete trigger checks each row a statement deletes, so each
// deletion is the oldest row alone.
export async function pruneAuditEvents(store: Store, retentionDays: number): Promise<number> {
  if (retentionDays === 0) {
    return 0;
  }
  const { db } = store;
  const remove = db.prepare(
    `DELETE FROM audit_events
     WHERE seq = (SELECT min(seq) FROM audit_events)
       AND time < :cutoff
       AND NOT EXISTS (SELECT 1 FROM audit_sinks WHERE delivered_seq < audit_events.seq)`,
  );
  let removed = 0;
  for (;;) {
    const batch = db.transaction(() => {
      const cutoff = store.clock() - retentionDays * day;
      let count = 0;
      while (count < batchSize && remove.run({ cutoff }).changes === 1) {
        count += 1;
      }
      return count;
    });
    removed += batch;
    if (batch < batchSize) {
      return removed;
    }
    await nextTurn();
  }
}
