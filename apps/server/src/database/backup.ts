import { createPrivateFile, PrivateFileError } from "@wayfarerlabs/agention-private-files";
import { closeSync, lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { existingDatabaseFile, privateFileRefusal } from "./database-file.ts";
import { applicationId } from "./migrations.ts";

// A backup that could not be written, for the reason its message gives the
// operator. Nothing of it is left behind.
export class BackupError extends Error {
  override name = "BackupError";
}

export interface BackupResult {
  // The copy's absolute path, its size in bytes, and its schema version.
  file: string;
  bytes: number;
  schemaVersion: number;
}

// The pages copied in each step of SQLite's online backup: the largest rate
// node:sqlite accepts, so the whole database is copied in one step, which a
// server writing meanwhile cannot restart.
const allPages = 2 ** 31 - 1;

// The files SQLite keeps beside a database.
const companionsOf = (file: string) => [`${file}-journal`, `${file}-wal`, `${file}-shm`];

// backupDatabase writes a consistent copy of the database at source into a
// new file at destination, whether a server is using the database or not.
// It opens the database read-only, without migrating it, and refuses one
// that is missing or is not an Agention database, with a DatabaseOpenError
// for the latter. The copy holds what the
// database holds, the instance's key included, so it is created as a private
// file, in a directory that obeys the private-file rule, and never over one
// that exists, nor at a path SQLite would take for one of the database's own
// files. Once written, the copy is checked; a backup that fails leaves no
// file behind. It never changes what the database holds, though SQLite may
// leave an empty -wal and a -shm beside a database no server has open.
export async function backupDatabase(source: string, destination: string): Promise<BackupResult> {
  const database = existingDatabaseFile(source, applicationId);
  if (database === undefined) {
    throw new BackupError(`${path.dirname(path.resolve(source))} holds no Agention database`);
  }
  const copy = createCopy(destination, database);
  try {
    const connection = new DatabaseSync(database, { readOnly: true });
    try {
      await backup(connection, copy, { rate: allPages });
    } finally {
      connection.close();
    }
    return { file: copy, ...checkCopy(copy) };
  } catch (error) {
    for (const file of [copy, ...companionsOf(copy)]) {
      rmSync(file, { force: true });
    }
    if (error instanceof BackupError) {
      throw error;
    }
    throw new BackupError(`the backup failed: ${(error as Error).message}`);
  }
}

// createCopy creates the copy's file, empty, readable only by its owner, and
// returns its real path. It refuses a file that exists, and one that SQLite
// would find files of its own beside, which it would read into the copy;
// and, before creating anything, a file SQLite would take for one of the
// database's own, at the database's real path, which may not exist yet.
function createCopy(destination: string, database: string): string {
  const absolute = path.resolve(destination);
  const real = realDirectory(path.dirname(absolute));
  if (
    real !== undefined &&
    companionsOf(database).includes(path.join(real, path.basename(absolute)))
  ) {
    throw new BackupError(
      `${absolute} is where SQLite keeps a file of the database's own; choose another file for the backup`,
    );
  }
  let fd: number | undefined;
  try {
    fd = createPrivateFile(absolute);
  } catch (error) {
    if (error instanceof PrivateFileError) {
      throw new BackupError(privateFileRefusal(error, "backup's directory"));
    }
    throw error;
  }
  if (fd === undefined) {
    throw new BackupError(`${absolute} exists; choose a new file for the backup`);
  }
  closeSync(fd);
  const copy = path.join(realpathSync(path.dirname(absolute)), path.basename(absolute));
  const beside = companionsOf(copy).find(present);
  if (beside !== undefined) {
    rmSync(copy, { force: true });
    throw new BackupError(`${beside} exists; move it aside, or choose another file for the backup`);
  }
  return copy;
}

// realDirectory is a directory's real path, or undefined while it does not
// exist.
function realDirectory(directory: string): string | undefined {
  try {
    return realpathSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

// present says whether anything is at a path, a symlink that leads nowhere
// included.
function present(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// checkCopy opens the copy read-only as immutable, so that SQLite creates
// nothing beside it, checks it, and reads its size and schema version.
function checkCopy(copy: string): { bytes: number; schemaVersion: number } {
  const url = pathToFileURL(copy);
  url.searchParams.set("immutable", "1");
  const connection = new DatabaseSync(url, { readOnly: true });
  try {
    const results = connection.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    if (results.length !== 1 || results[0]?.quick_check !== "ok") {
      throw new BackupError(
        `the copy failed its check: ${results.map((result) => result.quick_check).join("; ")}`,
      );
    }
    const { user_version: schemaVersion } = connection.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    return { bytes: statSync(copy).size, schemaVersion };
  } finally {
    connection.close();
  }
}
