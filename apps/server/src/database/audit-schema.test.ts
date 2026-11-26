import { chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDirectory } from "../test-directory.ts";
import { Database } from "./database.ts";
import { applicationId, migrations } from "./migrations.ts";

// The audit log's tables, as their triggers hold them: events in sequence,
// fixed once recorded but for an open failure's count, removed only oldest
// first and once every sink has them; sinks' cursors only moving forward;
// and the ids the instance and each browser session carry, never changed.

let root: string;
let database: Database;

beforeEach(() => {
  root = testDirectory("audit-schema");
  database = Database.open(path.join(root, "agention.db"));
});

afterEach(() => {
  database.close();
});

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// An event's JSON as the triggers read it: its sequence and uid, and for a
// failure its count and window.
function event(seq: number, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    class_uid: 3002,
    time: 1000,
    ...fields,
    metadata: { uid: uid(seq), sequence: seq },
  });
}

function insert(seq: number, options: { failure?: boolean; json?: string; uid?: string } = {}) {
  const failure = options.failure ?? false;
  database
    .prepare(
      `INSERT INTO audit_events (seq, uid, time, class_uid, action, outcome, credential_kind,
         credential_id, event, open_until)
       VALUES (?, ?, 1000, 3002, 'signIn', ?, 'none', NULL, ?, ?)`,
    )
    .run(
      seq,
      options.uid ?? uid(seq),
      failure ? "failure" : "success",
      options.json ?? event(seq, failure ? { count: 1, start_time: 1000, end_time: 1000 } : {}),
      failure ? 60_000 : null,
    );
}

const update = (seq: number, fields: Record<string, unknown>) =>
  database.prepare("UPDATE audit_events SET event = ? WHERE seq = ?").run(event(seq, fields), seq);

const remove = (seq: number) => database.prepare("DELETE FROM audit_events WHERE seq = ?").run(seq);

const sink = (deliveredSeq: number) =>
  database
    .prepare(
      `INSERT INTO audit_sinks (name, delivered_seq, created_at) VALUES ('file', ?, 0)
       ON CONFLICT (name) DO UPDATE SET delivered_seq = excluded.delivered_seq`,
    )
    .run(deliveredSeq);

describe("audit events", () => {
  it("take each next sequence, carrying their own seq and uid", () => {
    insert(1);
    expect(() => insert(3)).toThrow(/next sequence/);
    expect(() => insert(2, { json: event(2), uid: uid(9) })).toThrow(/next sequence/);
    expect(() => insert(2, { json: event(3) })).toThrow(/next sequence/);
    insert(2);
  });

  it("never reuse a sequence, even once pruning empties the table", () => {
    insert(1);
    insert(2);
    remove(1);
    remove(2);
    expect(() => insert(1)).toThrow(/next sequence/);
    insert(3);
  });

  it("change only as an open failure counts another, within its minute", () => {
    insert(1);
    insert(2, { failure: true });
    expect(() => update(1, { x: 1 })).toThrow(/open failure/);
    update(2, { count: 2, start_time: 1000, end_time: 2000 });
    for (const fields of [
      { count: 2, start_time: 1000, end_time: 3000 },
      { start_time: 1000, end_time: 3000 },
      { count: "3", start_time: 1000, end_time: 3000 },
      { count: 3, start_time: 1000 },
      { count: 3, start_time: 1000, end_time: "3000" },
      { count: 2.5, start_time: 1000, end_time: 3000 },
      { count: 3, start_time: 1000, end_time: 1500 },
      { count: 3, start_time: 1000, end_time: 60_000 },
      { count: 3, start_time: 999, end_time: 3000 },
    ]) {
      expect(() => update(2, fields), JSON.stringify(fields)).toThrow(/open failure/);
    }
    for (const statement of [
      "UPDATE audit_events SET time = 1001 WHERE seq = 2",
      "UPDATE audit_events SET action = 'usePasskeyLink' WHERE seq = 2",
      "UPDATE audit_events SET open_until = 120000 WHERE seq = 2",
    ]) {
      expect(() => database.prepare(statement).run(), statement).toThrow(/open failure/);
    }
  });

  it("close once, open_until becoming null with nothing else changing", () => {
    insert(1);
    insert(2, { failure: true });
    insert(3, { failure: true });
    const close = (statement: string) => () => database.prepare(statement).run();
    expect(close("UPDATE audit_events SET open_until = NULL WHERE seq = 1")).toThrow(
      /open failure/,
    );
    expect(
      close(
        `UPDATE audit_events SET open_until = NULL,
           event = json_set(event, '$.count', 2) WHERE seq = 2`,
      ),
    ).toThrow(/open failure/);
    expect(close("UPDATE audit_events SET open_until = NULL, time = 1001 WHERE seq = 2")).toThrow(
      /open failure/,
    );
    sink(3);
    close("UPDATE audit_events SET open_until = NULL WHERE seq IN (2, 3)")();
    expect(
      database
        .prepare("SELECT count(*) AS open FROM audit_events WHERE open_until IS NOT NULL")
        .get(),
    ).toEqual({ open: 0 });
    // A closed failure counts no more.
    expect(() => update(2, { count: 2, start_time: 1000, end_time: 2000 })).toThrow(/open failure/);
  });

  it("stop changing once a sink has an open failure", () => {
    insert(1, { failure: true });
    sink(1);
    expect(() => update(1, { count: 2, start_time: 1000, end_time: 2000 })).toThrow(/open failure/);
  });

  it("are removed only oldest first, and only once every sink has them", () => {
    insert(1);
    insert(2);
    sink(0);
    expect(() => remove(1)).toThrow(/oldest/);
    sink(1);
    expect(() => remove(2)).toThrow(/oldest/);
    remove(1);
    expect(() => remove(2)).toThrow(/oldest/);
    sink(2);
    remove(2);
  });

  it("cannot be replaced, which would remove one out of order", () => {
    insert(1);
    insert(2);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO audit_events (seq, uid, time, class_uid, action, outcome,
             credential_kind, credential_id, event)
           VALUES (3, ?, 1000, 3002, 'signIn', 'success', 'none', NULL, ?)`,
        )
        .run(uid(2), JSON.stringify({ metadata: { uid: uid(2), sequence: 3 } })),
    ).toThrow();
  });

  it("refuse columns that disagree with each other", () => {
    for (const statement of [
      // A credential id for the command line.
      `INSERT INTO audit_events (seq, uid, time, class_uid, action, outcome, credential_kind,
         credential_id, event) VALUES (1, '${uid(1)}', 1, 3002, 'a', 'success', 'cli', '1',
         '${event(1)}')`,
      // An open success.
      `INSERT INTO audit_events (seq, uid, time, class_uid, action, outcome, credential_kind,
         credential_id, event, open_until) VALUES (1, '${uid(1)}', 1, 3002, 'a', 'success',
         'none', NULL, '${event(1)}', 60000)`,
      // A class the log does not use.
      `INSERT INTO audit_events (seq, uid, time, class_uid, action, outcome, credential_kind,
         credential_id, event) VALUES (1, '${uid(1)}', 1, 1001, 'a', 'success', 'none', NULL,
         '${event(1)}')`,
    ]) {
      expect(() => database.prepare(statement).run()).toThrow();
    }
  });
});

describe("audit sinks", () => {
  it("move their cursors only forward", () => {
    sink(5);
    expect(() => database.prepare("UPDATE audit_sinks SET delivered_seq = 4").run()).toThrow(
      /forward/,
    );
    database.prepare("UPDATE audit_sinks SET delivered_seq = 6").run();
    expect(() =>
      database
        .prepare("INSERT INTO audit_sinks (name, delivered_seq, created_at) VALUES ('otlp', 0, 0)")
        .run(),
    ).toThrow();
  });
});

describe("the instance and its browser sessions", () => {
  it("give the instance an id once, which never changes", () => {
    const { uid: id } = database.prepare("SELECT uid FROM instance").get() as { uid: string };
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    database.prepare("UPDATE instance SET uid = uid").run();
    for (const statement of [
      "UPDATE instance SET uid = NULL",
      "UPDATE instance SET uid = lower(hex(randomblob(16)))",
    ]) {
      expect(() => database.prepare(statement).run(), statement).toThrow(/never changes/);
    }
  });

  it("give every browser session an earlier release opened an id of its own", () => {
    database.close();
    const file = path.join(root, "earlier.db");
    const connection = new DatabaseSync(file);
    connection.exec(`PRAGMA application_id = ${applicationId}`);
    // The migrations before the audit log's, the eleventh.
    for (const migration of migrations.slice(0, 10)) {
      connection.exec(migration);
    }
    connection.exec(`
      PRAGMA user_version = 10;
      INSERT INTO people (name, created_at) VALUES ('operator', 1);
      INSERT INTO passkeys (person_id, credential_id, name, data, created_at)
        VALUES (1, 'c', 'p', '{}', 1);
      INSERT INTO browser_sessions (hash, person_id, passkey_id, csrf_token, created_at,
          idle_expires_at, absolute_expires_at)
        VALUES (randomblob(32), 1, 1, 't', 1, 2, 3), (randomblob(32), 1, 1, 't', 1, 2, 3);
    `);
    connection.close();
    chmodSync(file, 0o600);
    database = Database.open(file, { log: () => {} });
    const ids = (database.prepare("SELECT id FROM browser_sessions").all() as { id: string }[]).map(
      (row) => row.id,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(() =>
      database.prepare("UPDATE browser_sessions SET id = lower(hex(randomblob(16)))").run(),
    ).toThrow(/never changes/);
    // Removing a passkey still ends the sessions it signed in.
    database.prepare("DELETE FROM passkeys").run();
    expect(database.prepare("SELECT count(*) AS n FROM browser_sessions").get()).toEqual({ n: 0 });
  });
});
