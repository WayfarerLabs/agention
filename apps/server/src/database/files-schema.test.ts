import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "./database.ts";

let root: string;
let database: Database;

const run = (sql: string, ...params: (string | number | Buffer | null)[]) =>
  database.prepare(sql).run(...params);

// insertFile writes a file of the session's, complete unless told otherwise,
// with one chunk, and returns its id.
function insertFile(ref: string, options: { complete?: boolean } = {}): number {
  const complete = options.complete ?? true;
  const { id } = database
    .prepare(
      `INSERT INTO files (ref, name, type, size, actor_id, session_id, created_at, sha256,
         completed_at)
       VALUES (?, 'a.txt', 'text/plain', 3, 2, 1, 1, ?, ?) RETURNING id`,
    )
    .get(ref, complete ? Buffer.alloc(32) : null, complete ? 2 : null) as { id: number };
  run("INSERT INTO file_chunks (file_id, idx, data) VALUES (?, 0, ?)", id, Buffer.from("abc"));
  return id;
}

const ref = (n: number) => String(n).padStart(22, "r");

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-files-schema-")));
  database = Database.open(path.join(root, "agention.db"), { log: () => undefined });
  database.prepare("INSERT INTO people (name, created_at) VALUES ('operator', 1)").run();
  database.prepare("INSERT INTO agents (name, created_at) VALUES ('agent', 1)").run();
  database.prepare("INSERT INTO sessions (agent_id, name, created_at) VALUES (1, 's', 1)").run();
  database.prepare("INSERT INTO actors (person_id) VALUES (1)").run();
  database.prepare("INSERT INTO actors (session_id) VALUES (1)").run();
  run(
    `INSERT INTO threads (session_id, number, requester_actor_id, audience_actor_id, title,
       created_at, last_seq)
     VALUES (1, 1, 2, 1, 't', 1, 1)`,
  );
  run(
    `INSERT INTO messages (thread_id, seq, session_id, session_pos, actor_id, created_at,
       request_id, digest, text)
     VALUES (1, 1, 1, 1, 2, 7, 'r1', zeroblob(32), 'hello')`,
  );
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("files, their chunks and attachments", () => {
  it("mark a file attached, at its message's time, once a message names it", () => {
    const id = insertFile(ref(1));
    run(
      "INSERT INTO attachments (thread_id, seq, position, name, file_id) VALUES (1, 1, 0, 'a', ?)",
      id,
    );
    expect(database.prepare("SELECT attached_at FROM files WHERE id = ?").get(id)).toEqual({
      attached_at: 7,
    });
  });

  it("refuse attaching a file that has not completed", () => {
    const id = insertFile(ref(1), { complete: false });
    expect(() =>
      run(
        "INSERT INTO attachments (thread_id, seq, position, name, file_id) VALUES (1, 1, 0, 'a', ?)",
        id,
      ),
    ).toThrow(/CHECK/);
  });

  it("keep an attached file, its bytes and its attachments as they are", () => {
    const id = insertFile(ref(1));
    run(
      "INSERT INTO attachments (thread_id, seq, position, name, file_id) VALUES (1, 1, 0, 'a', ?)",
      id,
    );
    expect(() => run("DELETE FROM files WHERE id = ?", id)).toThrow(/never removed/);
    expect(() => run("DELETE FROM file_chunks WHERE file_id = ?", id)).toThrow(/keeps its bytes/);
    expect(() => run("UPDATE file_chunks SET data = x'00' WHERE file_id = ?", id)).toThrow(
      /never change/,
    );
    expect(() => run("UPDATE attachments SET name = 'b'")).toThrow(/append-only/);
    expect(() => run("DELETE FROM attachments")).toThrow(/append-only/);
    expect(() => run("UPDATE files SET attached_at = 8 WHERE id = ?", id)).toThrow(/changes only/);
  });

  it("let a file change only as its upload completes and a message first names it", () => {
    const id = insertFile(ref(1), { complete: false });
    for (const change of [
      "name = 'b.txt'",
      "type = 'text/html'",
      "size = 4",
      "ref = '" + ref(2) + "'",
      "created_at = 9",
      "actor_id = 1",
    ]) {
      expect(() => run(`UPDATE files SET ${change} WHERE id = ?`, id), change).toThrow(
        /changes only/,
      );
    }
    run("UPDATE files SET sha256 = zeroblob(32), completed_at = 3 WHERE id = ?", id);
    expect(() => run("UPDATE files SET completed_at = 4 WHERE id = ?", id)).toThrow(/changes only/);
    expect(() => run("UPDATE files SET sha256 = randomblob(32) WHERE id = ?", id)).toThrow(
      /changes only/,
    );
  });

  it("let a pending file go with its bytes", () => {
    const id = insertFile(ref(1));
    run("DELETE FROM file_chunks WHERE file_id = ?", id);
    run("DELETE FROM files WHERE id = ?", id);
    expect(database.prepare("SELECT count(*) AS n FROM files").get()).toEqual({ n: 0 });
  });

  it("hold each name and each position once in a message", () => {
    const first = insertFile(ref(1));
    const second = insertFile(ref(2));
    run(
      "INSERT INTO attachments (thread_id, seq, position, name, file_id) VALUES (1, 1, 0, 'a', ?)",
      first,
    );
    expect(() =>
      run(
        "INSERT INTO attachments (thread_id, seq, position, name, file_id) VALUES (1, 1, 1, 'a', ?)",
        second,
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      run(
        "INSERT INTO attachments (thread_id, seq, position, name, file_id) VALUES (1, 1, 0, 'b', ?)",
        second,
      ),
    ).toThrow(/UNIQUE/);
  });
});
