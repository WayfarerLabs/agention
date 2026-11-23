import {
  createPrivateFile,
  ensurePrivateDirectory,
  openPrivateFile,
  PrivateFileError,
} from "@wayfarerlabs/agention-private-files";
import { cursor, name, threadNumber } from "@wayfarerlabs/agention-api";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { keyDirectory } from "./key-file.ts";

// A host directory is where the bridge and the Claude Code plugin's watcher
// meet: ~/.config/agention/_hosts/claude/<pid>/, named for the Claude Code
// process that runs both. No server's host is named _hosts, since an origin's
// host admits no underscore, so it never meets a session's key directory. It
// holds, under the private-file rule:
//
// - watcher: the running watcher's pid, which the watcher keeps;
// - hooked: the mark the watcher writes, which says the plugin's hooks run
//   in this host process;
// - wake: the notice the bridge writes for the watcher to take and print;
// - cursor: the bridge's wait position, with the server and the granted
//   names it belongs to, and the threads the wake file not yet taken names.
//
// The watcher, a shell script, keeps the same layout: the plugin's
// hooks/agention-watcher.sh.

const markName = "hooked";
const wakeName = "wake";
const cursorName = "cursor";
// Where the bridge moves a wake file it takes back to rewrite.
const reclaimedName = "wake.reclaimed";

// The directory below the home directory that holds every Claude Code host
// process's directory.
export function claudeHostsDirectory(home: string): string {
  return path.join(keyDirectory(home), "_hosts", "claude");
}

// A thread a notice names, with how many messages in it are unread.
export interface NoticeThread {
  thread: number;
  unread: number;
}

// What the cursor file holds: where the session's wait stands on one server
// under the names the operator granted, and the threads the wake file names
// while the watcher has not taken it.
export const waitPosition = z.object({
  origin: z.string(),
  agent: name,
  session: name,
  since: cursor,
  notice: z.array(z.object({ thread: threadNumber, unread: z.number().int().positive() })),
});
export type WaitPosition = z.infer<typeof waitPosition>;

export class HostDirectory {
  readonly path: string;

  constructor(home: string, pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`a host process's pid must be a positive integer, not ${pid}`);
    }
    this.path = path.join(claudeHostsDirectory(home), String(pid));
  }

  // hooked says whether the watcher has marked this directory, which counts
  // only while the directory and the mark obey the private-file rule.
  hooked(): boolean {
    let fd: number | undefined;
    try {
      fd = openPrivateFile(path.join(this.path, markName));
    } catch (error) {
      if (error instanceof PrivateFileError) {
        return false;
      }
      throw error;
    }
    if (fd === undefined) {
      return false;
    }
    closeSync(fd);
    return true;
  }

  // readCursor returns the saved wait position, or undefined when there is
  // none or it does not parse. It is state an earlier bridge wrote, which may
  // be truncated or from another release, so it is checked as it is read.
  readCursor(): WaitPosition | undefined {
    const fd = openPrivateFile(path.join(this.path, cursorName));
    if (fd === undefined) {
      return undefined;
    }
    let text: string;
    try {
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    try {
      const parsed = waitPosition.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  saveCursor(position: WaitPosition): void {
    this.#write(cursorName, `${JSON.stringify(position)}\n`);
  }

  // reclaimWake takes back a wake file the watcher has not taken, so the
  // bridge can write one naming more threads, and says whether there was
  // one. The rename is atomic, so the bridge and the watcher never both take
  // the same file.
  reclaimWake(): boolean {
    const directory = ensurePrivateDirectory(this.path);
    try {
      renameSync(path.join(directory, wakeName), path.join(directory, reclaimedName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    rmSync(path.join(directory, reclaimedName), { force: true });
    return true;
  }

  writeWake(notice: string): void {
    this.#write(wakeName, notice);
  }

  // write puts a file in place whole: written to a new private file in the
  // directory's real path, then renamed over the name. It does not wait for
  // the disk, which on a busy machine takes seconds the bridge's tools would
  // wait too: a cursor lost to a crash of the machine only pushes again what
  // is still unread, since one that does not parse counts as none.
  #write(fileName: string, text: string): void {
    const directory = ensurePrivateDirectory(this.path);
    const temporary = path.join(directory, `${fileName}.${randomBytes(8).toString("hex")}.new`);
    const fd = createPrivateFile(temporary);
    if (fd === undefined) {
      throw new Error(`${temporary} is in the way`);
    }
    try {
      writeSync(fd, text);
    } catch (error) {
      closeSync(fd);
      rmSync(temporary, { force: true });
      throw error;
    }
    closeSync(fd);
    try {
      renameSync(temporary, path.join(directory, fileName));
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

// findHostDirectory returns the directory of the first of the ancestors given
// whose directory has the watcher's mark, or undefined when none has.
export function findHostDirectory(
  home: string,
  ancestors: readonly number[],
): HostDirectory | undefined {
  for (const pid of ancestors) {
    const directory = new HostDirectory(home, pid);
    if (directory.hooked()) {
      return directory;
    }
  }
  return undefined;
}

// pruneHostDirectories removes the directory of every host process that is
// no longer running, so ended host sessions leave nothing behind. Only
// directories named for a pid are touched, and only in the real path of a
// directory that obeys the private-file rule.
export function pruneHostDirectories(home: string, alive = processAlive): void {
  const hosts = ensurePrivateDirectory(claudeHostsDirectory(home));
  for (const entry of readdirSync(hosts)) {
    if (!/^[1-9][0-9]{0,9}$/.test(entry) || alive(Number(entry))) {
      continue;
    }
    const at = path.join(hosts, entry);
    if (lstatSync(at, { throwIfNoEntry: false })?.isDirectory() === true) {
      // A watcher pruning the same directory may get there first.
      rmSync(at, { recursive: true, force: true });
    }
  }
}

// processAlive says whether a process of this user runs with the pid. One of
// another user's is no host of this user's sessions.
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
