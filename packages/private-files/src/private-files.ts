import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import path from "node:path";

// The private-file rule, for a file only the OS user running Agention, its
// effective user, may read or replace, such as the server's database or a
// bridge's session key:
//
// - the file is a regular file, never a symlink, that belongs to the user,
//   with no group or other permissions;
// - the directory holding it belongs to the user, with no group or other
//   permissions;
// - symlinks on the way to that directory are resolved, and every directory
//   on its real path, from the root down, belongs to the user or root and no
//   other user can write to it.
//
// Every directory on the real path is then one that only the user or root can
// change, so a symlink swapped on the way can only lead somewhere that breaks
// the rule, or somewhere no other user can write. Each function here applies
// the whole rule, so no caller applies half of it, and works only in the real
// path. None changes the permissions of a path that exists: each refuses
// rather than repairs, with a PrivateFileError that the caller words as what
// to change. A file system error on the way is a refusal too, never a raw
// error.
//
// A directory may instead be shared with a group, for a program running as
// another user that only reads its files, such as a log collector: the same
// rule, except that the directory belongs to the user and that group with
// mode 0750, and each file in it to the user and the group with mode 0640.
// The group can read, never write, and others still have no access.

// Why a path breaks the private-file rule.
export type PrivateFileReason =
  // The platform cannot report file ownership.
  | "unsupported_platform"
  // The path cannot be searched, read or created, for the error code the
  // refusal carries, such as EACCES for a directory this user cannot search,
  // ELOOP for a symlink loop, or ENAMETOOLONG.
  | "inaccessible"
  // Something on the real path that must be a directory is not one, such as a
  // file, or a symlink that leads nowhere.
  | "not_a_directory"
  // A directory on the real path belongs to a user other than the current one
  // or root.
  | "foreign_ancestor"
  // A directory on the real path is writable by another user.
  | "writable_ancestor"
  // The directory holding the file does not belong to the current user, or
  // has group or other permissions; or, shared with a group, it does not
  // belong to the user and that group with mode 0750.
  | "directory_not_private"
  // The file is a symlink, a directory or anything else but a regular file.
  | "not_a_file"
  // The file does not belong to the current user, or has group or other
  // permissions; or, shared with a group, it does not belong to the user and
  // that group with mode 0640.
  | "file_not_private";

// A refusal under the private-file rule: the reason, the real path at fault,
// and, for an inaccessible path, the error code. Its message is for logs; each
// caller words the refusal for the person who has to change something.
export class PrivateFileError extends Error {
  override name = "PrivateFileError";
  readonly reason: PrivateFileReason;
  readonly path: string;
  readonly code: string | undefined;

  constructor(reason: PrivateFileReason, at: string, code?: string) {
    super(code === undefined ? `${at}: ${reason}` : `${at}: ${reason} (${code})`);
    this.reason = reason;
    this.path = at;
    this.code = code;
  }
}

// shellQuoted quotes a path for a shell command a refusal suggests, so that
// it copies safely whatever it holds, such as a space or a quote.
export function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const sticky = 0o1000;

interface User {
  uid: number;
}

// The effective user, which owns what this process creates.
function currentUser(at: string): User {
  if (process.geteuid === undefined) {
    throw new PrivateFileError("unsupported_platform", at);
  }
  return { uid: process.geteuid() };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// refusing runs one of the rule's operations, turning a file system error it
// meets into an inaccessible refusal that names the path and the error code.
function refusing<T>(at: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const { syscall, code, path: failed } = error as NodeJS.ErrnoException;
    if (error instanceof PrivateFileError || syscall === undefined || code === undefined) {
      throw error;
    }
    throw new PrivateFileError("inaccessible", failed ?? at, code);
  }
}

function lstatOrUndefined(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

// The modes a directory and its files take: private, or shared with a
// reading group, by its id, which the user must be a member of to give it the
// directory and its files.
function modesFor(gid: number | undefined) {
  return gid === undefined
    ? { directory: 0o700, file: 0o600, gid }
    : { directory: 0o750, file: 0o640, gid };
}

// The parts of a directory's status the ancestor rule reads.
export interface DirectoryStatus {
  uid: number;
  mode: number;
  isDirectory(): boolean;
}

// checkAncestor applies the rule for each directory on a private file's real
// path: a directory that belongs to the current user or root, and that no
// other user can write to. A sticky directory such as /tmp is accepted
// however writable, since there no one can replace another user's entries. A
// group-writable one is refused even when the group is the user's own:
// nothing tells whether that group has other members.
export function checkAncestor(
  directory: string,
  status: DirectoryStatus,
  user: { uid: number },
): void {
  if (!status.isDirectory()) {
    throw new PrivateFileError("not_a_directory", directory);
  }
  if (status.uid !== user.uid && status.uid !== 0) {
    throw new PrivateFileError("foreign_ancestor", directory);
  }
  if ((status.mode & sticky) === 0 && (status.mode & 0o022) !== 0) {
    throw new PrivateFileError("writable_ancestor", directory);
  }
}

// checkOwnDirectory applies the rule for the directory that holds the file: a
// directory that belongs to the current user, with no group or other
// permissions, or, shared with a group, one that belongs to the user and the
// group with mode 0750.
function checkOwnDirectory(directory: string, status: Stats, user: User, gid?: number): void {
  if (!status.isDirectory()) {
    throw new PrivateFileError("not_a_directory", directory);
  }
  const allowed =
    gid === undefined
      ? (status.mode & 0o077) === 0
      : status.gid === gid && (status.mode & 0o777) === 0o750;
  if (status.uid !== user.uid || !allowed) {
    throw new PrivateFileError("directory_not_private", directory);
  }
}

// checkedPath resolves a directory's path as far as it exists, from its
// deepest existing ancestor or itself, and applies the rule to every
// directory on that real path. It returns the real path, with the names below
// it that do not exist yet, and the user the rule is for. A directory that
// exists is checked as the file's own first, so that one others can write to
// is refused once, for what it needs.
function checkedPath(
  directory: string,
  gid?: number,
): { real: string; missing: string[]; user: User } {
  const absolute = path.resolve(directory);
  const user = currentUser(absolute);
  const missing: string[] = [];
  let real: string | undefined;
  for (let given = absolute; real === undefined; given = path.dirname(given)) {
    try {
      real = realpathSync(given);
    } catch (error) {
      const code = errorCode(error);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || path.dirname(given) === given) {
        throw error;
      }
      missing.unshift(path.basename(given));
    }
  }
  if (missing.length === 0) {
    checkOwnDirectory(real, lstatSync(real), user, gid);
  }
  const components: string[] = [];
  for (let p = real; ; p = path.dirname(p)) {
    components.unshift(p);
    if (path.dirname(p) === p) {
      break;
    }
  }
  for (const component of components) {
    checkAncestor(component, lstatSync(component), user);
  }
  return { real, missing, user };
}

// existingDirectory applies the rule to a directory that should exist, and
// returns its real path, or undefined when it is missing.
function existingDirectory(directory: string, gid?: number): string | undefined {
  const { real, missing } = checkedPath(directory, gid);
  return missing.length === 0 ? real : undefined;
}

function checkFile(file: string, status: Stats, user: User, gid?: number): void {
  if (!status.isFile()) {
    throw new PrivateFileError("not_a_file", file);
  }
  const allowed =
    gid === undefined
      ? (status.mode & 0o077) === 0
      : status.gid === gid && (status.mode & 0o777) === 0o640;
  if (status.uid !== user.uid || !allowed) {
    throw new PrivateFileError("file_not_private", file);
  }
}

// ensurePrivateDirectory makes a directory to hold private files, creating it
// and any missing directory above it with mode 0700 whatever the umask, or,
// shared with a group, with mode 0750 in that group, and returns its real
// path, the one to work in.
export function ensurePrivateDirectory(directory: string, gid?: number): string {
  return refusing(directory, () => {
    const modes = modesFor(gid);
    const { real, missing, user } = checkedPath(directory, gid);
    let current = real;
    for (const name of missing) {
      current = path.join(current, name);
      try {
        mkdirSync(current, { mode: modes.directory });
        // The group is set first, since changing it may clear mode bits, and
        // the umask may have narrowed the mode; this directory is ours to set.
        if (modes.gid !== undefined) {
          chownSync(current, user.uid, modes.gid);
        }
        chmodSync(current, modes.directory);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      }
      checkAncestor(current, lstatSync(current), user);
    }
    checkOwnDirectory(current, lstatSync(current), user, gid);
    return current;
  });
}

// checkPrivateFile applies the rule to a file that another program opens,
// such as one SQLite keeps beside its database, without opening it. A missing
// file passes.
export function checkPrivateFile(file: string): void {
  refusing(file, () => {
    const absolute = path.resolve(file);
    const directory = existingDirectory(path.dirname(absolute));
    if (directory === undefined) {
      return;
    }
    const real = path.join(directory, path.basename(absolute));
    const status = lstatOrUndefined(real);
    if (status !== undefined) {
      checkFile(real, status, currentUser(real));
    }
  });
}

// openPrivateFile opens a private file for reading and returns its
// descriptor, or undefined when the file or its directory is missing. The
// checks run on the file it opened, and opening never waits, so a FIFO in the
// file's place is refused rather than holding the open up.
export function openPrivateFile(file: string): number | undefined {
  return refusing(file, () => {
    const absolute = path.resolve(file);
    const directory = existingDirectory(path.dirname(absolute));
    if (directory === undefined) {
      return undefined;
    }
    const real = path.join(directory, path.basename(absolute));
    try {
      return openExisting(real, constants.O_RDONLY | constants.O_NOFOLLOW, currentUser(real));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  });
}

// createPrivateFile creates a new, empty private file with mode 0600 whatever
// the umask, in a directory ensurePrivateDirectory has made, and returns its
// descriptor, open for reading and writing. It returns undefined when
// anything is at that path already, a symlink included.
export function createPrivateFile(file: string): number | undefined {
  return refusing(file, () => {
    const absolute = path.resolve(file);
    const directory = existingDirectory(path.dirname(absolute));
    if (directory === undefined) {
      throw new PrivateFileError("inaccessible", path.dirname(absolute), "ENOENT");
    }
    let fd: number;
    try {
      fd = openSync(
        path.join(directory, path.basename(absolute)),
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        return undefined;
      }
      throw error;
    }
    try {
      // The umask may have narrowed the mode; this file is ours to set.
      fchmodSync(fd, 0o600);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return fd;
  });
}

// appendToPrivateFile opens a private file for appending, in a directory
// ensurePrivateDirectory has made with the same group, if any, and returns
// its descriptor: a new file is created with mode 0600 whatever the umask, or
// 0640 in the group; one that exists is opened and checked, never changed.
export function appendToPrivateFile(file: string, gid?: number): number {
  return refusing(file, () => {
    const absolute = path.resolve(file);
    const directory = existingDirectory(path.dirname(absolute), gid);
    if (directory === undefined) {
      throw new PrivateFileError("inaccessible", path.dirname(absolute), "ENOENT");
    }
    const real = path.join(directory, path.basename(absolute));
    const user = currentUser(real);
    const modes = modesFor(gid);
    const append = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;
    let fd: number;
    try {
      fd = openSync(real, append | constants.O_CREAT | constants.O_EXCL, modes.file);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      return openExisting(real, append, user, gid);
    }
    try {
      // The group is set first, since changing it may clear mode bits.
      if (modes.gid !== undefined) {
        fchownSync(fd, user.uid, modes.gid);
      }
      fchmodSync(fd, modes.file);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return fd;
  });
}

// openExisting opens a file that exists with the flags given, never waiting
// on one that would block, and checks the file it opened.
function openExisting(real: string, flags: number, user: User, gid?: number): number {
  let fd: number;
  try {
    fd = openSync(real, flags | constants.O_NONBLOCK);
  } catch (error) {
    // What open answers for a symlink it was told not to follow.
    if (errorCode(error) === "ELOOP") {
      throw new PrivateFileError("not_a_file", real);
    }
    throw error;
  }
  try {
    checkFile(real, fstatSync(fd), user, gid);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}
