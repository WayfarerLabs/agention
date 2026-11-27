import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Fixture } from "../store/test-fixture.ts";
import { advanceCursor, openCursor } from "./cursors.ts";
import { pruneAuditEvents } from "./retention.ts";
import { eventsAfter, lastSeq } from "./test-events.ts";

let fixture: Fixture;
const day = 24 * 60 * 60_000;

beforeEach(() => {
  fixture = new Fixture();
});

afterEach(() => {
  fixture.close();
});

// insert records events at the times given, in one transaction, as the
// recorder would.
function insert(...times: number[]): void {
  fixture.db.transaction(() => {
    for (const time of times) {
      const seq = lastSeq(fixture.db) + 1;
      const uid = randomUUID();
      fixture.db
        .prepare(
          `INSERT INTO audit_events (seq, uid, time, class_uid, action, outcome, credential_kind,
             credential_id, event)
           VALUES (?, ?, ?, 6003, 'createGroup', 'success', 'cli', NULL, ?)`,
        )
        .run(seq, uid, time, JSON.stringify({ metadata: { uid, sequence: seq } }));
    }
  });
}

const kept = () => eventsAfter(fixture.db).map((event) => event.seq);

it("removes events past retention oldest first, and only once every sink has them", async () => {
  const now = fixture.now;
  insert(now - 10 * day, now - 9 * day, now - day);
  expect(openCursor(fixture.store, "file")).toBe(0);
  expect(await pruneAuditEvents(fixture.store, 5)).toBe(0);
  advanceCursor(fixture.store, "file", 1);
  expect(await pruneAuditEvents(fixture.store, 5)).toBe(1);
  advanceCursor(fixture.store, "file", 3);
  expect(await pruneAuditEvents(fixture.store, 5)).toBe(1);
  expect(kept()).toEqual([3]);
});

it("stops at the first event too new, whatever the times after it", async () => {
  const now = fixture.now;
  insert(now - 10 * day, now - day, now - 10 * day);
  expect(await pruneAuditEvents(fixture.store, 5)).toBe(1);
  expect(kept()).toEqual([2, 3]);
});

it("keeps every event for a retention of 0", async () => {
  insert(fixture.now - 100_000 * day);
  expect(await pruneAuditEvents(fixture.store, 0)).toBe(0);
  expect(kept()).toHaveLength(1);
});

it("removes a backlog larger than a batch", async () => {
  insert(...Array.from({ length: 2500 }, () => fixture.now - 10 * day));
  expect(await pruneAuditEvents(fixture.store, 5)).toBe(2500);
  expect(kept()).toEqual([]);
});
