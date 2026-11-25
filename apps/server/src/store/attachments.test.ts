import { pendingLifetime, threadFilesQuery } from "@wayfarerlabs/agention-api";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { findCarriedFile, listThreadFiles, readFileChunk } from "./file-reads.ts";
import { beginUpload, chunkBytes, completeUpload, writeChunk } from "./files.ts";
import { type Agent, Fixture, requestId, threadTarget } from "./test-fixture.ts";
import type { Identity } from "../identity.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
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

// upload uploads a file of the given text, under a name, and answers with
// its reference.
function upload(
  text: string,
  options: { name?: string; identity?: Identity; target?: Agent["target"] } = {},
): string {
  const bytes = Buffer.from(text);
  const started = beginUpload(
    fixture.store,
    options.identity ?? agent.identity,
    options.target ?? agent.target,
    { name: options.name ?? "notes.txt", type: "text/plain", size: bytes.length },
  );
  if (bytes.length > 0) {
    writeChunk(fixture.store, started, 0, bytes);
  }
  return completeUpload(
    fixture.store,
    started,
    bytes.length,
    createHash("sha256").update(bytes).digest(),
  ).upload;
}

const target = (number = 1) => threadTarget(agent, number);
const messageAt = (seq: number) =>
  fixture.thread(fixture.operator, target()).messages.find((message) => message.seq === seq);

describe("a message's attachments", () => {
  it("carry the writer's uploads in order, under their own names or the ones given", () => {
    const first = upload("one", { name: "one.txt" });
    const second = upload("two!", { name: "two.txt" });
    fixture.createThread(agent, {
      text: "Logs attached.",
      attachments: [{ upload: second, name: "renamed.txt" }, { upload: first }],
    });
    expect(messageAt(1)?.attachments).toEqual([
      { name: "renamed.txt", file: second, size: 4, type: "text/plain" },
      { name: "one.txt", file: first, size: 3, type: "text/plain" },
    ]);
    expect(fixture.thread(fixture.operator, target()).files).toEqual({ count: 2, bytes: 7 });
  });

  it("may be all a message carries", () => {
    fixture.createThread(agent);
    const file = upload("x", { identity: fixture.operator });
    fixture.write(fixture.operator, target(), { attachments: [{ upload: file }] });
    expect(messageAt(2)?.attachments?.map((each) => each.file)).toEqual([file]);
  });

  it("ride on the first message of a thread the operator starts, from their uploads to its session", () => {
    const file = upload("plan", { name: "plan.txt", identity: fixture.operator });
    fixture.startThread(agent, { attachments: [{ upload: file }] });
    expect(messageAt(1)?.attachments).toEqual([
      { name: "plan.txt", file, size: 4, type: "text/plain" },
    ]);
    // Another writer's upload, one to another session and a kept file are
    // refused there as on any first message, and start no thread.
    const nightly = fixture.registerAgent("builder", "nightly");
    const agents = upload("ag");
    const elsewhere = upload("ns", { identity: fixture.operator, target: nightly.target });
    for (const ref of [agents, elsewhere]) {
      expect(failure(() => fixture.startThread(agent, { attachments: [{ upload: ref }] }))).toEqual(
        { code: "invalid_input", field: "attachments.0.upload" },
      );
    }
    expect(
      failure(() => fixture.startThread(agent, { attachments: [{ keep: "plan.txt" }] })),
    ).toEqual({ code: "invalid_input", field: "attachments.0.keep" });
    expect(fixture.startThread(agent).number).toBe(2);
  });

  it("refuse alike another writer's, another session's, an unknown, an expired and an attached upload", () => {
    fixture.createThread(agent);
    const nightly = fixture.registerAgent("builder", "nightly");
    fixture.createThread(nightly);
    const expired = upload("ex");
    fixture.advance(pendingLifetime);
    // Every upload but the expired one is fresh, so each is refused for what
    // it is, not for its age: the operator's in this very session, another
    // session's by the same agent, and one already attached.
    const operators = upload("op", { identity: fixture.operator });
    const agents = upload("ag");
    const otherSession = upload("ns", { identity: nightly.identity, target: nightly.target });
    const attached = upload("at");
    fixture.write(agent.identity, target(), { attachments: [{ upload: attached }] });
    const refused = { code: "invalid_input", field: "attachments.0.upload" };
    for (const ref of [operators, otherSession, "A".repeat(22), expired, attached]) {
      expect(
        failure(() => fixture.write(agent.identity, target(), { attachments: [{ upload: ref }] })),
      ).toEqual(refused);
    }
    expect(
      failure(() =>
        fixture.write(fixture.operator, target(), { attachments: [{ upload: agents }] }),
      ),
    ).toEqual(refused);
    // The operator's own upload of this session, named in another session's
    // thread.
    expect(
      failure(() =>
        fixture.write(fixture.operator, threadTarget(nightly, 1), {
          attachments: [{ upload: operators }],
        }),
      ),
    ).toEqual(refused);
    // Each writer may still attach its own, where it was uploaded.
    fixture.write(fixture.operator, target(), { attachments: [{ upload: operators }] });
    fixture.write(agent.identity, target(), { attachments: [{ upload: agents }] });
    fixture.write(nightly.identity, threadTarget(nightly, 1), {
      attachments: [{ upload: otherSession }],
    });
  });

  it("keep files of the replaced message only by naming them, and the replaced message keeps its own", () => {
    const kept = upload("kept", { name: "Kept.txt" });
    const dropped = upload("dropped", { name: "dropped.txt" });
    fixture.createThread(agent, {
      text: "v1",
      attachments: [{ upload: kept }, { upload: dropped }],
    });
    const fresh = upload("fresh", { name: "fresh.txt" });
    fixture.write(agent.identity, target(), {
      text: "v2",
      replaces: 1,
      attachments: [{ keep: "Kept.txt" }, { upload: fresh }],
    });
    expect(messageAt(2)?.attachments?.map((each) => [each.name, each.file])).toEqual([
      ["Kept.txt", kept],
      ["fresh.txt", fresh],
    ]);
    expect(messageAt(1)?.attachments?.map((each) => each.file)).toEqual([kept, dropped]);
    // A replacement without keep leaves the files with the message it replaced.
    fixture.write(agent.identity, target(), { text: "v3", replaces: 2 });
    expect(messageAt(3)?.attachments).toBeUndefined();
    expect(messageAt(2)?.attachments).toHaveLength(2);
  });

  it("roll up to the thread from its live messages only, a kept file once", () => {
    const kept = upload("kept", { name: "kept.txt" });
    const dropped = upload("dropped", { name: "dropped.txt" });
    fixture.createThread(agent, {
      text: "v1",
      attachments: [{ upload: kept }, { upload: dropped }],
    });
    const totals = () => fixture.thread(fixture.operator, target()).files;
    const listed = () =>
      listThreadFiles(
        fixture.store,
        fixture.operator,
        target(),
        threadFilesQuery.parse({}),
      ).files.map((each) => [each.seq, each.file]);
    expect(totals()).toEqual({ count: 2, bytes: "kept".length + "dropped".length });
    fixture.write(agent.identity, target(), {
      text: "v2",
      replaces: 1,
      attachments: [{ keep: "kept.txt" }],
    });
    // The file only the replaced message carries drops out; the kept one
    // stays, with the replacement that carries it, while the replaced
    // message still shows both.
    expect(totals()).toEqual({ count: 1, bytes: "kept".length });
    expect(listed()).toEqual([[2, kept]]);
    expect(messageAt(1)?.attachments?.map((each) => each.file)).toEqual([kept, dropped]);
    fixture.write(agent.identity, target(), { text: "v3", replaces: 2 });
    expect(totals()).toEqual({ count: 0, bytes: 0 });
    expect(listed()).toEqual([]);
    expect(messageAt(2)?.attachments?.map((each) => each.file)).toEqual([kept]);
  });

  it("keep a file only on a replacement, and only one the replaced message carries", () => {
    fixture.createThread(agent, { attachments: [{ upload: upload("a", { name: "a.txt" }) }] });
    expect(
      failure(() => fixture.write(agent.identity, target(), { attachments: [{ keep: "a.txt" }] })),
    ).toEqual({ code: "invalid_input", field: "attachments.0.keep" });
    expect(
      failure(() =>
        fixture.write(agent.identity, target(), { replaces: 1, attachments: [{ keep: "b.txt" }] }),
      ),
    ).toEqual({ code: "invalid_input", field: "attachments.0.keep" });
  });

  it("refuse two names equal after NFC normalization, an upload's own name included", () => {
    const composed = "café.txt";
    const decomposed = "café.txt";
    fixture.createThread(agent);
    expect(
      failure(() =>
        fixture.write(agent.identity, target(), {
          attachments: [
            { upload: upload("1", { name: composed }) },
            { upload: upload("2", { name: decomposed }) },
          ],
        }),
      ),
    ).toEqual({ code: "invalid_input", field: "attachments.1.name" });
    // Case is kept: these are two names.
    fixture.write(agent.identity, target(), {
      attachments: [
        { upload: upload("3", { name: "Log.txt" }) },
        { upload: upload("4", { name: "log.txt" }) },
      ],
    });
    expect(messageAt(2)?.attachments).toHaveLength(2);
  });

  it("number at most ten", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      upload: upload(`${i}`, { name: `${i}.txt` }),
    }));
    fixture.createThread(agent, { attachments: ten });
    expect(messageAt(1)?.attachments).toHaveLength(10);
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      upload: upload(`${i}`, { name: `${i}.txt` }),
    }));
    expect(() => fixture.write(agent.identity, target(), { attachments: eleven })).toThrow(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "too_big", path: ["attachments"] })],
      }),
    );
  });

  it("are part of a write's digest, so a retry answers as the first did after its uploads were consumed", () => {
    fixture.createThread(agent);
    const file = upload("x");
    const id = requestId();
    const write = (attachments: unknown) =>
      fixture.write(agent.identity, target(), { request_id: id, seen_through: 1, attachments });
    const first = write([{ upload: file }]);
    expect(write([{ upload: file }])).toEqual(first);
    expect(failure(() => write([{ upload: file, name: "other.txt" }]))).toEqual({
      code: "request_id_conflict",
      field: "request_id",
    });
    // A thread's first message too.
    const opening = upload("y");
    const create = { request_id: requestId(), attachments: [{ upload: opening }] };
    const created = fixture.createThread(agent, create);
    expect(fixture.createThread(agent, create)).toEqual(created);
  });

  it("land with their message or not at all", () => {
    fixture.createThread(agent);
    const file = upload("x");
    expect(
      failure(() =>
        fixture.write(agent.identity, target(), {
          attachments: [{ upload: file }, { upload: "B".repeat(22) }],
        }),
      ).code,
    ).toBe("invalid_input");
    const pending = fixture.db.prepare("SELECT attached_at FROM files").get() as {
      attached_at: number | null;
    };
    expect(pending.attached_at).toBeNull();
  });
});

describe("a missing file", () => {
  it("reads as missing in its messages and the thread's list, and its read is not_found", () => {
    const file = upload("gone", { name: "gone.txt" });
    const empty = upload("", { name: "empty.txt" });
    fixture.createThread(agent, { attachments: [{ upload: file }, { upload: empty }] });
    // As a future purge would leave it.
    fixture.db.prepare("DROP TRIGGER file_chunks_kept").run();
    fixture.db.prepare("DELETE FROM file_chunks").run();
    expect(messageAt(1)?.attachments).toEqual([
      { name: "gone.txt", file, size: 4, type: "text/plain", missing: true },
      { name: "empty.txt", file: empty, size: 0, type: "text/plain" },
    ]);
    const listed = listThreadFiles(
      fixture.store,
      fixture.operator,
      target(),
      threadFilesQuery.parse({}),
    );
    expect(listed.files.map((each) => each.missing)).toEqual([true, undefined]);
    const find = (name: string) => () =>
      findCarriedFile(fixture.store, fixture.operator, {
        ...target(),
        seq: 1,
        name,
        ref: undefined,
      });
    expect(failure(find("gone.txt")).code).toBe("not_found");
    expect(find("empty.txt")().size).toBe(0);
  });
});

describe("the thread's file list", () => {
  it("lists each file its live messages carry, with that message, newest first, in pages", () => {
    const a = upload("a", { name: "a.txt" });
    const b = upload("b", { name: "b.txt" });
    fixture.createThread(agent, { attachments: [{ upload: a }, { upload: b }] });
    const c = upload("c", { name: "c.txt" });
    fixture.advance(1000);
    const byOperator = (name: string) =>
      upload(name, { name: `${name}.txt`, identity: fixture.operator });
    fixture.write(fixture.operator, target(), {
      attachments: [{ upload: byOperator("d") }, { upload: byOperator("e") }],
    });
    fixture.write(agent.identity, target(), {
      replaces: 1,
      attachments: [{ keep: "b.txt" }, { upload: c }],
    });
    const page = (cursor?: string) =>
      listThreadFiles(
        fixture.store,
        fixture.operator,
        target(),
        threadFilesQuery.parse({ limit: "3", ...(cursor === undefined ? {} : { cursor }) }),
      );
    // a.txt went with the message replaced; b.txt lists with the replacement
    // that kept it, and the second page starts inside message 2.
    const first = page();
    expect(first.files.map((each) => [each.seq, each.name, each.author.kind])).toEqual([
      [3, "b.txt", "session"],
      [3, "c.txt", "session"],
      [2, "d.txt", "person"],
    ]);
    expect(first.files[2]?.author).toEqual({ kind: "person", name: "operator" });
    const second = page(first.next);
    expect(second.files.map((each) => [each.seq, each.name])).toEqual([[2, "e.txt"]]);
    expect(second.next).toBeUndefined();
    expect(failure(() => page("bm90IGEgY3Vyc29y"))).toEqual({
      code: "invalid_input",
      field: "cursor",
    });
  });

  it("is not_found for a thread of another session", () => {
    const nightly = fixture.registerAgent("builder", "nightly");
    fixture.createThread(nightly);
    expect(
      failure(() =>
        listThreadFiles(
          fixture.store,
          agent.identity,
          threadTarget(nightly, 1),
          threadFilesQuery.parse({}),
        ),
      ).code,
    ).toBe("not_found");
  });
});

describe("a file read", () => {
  it("finds a message's file by its name, compared as names are, and its ref when given", () => {
    const file = upload("hello", { name: "café.txt" });
    fixture.createThread(agent, { attachments: [{ upload: file }] });
    const find = (fields: { seq?: number; name?: string; ref?: string }) =>
      findCarriedFile(fixture.store, agent.identity, {
        ...target(),
        seq: fields.seq ?? 1,
        name: fields.name ?? "café.txt",
        ref: fields.ref,
      });
    const found = find({ name: "café.txt", ref: file });
    expect(found).toMatchObject({ name: "café.txt", size: 5, type: "text/plain" });
    expect(Buffer.from(readFileChunk(fixture.store, agent.identity, found.id, 0) ?? [])).toEqual(
      Buffer.from("hello"),
    );
    for (const miss of [{ seq: 2 }, { name: "other.txt" }, { ref: "C".repeat(22) }]) {
      expect(failure(() => find(miss)).code).toBe("not_found");
    }
    expect(chunkBytes).toBe(1024 * 1024);
  });
});
