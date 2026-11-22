import {
  agentApi,
  agentApiHeader,
  maxFileBytes,
  maxPendingFiles,
} from "@wayfarerlabs/agention-api";
import { host, sessionCookie } from "@wayfarerlabs/agention/src/http/test-harness.ts";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchedFileLifetime, fetchedFilesDirectory, maxImageBlockBytes } from "./file-tools.ts";
import { BridgeHarness, serverJson, type TestBridge } from "./test-harness.ts";

let harness: BridgeHarness;
let bridge: TestBridge;

beforeEach(async () => {
  harness = await new BridgeHarness().start();
  bridge = await harness.bridge();
  await bridge.ok("register");
  await harness.approve(harness.keyOnDisk());
  await bridge.ok("thread_create", { request_id: "r1", title: "Files", text: "Files follow." });
});

afterEach(async () => {
  await harness.close();
});

// A scratch file in the test's home directory, outside the bridge's own.
function scratch(name: string, content: string | Uint8Array = "hello\n"): string {
  const at = path.join(harness.home, "work", name);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, content);
  return at;
}

// A sparse file of a size, which reads as zeros without taking the disk.
function sparse(name: string, size: number): string {
  const at = scratch(name, "");
  truncateSync(at, size);
  return at;
}

// The files the server holds, pending or attached.
function storedFiles(): { name: string; size: number }[] {
  return harness.server.fixture.db.prepare("SELECT name, size FROM files ORDER BY id").all() as {
    name: string;
    size: number;
  }[];
}

// uploadRequests counts the uploads that reach the server.
function uploadRequests(): () => number {
  let count = 0;
  harness.beforeRequest = (request) => {
    if (new URL(request.url).pathname.endsWith("/uploads")) {
      count++;
    }
  };
  return () => count;
}

// attach uploads a file through the bridge and sends a message carrying it,
// answering with the message's sequence.
async function attach(filePath: string, name?: string): Promise<number> {
  const uploaded = await bridge.ok("file_upload", {
    path: filePath,
    ...(name === undefined ? {} : { name }),
  });
  const thread = await bridge.ok("thread_get", { thread: 1 });
  const seen = (thread.thread as { last_seq: number }).last_seq;
  const sent = await bridge.ok("message_send", {
    thread: 1,
    request_id: `attach-${seen}`,
    seen_through: seen,
    attachments: [{ upload: uploaded.upload }],
  });
  return sent.seq as number;
}

// operatorAttaches uploads bytes as the operator and sends a message carrying
// them, answering with the message's sequence.
async function operatorAttaches(bytes: Uint8Array, name: string, type: string): Promise<number> {
  const { upload } = await harness.operatorUploads(bytes, { name, type });
  return harness.operatorWrites(1, { attachments: [{ upload }] });
}

// The operator's read of a file a message carries, through the web API.
async function operatorReads(seq: number, name: string): Promise<Buffer> {
  const response = await harness.server.app.request(
    `/api/web/s/builder/main/threads/1/messages/${seq}/files/${encodeURIComponent(name)}`,
    { headers: { host, cookie: `${sessionCookie}=${harness.server.cookie}` } },
  );
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

// Every test runs the server in process and a bridge against it, which under
// load can take longer than Vitest's default 5 seconds.
describe("file_upload", { timeout: 30_000 }, () => {
  it("uploads a file that a message then carries for good", async () => {
    const bytes = "line one\nline two\n";
    const uploaded = await bridge.ok("file_upload", { path: scratch("notes.md", bytes) });
    expect(uploaded).toMatchObject({
      upload: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      name: "notes.md",
      size: bytes.length,
      type: "text/plain",
      served_type: "text/plain; charset=utf-8",
      expires_at: expect.any(String),
      message: expect.any(String),
    });
    const sent = await bridge.ok("message_send", {
      thread: 1,
      request_id: "r2",
      seen_through: 1,
      text: "The notes, as [notes](attachment:notes.md).",
      attachments: [{ upload: uploaded.upload, name: "meeting notes.md" }],
    });
    const read = await bridge.ok("thread_get", { thread: 1, after: 1 });
    expect(read).toMatchObject({
      files: { count: 1, bytes: bytes.length },
      messages: [
        {
          seq: sent.seq,
          attachments: [
            {
              name: "meeting notes.md",
              file: uploaded.upload,
              size: bytes.length,
              type: "text/plain",
            },
          ],
        },
      ],
    });
    expect((await operatorReads(sent.seq as number, "meeting notes.md")).toString()).toBe(bytes);
  });

  it("declares the type its name's extension gives", async () => {
    for (const [name, type] of [
      ["photo.JPG", "image/jpeg"],
      ["clip.webm", "video/webm"],
      ["build.log", "text/plain"],
      ["archive.tar.zst", "application/octet-stream"],
      ["Makefile", "application/octet-stream"],
    ]) {
      expect(await bridge.ok("file_upload", { path: scratch(name ?? "") })).toMatchObject({
        name,
        type,
      });
    }
  });

  it("uploads an empty file", async () => {
    const seq = await attach(scratch("empty.txt", ""));
    expect(storedFiles()).toEqual([{ name: "empty.txt", size: 0 }]);
    expect(await operatorReads(seq, "empty.txt")).toHaveLength(0);
  });

  it("refuses a relative path", async () => {
    expect(await bridge.error("file_upload", { path: "work/notes.md" })).toMatchObject({
      code: "invalid_input",
      field: "path",
    });
  });

  it("refuses what is not a regular file, a FIFO without waiting on it", async () => {
    const fifo = path.join(harness.home, "work", "pipe");
    mkdirSync(path.dirname(fifo), { recursive: true });
    execFileSync("mkfifo", [fifo]);
    const uploads = uploadRequests();
    for (const target of [path.dirname(fifo), fifo, "/dev/null"]) {
      expect([target, await bridge.error("file_upload", { path: target })]).toMatchObject([
        target,
        { code: "invalid_input", field: "path" },
      ]);
    }
    expect(
      await bridge.error("file_upload", { path: path.join(harness.home, "none") }),
    ).toMatchObject({ code: "invalid_input", field: "path" });
    expect(uploads()).toBe(0);
  });

  it("refuses a file over the limit before sending any of it", async () => {
    const uploads = uploadRequests();
    expect(
      await bridge.error("file_upload", { path: sparse("huge.bin", maxFileBytes + 1) }),
    ).toMatchObject({ code: "invalid_input", field: "path" });
    expect(uploads()).toBe(0);
    expect(storedFiles()).toEqual([]);
  });

  it("refuses every file of the bridge's key directory, by path or through a symlink", async () => {
    const own = harness.keyFile();
    const other = harness.keyFile({ agent: "builder", session: "other" });
    mkdirSync(path.dirname(other), { recursive: true, mode: 0o700 });
    writeFileSync(other, "another session's key\n", { mode: 0o600 });
    const link = path.join(harness.home, "work", "innocent.txt");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(own, link);
    const directoryLink = path.join(harness.home, "work", "config");
    symlinkSync(path.join(harness.home, ".config"), directoryLink);
    const uploads = uploadRequests();
    for (const target of [
      own,
      other,
      link,
      path.join(directoryLink, path.relative(path.join(harness.home, ".config"), own)),
    ]) {
      expect([target, await bridge.error("file_upload", { path: target })]).toMatchObject([
        target,
        { code: "invalid_input", field: "path" },
      ]);
    }
    expect(uploads()).toBe(0);
  });

  it("asks for a name when the file's own cannot be one", async () => {
    const odd = scratch("trailing ");
    expect(await bridge.error("file_upload", { path: odd })).toMatchObject({
      code: "invalid_input",
      field: "name",
    });
    expect(await bridge.ok("file_upload", { path: odd, name: "trailing.txt" })).toMatchObject({
      name: "trailing.txt",
    });
  });

  it("refuses a file that shrinks while it is read, leaving nothing uploaded", async () => {
    const file = sparse("shrinking.bin", 64 * 1024 * 1024);
    harness.beforeRequest = (request) => {
      if (new URL(request.url).pathname.endsWith("/uploads")) {
        truncateSync(file, 1024);
      }
    };
    const answer = await bridge.call("file_upload", { path: file });
    expect([answer.isError, answer.json]).toEqual([true, undefined]);
    await expect.poll(() => storedFiles()).toEqual([]);
  });

  it("sends a file that grows while it is read as it was opened", async () => {
    const file = scratch("growing.log", "first\n");
    harness.beforeRequest = (request) => {
      if (new URL(request.url).pathname.endsWith("/uploads")) {
        appendFileSync(file, "second\n");
      }
    };
    expect(await bridge.ok("file_upload", { path: file })).toMatchObject({ size: 6 });
  });

  it("reads a refusal the server answers before taking the body", { timeout: 60_000 }, async () => {
    for (let i = 0; i < maxPendingFiles; i++) {
      await bridge.ok("file_upload", { path: scratch(`small-${i}.txt`) });
    }
    // The server answers at once and reads no more than a bounded part of
    // the rest before it closes the connection.
    expect(
      await bridge.error("file_upload", { path: sparse("large.bin", maxFileBytes) }),
    ).toMatchObject({ code: "invalid_input" });
    expect(storedFiles()).toHaveLength(maxPendingFiles);
  });

  it("sends on a file it fetched", async () => {
    const seq = await operatorAttaches(Buffer.from("the operator's log\n"), "op.log", "text/plain");
    const fetched = await bridge.ok("file_get", { thread: 1, seq, name: "op.log" });
    const sent = await attach(fetched.path as string, "forwarded.log");
    expect((await operatorReads(sent, "forwarded.log")).toString()).toBe("the operator's log\n");
  });
});

// Leading bytes with each raster type's signature.
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00", "latin1");
const webp = Buffer.from("RIFF\x24\x00\x00\x00WEBP" + "VP8 ", "latin1");

describe("file_get", { timeout: 30_000 }, () => {
  it("fetches a file into the bridge's private directory, named by its reference", async () => {
    const bytes = Buffer.from("build output\n");
    const seq = await operatorAttaches(bytes, "build.log", "text/x-log");
    const answer = await bridge.call("file_get", { thread: 1, seq, name: "build.log" });
    expect(answer.content).toHaveLength(1);
    const fetched = answer.json as Record<string, unknown>;
    const directory = fetchedFilesDirectory(harness.home);
    const file = (
      (await bridge.ok("thread_get", { thread: 1, after: seq - 1, limit: 1 })).messages as {
        attachments: { file: string }[];
      }[]
    )[0]?.attachments[0]?.file;
    expect(fetched).toEqual({
      path: path.join(directory, `${file}.txt`),
      name: "build.log",
      size: bytes.length,
      type: "text/x-log",
      served_type: "text/plain; charset=utf-8",
    });
    expect(readFileSync(fetched.path as string)).toEqual(bytes);
    expect(statSync(fetched.path as string).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).toEqual([`${file}.txt`]);
  });

  it("names a file by the type it is served as, never by its sender's name", async () => {
    const seq = await operatorAttaches(
      Buffer.from("MZ"),
      "setup.exe",
      "application/vnd.microsoft.portable-executable",
    );
    const fetched = await bridge.ok("file_get", { thread: 1, seq, name: "setup.exe" });
    expect(path.basename(fetched.path as string)).toMatch(/^[A-Za-z0-9_-]{22}\.bin$/);
  });

  it("finds a file by its name as names are compared", async () => {
    // The name written decomposed, and asked for composed.
    const seq = await operatorAttaches(Buffer.from("x"), "café.txt", "text/plain");
    expect(await bridge.ok("file_get", { thread: 1, seq, name: "café.txt" })).toMatchObject({
      name: "café.txt",
    });
  });

  it("writes into a partial file renamed into place once whole, and replaces it when fetched again", async () => {
    const seq = await operatorAttaches(Buffer.from("v1"), "notes.txt", "text/plain");
    const directory = fetchedFilesDirectory(harness.home);
    const seen: string[][] = [];
    harness.beforeRequest = (request) => {
      if (new URL(request.url).pathname.includes("/files/")) {
        seen.push(readdirSync(directory));
      }
    };
    const first = await bridge.ok("file_get", { thread: 1, seq, name: "notes.txt" });
    expect(seen).toEqual([[expect.stringMatching(/^\.[0-9a-f]{16}\.part$/)]]);
    const again = await bridge.ok("file_get", { thread: 1, seq, name: "notes.txt" });
    expect(again.path).toBe(first.path);
    expect(readdirSync(directory)).toEqual([path.basename(first.path as string)]);
  });

  it("removes what it fetched a week ago, partial files included, and keeps the rest", async () => {
    const directory = fetchedFilesDirectory(harness.home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const old = (Date.now() - fetchedFileLifetime - 60_000) / 1000;
    const recent = (Date.now() - fetchedFileLifetime + 60_000) / 1000;
    for (const [name, time] of [
      ["AAAAAAAAAAAAAAAAAAAAAA.png", old],
      [".0123456789abcdef.part", old],
      ["BBBBBBBBBBBBBBBBBBBBBB.txt", recent],
    ] as const) {
      writeFileSync(path.join(directory, name), "x", { mode: 0o600 });
      utimesSync(path.join(directory, name), time, time);
    }
    const seq = await operatorAttaches(Buffer.from("new"), "new.txt", "text/plain");
    const fetched = await bridge.ok("file_get", { thread: 1, seq, name: "new.txt" });
    expect(readdirSync(directory).sort()).toEqual(
      ["BBBBBBBBBBBBBBBBBBBBBB.txt", path.basename(fetched.path as string)].sort(),
    );
  });

  it.each([
    ["image/png", png],
    ["image/jpeg", jpeg],
    ["image/gif", gif],
    ["image/webp", webp],
  ])("answers a %s image with an image block of its bytes", async (type, bytes) => {
    const seq = await operatorAttaches(bytes, "picture", type);
    const answer = await bridge.call("file_get", { thread: 1, seq, name: "picture" });
    expect(answer.isError).toBe(false);
    expect(answer.content).toEqual([
      { type: "text", text: answer.text },
      { type: "image", data: bytes.toString("base64"), mimeType: type },
    ]);
  });

  it("adds no image block for an image over the limit, saying to read the file", async () => {
    const bytes = Buffer.concat([png, Buffer.alloc(maxImageBlockBytes + 1 - png.length)]);
    const seq = await operatorAttaches(bytes, "large.png", "image/png");
    const answer = await bridge.call("file_get", { thread: 1, seq, name: "large.png" });
    expect(answer.content).toHaveLength(1);
    expect(answer.json).toMatchObject({ size: bytes.length, message: expect.any(String) });
  });

  it("takes an image at the limit whole", async () => {
    const bytes = Buffer.concat([jpeg, Buffer.alloc(maxImageBlockBytes - jpeg.length)]);
    const seq = await operatorAttaches(bytes, "at-limit.jpg", "image/jpeg");
    const answer = await bridge.call("file_get", { thread: 1, seq, name: "at-limit.jpg" });
    expect(answer.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  });

  it("adds no image block for bytes without their type's signature, or for SVG", async () => {
    const lying = await operatorAttaches(Buffer.from("not a picture"), "lie.png", "image/png");
    const svg = await operatorAttaches(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "drawing.svg",
      "image/svg+xml",
    );
    const wrongType = await operatorAttaches(gif, "gif.png", "image/png");
    for (const [seq, name] of [
      [lying, "lie.png"],
      [svg, "drawing.svg"],
      [wrongType, "gif.png"],
    ] as const) {
      const answer = await bridge.call("file_get", { thread: 1, seq, name });
      expect([name, answer.isError, answer.content.length]).toEqual([name, false, 1]);
    }
  });

  it("answers a name or message that carries no file as not found", async () => {
    const seq = await operatorAttaches(Buffer.from("x"), "here.txt", "text/plain");
    expect(await bridge.error("file_get", { thread: 1, seq, name: "elsewhere.txt" })).toMatchObject(
      { code: "not_found" },
    );
    expect(
      await bridge.error("file_get", { thread: 1, seq: seq + 5, name: "here.txt" }),
    ).toMatchObject({ code: "not_found" });
    expect(await bridge.error("file_get", { thread: 9, seq, name: "here.txt" })).toMatchObject({
      code: "not_found",
    });
    const directory = fetchedFilesDirectory(harness.home);
    expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
  });

  it("removes its partial file when the server refuses the file", async () => {
    const seq = await operatorAttaches(Buffer.from("x"), "gone.txt", "text/plain");
    harness.beforeRequest = (request) =>
      new URL(request.url).pathname.includes("/files/")
        ? serverJson({ error: { code: "not_found", message: "not found" } }, 404)
        : undefined;
    expect(await bridge.error("file_get", { thread: 1, seq, name: "gone.txt" })).toMatchObject({
      code: "not_found",
    });
    expect(readdirSync(fetchedFilesDirectory(harness.home))).toEqual([]);
  });

  it("removes its partial file when it cannot put the file in place, answering in its own words", async () => {
    const seq = await operatorAttaches(Buffer.from("x"), "blocked.txt", "text/plain");
    const read = await bridge.ok("thread_get", { thread: 1, after: seq - 1, limit: 1 });
    const { file } = (read.messages as { attachments: { file: string }[] }[])[0]
      ?.attachments[0] ?? { file: "" };
    // A directory where the fetched file goes, which no file can be renamed over.
    const directory = fetchedFilesDirectory(harness.home);
    mkdirSync(path.join(directory, `${file}.txt`), { recursive: true });
    chmodSync(directory, 0o700);
    const answer = await bridge.call("file_get", { thread: 1, seq, name: "blocked.txt" });
    expect([answer.isError, answer.json]).toEqual([true, undefined]);
    // It names the directory to fix, and never the partial file it removed.
    expect(answer.text).toContain(directory);
    expect(answer.text).not.toContain(".part");
    expect(readdirSync(directory)).toEqual([`${file}.txt`]);
  });

  it("refuses a message whose file is not a reference, writing nothing", async () => {
    const seq = await operatorAttaches(Buffer.from("x"), "a.txt", "text/plain");
    // A server that names the file with a path, and serves bytes for it.
    harness.beforeRequest = (request) => {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/threads/1")) {
        return serverJson({
          messages: [
            {
              seq,
              attachments: [
                { name: "a.txt", file: "../../../planted", size: 7, type: "text/plain" },
              ],
            },
          ],
        });
      }
      if (pathname.includes("/files/")) {
        return new Response("planted", {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            [agentApiHeader]: String(agentApi.version),
          },
        });
      }
      return undefined;
    };
    const answer = await bridge.call("file_get", { thread: 1, seq, name: "a.txt" });
    expect([answer.isError, answer.json]).toEqual([true, undefined]);
    expect(readdirSync(harness.home)).not.toContain("planted.txt");
  });

  it("refuses a directory for its files that others can reach", async () => {
    const directory = fetchedFilesDirectory(harness.home);
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    const seq = await operatorAttaches(Buffer.from("x"), "a.txt", "text/plain");
    const answer = await bridge.call("file_get", { thread: 1, seq, name: "a.txt" });
    expect([answer.isError, answer.json]).toEqual([true, undefined]);
    expect(answer.text).toContain(directory);
  });
});
