import { cursor, name } from "@wayfarerlabs/agention-api";
import {
  createPrivateFile,
  ensurePrivateDirectory,
  openPrivateFile,
  PrivateFileError,
} from "@wayfarerlabs/agention-private-files";
import { createHash, randomBytes } from "node:crypto";
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
import type { SessionNames } from "./session.ts";

// A host directory is where bridges and the Claude Code plugin's watcher
// meet: ~/.config/agention/_hosts/claude/<host name>/<pid>/, named for the
// machine and the Claude Code process that runs them, so machines or pid
// namespaces sharing a home never meet. No server's host is named _hosts, since an
// origin's host admits no underscore, so it never meets a session's key
// directory. It holds, under the private-file rule:
//
// - watcher: the running watcher's pid, which the watcher keeps;
// - hooked: the mark the watcher writes, which says the plugin's hooks run
//   in this host process;
// - cursor-<session> and wake-<session>, for each session a bridge in this
//   host process pushes: the wait's position, and the notice the watcher
//   takes and prints. <session> stands for the server and the names the
//   operator granted, so two bridges of different sessions under one Claude
//   Code never touch each other's.
//
// The watcher, a shell script, keeps the same layout: the plugin's
// hooks/agention-watcher.sh.

const markName = "hooked";

// The directory below the home directory that holds the directory of every
// Claude Code process on the machine with the host name given.
export function claudeHostsDirectory(home: string, hostName: string): string {
  return path.join(keyDirectory(home), "_hosts", "claude", hostName);
}

// hostNamePart returns the machine's host name when it is a path component
// the watcher takes too: letters, digits, dots, hyphens and underscores, at
// most 255 of them, and neither . nor ..; otherwise undefined, and there is
// no push.
export function hostNamePart(hostName: string): string | undefined {
  return /^[A-Za-z0-9._-]{1,255}$/.test(hostName) && hostName !== "." && hostName !== ".."
    ? hostName
    : undefined;
}

// Where a session's wait is: on which server, under which granted names.
export interface SessionAt extends SessionNames {
  origin: string;
}

// What a cursor file holds: where the session's wait stands, with the server
// and the names it belongs to.
export const waitPosition = z.object({
  origin: z.string(),
  agent: name,
  session: name,
  since: cursor,
});
export type WaitPosition = z.infer<typeof waitPosition>;

// The part of a session's file names that stands for its server and names:
// a hash, so any origin and names make a short name of letters and digits.
function sessionPart(at: SessionAt): string {
  return createHash("sha256")
    .update(`${at.origin}\n${at.agent}\n${at.session}`)
    .digest("hex")
    .slice(0, 32);
}

export class HostDirectory {
  readonly path: string;

  constructor(home: string, hostName: string, pid: number) {
    this.path = path.join(claudeHostsDirectory(home, hostName), String(pid));
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

  // readCursor returns a session's saved wait position, or undefined when
  // there is none or it does not parse. It is state an earlier bridge wrote,
  // which may be truncated or from another release, so it is checked as it is
  // read.
  readCursor(at: SessionAt): WaitPosition | undefined {
    const fd = openPrivateFile(path.join(this.path, `cursor-${sessionPart(at)}`));
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

  dropCursor(at: SessionAt): void {
    rmSync(path.join(ensurePrivateDirectory(this.path), `cursor-${sessionPart(at)}`), {
      force: true,
    });
  }

  saveCursor(position: WaitPosition): void {
    this.#write(`cursor-${sessionPart(position)}`, `${JSON.stringify(position)}\n`);
  }

  // writeWake puts a session's notice in place for the watcher, replacing
  // one it has not taken yet.
  writeWake(at: SessionAt, notice: string): void {
    this.#write(`wake-${sessionPart(at)}`, notice);
  }

  // write puts a file in place whole: written to a new private file in the
  // directory's real path, hidden from the watcher by its leading dot, then
  // renamed over the name. It does not wait for the disk, which on a busy
  // machine takes seconds the bridge's tools would wait too: a cursor lost to
  // a crash of the machine only pushes again what is still unread, since one
  // that does not parse counts as none.
  #write(fileName: string, text: string): void {
    const directory = ensurePrivateDirectory(this.path);
    const temporary = path.join(directory, `.${fileName}.${randomBytes(8).toString("hex")}`);
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

// pruneHostDirectories removes the directory of every host process on this
// machine that is no longer running, so ended host sessions leave nothing
// behind. Only directories named for a pid are touched, only under this
// machine's host name, and only in the real path of a directory that obeys
// the private-file rule.
export function pruneHostDirectories(home: string, hostName: string): void {
  const hosts = ensurePrivateDirectory(claudeHostsDirectory(home, hostName));
  for (const entry of readdirSync(hosts)) {
    if (!/^[1-9][0-9]{0,9}$/.test(entry) || processAlive(Number(entry))) {
      continue;
    }
    const at = path.join(hosts, entry);
    if (lstatSync(at, { throwIfNoEntry: false })?.isDirectory() === true) {
      // Another bridge pruning the same directory may get there first.
      rmSync(at, { recursive: true, force: true });
    }
  }
}

// processAlive says whether a process of this user runs with the pid. One of
// another user's is no host of this user's sessions.
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
