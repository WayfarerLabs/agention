import {
  agentApiHeader,
  maxFileBytes,
  maxPendingFiles,
  type UploadResult,
} from "@wayfarerlabs/agention-api";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginUpload } from "../store/index.ts";
import { maxBodyBytes } from "./app.ts";
import { codeOf, json, type Mount, mountHeaders, send, upload } from "./file-test-support.ts";
import { type AgentKey, Harness, host } from "./test-harness.ts";
import { freeSpaceFloor, isUploadRequest } from "./uploads.ts";

let harness: Harness;
let agent: AgentKey;
// The bytes the stubbed file system says are free.
let free: number;

beforeEach(async () => {
  free = 100 * 1024 ** 3;
  harness = new Harness({ freeBytes: async () => free });
  agent = await harness.approvedAgent("builder", "main");
});

afterEach(() => {
  harness.close();
});

const mounts: Mount[] = ["agent", "web"];
const count = (table: string) =>
  (harness.fixture.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("an upload", () => {
  it.each(mounts)("on the %s mount answers with the pending file", async (mount) => {
    const sent = await upload(harness, mount, agent, Buffer.from("{}"), {
      name: "data.json",
      type: "Application/JSON; charset=utf-8",
    });
    expect(sent.status).toBe(200);
    const result = json(sent) as UploadResult;
    expect(result).toMatchObject({
      name: "data.json",
      size: 2,
      type: "application/json",
      served_type: "text/plain; charset=utf-8",
    });
    expect(result.upload).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Date.parse(result.expires_at)).toBe(harness.fixture.now + 24 * 60 * 60 * 1000);
  });

  it("takes an empty file", async () => {
    const sent = await upload(harness, "agent", agent, new Uint8Array(0));
    expect([sent.status, (json(sent) as UploadResult).size]).toEqual([200, 0]);
  });

  it("refuses a name that cannot be a file's", async () => {
    for (const name of ["", "a/b", "..", " padded"]) {
      const sent = await upload(harness, "web", agent, Buffer.from("x"), { name });
      expect([name, sent.status, codeOf(sent)]).toEqual([name, 400, "invalid_input"]);
    }
    expect(count("files")).toBe(0);
  });

  it("refuses a session it does not act for as not_found", async () => {
    await harness.approvedAgent("builder", "nightly");
    const sent = await upload(harness, "agent", agent, Buffer.from("x"), { session: "nightly" });
    expect(codeOf(sent)).toBe("not_found");
  });

  it("over 100 MiB by its Content-Length is 413, before anything is stored", async () => {
    const sent = await upload(harness, "agent", agent, Buffer.from("x"), {
      length: maxFileBytes + 1,
    });
    expect([sent.status, codeOf(sent)]).toEqual([413, "invalid_input"]);
    expect(count("files")).toBe(0);
  });

  it("sent chunked is 411", async () => {
    const sent = await send(
      harness,
      "POST",
      "/api/web/s/builder/main/uploads?name=a.txt",
      {
        ...(await mountHeaders(harness, "web", agent, "POST")),
        "transfer-encoding": "chunked",
      },
      Buffer.from("x"),
    );
    expect([sent.status, codeOf(sent)]).toEqual([411, "invalid_input"]);
  });

  it("is refused while its writer holds the most pending uploads, naming the limit", async () => {
    for (let i = 0; i < maxPendingFiles; i++) {
      expect((await upload(harness, "web", agent, Buffer.from("x"))).status).toBe(200);
    }
    const sent = await upload(harness, "web", agent, Buffer.from("x"));
    expect([sent.status, codeOf(sent)]).toEqual([400, "invalid_input"]);
    expect((json(sent) as { error: { message: string } }).error.message).toContain(
      String(maxPendingFiles),
    );
    // The agent is another writer, with limits of its own.
    expect((await upload(harness, "agent", agent, Buffer.from("x"))).status).toBe(200);
  });

  it("is refused as storage_full under the free-space floor, counting every writer's uploads still arriving", async () => {
    const arriving = 5000;
    beginUpload(
      harness.fixture.store,
      harness.fixture.operator,
      { agent: "builder", session: "main" },
      {
        name: "other.bin",
        type: "application/octet-stream",
        size: arriving,
      },
    );
    const size = 10;
    free = freeSpaceFloor + arriving + size - 1;
    const refused = await upload(harness, "agent", agent, Buffer.alloc(size));
    expect([refused.status, codeOf(refused)]).toEqual([507, "storage_full"]);
    free += 1;
    expect((await upload(harness, "agent", agent, Buffer.alloc(size))).status).toBe(200);
  });

  it("whose bytes differ from its Content-Length is refused, and leaves nothing", async () => {
    const sent = await upload(harness, "web", agent, Buffer.from("short"), { length: 10 });
    expect([sent.status, codeOf(sent)]).toEqual([400, "invalid_input"]);
    expect([count("files"), count("file_chunks")]).toEqual([0, 0]);
  });
});

describe("the body bounds", () => {
  it("keep 2 MiB on every route but uploads", async () => {
    const sent = await send(
      harness,
      "POST",
      "/api/web/s/builder/main/threads/1/read",
      {
        ...(await mountHeaders(harness, "web", agent, "POST")),
        "content-type": "application/json",
        "content-length": String(maxBodyBytes + 1),
      },
      Buffer.from("{}"),
    );
    expect([sent.status, codeOf(sent)]).toEqual([413, "invalid_input"]);
  });

  it.each([
    ["POST", "/api/agent/s/builder/main/uploads", true],
    ["POST", "/api/web/s/builder/main/uploads?name=a.txt", true],
    ["POST", "/api/web/s/b%20x/m/uploads", true],
    ["POST", "/api/web/s/builder/main/x/../uploads", true],
    ["POST", "/api/web/s/builder/%2e%2e/uploads", false],
    ["GET", "/api/web/s/builder/main/uploads", false],
    ["POST", "/api/web/s/builder/main/uploads/x", false],
    ["POST", "/api/web/s/builder/main/threads/1/uploads", false],
    ["POST", "/api/other/s/builder/main/uploads", false],
    ["POST", "/api/web/s//main/uploads", false],
  ])("call %s %s an upload: %s", (method, target, expected) => {
    expect(isUploadRequest(method, `https://agention.test${target}`)).toBe(expected);
  });
});

describe("a refused upload over a real connection", () => {
  // refusedAfter streams an upload's body on a raw socket, as a client that
  // does not wait for an answer does, and resolves with the answer's status
  // once the server closes the connection, and the bytes the client wrote by
  // then.
  async function refusedAfter(
    port: number,
    headers: Record<string, string>,
  ): Promise<{ status: number; written: number }> {
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    let received = "";
    socket.on("data", (data: Buffer) => (received += data.toString()));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const lines = Object.entries({
      host,
      "content-type": "application/octet-stream",
      "content-length": String(50 * 1024 * 1024),
      ...headers,
    }).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.write(
      `POST /api/agent/s/builder/main/uploads?name=big.bin HTTP/1.1\r\n${lines.join("")}\r\n`,
    );
    const piece = Buffer.alloc(64 * 1024);
    let open = true;
    void closed.then(() => (open = false));
    while (open && socket.bytesWritten < 50 * 1024 * 1024) {
      if (!socket.write(piece)) {
        await Promise.race([new Promise((resolve) => socket.once("drain", resolve)), closed]);
      }
    }
    await closed;
    return {
      status: Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1]),
      written: socket.bytesWritten,
    };
  }

  it("is answered and closed before its body is read, unauthenticated, unversioned or over-size", async () => {
    const listening = await harness.listen();
    try {
      const { port } = listening.address;
      const token = `Bearer ${await harness.token(agent)}`;
      const unauthenticated = await refusedAfter(port, {});
      const unversioned = await refusedAfter(port, {
        authorization: token,
        [agentApiHeader]: "999",
      });
      const oversized = await refusedAfter(port, {
        authorization: token,
        "content-length": String(maxFileBytes + 1),
      });
      expect([unauthenticated.status, unversioned.status, oversized.status]).toEqual([
        401, 400, 413,
      ]);
      // The adapter drains a refused body for at most 64 MiB before closing.
      for (const refused of [unauthenticated, unversioned, oversized]) {
        expect(refused.written).toBeLessThan(50 * 1024 * 1024);
      }
      expect(count("files")).toBe(0);
    } finally {
      await listening.close();
    }
  }, 30_000);
});
