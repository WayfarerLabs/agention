import type { PrivateFileReason } from "@wayfarerlabs/agention-private-files";

// Why the database could not be opened: the data directory or a database
// file breaks the private-file rule, for the reason given, or one of these.
export type DatabaseOpenReason =
  | PrivateFileReason
  // The database file is not a SQLite database.
  | "not_sqlite"
  // The database file is a SQLite database, but not this Agention's.
  | "not_agention"
  // The database was written by a newer Agention release.
  | "newer_schema";

// A refusal to open the data directory or the database. The reason is for
// code; the message is for the operator and names what to fix.
export class DatabaseOpenError extends Error {
  override name = "DatabaseOpenError";
  readonly reason: DatabaseOpenReason;

  constructor(reason: DatabaseOpenReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
