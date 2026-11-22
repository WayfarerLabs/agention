import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { applicationId, migrations } from "./migrations.ts";
import { DatabaseOpenError } from "./open-error.ts";
import { prepareDatabaseFile } from "./database-file.ts";
import { enableIncrementalVacuum, incremental, vacuumMode } from "./vacuum-mode.ts";

export { DatabaseOpenError, type DatabaseOpenReason } from "./open-error.ts";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// The most the log beside the database keeps once a checkpoint empties it.
const journalSizeLimit = 16 * 1024 * 1024;

// Database is the process's one connection to the Agention database. It owns
// opening, every DDL statement and migrations. Its API is synchronous, and
// every store operation, read or write, runs in transaction(): no write can
// interleave with another in this process, and an operation reads its
// authorization and its data in one snapshot.
export class Database {
  readonly #connection: DatabaseSync;
  // The database file's real path, the one SQLite opened.
  readonly file: string;

  private constructor(connection: DatabaseSync, file: string) {
    this.#connection = connection;
    this.file = file;
  }

  // open opens the database file, creating it and its directory when missing,
  // applies any migrations this release has that the file lacks, and then
  // switches a database not yet vacuumed incrementally to that mode, logging
  // and carrying on when it cannot. It refuses an unsafe data directory or
  // file, a file that is not an Agention database, and a database written by
  // a newer release.
  static open(file: string, options: { log?: (message: string) => void } = {}): Database {
    const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
    const real = prepareDatabaseFile(path.resolve(file), applicationId);
    const database = new Database(new DatabaseSync(real), real);
    try {
      // recursive_triggers makes a REPLACE that deletes a row fire its delete
      // triggers, so REPLACE cannot rewrite an append-only log either.
      // journal_size_limit truncates a log that a backup's long read let grow
      // once a checkpoint empties it.
      database.#connection.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA recursive_triggers = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = FULL;
        PRAGMA journal_size_limit = ${journalSizeLimit};
      `);
      database.#migrate();
      // After the migrations, so a new database's first header, with its
      // application id, is written to the main file rather than the log.
      database.#connection.exec("PRAGMA journal_mode = WAL");
      enableIncrementalVacuum(database.#connection, log);
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

  // incrementalVacuum says whether the database returns freed pages to the
  // disk through vacuumStep, which a database the open could not yet switch
  // does not.
  get incrementalVacuum(): boolean {
    return vacuumMode(this.#connection) === incremental;
  }

  // freePages counts the database file's pages that hold nothing.
  freePages(): number {
    const { freelist_count: count } = this.prepare("PRAGMA freelist_count").get() as {
      freelist_count: number;
    };
    return count;
  }

  // vacuumStep returns up to pages free pages to the disk, outside any
  // transaction, holding the connection only as long as that takes. A
  // prepared incremental_vacuum frees one page each time it runs, so it runs
  // through exec, which frees them all.
  vacuumStep(pages: number): void {
    if (!Number.isSafeInteger(pages) || pages < 1) {
      throw new RangeError(`a vacuum step frees at least one page, not ${pages}`);
    }
    if (this.#connection.isTransaction) {
      throw new TypeError("a vacuum step runs outside any transaction");
    }
    this.#connection.exec(`PRAGMA incremental_vacuum(${pages})`);
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
