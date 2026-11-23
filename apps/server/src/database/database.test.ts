import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database, DatabaseOpenError, type DatabaseOpenReason } from "./database.ts";
import { applicationId, migrations } from "./migrations.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-database-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mode(target: string): number {
  return statSync(target).mode & 0o7777;
}

function reasonOf(fn: () => unknown): DatabaseOpenReason | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DatabaseOpenError) {
      return error.reason;
    }
    throw error;
  }
  return undefined;
}

function withRaw<T>(file: string, fn: (connection: DatabaseSync) => T): T {
  const connection = new DatabaseSync(file);
  try {
    return fn(connection);
  } finally {
    connection.close();
  }
}

describe("Database.open", () => {
  it("creates a database with every migration applied and every table strict", () => {
    const file = path.join(root, "data", "agention.db");
    const database = Database.open(file);
    try {
      const pragma = (name: string) =>
        Object.values(database.prepare(`PRAGMA ${name}`).get() ?? {})[0];
      expect(pragma("user_version")).toBe(migrations.length);
      expect(pragma("application_id")).toBe(applicationId);
      expect(pragma("journal_mode")).toBe("wal");
      expect(pragma("foreign_keys")).toBe(1);
      // FULL, which SQLite reports as 2: the store's test fixture turns it
      // off, so this is what guards the server's own setting.
      expect(pragma("synchronous")).toBe(2);
      const tables = database
        .prepare(
          "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table'",
        )
        .all()
        .filter((table) => !String(table.name).startsWith("sqlite_"));
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.filter((table) => table.strict !== 1)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("reopens an existing database and keeps its data", () => {
    const file = path.join(root, "agention.db");
    const first = Database.open(file);
    first.prepare("INSERT INTO agents (name, created_at) VALUES ('kept', 1)").run();
    first.close();
    const second = Database.open(file);
    try {
      expect(second.prepare("SELECT name FROM agents").all()).toEqual([{ name: "kept" }]);
    } finally {
      second.close();
    }
  });

  it("refuses a database written by a newer release without changing it", () => {
    const file = path.join(root, "agention.db");
    Database.open(file).close();
    withRaw(file, (connection) =>
      connection.exec(`PRAGMA user_version = ${migrations.length + 1}`),
    );
    const before = readFileSync(file);
    expect(reasonOf(() => Database.open(file))).toBe("newer_schema");
    expect(readFileSync(file)).toEqual(before);
  });

  it("refuses a file that is not a SQLite database without changing it", () => {
    const file = path.join(root, "agention.db");
    writeFileSync(file, "not a database, but someone's notes", { mode: 0o600 });
    const before = readFileSync(file);
    expect(reasonOf(() => Database.open(file))).toBe("not_sqlite");
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(root)).toEqual(["agention.db"]);
  });

  it("refuses another application's SQLite database without changing it", () => {
    const file = path.join(root, "agention.db");
    withRaw(file, (connection) => connection.exec("CREATE TABLE theirs (x)"));
    chmodSync(file, 0o600);
    const before = readFileSync(file);
    expect(reasonOf(() => Database.open(file))).toBe("not_agention");
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(root)).toEqual(["agention.db"]);
  });

  it("refuses a SQLite database stamped with another application id", () => {
    const file = path.join(root, "agention.db");
    withRaw(file, (connection) =>
      connection.exec(`PRAGMA application_id = ${applicationId + 1}; PRAGMA user_version = 2;
        CREATE TABLE kept (x)`),
    );
    chmodSync(file, 0o600);
    const before = readFileSync(file);
    expect(reasonOf(() => Database.open(file))).toBe("not_agention");
    expect(readFileSync(file)).toEqual(before);
  });

  it.each(["000", "022", "077", "700"])("makes new files private under umask %s", (umask) => {
    const previous = process.umask(parseInt(umask, 8));
    try {
      const directory = path.join(root, "a", "b");
      const file = path.join(directory, "agention.db");
      const database = Database.open(file);
      database.prepare("INSERT INTO agents (name, created_at) VALUES ('x', 1)").run();
      try {
        expect(mode(path.join(root, "a"))).toBe(0o700);
        expect(mode(directory)).toBe(0o700);
        for (const companion of [file, `${file}-wal`, `${file}-shm`]) {
          expect(mode(companion)).toBe(0o600);
        }
      } finally {
        database.close();
      }
    } finally {
      process.umask(previous);
    }
  });

  // The private-file rule is the package's to test; here, each path the
  // database opens is refused once, as a DatabaseOpenError with the rule's
  // reason.
  describe("refuses unsafe paths without changing them", () => {
    it("a data directory others can read", () => {
      const directory = path.join(root, "shared");
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o750);
      expect(reasonOf(() => Database.open(path.join(directory, "agention.db")))).toBe(
        "directory_not_private",
      );
      expect(mode(directory)).toBe(0o750);
      expect(readdirSync(directory)).toEqual([]);
    });

    it("a symlinked database file", () => {
      const target = path.join(root, "elsewhere.db");
      writeFileSync(target, "", { mode: 0o600 });
      symlinkSync(target, path.join(root, "agention.db"));
      expect(reasonOf(() => Database.open(path.join(root, "agention.db")))).toBe("not_a_file");
      expect(readFileSync(target, "utf8")).toBe("");
    });

    it("a symlinked companion file", () => {
      const file = path.join(root, "agention.db");
      Database.open(file).close();
      symlinkSync(path.join(root, "elsewhere"), `${file}-wal`);
      expect(reasonOf(() => Database.open(file))).toBe("not_a_file");
    });
  });
});

describe("Database.transaction", () => {
  let database: Database;

  beforeEach(() => {
    database = Database.open(path.join(root, "agention.db"));
  });

  afterEach(() => {
    database.close();
  });

  const insert = (name: string) =>
    database.prepare("INSERT INTO agents (name, created_at) VALUES (?, 1)").run(name);
  const names = () => database.prepare("SELECT name FROM agents ORDER BY name").all();

  it("commits what the function wrote and returns its result", () => {
    expect(database.transaction(() => (insert("a"), 7))).toBe(7);
    expect(names()).toEqual([{ name: "a" }]);
  });

  it("rolls back when the function throws", () => {
    expect(() =>
      database.transaction(() => {
        insert("a");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(names()).toEqual([]);
  });

  it("rolls back and refuses a function that returns a promise", () => {
    expect(() =>
      database.transaction(() => {
        insert("a");
        return Promise.resolve();
      }),
    ).toThrow(TypeError);
    expect(names()).toEqual([]);
    expect(database.transaction(() => (insert("b"), true))).toBe(true);
  });
});

describe("messages, asks, answers and withdrawals", () => {
  let database: Database;

  // insert writes a row to a table, with the given columns.
  function insert(table: string, columns: Record<string, string | number | Buffer>): void {
    const names = Object.keys(columns);
    database
      .prepare(
        `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(columns));
  }

  // insertMessage writes a message to thread 1, by the session unless the
  // columns say otherwise.
  function insertMessage(seq: number, columns: Record<string, string | number> = {}): void {
    insert("messages", {
      thread_id: 1,
      seq,
      session_id: 1,
      session_pos: seq,
      actor_id: 2,
      created_at: 1,
      request_id: `r${seq}`,
      digest: Buffer.alloc(32),
      ...columns,
    });
  }

  const asked = {
    thread_id: 1,
    seq: 1,
    question: "q",
    suggestions: '[{"label":"a","description":""}]',
    multiple: 0,
    impact: "none",
    priority: "normal",
  };

  // A session's thread whose first message says hello and asks ask 1, and the
  // operator's message 2.
  beforeEach(() => {
    database = Database.open(path.join(root, "agention.db"));
    database.prepare("INSERT INTO people (name, created_at) VALUES ('operator', 1)").run();
    database.prepare("INSERT INTO agents (name, created_at) VALUES ('agent', 1)").run();
    database
      .prepare("INSERT INTO sessions (agent_id, name, last_pos, created_at) VALUES (1, 's', 9, 1)")
      .run();
    database.prepare("INSERT INTO actors (person_id) VALUES (1)").run();
    database.prepare("INSERT INTO actors (session_id) VALUES (1)").run();
    database
      .prepare(
        `INSERT INTO threads (session_id, number, requester_actor_id, audience_actor_id, title,
           created_at, last_seq)
         VALUES (1, 1, 2, 1, 't', 1, 1)`,
      )
      .run();
    insertMessage(1, { text: "hello" });
    insert("asks", { ...asked, number: 1 });
    insertMessage(2, { actor_id: 1 });
  });

  afterEach(() => {
    database.close();
  });

  it("are append-only", () => {
    insert("answers", { thread_id: 1, seq: 2, ask: 1, declined: 1 });
    insertMessage(3);
    insert("withdrawals", { thread_id: 1, seq: 3, ask: 1, reason: "r" });
    const message = `(thread_id, seq, session_id, session_pos, actor_id, created_at, request_id,
      digest, text) VALUES (1, 1, 1, 1, 2, 1, 'r', x'${"00".repeat(32)}', 'replaced')`;
    const ask = `(thread_id, number, seq, question, suggestions, multiple, impact, priority)
      VALUES (1, 1, 1, 'replaced', '[]', 0, 'none', 'normal')`;
    const answer = "(thread_id, seq, ask, declined, text) VALUES (1, 2, 1, 0, 'replaced')";
    const withdrawal = "(thread_id, seq, ask, reason) VALUES (1, 3, 1, 'replaced')";
    for (const statement of [
      "UPDATE messages SET text = 'changed'",
      "DELETE FROM messages",
      `INSERT OR REPLACE INTO messages ${message}`,
      `REPLACE INTO messages ${message}`,
      "UPDATE asks SET question = 'changed'",
      "DELETE FROM asks",
      `INSERT OR REPLACE INTO asks ${ask}`,
      `REPLACE INTO asks ${ask}`,
      "UPDATE answers SET declined = 0, text = 'changed'",
      "DELETE FROM answers",
      `INSERT OR REPLACE INTO answers ${answer}`,
      `REPLACE INTO answers ${answer}`,
      "UPDATE withdrawals SET reason = 'changed'",
      "DELETE FROM withdrawals",
      `INSERT OR REPLACE INTO withdrawals ${withdrawal}`,
      `REPLACE INTO withdrawals ${withdrawal}`,
    ]) {
      expect(() => database.prepare(statement).run()).toThrow();
    }
    expect(database.prepare("SELECT text FROM messages WHERE seq = 1").all()).toEqual([
      { text: "hello" },
    ]);
    expect(database.prepare("SELECT question FROM asks").all()).toEqual([{ question: "q" }]);
    expect(database.prepare("SELECT declined FROM answers").all()).toEqual([{ declined: 1 }]);
    expect(database.prepare("SELECT reason FROM withdrawals").all()).toEqual([{ reason: "r" }]);
  });

  it("are replaced at most once each", () => {
    insertMessage(3, { replaces_seq: 1 });
    expect(() => insertMessage(4, { replaces_seq: 1 })).toThrow();
    insertMessage(4, { replaces_seq: 3 });
  });

  it("hold a message's detail only beside its text", () => {
    insertMessage(3, { text: "Summary.", detail: "At length." });
    expect(() => insertMessage(4, { detail: "At length." })).toThrow();
  });

  it.each([
    ["a decline", { declined: 1 }],
    ["picks", { declined: 0, picks: "[0]" }],
    ["own words", { declined: 0, text: "x" }],
    ["picks and own words", { declined: 0, picks: "[0]", text: "x" }],
  ])("hold an answer of %s", (_, columns) => {
    insert("answers", { thread_id: 1, seq: 2, ask: 1, ...columns });
  });

  it.each([
    ["an empty list of references", { message_references: "[]" }],
    ["a replacement of itself", { replaces_seq: 3 }],
    ["a replacement of a message that does not exist", { replaces_seq: 0 }],
  ])("refuse a message with %s", (_, columns) => {
    expect(() => insertMessage(3, columns)).toThrow();
  });

  it.each([
    ["an ask numbered as one before it", { number: 1 }],
    ["an ask numbered 0", { number: 0 }],
    ["an ask on no message", { number: 2, seq: 9 }],
    ["an ask without a question", { number: 2, question: null as unknown as string }],
    ["an ask's effort of no known length", { number: 2, effort: "soon" }],
    ["several picks over one suggested answer", { number: 2, multiple: 1 }],
  ])("refuse %s", (_, columns) => {
    expect(() => insert("asks", { ...asked, ...columns })).toThrow();
  });

  it.each([
    ["an answer to an ask that does not exist", { ask: 2, declined: 1 }],
    ["an answer on no message", { seq: 9, declined: 1 }],
    ["an answer with neither picks nor own words", { declined: 0 }],
    ["a decline with picks", { declined: 1, picks: "[0]" }],
    ["a decline with own words", { declined: 1, text: "x" }],
  ])("refuse %s", (_, columns) => {
    expect(() => insert("answers", { thread_id: 1, seq: 2, ask: 1, ...columns })).toThrow();
  });

  it.each([
    ["a withdrawal of an ask that does not exist", { ask: 2 }],
    ["a withdrawal on no message", { seq: 9 }],
    ["a withdrawal without a reason", { reason: null as unknown as string }],
  ])("refuse %s", (_, columns) => {
    expect(() =>
      insert("withdrawals", { thread_id: 1, seq: 2, ask: 1, reason: "r", ...columns }),
    ).toThrow();
  });

  it("refuse a message withdrawing an ask twice", () => {
    insert("withdrawals", { thread_id: 1, seq: 2, ask: 1, reason: "r" });
    expect(() => insert("withdrawals", { thread_id: 1, seq: 2, ask: 1, reason: "s" })).toThrow();
  });

  it("refuse a message answering an ask twice", () => {
    insert("answers", { thread_id: 1, seq: 2, ask: 1, declined: 1 });
    expect(() =>
      insert("answers", { thread_id: 1, seq: 2, ask: 1, declined: 0, text: "x" }),
    ).toThrow();
  });
});

describe("the operator, registrations and threads", () => {
  let database: Database;

  beforeEach(() => {
    database = Database.open(path.join(root, "agention.db"));
    database.prepare("INSERT INTO people (name, created_at) VALUES ('operator', 1)").run();
    database.prepare("INSERT INTO agents (name, created_at) VALUES ('agent', 1)").run();
    database.prepare("INSERT INTO sessions (agent_id, name, created_at) VALUES (1, 's', 1)").run();
    database.prepare("INSERT INTO actors (person_id) VALUES (1)").run();
    database.prepare("INSERT INTO actors (session_id) VALUES (1)").run();
    database
      .prepare(
        `INSERT INTO threads (session_id, number, requester_actor_id, audience_actor_id, title,
           created_at, last_seq)
         VALUES (1, 1, 2, 1, 't', 1, 1)`,
      )
      .run();
  });

  afterEach(() => {
    database.close();
  });

  it("hold one operator, whose id is 1", () => {
    expect(() =>
      database.prepare("INSERT INTO people (name, created_at) VALUES ('second', 1)").run(),
    ).toThrow();
    expect(() => database.prepare("UPDATE people SET id = 2").run()).toThrow();
  });

  // registration writes a registration with the given status and session.
  const registration = (status: string, sessionId: number | null) =>
    database
      .prepare(
        `INSERT INTO registrations (public_key, proposed_agent, proposed_session, status,
           session_id, created_at, expires_at, decided_at, revoked_at)
         VALUES (?, 'agent', 's', ?, ?, 1, 2, ?, ?)`,
      )
      .run(
        `key-${status}-${sessionId}`,
        status,
        sessionId,
        status === "pending" ? null : 1,
        status === "revoked" ? 1 : null,
      );

  it.each([
    ["pending", null],
    ["approved", 1],
    ["rejected", null],
    ["revoked", 1],
  ])("hold a %s registration with its session set exactly when decided onto one", (status, id) => {
    registration(status, id);
  });

  it.each([
    ["pending", 1],
    ["approved", null],
    ["rejected", 1],
    ["revoked", null],
  ])("refuse a %s registration whose session says otherwise", (status, id) => {
    expect(() => registration(status, id)).toThrow();
  });

  it("let a thread change only its latest sequence", () => {
    database.prepare("UPDATE threads SET last_seq = 2").run();
    // How SQLite reports a trigger's refusal: SQLITE_CONSTRAINT_TRIGGER.
    const refusal = (statement: string) => {
      try {
        database.prepare(statement).run();
      } catch (error) {
        return (error as { errcode?: number }).errcode;
      }
      return undefined;
    };
    for (const change of [
      "id = 2",
      "session_id = 2",
      "number = 2",
      "requester_actor_id = 1",
      "audience_actor_id = 2",
      "title = 'changed'",
      "created_at = 2",
      "title = 'changed', last_seq = 3",
    ]) {
      expect([change, refusal(`UPDATE threads SET ${change}`)]).toEqual([change, 1811]);
    }
    expect(database.prepare("SELECT title, last_seq FROM threads").all()).toEqual([
      { title: "t", last_seq: 2 },
    ]);
  });
});

describe("session updates and their marks", () => {
  let database: Database;

  // A session with an approved registration, the operator and their actors.
  beforeEach(() => {
    database = Database.open(path.join(root, "agention.db"));
    database.prepare("INSERT INTO people (name, created_at) VALUES ('operator', 1)").run();
    database.prepare("INSERT INTO agents (name, created_at) VALUES ('agent', 1)").run();
    database.prepare("INSERT INTO sessions (agent_id, name, created_at) VALUES (1, 's', 1)").run();
    database.prepare("INSERT INTO actors (person_id) VALUES (1)").run();
    database.prepare("INSERT INTO actors (session_id) VALUES (1)").run();
    database
      .prepare(
        `INSERT INTO registrations (public_key, proposed_agent, proposed_session, status,
           session_id, created_at, expires_at, decided_at)
         VALUES ('key', 'agent', 's', 'approved', 1, 1, 2, 1)`,
      )
      .run();
  });

  afterEach(() => {
    database.close();
  });

  // update writes the session's entry at seq with the given columns.
  function update(seq: number, columns: Record<string, string | number | null> = {}): void {
    const all = { state: "working", ...columns };
    const names = Object.keys(all);
    database
      .prepare(
        `INSERT INTO session_updates (session_id, seq, registration_id, created_at,
           ${names.join(", ")})
         VALUES (1, ?, 1, 1, ${names.map(() => "?").join(", ")})`,
      )
      .run(seq, ...Object.values(all));
  }

  it("are append-only", () => {
    update(1, { title: "t", note: "n" });
    const entry = `(session_id, seq, registration_id, state, title, created_at)
      VALUES (1, 1, 1, 'idle', 'replaced', 1)`;
    for (const statement of [
      "UPDATE session_updates SET title = 'changed'",
      "DELETE FROM session_updates",
      `INSERT OR REPLACE INTO session_updates ${entry}`,
      `REPLACE INTO session_updates ${entry}`,
    ]) {
      expect(() => database.prepare(statement).run()).toThrow();
    }
    expect(database.prepare("SELECT state, title, note FROM session_updates").all()).toEqual([
      { state: "working", title: "t", note: "n" },
    ]);
  });

  it("hold an outcome exactly while stopped", () => {
    update(1, { state: "stopped", outcome: "completed" });
    expect(() => update(2, { state: "stopped" })).toThrow();
    expect(() => update(2, { state: "working", outcome: "completed" })).toThrow();
    expect(() => update(2, { state: "idle", outcome: "stalled" })).toThrow();
  });

  it.each([
    ["a state it does not know", { state: "paused" }],
    ["an outcome it does not know", { state: "stopped", outcome: "failed" }],
    ["a percent below 0", { percent: -1 }],
    ["a percent above 100", { percent: 101 }],
    ["no state", { state: null }],
  ])("refuse %s", (_, columns) => {
    expect(() => update(1, columns)).toThrow();
  });

  it("number each session's entries from 1, once each", () => {
    expect(() => update(0)).toThrow();
    update(1);
    expect(() => update(1, { state: "idle" })).toThrow();
    update(2, { percent: 0 });
    update(3, { percent: 100 });
  });

  it("refuse an entry for a session or credential that does not exist", () => {
    expect(() =>
      database
        .prepare(
          `INSERT INTO session_updates (session_id, seq, registration_id, state, created_at)
           VALUES (2, 1, 1, 'working', 1)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO session_updates (session_id, seq, registration_id, state, created_at)
           VALUES (1, 1, 2, 'working', 1)`,
        )
        .run(),
    ).toThrow();
  });

  it("keep one read mark per actor and session, never below 0", () => {
    const mark = (actor: number, readSeq: number) =>
      database
        .prepare("INSERT INTO session_marks (actor_id, session_id, read_seq) VALUES (?, 1, ?)")
        .run(actor, readSeq);
    mark(1, 0);
    expect(() => mark(1, 1)).toThrow();
    expect(() => mark(2, -1)).toThrow();
  });
});

describe("a database an earlier release wrote", () => {
  // Opening one logs its switch to incremental vacuuming, which
  // vacuum-mode.test.ts checks; these opens keep that out of the run's output.
  const quiet = { log: () => {} };

  // Every row of every table, in a stable order, by table.
  function rowsOf(connection: { prepare: DatabaseSync["prepare"] }): Record<string, string[]> {
    const tables = connection
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        connection
          .prepare(`SELECT * FROM "${name}"`)
          .all()
          .map((row) =>
            JSON.stringify(row, (_, value: unknown) =>
              value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value,
            ),
          )
          .sort(),
      ]),
    );
  }

  // earlier keeps what a database had before it was opened at HEAD: its
  // tables, and of each table's rows the columns they had, since a later
  // migration may add one.
  function earlier(
    rows: Record<string, string[]>,
    before: Record<string, string[]>,
  ): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(before).map(([name, had]) => {
        const columns = Object.keys(JSON.parse(had[0] ?? "{}") as object);
        const kept = (rows[name] ?? []).map((row) => {
          const values = JSON.parse(row) as Record<string, unknown>;
          return JSON.stringify(
            Object.fromEntries(columns.map((column) => [column, values[column]])),
          );
        });
        return [name, kept.sort()];
      }),
    );
  }

  it("opens with migration 1's rows intact and the session log's tables empty", () => {
    const file = path.join(root, "agention.db");
    const before = withRaw(file, (connection) => {
      connection.exec(`PRAGMA application_id = ${applicationId}`);
      connection.exec(migrations[0] ?? "");
      connection.exec("PRAGMA user_version = 1");
      connection.exec(`
        INSERT INTO people (name, created_at) VALUES ('operator', 1);
        INSERT INTO agents (name, created_at) VALUES ('builder', 1), ('reviewer', 2);
        INSERT INTO sessions (agent_id, name, last_pos, last_seen_at, created_at)
          VALUES (1, 'main', 3, 60000, 1), (2, 'nightly', 0, NULL, 2);
        INSERT INTO actors (person_id) VALUES (1);
        INSERT INTO actors (session_id) VALUES (1), (2);
        INSERT INTO registrations (public_key, proposed_agent, proposed_session, status,
            session_id, created_at, expires_at, decided_at, revoked_at)
          VALUES ('approved-key', 'builder', 'main', 'approved', 1, 1, 2, 1, NULL),
            ('revoked-key', 'reviewer', 'nightly', 'revoked', 2, 1, 2, 1, 3),
            ('pending-key', 'builder', 'side', 'pending', NULL, 9, 99, NULL, NULL);
        INSERT INTO threads (session_id, number, requester_actor_id, audience_actor_id, title,
            created_at, last_seq)
          VALUES (1, 1, 2, 1, 'Ship the release?', 1, 3);
        INSERT INTO messages (thread_id, seq, session_id, session_pos, actor_id, registration_id,
            created_at, request_id, digest, text, topic)
          VALUES (1, 1, 1, 1, 2, 1, 1, 'r-1', zeroblob(32), 'Ready to ship.', 'release'),
            (1, 2, 1, 2, 1, NULL, 2, 'o-1', zeroblob(32), NULL, NULL),
            (1, 3, 1, 3, 2, 1, 3, 'r-2', zeroblob(32), 'Shipping.', NULL);
        INSERT INTO asks (thread_id, number, seq, question, suggestions, multiple, impact,
            priority)
          VALUES (1, 1, 1, 'Ship it?', '[{"label":"Yes","description":""}]', 0, 'blocking',
            'high');
        INSERT INTO answers (thread_id, seq, ask, declined, picks) VALUES (1, 2, 1, 0, '[0]');
        INSERT INTO thread_marks (actor_id, thread_id, read_seq, archived_seq)
          VALUES (1, 1, 2, 0), (2, 1, 3, 3);
      `);
      return rowsOf(connection);
    });
    chmodSync(file, 0o600);

    const database = Database.open(file, quiet);
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: migrations.length,
      });
      const after = rowsOf(database);
      expect(earlier(after, before)).toEqual(before);
      expect([after.session_marks, after.session_updates]).toEqual([[], []]);
      expect(
        database.prepare("SELECT rowid FROM thread_titles WHERE thread_titles MATCH 'ship*'").all(),
      ).toEqual([{ rowid: 1 }]);
    } finally {
      database.close();
    }
  });

  it("opens with the session log's rows intact, no groups or tags, and messages searchable", () => {
    const file = path.join(root, "agention.db");
    const before = withRaw(file, (connection) => {
      connection.exec(`PRAGMA application_id = ${applicationId}`);
      connection.exec(migrations[0] ?? "");
      connection.exec(migrations[1] ?? "");
      connection.exec("PRAGMA user_version = 2");
      connection.exec(`
        INSERT INTO people (name, created_at) VALUES ('operator', 1);
        INSERT INTO agents (name, created_at) VALUES ('builder', 1);
        INSERT INTO sessions (agent_id, name, last_pos, last_seen_at, created_at)
          VALUES (1, 'main', 3, 60000, 1);
        INSERT INTO actors (person_id) VALUES (1);
        INSERT INTO actors (session_id) VALUES (1);
        INSERT INTO registrations (public_key, proposed_agent, proposed_session, status,
            session_id, created_at, expires_at, decided_at, revoked_at)
          VALUES ('approved-key', 'builder', 'main', 'approved', 1, 1, 2, 1, NULL);
        INSERT INTO threads (session_id, number, requester_actor_id, audience_actor_id, title,
            created_at, last_seq)
          VALUES (1, 1, 2, 1, 'Release notes', 1, 3);
        INSERT INTO messages (thread_id, seq, session_id, session_pos, actor_id, registration_id,
            created_at, request_id, digest, text, detail, replaces_seq)
          VALUES (1, 1, 1, 1, 2, 1, 1, 'r-1', zeroblob(32), 'Drafted the changelog.',
              'Covers the migration to Postgres.', NULL),
            (1, 2, 1, 2, 2, 1, 2, 'r-2', zeroblob(32), 'Old wording about Kubernetes.', NULL,
              NULL),
            (1, 3, 1, 3, 2, 1, 3, 'r-3', zeroblob(32), 'New wording.', NULL, 2);
        INSERT INTO session_updates (session_id, seq, registration_id, state, title, note,
            created_at)
          VALUES (1, 1, 1, 'working', 'Release', 'Started.', 1),
            (1, 2, 1, 'idle', 'Release', NULL, 2);
        INSERT INTO session_marks (actor_id, session_id, read_seq) VALUES (1, 1, 1);
        INSERT INTO thread_marks (actor_id, thread_id, read_seq, archived_seq)
          VALUES (1, 1, 3, 0);
      `);
      return rowsOf(connection);
    });
    chmodSync(file, 0o600);

    const database = Database.open(file, quiet);
    try {
      const after = rowsOf(database);
      expect(earlier(after, before)).toEqual(before);
      expect([
        after.session_groups,
        after.session_group_members,
        after.agent_tags,
        after.session_tags,
      ]).toEqual([[], [], [], []]);
      // What the messages said before is found as it is written, each message
      // by its thread and sequence.
      const found = (text: string) =>
        database
          .prepare("SELECT thread_id, seq FROM message_texts WHERE message_texts MATCH ?")
          .all(text);
      expect(found("postgres*")).toEqual([{ thread_id: 1, seq: 1 }]);
      expect(found("kubernetes*")).toEqual([{ thread_id: 1, seq: 2 }]);
      // Each message written before has its position, in the order written.
      expect(after.message_positions?.map((row) => JSON.parse(row) as unknown)).toEqual([
        { pos: 1, thread_id: 1, seq: 1 },
        { pos: 2, thread_id: 1, seq: 2 },
        { pos: 3, thread_id: 1, seq: 3 },
      ]);
    } finally {
      database.close();
    }
  });

  it("opens with groups and tags intact and no voice settings", () => {
    const file = path.join(root, "agention.db");
    const before = withRaw(file, (connection) => {
      connection.exec(`PRAGMA application_id = ${applicationId}`);
      connection.exec(migrations[0] ?? "");
      connection.exec(migrations[1] ?? "");
      connection.exec(migrations[2] ?? "");
      connection.exec("PRAGMA user_version = 3");
      connection.exec(`
        INSERT INTO people (name, created_at) VALUES ('operator', 1);
        INSERT INTO agents (name, created_at) VALUES ('builder', 1);
        INSERT INTO sessions (agent_id, name, created_at) VALUES (1, 'main', 1);
        INSERT INTO session_groups (name, created_at) VALUES ('Work', 1);
        INSERT INTO session_group_members (session_id, group_id) VALUES (1, 1);
        INSERT INTO agent_tags (agent_id, name) VALUES (1, 'infra');
        INSERT INTO session_tags (session_id, name) VALUES (1, 'release');
      `);
      return rowsOf(connection);
    });
    chmodSync(file, 0o600);

    const database = Database.open(file, quiet);
    try {
      const after = rowsOf(database);
      expect(Object.keys(after)).toEqual(
        expect.arrayContaining([...Object.keys(before), "voice_settings"]),
      );
      expect(earlier(after, before)).toEqual(before);
      expect(after.voice_settings).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("opens with every earlier row intact, no files and no API keys", () => {
    const file = path.join(root, "agention.db");
    const before = withRaw(file, (connection) => {
      connection.exec(`PRAGMA application_id = ${applicationId}`);
      for (const migration of migrations.slice(0, 4)) {
        connection.exec(migration);
      }
      connection.exec("PRAGMA user_version = 4");
      connection.exec(`
        INSERT INTO people (name, created_at) VALUES ('operator', 1);
        INSERT INTO agents (name, created_at) VALUES ('builder', 1);
        INSERT INTO sessions (agent_id, name, created_at) VALUES (1, 'main', 1);
        INSERT INTO actors (person_id) VALUES (1);
        INSERT INTO actors (session_id) VALUES (1);
        INSERT INTO threads (session_id, number, requester_actor_id, audience_actor_id, title,
            created_at, last_seq)
          VALUES (1, 1, 2, 1, 'Logs', 1, 1);
        INSERT INTO messages (thread_id, seq, session_id, session_pos, actor_id, created_at,
            request_id, digest, text)
          VALUES (1, 1, 1, 1, 2, 1, 'r-1', zeroblob(32), 'See the log.');
        INSERT INTO voice_settings (id, base_url, model, prompt, api_key)
          VALUES (1, 'https://stt.test/v1', 'm', NULL, 'sk-test');
      `);
      return rowsOf(connection);
    });
    chmodSync(file, 0o600);

    const database = Database.open(file, quiet);
    try {
      const after = rowsOf(database);
      expect(Object.keys(after).sort()).toEqual(
        [
          ...Object.keys(before),
          "attachments",
          "file_chunks",
          "files",
          "api_keys",
          "message_positions",
        ].sort(),
      );
      expect(earlier(after, before)).toEqual(before);
      expect([after.files, after.file_chunks, after.attachments, after.api_keys]).toEqual([
        [],
        [],
        [],
        [],
      ]);
    } finally {
      database.close();
    }
  });

  it("opens with every earlier row intact and no session's agent API version recorded", () => {
    const file = path.join(root, "agention.db");
    const before = withRaw(file, (connection) => {
      connection.exec(`PRAGMA application_id = ${applicationId}`);
      for (const migration of migrations.slice(0, 7)) {
        connection.exec(migration);
      }
      connection.exec("PRAGMA user_version = 7");
      connection.exec(`
        INSERT INTO people (name, created_at) VALUES ('operator', 1);
        INSERT INTO agents (name, created_at) VALUES ('builder', 1);
        INSERT INTO sessions (agent_id, name, last_pos, last_seen_at, created_at)
          VALUES (1, 'main', 0, 60000, 1), (1, 'nightly', 0, NULL, 2);
        INSERT INTO actors (person_id) VALUES (1);
        INSERT INTO actors (session_id) VALUES (1), (2);
        INSERT INTO registrations (public_key, proposed_agent, proposed_session, status,
            session_id, created_at, expires_at, decided_at, revoked_at)
          VALUES ('approved-key', 'builder', 'main', 'approved', 1, 1, 2, 1, NULL);
      `);
      return rowsOf(connection);
    });
    chmodSync(file, 0o600);

    const database = Database.open(file, quiet);
    try {
      expect(earlier(rowsOf(database), before)).toEqual(before);
      expect(database.prepare("SELECT agent_api_version FROM sessions").all()).toEqual([
        { agent_api_version: null },
        { agent_api_version: null },
      ]);
    } finally {
      database.close();
    }
  });
});

describe("voice settings", () => {
  let database: Database;

  beforeEach(() => {
    database = Database.open(path.join(root, "agention.db"));
  });

  afterEach(() => {
    database.close();
  });

  it("hold at most one row, with a base URL and a model", () => {
    const insert = (id: number, baseUrl: string | null, model: string | null) =>
      database
        .prepare("INSERT INTO voice_settings (id, base_url, model) VALUES (?, ?, ?)")
        .run(id, baseUrl, model);
    expect(() => insert(2, "https://api.openai.com/v1", "gpt-transcribe")).toThrow();
    expect(() => insert(1, null, "gpt-transcribe")).toThrow();
    expect(() => insert(1, "https://api.openai.com/v1", null)).toThrow();
    insert(1, "https://api.openai.com/v1", "gpt-transcribe");
    expect(() => insert(1, "https://api.groq.com/openai/v1", "whisper-large-v3-turbo")).toThrow();
  });
});

describe("the instance", () => {
  let database: Database;

  beforeEach(() => {
    database = Database.open(path.join(root, "agention.db"));
  });

  afterEach(() => {
    database.close();
  });

  const name = () =>
    (database.prepare("SELECT name FROM instance").get() as { name: string | null }).name;

  it("takes a server name once and refuses changing it after", () => {
    expect(name()).toBeNull();
    database.prepare("UPDATE instance SET name = 'Work'").run();
    database.prepare("UPDATE instance SET name = 'Work'").run();
    for (const statement of [
      "UPDATE instance SET name = 'Play'",
      "UPDATE instance SET name = NULL",
      "DELETE FROM instance",
      "REPLACE INTO instance (id, challenge_key, name) VALUES (1, randomblob(32), 'Play')",
    ]) {
      expect(() => database.prepare(statement).run()).toThrow();
    }
    expect(name()).toBe("Work");
  });
});

describe("passkeys", () => {
  let database: Database;

  beforeEach(() => {
    database = Database.open(path.join(root, "agention.db"));
    database.prepare("INSERT INTO people (name, created_at) VALUES ('operator', 1)").run();
    for (const id of [1, 2]) {
      database
        .prepare(
          `INSERT INTO passkeys (id, person_id, credential_id, name, data, created_at)
           VALUES (?, 1, ?, 'p', '{}', 1)`,
        )
        .run(id, `c${id}`);
      database
        .prepare(
          `INSERT INTO browser_sessions (hash, person_id, passkey_id, csrf_token, created_at,
             idle_expires_at, absolute_expires_at) VALUES (?, 1, ?, 't', 1, 2, 2)`,
        )
        .run(Buffer.alloc(32, id), id);
    }
  });

  afterEach(() => {
    database.close();
  });

  it("take the browser sessions they signed in with them", () => {
    database.prepare("DELETE FROM passkeys WHERE id = 1").run();
    expect(database.prepare("SELECT passkey_id FROM browser_sessions").all()).toEqual([
      { passkey_id: 2 },
    ]);
  });

  it("refuse a passkey link without the operator's name", () => {
    expect(() =>
      database
        .prepare("INSERT INTO passkey_links (hash, operator_name, expires_at) VALUES (?, NULL, 1)")
        .run(Buffer.alloc(32)),
    ).toThrow();
  });
});
