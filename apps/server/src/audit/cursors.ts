import type { Store } from "../store/store.ts";
import type { SinkKind } from "./actions.ts";
import { openAt, recordAudit } from "./record.ts";

// Each sink's cursor: the last sequence it delivered, kept in audit_sinks by
// its kind. The table is every sink's outbox: a sink's batch is the events
// after its cursor, in sequence, stopping before the first coalesced failure
// still open.

export const sinkKinds: readonly SinkKind[] = ["stdout", "file"];

// An event as a sink receives it.
export interface AuditRecord {
  seq: number;
  uid: string;
  time: number;
  json: string;
}

// The most a batch holds: 100 events, or 1 MiB of them, but always one.
export const maxBatchEvents = 100;
export const maxBatchBytes = 1024 * 1024;

// openCursor gives a sink new to the database its cursor, just before the
// oldest event retained, or, with none retained, at the latest sequence ever
// taken, so a new destination receives every event the log still holds; a
// sink that has a cursor keeps it. It answers the cursor.
export function openCursor(store: Store, kind: SinkKind): number {
  const { db } = store;
  return db.transaction(() => {
    const held = db.prepare("SELECT delivered_seq FROM audit_sinks WHERE name = ?").get(kind) as
      { delivered_seq: number } | undefined;
    if (held !== undefined) {
      return held.delivered_seq;
    }
    const { start } = db
      .prepare(
        `SELECT coalesce(
           (SELECT min(seq) - 1 FROM audit_events),
           (SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'),
           0) AS start`,
      )
      .get() as { start: number };
    db.prepare("INSERT INTO audit_sinks (name, delivered_seq, created_at) VALUES (?, ?, ?)").run(
      kind,
      start,
      store.clock(),
    );
    return start;
  });
}

// A sink's next events, after its cursor and before the first event after it
// still open by the store's clock. The open events are found through their
// own index, which INDEXED BY names, since SQLite would otherwise walk the
// primary key from its start for min(seq), the whole backlog. Delivery closes
// every event it takes, so none behind the cursor is open; bounding the open
// events by the cursor is defense in depth.
export const batchQuery = `SELECT seq, uid, time, event FROM audit_events
  WHERE seq > :delivered
    AND seq < coalesce(
      (SELECT min(seq) FROM audit_events INDEXED BY audit_events_open
        WHERE ${openAt} AND seq > :delivered),
      9223372036854775807)
  ORDER BY seq LIMIT ${maxBatchEvents}`;

// When the first event still open ends, through the same index.
export const openEndQuery = `SELECT min(open_until) AS ends
  FROM audit_events INDEXED BY audit_events_open WHERE ${openAt} AND seq > :delivered`;

// readBatch reads a sink's next batch, and closes each coalesced failure in
// it, in the same transaction: once an event is copied for a destination,
// nothing counts into it again, even once a clock stepped back makes it look
// open, so every destination and the database hold the same count for it,
// and a later failure of its kind starts an event of its own.
export function readBatch(store: Store, delivered: number): AuditRecord[] {
  const { db } = store;
  return db.transaction(() => {
    const rows = db.prepare(batchQuery).all({ delivered, now: store.clock() }) as {
      seq: number;
      uid: string;
      time: number;
      event: string;
    }[];
    const batch: AuditRecord[] = [];
    let bytes = 0;
    for (const row of rows) {
      bytes += Buffer.byteLength(row.event);
      if (batch.length > 0 && bytes > maxBatchBytes) {
        break;
      }
      batch.push({ seq: row.seq, uid: row.uid, time: row.time, json: row.event });
    }
    const [first, last] = [batch[0]?.seq, batch.at(-1)?.seq];
    if (first !== undefined && last !== undefined) {
      db.prepare(
        `UPDATE audit_events SET open_until = NULL
         WHERE seq BETWEEN ? AND ? AND open_until IS NOT NULL`,
      ).run(first, last);
    }
    return batch;
  });
}

// nextOpenEnd answers when the first coalesced failure still open after a
// sink's cursor ends, if one is, which is when the events behind it become
// deliverable to that sink.
export function nextOpenEnd(store: Store, delivered: number): number | undefined {
  const { db } = store;
  return db.transaction(() => {
    const row = db.prepare(openEndQuery).get({ delivered, now: store.clock() }) as {
      ends: number | null;
    };
    return row.ends ?? undefined;
  });
}

// advanceCursor moves a sink's cursor to the last sequence it delivered. It
// answers false when the sink has no cursor, as once agention audit
// forget-sink has removed it from a server still running.
export function advanceCursor(store: Store, kind: SinkKind, through: number): boolean {
  return store.db.transaction(
    () =>
      store.db
        .prepare("UPDATE audit_sinks SET delivered_seq = max(delivered_seq, ?) WHERE name = ?")
        .run(through, kind).changes === 1,
  );
}

// How far behind a cursor is: the events after it, and when the oldest of
// them was recorded.
export interface Lag {
  behind: number;
  oldest: number | undefined;
}

export function lagOf(store: Store, delivered: number): Lag {
  const { db } = store;
  return db.transaction(() => {
    const row = db
      .prepare("SELECT count(*) AS behind, min(time) AS oldest FROM audit_events WHERE seq > ?")
      .get(delivered) as { behind: number; oldest: number | null };
    return { behind: row.behind, oldest: row.oldest ?? undefined };
  });
}

// cursorsOf lists every cursor the database holds, by kind.
export function cursorsOf(store: Store): { kind: SinkKind; delivered: number }[] {
  const { db } = store;
  return db.transaction(() =>
    (
      db.prepare("SELECT name, delivered_seq FROM audit_sinks ORDER BY name").all() as {
        name: SinkKind;
        delivered_seq: number;
      }[]
    ).map((row) => ({ kind: row.name, delivered: row.delivered_seq })),
  );
}

// forgetSink removes a sink's cursor, so retention no longer waits for it,
// and records that the command line forgot it, with the sequence it had
// delivered, in one transaction. It answers that sequence, or undefined for
// a kind with no cursor, which changes nothing.
export function forgetSink(store: Store, kind: SinkKind): number | undefined {
  const { db } = store;
  return db.transaction(() => {
    const forgotten = db
      .prepare("DELETE FROM audit_sinks WHERE name = ? RETURNING delivered_seq")
      .get(kind) as { delivered_seq: number } | undefined;
    if (forgotten === undefined) {
      return undefined;
    }
    recordAudit(store, store.clock(), { kind: "cli", command: "audit forget-sink" }, "forgetSink", {
      sink: kind,
      deliveredSeq: forgotten.delivered_seq,
    });
    return forgotten.delivered_seq;
  });
}
