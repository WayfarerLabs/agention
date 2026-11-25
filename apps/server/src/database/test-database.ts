// A database for a test, as Database.open leaves a new one, without
// migrating it afresh: each test file's process migrates one database the
// first time a test asks, keeps its file's bytes, and gives every test a copy.
// Opening the copy still goes through Database.open, which finds it up to
// date, so each connection is set up as the server's is; only the migrations,
// the switch to the log and the vacuum that a new file needs are done once
// rather than for every test. The template is built from this checkout's
// migrations in each test file's process and never kept on disk, so no run can
// use a stale one and nothing is left in the temporary directory.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "./database.ts";

let template: Buffer | undefined;

// templateBytes migrates a database and reads its file once it is closed.
function templateBytes(): Buffer {
  if (template === undefined) {
    const root = mkdtempSync(path.join(tmpdir(), "agention-template-"));
    try {
      const file = path.join(root, "agention.db");
      // Closing the only connection moves the log into the file and deletes it.
      Database.open(file).close();
      template = readFileSync(file);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return template;
}

// openTestDatabase creates file as a copy of the template, private as
// Database.open requires, and opens it.
export function openTestDatabase(file: string): Database {
  writeFileSync(file, templateBytes(), { mode: 0o600, flag: "wx" });
  const database = Database.open(file);
  try {
    // A test's database is thrown away, so no commit needs to survive a power
    // loss. Not syncing each one to disk keeps the tests built on it, the
    // HTTP and bridge harnesses' included, from waiting on the disk, which
    // parallel test workers and a busy machine contend for.
    database.prepare("PRAGMA synchronous = OFF").run();
    // Every secret of its own that a new database's migrations make, each copy
    // makes afresh, so two test servers keep them apart as two real ones do: a
    // migration that adds one needs a line here. The key that seals passkey
    // ceremonies' challenges is the only one so far.
    database.prepare("UPDATE instance SET challenge_key = randomblob(32)").run();
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
