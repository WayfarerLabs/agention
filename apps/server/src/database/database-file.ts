import {
  checkPrivateFile,
  createPrivateFile,
  ensurePrivateDirectory,
  openPrivateFile,
  PrivateFileError,
  shellQuoted,
} from "@wayfarerlabs/agention-private-files";
import { closeSync, fstatSync, readSync, realpathSync } from "node:fs";
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

// existingDatabaseFile checks a database file that must exist without
// creating anything, and returns its real path, the one SQLite opens, or
// undefined when there is no database there: no file, or an empty one that
// a start created and never initialized. It refuses what prepareDatabaseFile
// refuses.
export function existingDatabaseFile(file: string, applicationId: number): string | undefined {
  try {
    const absolute = path.resolve(file);
    const fd = openPrivateFile(absolute);
    if (fd === undefined) {
      return undefined;
    }
    let real: string;
    try {
      real = path.join(realpathSync(path.dirname(absolute)), path.basename(absolute));
      for (const companion of [`${real}-wal`, `${real}-shm`, `${real}-journal`]) {
        checkPrivateFile(companion);
      }
      if (!checkHeader(real, fd, applicationId)) {
        return undefined;
      }
    } finally {
      closeSync(fd);
    }
    return real;
  } catch (error) {
    throw error instanceof PrivateFileError ? refusal(error) : error;
  }
}

// checkHeader reads the database header directly, since even a read-only
// SQLite connection may create files beside the database, and says whether
// the file holds a database. An empty file is one that this or a previous
// start created and never initialized.
function checkHeader(file: string, fd: number, applicationId: number): boolean {
  const header = Buffer.alloc(headerLength);
  let read: number;
  try {
    if (fstatSync(fd).size === 0) {
      return false;
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
  return true;
}

// refusal words a refusal under the private-file rule for the data
// directory and its database.
function refusal(error: PrivateFileError): DatabaseOpenError {
  return new DatabaseOpenError(error.reason, privateFileRefusal(error, "data directory"));
}

// privateFileRefusal words a refusal under the private-file rule for the
// operator, with what to change, since Agention changes nothing that exists.
// The place names the directory the rule applies to, such as the data
// directory, and group the group it is shared with, if it is.
export function privateFileRefusal(error: PrivateFileError, place: string, group?: string): string {
  const at = error.path;
  switch (error.reason) {
    case "unsupported_platform":
      return "Agention needs a POSIX system to check file ownership";
    case "inaccessible":
      return (
        `${at} cannot be reached (${error.code ?? "unknown error"}); check that this user can ` +
        `search every directory on its path, and read and write the ${place}`
      );
    case "not_a_directory":
      return `${at} is on the ${place}'s path, so it must be a directory`;
    case "foreign_ancestor":
      return `${at} must belong to the current user or root; choose a ${place} whose ancestors do`;
    case "writable_ancestor":
      return (
        `${at} is writable by its group or others; run chmod go-w ${shellQuoted(at)}, or ` +
        `choose a ${place} whose ancestors only their owners can write to`
      );
    case "directory_not_private":
      return group === undefined
        ? `${at} must belong to the current user with mode 0700; its permissions were not changed`
        : `${at} must belong to the current user and ${group} with mode 0750; its permissions ` +
            "were not changed";
    case "not_a_file":
      return `${at} must be a regular file, not a symlink or a directory`;
    case "file_not_private":
      return group === undefined
        ? `${at} must belong to the current user with mode 0600; its permissions were not changed`
        : `${at} must belong to the current user and ${group} with mode 0640; its permissions ` +
            "were not changed";
  }
}
