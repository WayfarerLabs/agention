import {
  type ErrorBody,
  type ThreadFilesPage,
  type ThreadGetResult,
  type UploadResult,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { chunkBytes } from "../store/index.ts";
import { hour } from "../store/test-fixture.ts";
import { codeOf, json, send, type Sent } from "./file-test-support.ts";
import { filePolicy } from "./files.ts";
import { type AgentKey, codeOf as answerCodeOf, Harness, host, newThread } from "./test-harness.ts";

// Files on the operator mount, with API keys: uploads and file reads run the
// same operations the agent and web mounts do, under the threads scopes.

let harness: Harness;
let agent: AgentKey;

beforeEach(async () => {
  harness = new Harness();
  agent = await harness.approvedAgent("builder", "main");
  await harness.agent(agent, "POST", "/s/builder/main/threads", newThread("r-1"));
});

afterEach(() => {
  harness.close();
});

const prefix = "/api/operator/v1/s/builder/main";
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
const count = (table: string) =>
  (harness.fixture.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

// upload uploads bytes with a key to builder/main under a name.
const upload = (secret: string, bytes: Buffer, name = "notes.txt"): Promise<Sent> =>
  send(
    harness,
    "POST",
    `${prefix}/uploads?name=${encodeURIComponent(name)}`,
    {
      ...bearer(secret),
      "content-type": "text/plain",
      "content-length": String(bytes.length),
    },
    bytes,
  );

// readFile reads a file that message seq of thread 1 carries, with a key.
const readFile = (secret: string, seq: number, name: string, headers = {}): Promise<Sent> =>
  send(harness, "GET", `${prefix}/threads/1/messages/${seq}/files/${name}`, {
    ...bearer(secret),
    ...headers,
  });

// attach sends a message in thread 1 with a key, carrying an upload.
async function attach(secret: string, ref: string, requestId = "o-1"): Promise<number> {
  const sent = await harness.operator(secret, "POST", "/s/builder/main/threads/1/messages", {
    request_id: requestId,
    seen_through: 1,
    attachments: [{ upload: ref }],
  });
  expect(answerCodeOf(sent)).toBe("ok");
  return (sent.body as { seq: number }).seq;
}

describe("files on the operator mount", () => {
  it("a threads:write key uploads and attaches, and a threads:read key lists and reads", async () => {
    const writer = await harness.createKey(["threads:write"]);
    const reader = await harness.createKey(["threads:read"]);
    const bytes = Buffer.from("0123456789");
    const sent = await upload(writer.secret, bytes, "digits.txt");
    expect(codeOf(sent)).toBe("ok");
    const { upload: ref } = json(sent) as UploadResult;
    const seq = await attach(writer.secret, ref);

    const files = await harness.operator(reader.secret, "GET", "/s/builder/main/threads/1/files");
    expect((files.body as ThreadFilesPage).files.map((each) => [each.seq, each.name])).toEqual([
      [seq, "digits.txt"],
    ]);
    const whole = await readFile(reader.secret, seq, "digits.txt");
    expect([whole.status, whole.bytes.toString()]).toEqual([200, "0123456789"]);
    expect(whole.headers.get("content-security-policy")).toBe(filePolicy);
    const part = await readFile(reader.secret, seq, "digits.txt", { range: "bytes=2-4" });
    expect([part.status, part.bytes.toString(), part.headers.get("content-range")]).toEqual([
      206,
      "234",
      "bytes 2-4/10",
    ]);
    const outside = await readFile(reader.secret, seq, "digits.txt", { range: "bytes=10-" });
    expect([outside.status, outside.headers.get("content-range")]).toEqual([416, "bytes */10"]);
    // The file is the operator's, as the message is.
    const thread = await harness.web("GET", "/s/builder/main/threads/1");
    const message = (thread.body as ThreadGetResult).messages.find((each) => each.seq === seq);
    expect(message?.author).toEqual({ kind: "person", name: "operator" });
  });

  it("refuses an upload and its removal to a key without threads:write as not_found, storing nothing", async () => {
    const writer = await harness.createKey(["threads:write"]);
    const { upload: ref } = json(await upload(writer.secret, Buffer.from("x"))) as UploadResult;
    const reader = await harness.createKey(["threads:read", "sessions:write"]);
    const refused = await upload(reader.secret, Buffer.from("y"));
    expect([refused.status, codeOf(refused)]).toEqual([404, "not_found"]);
    const removal = await harness.operator(
      reader.secret,
      "POST",
      `/s/builder/main/uploads/${ref}/remove`,
    );
    expect(answerCodeOf(removal)).toBe("not_found");
    expect(count("files")).toBe(1);
  });

  it("holds a key's pending upload as the operator's, which the web session can attach", async () => {
    const writer = await harness.createKey(["threads:write"]);
    const { upload: ref } = json(await upload(writer.secret, Buffer.from("x"))) as UploadResult;
    const sent = await harness.web("POST", "/s/builder/main/threads/1/messages", {
      request_id: "w-1",
      seen_through: 1,
      attachments: [{ upload: ref }],
    });
    expect(answerCodeOf(sent)).toBe("ok");
  });

  it("starts a thread whose first message carries a key's upload to the session", async () => {
    const writer = await harness.createKey(["threads:write"]);
    const { upload: ref } = json(
      await upload(writer.secret, Buffer.from("plan"), "plan.txt"),
    ) as UploadResult;
    const started = await harness.operator(writer.secret, "POST", "/s/builder/main/threads", {
      request_id: "o-start",
      title: "The plan",
      text: "Here it is.",
      attachments: [{ upload: ref }],
    });
    expect(answerCodeOf(started)).toBe("ok");
    const { number } = started.body as { number: number };
    const thread = harness.fixture.thread(harness.fixture.operator, {
      agent: "builder",
      session: "main",
      thread: number,
    });
    expect(thread.messages[0]?.attachments?.map((each) => [each.name, each.file])).toEqual([
      ["plan.txt", ref],
    ]);
  });

  it("removes a pending upload, but never one a sent message carries, which still reads", async () => {
    const writer = await harness.createKey(["threads:write"]);
    const remove = (ref: string) =>
      harness.operator(writer.secret, "POST", `/s/builder/main/uploads/${ref}/remove`);
    const staged = json(await upload(writer.secret, Buffer.from("draft"))) as UploadResult;
    expect([(await remove(staged.upload)).status, count("files")]).toEqual([200, 0]);

    const kept = json(await upload(writer.secret, Buffer.from("kept"))) as UploadResult;
    const seq = await attach(writer.secret, kept.upload);
    const refused = await remove(kept.upload);
    expect([refused.status, answerCodeOf(refused)]).toEqual([404, "not_found"]);
    const read = await readFile(writer.secret, seq, "notes.txt");
    expect([read.status, read.bytes.toString()]).toEqual([200, "kept"]);
  });
});

// The key refusals the audit log holds: each one's key, its code, and the
// status its caller was answered with, if any, with its count.
const refusals = () =>
  (
    harness.fixture.db
      .prepare("SELECT credential_id, event FROM audit_events WHERE outcome = 'failure'")
      .all() as { credential_id: string; event: string }[]
  ).map((row) => {
    const event = JSON.parse(row.event) as {
      status_detail: string;
      count: number;
      http_response?: { code: number };
    };
    return [row.credential_id, event.status_detail, event.http_response?.code, event.count];
  });

describe("a key's file transfer", () => {
  it("stops a read within a chunk once the key is revoked", async () => {
    const { key, secret } = await harness.createKey(["threads:write"]);
    const big = Buffer.alloc(chunkBytes * 3);
    const { upload: ref } = json(await upload(secret, big, "big.bin")) as UploadResult;
    const seq = await attach(secret, ref);
    const response = await harness.app.request(
      `${prefix}/threads/1/messages/${seq}/files/big.bin`,
      { headers: { host, ...bearer(secret) } },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value?.length).toBe(chunkBytes);
    await harness.web("POST", `/keys/${key.id}/revoke`);
    await expect(reader?.read()).rejects.toBeInstanceOf(ApiError);
    // Recorded once, with no status: the client was answered 200, then cut off.
    expect(refusals()).toEqual([[String(key.id), "key_revoked", undefined, 1]]);
    // A later read, refused 401 at authentication in the same minute, counts
    // apart from the refusal its client never saw.
    await readFile(secret, seq, "big.bin");
    expect(refusals()).toEqual([
      [String(key.id), "key_revoked", undefined, 1],
      [String(key.id), "key_revoked", 401, 1],
    ]);
  });

  it("stops a read within a chunk once the key expires", async () => {
    const { key, secret } = await harness.createKey(["threads:write"], {
      kind: "days",
      days: 7,
    });
    const big = Buffer.alloc(chunkBytes * 3);
    const { upload: ref } = json(await upload(secret, big, "big.bin")) as UploadResult;
    const seq = await attach(secret, ref);
    const response = await harness.app.request(
      `${prefix}/threads/1/messages/${seq}/files/big.bin`,
      { headers: { host, ...bearer(secret) } },
    );
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value?.length).toBe(chunkBytes);
    harness.fixture.advance(7 * 24 * hour);
    await expect(reader?.read()).rejects.toBeInstanceOf(ApiError);
    expect(refusals()).toEqual([[String(key.id), "key_expired", undefined, 1]]);
  });

  it("stops an upload at its next chunk once the key is revoked, before its last arrives, keeping nothing", async () => {
    const { key, secret } = await harness.createKey(["threads:write"]);
    // A body of three chunks, each pulled only as the upload reads it. The
    // upload asks for the second once it has stored the first, and the key is
    // revoked then. Refused as it stores the second, the upload never pulls
    // the third, so the refusal is the chunk's own check and not the
    // completion's.
    let revoked: () => void = () => undefined;
    const revocation = new Promise<void>((resolve) => (revoked = resolve));
    let askedSecond: () => void = () => undefined;
    const secondAsked = new Promise<void>((resolve) => (askedSecond = resolve));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(chunkBytes));
            return;
          }
          if (pulls === 2) {
            askedSecond();
          }
          await revocation;
          if (pulls <= 3) {
            controller.enqueue(new Uint8Array(chunkBytes));
          } else {
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const answer = harness.app.request(`${prefix}/uploads?name=big.bin`, {
      method: "POST",
      headers: {
        host,
        ...bearer(secret),
        "content-type": "application/octet-stream",
        "content-length": String(chunkBytes * 3),
      },
      body,
      duplex: "half",
    } as RequestInit);
    await secondAsked;
    expect(count("file_chunks")).toBe(1);
    await harness.web("POST", `/keys/${key.id}/revoke`);
    revoked();
    const response = await answer;
    expect([response.status, ((await response.json()) as ErrorBody).error.code]).toEqual([
      401,
      "unauthenticated",
    ]);
    expect(pulls).toBe(2);
    expect([count("files"), count("file_chunks")]).toEqual([0, 0]);
    expect(refusals()).toEqual([[String(key.id), "key_revoked", 401, 1]]);
  });
});
