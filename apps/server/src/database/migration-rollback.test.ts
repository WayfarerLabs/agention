import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { testDirectory } from "../test-directory.ts";
import { Database } from "./database.ts";

// A migration list whose second migration fails part way through.
vi.mock("./migrations.ts", () => ({
  applicationId: 0x41474e31,
  migrations: [
    "CREATE TABLE first (x INTEGER) STRICT;",
    "CREATE TABLE second (x INTEGER) STRICT; INSERT INTO missing VALUES (1);",
  ],
}));

it("rolls back a failing migration and leaves the earlier ones applied", () => {
  const file = path.join(testDirectory("migration"), "agention.db");
  expect(() => Database.open(file)).toThrow();
  const connection = new DatabaseSync(file);
  try {
    expect(connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    const tables = connection
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all();
    expect(tables).toEqual([{ name: "first" }]);
  } finally {
    connection.close();
  }
});
