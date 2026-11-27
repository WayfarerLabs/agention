import {
  formatTimestamp,
  maxPendingBytes,
  maxPendingFiles,
  pendingLifetime,
  servedTypeOf,
} from "@wayfarerlabs/agention-api";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.ts";
import { sweepFiles } from "./sweep.ts";
import {
  abortUpload,
  beginUpload,
  bytesArriving,
  chunkBytes,
  completeUpload,
  removeUpload,
  storageTotals,
  type Upload,
  writeChunk,
} from "./files.ts";
import { revokeRegistration } from "./registrations.ts";
import { type Agent, Fixture } from "./test-fixture.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.close();
});

function failure(fn: () => unknown): { code: string; field: string | undefined } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return { code: error.code, field: error.field };
    }
    throw error;
  }
  throw new Error("expected the operation to fail");
}

const begin = (size: number, identity = agent.identity, target = agent.target) =>
  beginUpload(fixture.store, identity, target, { name: "build.log", type: "text/plain", size });

// fill writes an upload's bytes a chunk at a time, as the route does.
function fill(upload: Upload, bytes: Uint8Array): void {
  for (let at = 0, index = 0; at < bytes.length; at += chunkBytes, index++) {
    writeChunk(fixture.store, upload, index, bytes.subarray(at, at + chunkBytes));
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

// uploaded uploads a whole file and answers with its reference.
function uploaded(bytes: Uint8Array, identity = agent.identity, target = agent.target): string {
  const upload = begin(bytes.length, identity, target);
  fill(upload, bytes);
  return completeUpload(fixture.store, upload, bytes.length, sha256(bytes)).upload;
}

const count = (sql: string) =>
  (fixture.db.prepare(`SELECT count(*) AS n FROM ${sql}`).get() as { n: number }).n;

describe("an upload", () => {
  it("stores its bytes a chunk each, and completes with their hash", () => {
    const bytes = Buffer.alloc(chunkBytes * 2 + 5, 7);
    const upload = begin(bytes.length);
    expect(fixture.store.uploadsInFlight.has(upload.id)).toBe(true);
    fill(upload, bytes);
    const result = completeUpload(fixture.store, upload, bytes.length, sha256(bytes));
    expect(result).toEqual({
      upload: upload.ref,
      name: "build.log",
      size: bytes.length,
      type: "text/plain",
      served_type: servedTypeOf("text/plain"),
      expires_at: formatTimestamp(fixture.now + pendingLifetime),
    });
    expect(result.upload).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fixture.store.uploadsInFlight.has(upload.id)).toBe(false);
    const stored = fixture.db
      .prepare("SELECT sha256, completed_at, registration_id FROM files WHERE id = ?")
      .get(upload.id) as { sha256: Uint8Array; completed_at: number; registration_id: number };
    expect(Buffer.from(stored.sha256)).toEqual(sha256(bytes));
    expect(stored.completed_at).toBe(fixture.now);
    expect(stored.registration_id).toBe(agent.registrationId);
    expect(
      fixture.db
        .prepare("SELECT idx, length(data) AS length FROM file_chunks ORDER BY idx")
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([
      { idx: 0, length: chunkBytes },
      { idx: 1, length: chunkBytes },
      { idx: 2, length: 5 },
    ]);
    expect(storageTotals(fixture.db)).toEqual({ count: 1, bytes: bytes.length });
  });

  it("is refused at completion when the bytes received differ from its declared size", () => {
    const upload = begin(10);
    fill(upload, Buffer.alloc(9));
    expect(
      failure(() => completeUpload(fixture.store, upload, 9, sha256(Buffer.alloc(9)))),
    ).toEqual({ code: "invalid_input", field: undefined });
  });

  it("goes whole, its chunks with it, when it aborts", () => {
    const upload = begin(chunkBytes * 3);
    fill(upload, Buffer.alloc(chunkBytes * 2));
    const transaction = vi.spyOn(fixture.db, "transaction");
    abortUpload(fixture.store, upload, () => undefined);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect([count("files"), count("file_chunks")]).toEqual([0, 0]);
    expect(fixture.store.uploadsInFlight.has(upload.id)).toBe(false);
  });

  it("stops within a chunk once its credential is revoked", () => {
    const upload = begin(chunkBytes * 2);
    writeChunk(fixture.store, upload, 0, Buffer.alloc(chunkBytes));
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    expect(failure(() => writeChunk(fixture.store, upload, 1, Buffer.alloc(chunkBytes)))).toEqual({
      code: "unauthenticated",
      field: undefined,
    });
    expect(count("file_chunks")).toBe(1);
  });

  it("is refused for a session the writer does not act for", () => {
    const other = fixture.registerAgent("builder", "nightly");
    expect(failure(() => begin(1, agent.identity, other.target)).code).toBe("not_found");
  });
});

describe("the pending limits", () => {
  it("count a writer's uploads still arriving, and leave other writers theirs", () => {
    const arriving = Array.from({ length: maxPendingFiles - 1 }, () => begin(1));
    uploaded(Buffer.from("x"));
    expect(failure(() => begin(1))).toEqual({ code: "invalid_input", field: undefined });
    // Another writer holds its own.
    expect(() => begin(1, fixture.operator)).not.toThrow();
    // One that aborts frees its place; one attached would too.
    abortUpload(fixture.store, arriving[0]!, () => undefined);
    expect(() => begin(1)).not.toThrow();
  });

  it("count pending bytes by declared size, this upload's included", () => {
    const first = begin(maxPendingBytes / 2);
    const second = begin(maxPendingBytes / 2 - 10);
    // Two uploads of one writer arrive at once.
    expect(new Set([first.id, second.id]).size).toBe(2);
    expect(failure(() => begin(11)).code).toBe("invalid_input");
    expect(() => begin(10)).not.toThrow();
  });

  it("leave out uploads that expired", () => {
    for (let i = 0; i < maxPendingFiles; i++) {
      uploaded(Buffer.from("x"));
    }
    expect(failure(() => begin(1)).code).toBe("invalid_input");
    fixture.advance(pendingLifetime);
    expect(() => begin(1)).not.toThrow();
  });
});

describe("removing an upload", () => {
  it("removes the writer's own, its chunks with it, and frees its place in the limits at once", () => {
    const refs = Array.from({ length: maxPendingFiles }, () =>
      uploaded(Buffer.alloc(chunkBytes + 1)),
    );
    expect(failure(() => begin(1)).code).toBe("invalid_input");
    removeUpload(fixture.store, agent.identity, agent.target, refs[0]!);
    expect([count("files"), count("file_chunks")]).toEqual([
      maxPendingFiles - 1,
      (maxPendingFiles - 1) * 2,
    ]);
    expect(() => begin(1)).not.toThrow();
  });

  it("is not_found for any upload but the writer's own pending one in the session named", () => {
    const operators = uploaded(Buffer.from("x"), fixture.operator);
    const other = fixture.registerAgent("builder", "nightly");
    const nightlyOperators = uploaded(Buffer.from("x"), fixture.operator, other.target);
    const attached = uploaded(Buffer.from("x"));
    fixture.createThread(agent, { attachments: [{ upload: attached }] });
    const arriving = begin(1);
    const refused = [
      // Another writer's, in this session.
      [agent.identity, agent.target, operators],
      // The writer's own, named in another session.
      [fixture.operator, agent.target, nightlyOperators],
      // One a message names.
      [agent.identity, agent.target, attached],
      // One still arriving.
      [agent.identity, agent.target, arriving.ref],
      // One that names nothing.
      [agent.identity, agent.target, "AAAAAAAAAAAAAAAAAAAAAA"],
    ] as const;
    for (const [identity, target, ref] of refused) {
      expect(failure(() => removeUpload(fixture.store, identity, target, ref))).toEqual({
        code: "not_found",
        field: "upload",
      });
    }
    expect(count("files")).toBe(4);
  });
});

describe("the bytes still arriving", () => {
  it("sum every incomplete upload's declared size less the chunks it has", () => {
    const one = begin(chunkBytes * 3 + 1);
    writeChunk(fixture.store, one, 0, Buffer.alloc(chunkBytes));
    begin(100, fixture.operator, agent.target);
    uploaded(Buffer.alloc(50));
    expect(bytesArriving(fixture.store)).toBe(chunkBytes * 2 + 1 + 100);
  });
});

describe("the sweep", () => {
  it("removes every incomplete upload at start, when nothing is in flight", async () => {
    const left = begin(chunkBytes * 2);
    writeChunk(fixture.store, left, 0, Buffer.alloc(chunkBytes));
    uploaded(Buffer.from("kept"));
    // A new process starts with no uploads in flight.
    fixture.store.uploadsInFlight.clear();
    expect(await sweepFiles(fixture.store)).toBe(1);
    expect([count("files"), count("file_chunks")]).toEqual([1, 1]);
  });

  it("removes expired uploads and abandoned ones, leaving uploads in flight and attached files", async () => {
    const slow = begin(chunkBytes * 2);
    const abandoned = begin(chunkBytes * 2);
    writeChunk(fixture.store, abandoned, 0, Buffer.alloc(chunkBytes));
    fixture.store.uploadsInFlight.delete(abandoned.id);
    const attached = uploaded(Buffer.from("attached"));
    fixture.createThread(agent, { attachments: [{ upload: attached }] });
    uploaded(Buffer.from("expiring"));
    fixture.advance(pendingLifetime - 1);
    const fresh = uploaded(Buffer.from("fresh"));
    fixture.advance(1);
    // The slow upload has filled no chunk for all that time.
    expect(await sweepFiles(fixture.store)).toBe(2);
    const refs = fixture.db.prepare("SELECT ref FROM files ORDER BY id").all() as { ref: string }[];
    expect(refs.map((row) => row.ref)).toEqual([slow.ref, attached, fresh]);
  });

  it("returns the pages it frees to the disk a vacuum step at a time", async () => {
    for (let i = 0; i < 3; i++) {
      uploaded(Buffer.alloc(chunkBytes * 4, i));
    }
    fixture.advance(pendingLifetime);
    expect(fixture.db.incrementalVacuum).toBe(true);
    const step = vi.spyOn(fixture.db, "vacuumStep");
    expect(await sweepFiles(fixture.store)).toBe(3);
    // 12 MiB of chunks free about 3,100 pages of 4 KiB, two steps of 2,048.
    expect(step).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenCalledWith(2048);
    expect(fixture.db.freePages()).toBe(0);
  });

  it("skips the vacuum on a database not yet switched to incremental vacuuming", async () => {
    uploaded(Buffer.alloc(chunkBytes));
    fixture.advance(pendingLifetime);
    vi.spyOn(fixture.db, "incrementalVacuum", "get").mockReturnValue(false);
    const step = vi.spyOn(fixture.db, "vacuumStep");
    expect(await sweepFiles(fixture.store)).toBe(1);
    expect(step).not.toHaveBeenCalled();
  });
});
