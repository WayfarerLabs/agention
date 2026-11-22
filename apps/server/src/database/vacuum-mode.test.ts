import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "./database.ts";
import { applicationId, migrations } from "./migrations.ts";

let root: string;
let file: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-vacuum-")));
  file = path.join(root, "agention.db");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function withRaw<T>(fn: (connection: DatabaseSync) => T): T {
  const connection = new DatabaseSync(file);
  try {
    return fn(connection);
  } finally {
    connection.close();
  }
}

const modeOf = () =>
  withRaw(
    (connection) =>
      (connection.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum,
  );

// earlierDatabase writes a database at the migration before this release's
// last, in mode none as every earlier release left it, with a thread in it.
function earlierDatabase(): void {
  withRaw((connection) => {
    connection.exec(`PRAGMA application_id = ${applicationId}`);
    for (const migration of migrations.slice(0, -1)) {
      connection.exec(migration);
    }
    connection.exec(`PRAGMA user_version = ${migrations.length - 1}`);
    connection.exec(`
      INSERT INTO people (name, created_at) VALUES ('operator', 1);
      INSERT INTO agents (name, created_at) VALUES ('builder', 1);
      INSERT INTO sessions (agent_id, name, created_at) VALUES (1, 'main', 1);
      INSERT INTO actors (person_id) VALUES (1);
      INSERT INTO actors (session_id) VALUES (1);
      INSERT INTO threads (session_id, number, requester_actor_id, audience_actor_id, title,
          created_at, last_seq)
        VALUES (1, 1, 2, 1, 'Ship it?', 1, 1);
      INSERT INTO messages (thread_id, seq, session_id, session_pos, actor_id, created_at,
          request_id, digest, text)
        VALUES (1, 1, 1, 1, 2, 1, 'r-1', zeroblob(32), 'Ready.');
    `);
  });
  chmodSync(file, 0o600);
}

// vacuums counts the VACUUM statements the database's connections run.
function countVacuums(): { count: number } {
  const counted = { count: 0 };
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === "VACUUM") {
      counted.count += 1;
    }
    exec.call(this, sql);
  });
  return counted;
}

describe("incremental vacuuming", () => {
  it("is switched on for a new database just after its migrations", () => {
    const vacuums = countVacuums();
    const database = Database.open(file, { log: () => undefined });
    try {
      expect(database.incrementalVacuum).toBe(true);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: migrations.length,
      });
    } finally {
      database.close();
    }
    expect(vacuums.count).toBe(1);
  });

  it("converts a database an earlier release wrote once, its data unchanged", () => {
    earlierDatabase();
    expect(modeOf()).toBe(0);
    const vacuums = countVacuums();
    const logged: string[] = [];
    for (let open = 0; open < 2; open++) {
      const database = Database.open(file, { log: (message) => logged.push(message) });
      try {
        expect(database.incrementalVacuum).toBe(true);
        expect(database.prepare("SELECT text FROM messages").all()).toEqual([{ text: "Ready." }]);
        expect(
          database.prepare("SELECT name FROM sqlite_schema WHERE name = 'files'").get(),
        ).toEqual({
          name: "files",
        });
      } finally {
        database.close();
      }
    }
    expect(vacuums.count).toBe(1);
    expect(logged).toEqual([]);
    expect(modeOf()).toBe(2);
  });

  it("leaves the database in mode none when the switch fails, and switches at the next open", () => {
    earlierDatabase();
    const exec = DatabaseSync.prototype.exec;
    const failing = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql === "VACUUM") {
        throw Object.assign(new Error("database or disk is full"), { errcode: 13 });
      }
      exec.call(this, sql);
    });
    const logged: string[] = [];
    const failed = Database.open(file, { log: (message) => logged.push(message) });
    try {
      expect(failed.incrementalVacuum).toBe(false);
      // The open succeeded with every migration applied.
      expect(failed.prepare("PRAGMA user_version").get()).toEqual({
        user_version: migrations.length,
      });
    } finally {
      failed.close();
    }
    expect(logged).toHaveLength(1);
    expect(modeOf()).toBe(0);

    failing.mockRestore();
    const database = Database.open(file, { log: (message) => logged.push(message) });
    try {
      expect(database.incrementalVacuum).toBe(true);
    } finally {
      database.close();
    }
    expect(logged).toHaveLength(1);
  });

  it("returns freed pages to the disk a step at a time, outside any transaction", () => {
    const database = Database.open(file);
    try {
      database.prepare("CREATE TABLE scratch (data BLOB) STRICT").run();
      const insert = database.prepare("INSERT INTO scratch (data) VALUES (?)");
      insert.run(Buffer.alloc(1024 * 1024));
      database.prepare("DELETE FROM scratch").run();
      const freed = database.freePages();
      expect(freed).toBeGreaterThan(200);
      database.vacuumStep(100);
      expect(database.freePages()).toBe(freed - 100);
      expect(() => database.transaction(() => database.vacuumStep(1))).toThrow(TypeError);
      expect(() => database.vacuumStep(0)).toThrow(RangeError);
    } finally {
      database.close();
    }
  });
});
