import {
  checkPrivateFile,
  createPrivateFile,
  ensurePrivateDirectory,
  openPrivateFile,
  PrivateFileError,
  shellQuoted,
} from "@wayfarerlabs/agention-private-files";
import { closeSync, fstatSync, readSync } from "node:fs";
import path from "node:path";
import { DatabaseOpenError } from "./open-error.ts";

const sqliteMagic = Buffer.from("SQLite format 3\u0000", "latin1");
const headerLength = 100;
const applicationIdOffset = 68;

// prepareDatabaseFile makes the database file safe for SQLite to open, and
// returns its real path, the one SQLite opens: the database and the files
// SQLite keeps beside it obey the private-file rule, and an existing database
// is an Agention one, judged from its header before SQLite reads it. A
// missing database file is created empty, with its directory and any missing
// directory above. SQLite gives the files it creates beside the database the
// database's mode.
export function prepareDatabaseFile(file: string, applicationId: number): string {
  try {
    const real = path.join(ensurePrivateDirectory(path.dirname(file)), path.basename(file));
    for (const companion of [`${real}-wal`, `${real}-shm`, `${real}-journal`]) {
      checkPrivateFile(companion);
    }
    const fd = openDatabaseFile(real);
    try {
      checkHeader(real, fd, applicationId);
    } finally {
      closeSync(fd);
    }
    return real;
  } catch (error) {
    throw error instanceof PrivateFileError ? refusal(error) : error;
  }
}

// openDatabaseFile creates the database file, or opens the one there. A file
// removed between the two is tried once more, then refused.
function openDatabaseFile(real: string): number {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fd = createPrivateFile(real) ?? openPrivateFile(real);
    if (fd !== undefined) {
      return fd;
    }
  }
  throw new DatabaseOpenError(
    "inaccessible",
    `${real} was removed while Agention was opening it; start Agention again`,
  );
}

// checkHeader reads the database header directly, since even a read-only
// SQLite connection may create files beside the database. An empty file is
// one that this or a previous start created and never initialized.
function checkHeader(file: string, fd: number, applicationId: number): void {
  const header = Buffer.alloc(headerLength);
  let read: number;
  try {
    if (fstatSync(fd).size === 0) {
      return;
    }
    read = readSync(fd, header, 0, headerLength, 0);
  } catch (error) {
    const { code = "unknown error" } = error as NodeJS.ErrnoException;
    throw new DatabaseOpenError("inaccessible", `${file} could not be read (${code})`);
  }
  if (read < headerLength || !header.subarray(0, sqliteMagic.length).equals(sqliteMagic)) {
    throw new DatabaseOpenError("not_sqlite", `${file} is not a SQLite database`);
  }
  if (header.readUInt32BE(applicationIdOffset) !== applicationId) {
    throw new DatabaseOpenError(
      "not_agention",
      `${file} is a SQLite database, but not an Agention one`,
    );
  }
}

// refusal words a refusal under the private-file rule for the operator, with
// what to change, since Agention changes nothing that exists.
function refusal(error: PrivateFileError): DatabaseOpenError {
  const at = error.path;
  switch (error.reason) {
    case "unsupported_platform":
      return new DatabaseOpenError(
        error.reason,
        "Agention needs a POSIX system to check file ownership",
      );
    case "inaccessible":
      return new DatabaseOpenError(
        error.reason,
        `${at} cannot be reached (${error.code ?? "unknown error"}); check that this user can ` +
          "search every directory on its path, and read and write the data directory",
      );
    case "not_a_directory":
      return new DatabaseOpenError(
        error.reason,
        `${at} is on the data directory's path, so it must be a directory`,
      );
    case "foreign_ancestor":
      return new DatabaseOpenError(
        error.reason,
        `${at} must belong to the current user or root; choose a data directory whose ` +
          "ancestors do",
      );
    case "writable_ancestor":
      return new DatabaseOpenError(
        error.reason,
        `${at} is writable by its group or others; run chmod go-w ${shellQuoted(at)}, or ` +
          "choose a data directory whose ancestors only their owners can write to",
      );
    case "directory_not_private":
      return new DatabaseOpenError(
        error.reason,
        `${at} must belong to the current user with mode 0700; its permissions were not changed`,
      );
    case "not_a_file":
      return new DatabaseOpenError(
        error.reason,
        `${at} must be a regular file, not a symlink or a directory`,
      );
    case "file_not_private":
      return new DatabaseOpenError(
        error.reason,
        `${at} must belong to the current user with mode 0600; its permissions were not changed`,
      );
  }
}
