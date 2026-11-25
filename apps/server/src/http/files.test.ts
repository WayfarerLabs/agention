import {
  agentApi,
  agentApiHeader,
  servedTypes,
  type ThreadFilesPage,
  type ThreadGetResult,
} from "@wayfarerlabs/agention-api";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.ts";
import { chunkBytes, revokeRegistration } from "../store/index.ts";
import { contentSecurityPolicy } from "./app.ts";
import { codeOf, type Mount, readFile, uploaded } from "./file-test-support.ts";
import { contentDisposition, fileCaching, filePolicy, wantedOf } from "./files.ts";
import { type AgentKey, Harness, host, newThread, origin, sessionCookie } from "./test-harness.ts";

let harness: Harness;
let agent: AgentKey;

beforeEach(async () => {
  harness = new Harness();
  agent = await harness.approvedAgent("builder", "main");
});

afterEach(() => {
  harness.close();
  vi.restoreAllMocks();
});

const mounts: Mount[] = ["agent", "web"];

// attach uploads files as the agent and starts thread 1 with a message
// carrying them, answering with their references.
async function attach(
  files: { bytes: Uint8Array; name: string; type?: string | null }[],
): Promise<string[]> {
  const refs: string[] = [];
  for (const file of files) {
    refs.push((await uploaded(harness, "agent", agent, file.bytes, file)).upload);
  }
  const created = await harness.agent(
    agent,
    "POST",
    "/s/builder/main/threads",
    newThread("r-files", { attachments: refs.map((upload) => ({ upload })) }),
  );
  expect(created.status).toBe(200);
  return refs;
}

describe("a file read", () => {
  it.each(mounts)("on the %s mount answers the file with its serving headers", async (mount) => {
    const bytes = Buffer.from("hello, file");
    const [ref] = await attach([{ bytes, name: "hello.txt" }]);
    const sent = await readFile(harness, mount, agent, 1, "hello.txt", { file: ref });
    expect(sent.status).toBe(200);
    expect(sent.bytes).toEqual(bytes);
    expect(Object.fromEntries(sent.headers)).toMatchObject({
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(bytes.length),
      "content-disposition": `inline; filename="hello.txt"; filename*=UTF-8''hello.txt`,
      "accept-ranges": "bytes",
      etag: `"${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}"`,
      "content-security-policy": filePolicy,
      "cross-origin-resource-policy": "same-origin",
      "cache-control": fileCaching,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000",
    });
    expect(sent.headers.get(agentApiHeader)).toBe(
      mount === "agent" ? String(agentApi.version) : null,
    );
  });

  it("streams a file of several chunks whole", async () => {
    const bytes = Buffer.alloc(chunkBytes * 2 + 3);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 251;
    }
    await attach([{ bytes, name: "big.bin", type: "application/octet-stream" }]);
    const sent = await readFile(harness, "web", agent, 1, "big.bin");
    expect(sent.bytes.equals(bytes)).toBe(true);
  });

  it("stops within a chunk once its credential is revoked", async () => {
    await attach([{ bytes: Buffer.alloc(chunkBytes * 3), name: "big.bin" }]);
    const response = await harness.app.request(
      "/api/agent/s/builder/main/threads/1/messages/1/files/big.bin",
      { headers: { host, authorization: `Bearer ${await harness.token(agent)}` } },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value?.length).toBe(chunkBytes);
    revokeRegistration(
      harness.fixture.store,
      harness.fixture.operator,
      harness.registrationId(agent),
    );
    await expect(reader?.read()).rejects.toBeInstanceOf(ApiError);
  });

  // A read cut short over a real connection logs through the app, not the
  // adapter, and drops the connection, so the client's body ends incomplete.
  // The client reads nothing until onResponse has run, and with the default
  // socket buffers a file of 16 chunks is more than the connection holds, so a
  // cut it causes comes before the end.
  async function readCutShort(onResponse: () => void = () => undefined) {
    const consoleError = vi.spyOn(console, "error");
    const authorization = `Bearer ${await harness.token(agent)}`;
    const listening = await harness.listen();
    try {
      const read = await new Promise<{
        status: number | undefined;
        received: number;
        complete: boolean;
      }>((resolve, reject) => {
        const request = httpRequest({
          host: "127.0.0.1",
          port: listening.address.port,
          path: "/api/agent/s/builder/main/threads/1/messages/1/files/big.bin",
          headers: { host, authorization },
        });
        request
          .on("response", (answer) => {
            onResponse();
            let received = 0;
            answer.on("data", (data: Buffer) => (received += data.length));
            // The client's error for a body cut short, which complete shows.
            answer.on("error", () => undefined);
            answer.on("close", () =>
              resolve({ status: answer.statusCode, received, complete: answer.complete }),
            );
          })
          .on("error", reject)
          .end();
      });
      expect(consoleError).not.toHaveBeenCalled();
      return read;
    } finally {
      await listening.close();
    }
  }

  it("cut short once its credential is revoked logs one line and drops the connection", async () => {
    await attach([{ bytes: Buffer.alloc(chunkBytes * 16), name: "big.bin" }]);
    const logged = harness.logged.length;
    const read = await readCutShort(() =>
      revokeRegistration(
        harness.fixture.store,
        harness.fixture.operator,
        harness.registrationId(agent),
      ),
    );
    expect(read.status).toBe(200);
    expect(read.complete).toBe(false);
    expect(harness.logged.slice(logged)).toHaveLength(1);
    expect(harness.logged.at(-1)).not.toContain("\n");
  });

  it("cut short by a missing chunk logs one line and drops the connection", async () => {
    await attach([{ bytes: Buffer.alloc(chunkBytes * 3), name: "big.bin" }]);
    harness.fixture.db.prepare("DROP TRIGGER file_chunks_kept").run();
    harness.fixture.db.prepare("DELETE FROM file_chunks WHERE idx = 1").run();
    const logged = harness.logged.length;
    const read = await readCutShort();
    expect([read.status, read.complete]).toEqual([200, false]);
    expect(read.received).toBeLessThanOrEqual(chunkBytes);
    expect(harness.logged.slice(logged)).toHaveLength(1);
  });

  it("whose first chunk fails is answered by the app, with its headers, over a real connection", async () => {
    await attach([{ bytes: Buffer.alloc(chunkBytes * 2), name: "big.bin" }]);
    harness.fixture.db.prepare("DROP TRIGGER file_chunks_kept").run();
    harness.fixture.db.prepare("DELETE FROM file_chunks WHERE idx = 0").run();
    const listening = await harness.listen();
    try {
      const answer = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpRequest({
          host: "127.0.0.1",
          port: listening.address.port,
          path: "/api/web/s/builder/main/threads/1/messages/1/files/big.bin",
          headers: { host, cookie: `${sessionCookie}=${harness.cookie}` },
        });
        request.on("response", resolve).on("error", reject).end();
      });
      answer.resume();
      expect([answer.statusCode, answer.headers["content-type"]]).toEqual([
        404,
        "application/json",
      ]);
      expect(answer.headers["content-security-policy"]).toBe(contentSecurityPolicy(origin));
      expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      await listening.close();
    }
  });

  it("is not_found for a thread of another session, an unknown message or name, and another file's ref", async () => {
    const [ref] = await attach([{ bytes: Buffer.from("a"), name: "a.txt" }]);
    const other = await harness.approvedAgent("builder", "nightly");
    expect(codeOf(await readFile(harness, "agent", other, 1, "a.txt"))).toBe("not_found");
    expect(codeOf(await readFile(harness, "agent", agent, 2, "a.txt"))).toBe("not_found");
    expect(codeOf(await readFile(harness, "agent", agent, 1, "b.txt"))).toBe("not_found");
    expect(
      codeOf(await readFile(harness, "web", agent, 1, "a.txt", { file: "D".repeat(22) })),
    ).toBe("not_found");
    expect(codeOf(await readFile(harness, "web", agent, 1, "a.txt", { file: ref }))).toBe("ok");
  });

  it("is not_found, saying so, for a file whose contents are gone", async () => {
    await attach([{ bytes: Buffer.from("gone"), name: "gone.txt" }]);
    harness.fixture.db.prepare("DROP TRIGGER file_chunks_kept").run();
    harness.fixture.db.prepare("DELETE FROM file_chunks").run();
    const sent = await readFile(harness, "web", agent, 1, "gone.txt");
    expect([sent.status, codeOf(sent)]).toEqual([404, "not_found"]);
  });
});

describe("ranges", () => {
  const bytes = Buffer.from("0123456789");

  beforeEach(async () => {
    await attach([
      { bytes, name: "digits.txt" },
      { bytes: Buffer.alloc(0), name: "empty.txt" },
    ]);
  });

  const read = (range: string, name = "digits.txt", headers: Record<string, string> = {}) =>
    readFile(harness, "web", agent, 1, name, { headers: { range, ...headers } });

  it.each([
    ["bytes=2-4", "234", "bytes 2-4/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-99", "89", "bytes 8-9/10"],
    ["bytes=-99", "0123456789", "bytes 0-9/10"],
  ])("answer %s with 206 and the part asked for", async (range, body, contentRange) => {
    const sent = await read(range);
    expect([sent.status, sent.bytes.toString(), sent.headers.get("content-range")]).toEqual([
      206,
      body,
      contentRange,
    ]);
    expect(sent.headers.get("content-length")).toBe(String(body.length));
    expect(sent.headers.get("content-security-policy")).toBe(filePolicy);
  });

  it.each(["bytes=0-1,4-5", "items=0-1", "bytes=5-2", "bytes=x-", "bytes=-"])(
    "answer %s whole",
    async (range) => {
      const sent = await read(range);
      expect([sent.status, sent.bytes.toString(), sent.headers.get("content-range")]).toEqual([
        200,
        "0123456789",
        null,
      ]);
    },
  );

  it.each([
    ["bytes=10-", "digits.txt", 10],
    ["bytes=-0", "digits.txt", 10],
    ["bytes=0-", "empty.txt", 0],
    ["bytes=-5", "empty.txt", 0],
  ])("answer %s of %s with 416 and the size", async (range, name, size) => {
    const sent = await read(range, name);
    expect([sent.status, codeOf(sent), sent.headers.get("content-range")]).toEqual([
      416,
      "invalid_input",
      `bytes */${size}`,
    ]);
  });

  it("ignore If-None-Match and If-Range, which could only give the same answer", async () => {
    const etag = (await read("bytes=0-0")).headers.get("etag") ?? "";
    const whole = await readFile(harness, "web", agent, 1, "digits.txt", {
      headers: { "if-none-match": etag },
    });
    expect([whole.status, whole.bytes.toString()]).toEqual([200, "0123456789"]);
    const partial = await read("bytes=1-2", "digits.txt", { "if-range": '"stale"' });
    expect([partial.status, partial.bytes.toString()]).toEqual([206, "12"]);
  });

  it("answer HEAD as GET, reading no chunk", async () => {
    const prepare = vi.spyOn(harness.fixture.db, "prepare");
    const head = await readFile(harness, "agent", agent, 1, "digits.txt", { method: "HEAD" });
    expect([head.status, head.bytes.length, head.headers.get("content-length")]).toEqual([
      200,
      0,
      "10",
    ]);
    expect(head.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(prepare.mock.calls.some(([sql]) => /FROM file_chunks WHERE file_id/.test(sql))).toBe(
      false,
    );
  });

  it("read as wantedOf says, at the edges", () => {
    expect(wantedOf(undefined, 5)).toEqual({ kind: "whole" });
    expect(wantedOf("bytes=0-0", 1)).toEqual({ kind: "range", start: 0, end: 0 });
    expect(wantedOf("bytes=99999999999999999999-", 5)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("serving headers", () => {
  // The declared type an upload gives, and the served type and disposition
  // it is answered with: a row for each way the upload reads a declared
  // type, and one each for inline and attachment. The API package tests the
  // mapping itself.
  const cases: [string | null, string, "inline" | "attachment"][] = [
    ["image/png", "image/png", "inline"],
    ["application/zip", "application/octet-stream", "attachment"],
    ["image/jpg", "image/jpeg", "inline"],
    ["Text/CSS; charset=latin1", "text/plain; charset=utf-8", "inline"],
    [null, "application/octet-stream", "attachment"],
    ["not a type", "application/octet-stream", "attachment"],
  ];

  it.each(cases)("serve %s as %s, %s, inert", async (declared, served, disposition) => {
    await attach([{ bytes: Buffer.from("<script>alert(1)</script>"), name: "f", type: declared }]);
    for (const mount of mounts) {
      const sent = await readFile(harness, mount, agent, 1, "f");
      expect(Object.fromEntries(sent.headers)).toMatchObject({
        "content-type": served,
        "content-disposition": `${disposition}; filename="f"; filename*=UTF-8''f`,
        "content-security-policy": filePolicy,
        "cross-origin-resource-policy": "same-origin",
        "cache-control": fileCaching,
        "x-content-type-options": "nosniff",
      });
      expect(sent.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    }
  });

  it("serve HTML and script bytes declared as every allowlisted type as that type, never as a document or script", async () => {
    const hostile = Buffer.from(
      '<!doctype html><html><body><script>fetch("/api/web/session")</script>' +
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/></body></html>',
    );
    const scripting = /html|javascript|ecmascript/;
    // The operator uploads them, whose uploads spend no rate budget, and
    // attaches them ten a message to a thread the agent started.
    await harness.agent(agent, "POST", "/s/builder/main/threads", newThread("r-hostile"));
    for (let message = 0; message * 10 < servedTypes.length; message++) {
      const refs: string[] = [];
      for (const type of servedTypes.slice(message * 10, message * 10 + 10)) {
        const name = `page-${servedTypes.indexOf(type)}.html`;
        refs.push((await uploaded(harness, "web", agent, hostile, { name, type })).upload);
      }
      const sent = await harness.web("POST", "/s/builder/main/threads/1/messages", {
        request_id: `r-${message}`,
        seen_through: message + 1,
        attachments: refs.map((upload) => ({ upload })),
      });
      expect(sent.status).toBe(200);
    }
    for (const [i, type] of servedTypes.entries()) {
      const sent = await readFile(harness, "web", agent, Math.floor(i / 10) + 2, `page-${i}.html`);
      const contentType = sent.headers.get("content-type") ?? "";
      expect(contentType, type).toBe(type);
      expect(contentType).not.toMatch(scripting);
      expect(sent.headers.get("content-security-policy")).toBe(filePolicy);
      expect(sent.headers.get("x-content-type-options")).toBe("nosniff");
      expect(sent.headers.get("content-disposition")).toMatch(
        type === "image/svg+xml" || type === "application/octet-stream"
          ? /^attachment;/
          : /^inline;/,
      );
    }
  });

  it.each([
    ["notes.txt", `inline; filename="notes.txt"; filename*=UTF-8''notes.txt`],
    ['say "hi".txt', `inline; filename="say _hi_.txt"; filename*=UTF-8''say%20%22hi%22.txt`],
    ["100%.txt", `inline; filename="100_.txt"; filename*=UTF-8''100%25.txt`],
    ["a\\b", `inline; filename="a_b"; filename*=UTF-8''a%5Cb`],
    ["it's (1)*.txt", `inline; filename="it's (1)*.txt"; filename*=UTF-8''it%27s%20%281%29%2A.txt`],
    [
      "café \u{1f600}.txt",
      `inline; filename="caf_ _.txt"; filename*=UTF-8''caf%C3%A9%20%F0%9F%98%80.txt`,
    ],
    ["!#$&+-.^_`|~", `inline; filename="!#$&+-.^_\`|~"; filename*=UTF-8''!#$&+-.^_\`|~`],
  ])("write the disposition of %s", (name, expected) => {
    expect(contentDisposition("inline", name)).toBe(expected);
  });

  it("write the disposition of the longest name", () => {
    const name = "\u{1f600}".repeat(200);
    const written = contentDisposition("attachment", name);
    expect(written).toBe(
      `attachment; filename="${"_".repeat(200)}"; filename*=UTF-8''${"%F0%9F%98%80".repeat(200)}`,
    );
  });

  it("keep a file's own policy and caching while every other route's are replaced", async () => {
    await attach([{ bytes: Buffer.from("x"), name: "x.txt" }]);
    const file = await readFile(harness, "web", agent, 1, "x.txt");
    expect(file.headers.get("content-security-policy")).toBe(filePolicy);
    const thread = await harness.web("GET", "/s/builder/main/threads/1");
    expect(thread.headers.get("content-security-policy")).toBe(contentSecurityPolicy(origin));
    expect(thread.headers.get("cache-control")).toBe("no-store");
  });
});

describe("a thread's files", () => {
  it.each(mounts)(
    "on the %s mount total in the thread and list a page at a time",
    async (mount) => {
      await attach([
        { bytes: Buffer.from("aa"), name: "a.txt" },
        { bytes: Buffer.from("bbb"), name: "b.txt" },
      ]);
      const read = (path: string) =>
        mount === "agent"
          ? harness.agent(agent, "GET", `/s/builder/main${path}`)
          : harness.web("GET", `/s/builder/main${path}`);
      const thread = (await read("/threads/1")).body as ThreadGetResult;
      expect(thread.files).toEqual({ count: 2, bytes: 5 });
      expect(thread.messages[0]?.attachments?.map((each) => each.name)).toEqual(["a.txt", "b.txt"]);
      const first = (await read("/threads/1/files?limit=1")).body as ThreadFilesPage;
      expect(first.files.map((each) => [each.seq, each.name])).toEqual([[1, "a.txt"]]);
      const second = (await read(`/threads/1/files?limit=1&cursor=${first.next}`))
        .body as ThreadFilesPage;
      expect(second.files.map((each) => each.name)).toEqual(["b.txt"]);
      expect(second.next).toBeUndefined();
    },
  );

  it("count in the operator's storage, pending uploads included", async () => {
    await attach([{ bytes: Buffer.from("1234"), name: "a.txt" }]);
    await uploaded(harness, "web", agent, Buffer.from("123456"));
    const settings = await harness.web("GET", "/settings");
    expect((settings.body as { storage: unknown }).storage).toEqual({ count: 2, bytes: 10 });
  });
});
