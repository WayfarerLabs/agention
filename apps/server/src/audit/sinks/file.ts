import { appendToPrivateFile, ensurePrivateDirectory } from "@wayfarerlabs/agention-private-files";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  write,
  writeSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AuditRecord } from "../cursors.ts";
import type { Sink } from "../dispatcher.ts";
import { lines } from "./stdout.ts";

// The file sink writes each event as a JSON line to audit.jsonl in its
// directory, for a collector on the same machine to tail. At the first write
// on a later UTC day, the file is renamed for the UTC day it was written on,
// audit-YYYY-MM-DD.jsonl, and a new one started; the newest keepDays renamed
// files are kept. The directory and its files follow the private-file rule,
// or are shared with a reading group, for a collector running as its own
// user. A batch is delivered once it is written and synced to the disk, and
// the directory is synced too whenever a file in it is made or renamed.
//
// Every line the file holds is whole: a file that ends partway through a
// line, as a crash mid-write leaves it, is ended before the next write, and a
// write that fails is cut back off. A file renamed or removed from under the
// sink, by logrotate or a collector, is let go, and the next write starts a
// new one.

export const currentName = "audit.jsonl";

// The default number of renamed files kept, and its bounds.
export const defaultKeepDays = 30;
export const maxKeepDays = 3650;

const writeAsync = promisify(write);
const fsyncAsync = promisify(fsync);

// A renamed file: audit-YYYY-MM-DD.jsonl, or, for a second file of a day,
// as when a clock stepped back, audit-YYYY-MM-DD.N.jsonl.
const rotatedName = /^audit-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);

export interface FileSinkOptions {
  directory: string;
  // The group the directory and its files are shared with, by id, if any.
  gid: number | undefined;
  keepDays: number;
  clock: () => number;
}

export class FileSink implements Sink {
  readonly kind = "file";
  readonly #directory: string;
  readonly #gid: number | undefined;
  readonly #keepDays: number;
  readonly #clock: () => number;
  // The current file, open for appending; undefined once a rotation or a
  // move from under the sink has let it go, until the next write opens one.
  #fd: number | undefined;
  // The UTC day the current file holds events of.
  #day: string;
  // The delivery under way, which closing waits for.
  #delivering: Promise<void> | undefined;

  // open makes the directory, or checks the one there, opens the current
  // file for appending, and removes the renamed files beyond those kept. It
  // throws the PrivateFileError of a directory or file the rule refuses.
  static open(options: FileSinkOptions): FileSink {
    const directory = ensurePrivateDirectory(options.directory, options.gid);
    return new FileSink(directory, options);
  }

  private constructor(directory: string, options: FileSinkOptions) {
    this.#directory = directory;
    this.#gid = options.gid;
    this.#keepDays = options.keepDays;
    this.#clock = options.clock;
    // The day the file holds is its last write's, read before a torn line is
    // ended, which would make it today's.
    const opened = this.#openCurrent();
    this.#day = opened.size === 0 ? dayOf(this.#clock()) : dayOf(opened.mtimeMs);
    this.#prune();
  }

  get #current(): string {
    return path.join(this.#directory, currentName);
  }

  deliver(batch: readonly AuditRecord[]): Promise<void> {
    const delivering = this.#write(Buffer.from(lines(batch)));
    this.#delivering = delivering;
    return delivering.finally(() => {
      if (this.#delivering === delivering) {
        this.#delivering = undefined;
      }
    });
  }

  async #write(bytes: Buffer): Promise<void> {
    const fd = this.#rotate();
    const { size } = fstatSync(fd);
    try {
      for (let offset = 0; offset < bytes.length;) {
        offset += (await writeAsync(fd, bytes, offset, bytes.length - offset)).bytesWritten;
      }
      await fsyncAsync(fd);
    } catch (error) {
      // What part of the batch was written is cut off, so no line is torn.
      try {
        ftruncateSync(fd, size);
      } catch {
        // The file is let go, so the next open ends the line left torn.
        this.#closeCurrent();
      }
      throw error;
    }
    // A file moved or removed while the batch was written holds it where no
    // collector may look, so the batch goes again, to a new file.
    if (!this.#atItsPath(fd)) {
      this.#closeCurrent();
      throw new Error("the audit file was moved while it was written");
    }
  }

  // close waits for the delivery under way, so no write outlives its file,
  // and closes the current file.
  async close(): Promise<void> {
    await this.#delivering?.catch(() => undefined);
    this.#closeCurrent();
  }

  #closeCurrent(): void {
    if (this.#fd !== undefined) {
      closeSync(this.#fd);
      this.#fd = undefined;
    }
  }

  // openCurrent opens the current file, made if missing, ends a line it
  // left torn, and syncs the directory, which may now hold a new file. It
  // answers the descriptor, and the file's size and time of last write as it
  // was opened.
  #openCurrent(): { fd: number; size: number; mtimeMs: number } {
    const fd = appendToPrivateFile(this.#current, this.#gid);
    let opened;
    try {
      const { size, mtimeMs } = fstatSync(fd);
      opened = { fd, size, mtimeMs };
      if (size > 0 && !endsWithNewline(this.#current, size)) {
        writeSync(fd, "\n");
        fsyncSync(fd);
      }
      this.#syncDirectory();
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.#fd = fd;
    return opened;
  }

  #syncDirectory(): void {
    const fd = openSync(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  // rotate answers the file to write today's events to: once the current
  // file's day has passed, it is renamed for its day and a new one started; a
  // file that holds nothing yet is just taken for today. A current file no
  // longer at its path is let go for a new one.
  #rotate(): number {
    if (this.#fd !== undefined && !this.#atItsPath(this.#fd)) {
      this.#closeCurrent();
    }
    const today = dayOf(this.#clock());
    if (today !== this.#day) {
      if (this.#fd === undefined || fstatSync(this.#fd).size > 0) {
        this.#renameCurrent();
        this.#closeCurrent();
        this.#prune();
      }
      this.#day = today;
    }
    return this.#fd ?? this.#openCurrent().fd;
  }

  // atItsPath says whether the open file is still the one at the current
  // file's path.
  #atItsPath(fd: number): boolean {
    let atPath;
    try {
      atPath = statSync(this.#current);
    } catch {
      return false;
    }
    const open = fstatSync(fd);
    return atPath.ino === open.ino && atPath.dev === open.dev;
  }

  // renameCurrent gives the current file its day's name, never replacing a
  // file of that name, and syncs the directory. A current file already gone
  // is left so.
  #renameCurrent(): void {
    if (!existsSync(this.#current)) {
      return;
    }
    for (let n = 0; ; n++) {
      const name = path.join(this.#directory, `audit-${this.#day}${n === 0 ? "" : `.${n}`}.jsonl`);
      if (!existsSync(name)) {
        renameSync(this.#current, name);
        this.#syncDirectory();
        return;
      }
    }
  }

  // prune removes the renamed files beyond the newest keepDays.
  #prune(): void {
    const rotated = readdirSync(this.#directory)
      .map((name) => ({ name, match: rotatedName.exec(name) }))
      .filter(({ match }) => match !== null)
      .map(({ name, match }) => ({ name, day: match?.[1] ?? "", n: Number(match?.[2] ?? 0) }))
      .sort((a, b) => (a.day === b.day ? b.n - a.n : a.day < b.day ? 1 : -1));
    for (const { name } of rotated.slice(this.#keepDays)) {
      unlinkSync(path.join(this.#directory, name));
    }
  }
}

// endsWithNewline says whether a file of the size given ends a line, read
// through a descriptor of its own, since the sink's is open for appending
// only.
function endsWithNewline(file: string, size: number): boolean {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}
