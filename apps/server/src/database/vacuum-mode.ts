import type { DatabaseSync } from "node:sqlite";

// Incremental vacuuming returns the pages a deletion frees to the disk a step
// at a time, which removing an upload relies on. SQLite takes the mode only on
// a database without tables, or through a VACUUM that rewrites the whole
// file, and neither can run inside a transaction, so it cannot be part of a
// migration: the database's open switches a database still in mode none once,
// after its migrations. The check reads the database's header, so a database
// restored from an older release's backup converts too, and one already
// converted is never rewritten again.

// The auto_vacuum modes, as the pragma reads them.
const none = 0;
export const incremental = 2;

// vacuumMode reads the database's auto_vacuum mode from its header.
export function vacuumMode(connection: DatabaseSync): number {
  const { auto_vacuum: mode } = connection.prepare("PRAGMA auto_vacuum").get() as {
    auto_vacuum: number;
  };
  return mode;
}

// enableIncrementalVacuum switches a database in mode none to incremental
// vacuuming. VACUUM builds a copy of the database in SQLite's temporary
// directory and writes it whole through the log beside the database, which
// the checkpoint then empties. The migrations have committed by then, and an
// older release refuses the migrated database, so a failure, such as a full
// disk or another process holding the database past the busy timeout, never
// stops the open: it is logged with the space the step needs, the database
// stays in mode none, where freed pages stay in the file for reuse, and the
// next open tries again. VACUUM is atomic, so a crash during it leaves the
// database as it was.
export function enableIncrementalVacuum(
  connection: DatabaseSync,
  log: (message: string) => void,
): void {
  if (vacuumMode(connection) !== none) {
    return;
  }
  try {
    connection.exec("PRAGMA auto_vacuum = INCREMENTAL");
    connection.exec("VACUUM");
    connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    const { size } = connection
      .prepare("SELECT page_count * page_size AS size FROM pragma_page_count, pragma_page_size")
      .get() as { size: number };
    const mib = Math.ceil(size / (1024 * 1024));
    log(
      `cannot switch the database to incremental vacuuming, so space that removed uploads ` +
        `free stays in the database file for reuse until it does; this start carries on and ` +
        `the next one tries again. The switch rewrites the database once and needs about ` +
        `${mib} MiB free in SQLite's temporary directory (SQLITE_TMPDIR, else TMPDIR, ` +
        `else /var/tmp, else /tmp) and as much again beside the database: ` +
        `${(error as Error).message}`,
    );
  }
}
