import { threadsView } from "@wayfarerlabs/agention-api";
import { chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { readView } from "../store/saved-views.ts";
import { testDirectory } from "../test-directory.ts";
import { Database } from "./database.ts";
import { applicationId, migrations } from "./migrations.ts";

// The notifications migration over a database the release before it wrote:
// every row kept and no view notifying but the starting view, which it adds
// once, numbered past a name taken in any case, and not at all at 200 views;
// the new columns empty; and the push key fixed once made.

// How many migrations ran before notifications': saved views' was the 12th.
const before = 12;

let file: string;

beforeEach(() => {
  file = path.join(testDirectory("notifications-schema"), "agention.db");
});

// earlier writes a database as the release before wrote it, with an
// operator, a thread and its marks, and the saved views given.
function earlier(views: string[]): void {
  const connection = new DatabaseSync(file);
  try {
    connection.exec(`PRAGMA application_id = ${applicationId}`);
    for (const migration of migrations.slice(0, before)) {
      connection.exec(migration);
    }
    connection.exec(`PRAGMA user_version = ${before}`);
    connection.exec(`
      INSERT INTO people (name, created_at) VALUES ('operator', 1);
      INSERT INTO agents (name, created_at) VALUES ('builder', 1);
      INSERT INTO sessions (agent_id, name, created_at) VALUES (1, 'main', 1);
      INSERT INTO actors (person_id) VALUES (1);
      INSERT INTO actors (session_id) VALUES (1);
      INSERT INTO threads (session_id, number, requester_actor_id, audience_actor_id, title,
          created_at, last_seq)
        VALUES (1, 1, 2, 1, 'Logs', 1, 1);
      INSERT INTO thread_marks (actor_id, thread_id, read_seq) VALUES (1, 1, 1);
    `);
    const insert = connection.prepare(
      "INSERT INTO saved_views (name, view, created_at) VALUES (?, '{}', 1)",
    );
    for (const name of views) {
      insert.run(name);
    }
  } finally {
    connection.close();
  }
  chmodSync(file, 0o600);
}

function opened<T>(read: (database: Database) => T): T {
  const database = Database.open(file, { log: () => {} });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

const views = (database: Database) =>
  database.prepare("SELECT name, view, notifies FROM saved_views ORDER BY id").all() as {
    name: string;
    view: string;
    notifies: number;
  }[];

describe("the notifications migration", () => {
  it("keeps every row, adds the starting view once, notifying, and leaves the rest empty", () => {
    earlier(["Mine"]);
    const after = opened((database) => ({
      views: views(database),
      marks: database.prepare("SELECT read_seq, notified_seq FROM thread_marks").all(),
      key: database.prepare("SELECT vapid_private_key FROM instance").get(),
      devices: database.prepare("SELECT count(*) AS n FROM push_subscriptions").get(),
    }));
    expect(after.views.map(({ name, notifies }) => [name, notifies])).toEqual([
      ["Mine", 0],
      ["Blocking asks", 1],
    ]);
    expect(readView(after.views[1]?.view ?? "")).toEqual(threadsView.parse({ impact: "blocking" }));
    expect(after.marks).toEqual([{ read_seq: 1, notified_seq: null }]);
    expect(after.key).toEqual({ vapid_private_key: null });
    expect(after.devices).toEqual({ n: 0 });
  });

  it("numbers the starting view past a name taken in any case", () => {
    earlier(["blocking ASKS", "Blocking asks 3"]);
    expect(opened(views).map(({ name }) => name)).toEqual([
      "blocking ASKS",
      "Blocking asks 3",
      "Blocking asks 2",
    ]);
  });

  it("adds no starting view beside 200 views", () => {
    earlier(Array.from({ length: 200 }, (_, index) => `View ${index}`));
    expect(opened(views)).toHaveLength(200);
  });
});
