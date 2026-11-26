import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { testDirectory } from "../test-directory.ts";
import type { AuditRecord } from "./cursors.ts";
import { FileSink } from "./sinks/file.ts";
import { stdoutSink } from "./sinks/stdout.ts";

const record = (seq: number): AuditRecord => ({
  seq,
  uid: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  time: seq,
  json: JSON.stringify({ metadata: { sequence: seq } }),
});

describe("the stdout sink", () => {
  it("writes each event as a JSON line, delivering a batch only once its write has drained", async () => {
    const chunks: string[] = [];
    let release: (() => void) | undefined;
    // A stream that holds each write until the test releases it, as a pipe
    // whose reader has fallen behind does.
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _, callback) {
        chunks.push(chunk.toString());
        release = callback;
      },
    });
    const sink = stdoutSink(stream);
    let delivered = false;
    const delivering = sink.deliver([record(1), record(2)]).then(() => {
      delivered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([chunks.join(""), delivered]).toEqual([`${record(1).json}\n${record(2).json}\n`, false]);
    release?.();
    await delivering;
    expect(delivered).toBe(true);
  });

  it("fails a delivery whose write fails", async () => {
    const stream = new Writable({
      write(_chunk, _, callback) {
        callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      },
    });
    stream.on("error", () => undefined);
    await expect(stdoutSink(stream).deliver([record(1)])).rejects.toMatchObject({ code: "EPIPE" });
  });
});

describe("the file sink", () => {
  let root: string;
  let now: number;
  const day = 24 * 60 * 60_000;
  const clock = () => now;

  beforeEach(() => {
    root = testDirectory("audit-files");
    now = Date.UTC(2026, 10, 26, 23, 59);
  });

  const mode = (target: string) => statSync(target).mode & 0o777;
  const open = (options: { directory?: string; keepDays?: number; gid?: number } = {}) =>
    FileSink.open({
      directory: options.directory ?? path.join(root, "audit"),
      gid: options.gid,
      keepDays: options.keepDays ?? 30,
      clock,
    });
  const read = (name: string) => readFileSync(path.join(root, "audit", name), "utf8");

  it("appends lines to audit.jsonl in a directory only its user can enter", async () => {
    const sink = open();
    await sink.deliver([record(1)]);
    await sink.close();
    // A restart appends to the file there.
    const again = open();
    await again.deliver([record(2), record(3)]);
    await again.close();
    expect(read("audit.jsonl")).toBe([1, 2, 3].map((seq) => `${record(seq).json}\n`).join(""));
    expect([mode(path.join(root, "audit")), mode(path.join(root, "audit", "audit.jsonl"))]).toEqual(
      [0o700, 0o600],
    );
  });

  it("renames the file for its day at the first write of a later one, keeping the newest", async () => {
    const sink = open({ keepDays: 2 });
    await sink.deliver([record(1)]);
    for (const seq of [2, 3, 4]) {
      now += day;
      await sink.deliver([record(seq)]);
    }
    await sink.close();
    expect(readdirSync(path.join(root, "audit")).sort()).toEqual([
      "audit-2026-11-27.jsonl",
      "audit-2026-11-28.jsonl",
      "audit.jsonl",
    ]);
    expect(read("audit-2026-11-28.jsonl")).toBe(`${record(3).json}\n`);
    expect(read("audit.jsonl")).toBe(`${record(4).json}\n`);
    expect(mode(path.join(root, "audit", "audit-2026-11-27.jsonl"))).toBe(0o600);
  });

  it("never replaces a renamed file, as when a clock stepped back", async () => {
    const sink = open();
    await sink.deliver([record(1)]);
    now += day;
    await sink.deliver([record(2)]);
    now -= day;
    await sink.deliver([record(3)]);
    now += day;
    await sink.deliver([record(4)]);
    await sink.close();
    expect(read("audit-2026-11-26.jsonl")).toBe(`${record(1).json}\n`);
    expect(read("audit-2026-11-27.jsonl")).toBe(`${record(2).json}\n`);
    expect(read("audit-2026-11-26.1.jsonl")).toBe(`${record(3).json}\n`);
  });

  it("shares the directory and its files with a group, for a collector", async () => {
    const gid =
      process.getgroups?.().find((each) => each !== process.getegid?.()) ??
      process.getegid?.() ??
      0;
    const sink = open({ gid });
    await sink.deliver([record(1)]);
    now += day;
    await sink.deliver([record(2)]);
    await sink.close();
    for (const [name, expected] of [
      ["", 0o750],
      ["audit.jsonl", 0o640],
      ["audit-2026-11-26.jsonl", 0o640],
    ] as const) {
      const target = path.join(root, "audit", name);
      expect([name, mode(target), statSync(target).gid]).toEqual([name, expected, gid]);
    }
  });

  it("ends a line a crash left torn before writing the next", async () => {
    const directory = path.join(root, "audit");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(directory, "audit.jsonl"), '{"torn":', { mode: 0o600 });
    const sink = open();
    await sink.deliver([record(1)]);
    await sink.close();
    expect(read("audit.jsonl")).toBe(`{"torn":\n${record(1).json}\n`);
  });

  it("dates a file a crash left torn by its last write, not by the line's end", async () => {
    const directory = path.join(root, "audit");
    mkdirSync(directory, { mode: 0o700 });
    const file = path.join(directory, "audit.jsonl");
    writeFileSync(file, `${record(1).json}\n{"torn":`, { mode: 0o600 });
    const written = new Date(now - day);
    utimesSync(file, written, written);
    const sink = open();
    await sink.deliver([record(2)]);
    await sink.close();
    expect([read("audit-2026-11-25.jsonl"), read("audit.jsonl")]).toEqual([
      `${record(1).json}\n{"torn":\n`,
      `${record(2).json}\n`,
    ]);
  });

  it("starts a new file once the one it wrote is moved or removed from under it", async () => {
    const sink = open();
    await sink.deliver([record(1)]);
    renameSync(path.join(root, "audit", "audit.jsonl"), path.join(root, "audit", "moved"));
    await sink.deliver([record(2)]);
    rmSync(path.join(root, "audit", "audit.jsonl"));
    await sink.deliver([record(3)]);
    await sink.close();
    expect([read("moved"), read("audit.jsonl")]).toEqual([
      `${record(1).json}\n`,
      `${record(3).json}\n`,
    ]);
  });

  it("closes only once the delivery under way has finished", async () => {
    const sink = open();
    const delivering = sink.deliver([record(1)]);
    await sink.close();
    await delivering;
    expect(read("audit.jsonl")).toBe(`${record(1).json}\n`);
  });

  it("refuses a directory or file others can reach, changing nothing", () => {
    const directory = path.join(root, "audit");
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    expect(() => open()).toThrow(/directory_not_private/);
    chmodSync(directory, 0o700);
    writeFileSync(path.join(directory, "audit.jsonl"), "", { mode: 0o644 });
    chmodSync(path.join(directory, "audit.jsonl"), 0o644);
    expect(() => open()).toThrow(/file_not_private/);
    expect([mode(directory), mode(path.join(directory, "audit.jsonl"))]).toEqual([0o700, 0o644]);
  });
});
