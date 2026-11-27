import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { testDirectory } from "../test-directory.ts";
import type { AuditRecord } from "./cursors.ts";
import { FileSink } from "./sinks/file.ts";

// What the disk does, as the sink asks it: each directory synced, by path; a
// file sync that fails while failSync holds, as a full or failing disk fails
// one; a write that tears, writing a few of its bytes and failing, and a
// truncation that fails, as a failing disk does; and a move of the file
// during its sync, as logrotate's.
const disk = vi.hoisted(() => ({
  syncedDirectories: [] as string[],
  failSync: false,
  tearWrites: false,
  failTruncate: false,
  moveOnSync: undefined as { from: string; to: string } | undefined,
}));

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const { promisify } = await import("node:util");
  const eio = () => Object.assign(new Error("input/output error"), { code: "EIO" });
  return {
    ...real,
    fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      if (disk.failSync) {
        callback(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));
        return;
      }
      if (disk.moveOnSync !== undefined) {
        real.renameSync(disk.moveOnSync.from, disk.moveOnSync.to);
        disk.moveOnSync = undefined;
      }
      real.fsync(fd, callback);
    },
    write: Object.assign((...args: Parameters<typeof real.write>) => real.write(...args), {
      [promisify.custom]: async (fd: number, buffer: Buffer, offset: number, length: number) => {
        if (disk.tearWrites) {
          // Partway through the batch's first line.
          real.writeSync(fd, buffer, offset, Math.min(length, 5));
          throw eio();
        }
        return promisify(real.write)(fd, buffer, offset, length);
      },
    }),
    ftruncateSync: (fd: number, length?: number) => {
      if (disk.failTruncate) {
        throw eio();
      }
      real.ftruncateSync(fd, length);
    },
    fsyncSync: (fd: number) => {
      if (real.fstatSync(fd).isDirectory()) {
        disk.syncedDirectories.push(real.readlinkSync(`/proc/self/fd/${fd}`));
      }
      real.fsyncSync(fd);
    },
  };
});

const record = (seq: number): AuditRecord => ({
  seq,
  uid: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  time: seq,
  json: JSON.stringify({ metadata: { sequence: seq } }),
});

let directory: string;
let now: number;
const day = 24 * 60 * 60_000;

beforeEach(() => {
  directory = path.join(testDirectory("audit-disk"), "audit");
  now = Date.UTC(2026, 10, 26, 12);
  disk.syncedDirectories = [];
  disk.failSync = false;
  disk.tearWrites = false;
  disk.failTruncate = false;
  disk.moveOnSync = undefined;
});

const open = () => FileSink.open({ directory, gid: undefined, keepDays: 30, clock: () => now });

it("cuts a batch it could not sync back off, so the next is written whole", async () => {
  const sink = open();
  await sink.deliver([record(1)]);
  disk.failSync = true;
  await expect(sink.deliver([record(2), record(3)])).rejects.toMatchObject({ code: "ENOSPC" });
  disk.failSync = false;
  await sink.deliver([record(2), record(3)]);
  await sink.close();
  expect(readFileSync(path.join(directory, "audit.jsonl"), "utf8")).toBe(
    [1, 2, 3].map((seq) => `${record(seq).json}\n`).join(""),
  );
});

it("syncs the directory once it makes a file, and once it renames one", async () => {
  const sink = open();
  expect(disk.syncedDirectories).toEqual([directory]);
  await sink.deliver([record(1)]);
  now += day;
  await sink.deliver([record(2)]);
  await sink.close();
  // The rename, then the new file.
  expect(disk.syncedDirectories).toEqual([directory, directory, directory]);
  expect(fs.existsSync(path.join(directory, "audit-2026-11-26.jsonl"))).toBe(true);
});

it("lets a file it could not cut back go, so the next write starts on a line of its own", async () => {
  const sink = open();
  await sink.deliver([record(1)]);
  disk.tearWrites = true;
  disk.failTruncate = true;
  await expect(sink.deliver([record(2), record(3)])).rejects.toMatchObject({ code: "EIO" });
  disk.tearWrites = false;
  disk.failTruncate = false;
  await sink.deliver([record(2), record(3)]);
  await sink.close();
  const text = readFileSync(path.join(directory, "audit.jsonl"), "utf8");
  const lines = text.split("\n");
  expect([text.endsWith("\n"), lines.at(-3), lines.at(-2)]).toEqual([
    true,
    record(2).json,
    record(3).json,
  ]);
});

it("writes a batch again, to a new file, when its file moved while it was written", async () => {
  const sink = open();
  const moved = path.join(directory, "moved");
  disk.moveOnSync = { from: path.join(directory, "audit.jsonl"), to: moved };
  await expect(sink.deliver([record(1)])).rejects.toThrow();
  await sink.deliver([record(1)]);
  await sink.close();
  expect([
    readFileSync(moved, "utf8"),
    readFileSync(path.join(directory, "audit.jsonl"), "utf8"),
  ]).toEqual([`${record(1).json}\n`, `${record(1).json}\n`]);
});
