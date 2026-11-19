import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { applicationId, migrations } from "./migrations.ts";
import { DatabaseOpenError } from "./open-error.ts";
import { prepareDatabaseFile } from "./database-file.ts";

export { DatabaseOpenError, type DatabaseOpenReason } from "./open-error.ts";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// Database is the process's one connection to the Agention database. It owns
// opening, every DDL statement and migrations. Its API is synchronous, and
// every store operation, read or write, runs in transaction(): no write can
// interleave with another in this process, and an operation reads its
// authorization and its data in one snapshot.
export class Database {
  readonly #connection: DatabaseSync;

  private constructor(connection: DatabaseSync) {
    this.#connection = connection;
  }

  // open opens the database file, creating it and its directory when missing,
  // and applies any migrations this release has that the file lacks. It refuses
  // an unsafe data directory or file, a file that is not an Agention database,
  // and a database written by a newer release.
  static open(file: string): Database {
    const real = prepareDatabaseFile(path.resolve(file), applicationId);
    const database = new Database(new DatabaseSync(real));
    try {
      // recursive_triggers makes a REPLACE that deletes a row fire its delete
      // triggers, so REPLACE cannot rewrite an append-only log either.
      database.#connection.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA recursive_triggers = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = FULL;
      `);
      database.#migrate();
      // After the migrations, so a new database's first header, with its
      // application id, is written to the main file rather than the log.
      database.#connection.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      database.close();
      throw error;
    }
    return database;
  }

  // transaction runs fn between BEGIN IMMEDIATE and COMMIT, and rolls back if
  // it throws. fn must be synchronous: a transaction that awaited would let
  // other work run inside it, so a function that returns a promise is rolled
  // back and refused.
  transaction<T>(fn: () => T): T {
    this.#connection.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (isPromiseLike(result)) {
        // Nothing waits for this promise; keep its outcome from surfacing as an
        // unhandled rejection after the refusal below.
        result.then(undefined, () => undefined);
        throw new TypeError("a transaction function must not return a promise");
      }
      this.#connection.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#connection.isTransaction) {
        this.#connection.exec("ROLLBACK");
      }
      throw error;
    }
  }

  prepare(sql: string): StatementSync {
    return this.#connection.prepare(sql);
  }

  close(): void {
    if (this.#connection.isOpen) {
      this.#connection.close();
    }
  }

  // Each migration runs in its own transaction, which reads the version under
  // the write lock, so two processes opening a new database at once apply each
  // migration exactly once.
  #migrate(): void {
    for (;;) {
      const done = this.transaction(() => {
        const { user_version: version } = this.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        if (version > migrations.length) {
          throw new DatabaseOpenError(
            "newer_schema",
            `the database has schema version ${version}, but this release knows only ` +
              `${migrations.length}; it was written by a newer Agention release`,
          );
        }
        const migration = migrations[version];
        if (migration === undefined) {
          return true;
        }
        if (version === 0) {
          this.#connection.exec(`PRAGMA application_id = ${applicationId}`);
        }
        this.#connection.exec(migration);
        this.#connection.exec(`PRAGMA user_version = ${version + 1}`);
        return false;
      });
      if (done) {
        return;
      }
    }
  }
}
