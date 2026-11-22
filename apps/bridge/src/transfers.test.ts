import { agentApi, agentApiHeader, maxFileBytes } from "@wayfarerlabs/agention-api";
import { Deadlines } from "@wayfarerlabs/agention/src/http/deadlines.ts";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentApi, transferIdle } from "./agent-api.ts";
import { ApiFailure, BridgeError } from "./errors.ts";
import type { SessionKey } from "./key-file.ts";
import { certificate } from "./test-harness.ts";

// Transfers against servers that stand in for Agention's, as far as a file's
// body goes: one that stops reading an upload, one that stops sending a
// download, and one whose listener cuts off an upload with its 408.

const { privateKey } = generateKeyPairSync("ed25519");
const key: SessionKey = { privateKey, publicKey: "unused" as SessionKey["publicKey"] };

let directory: string;
let server: Server | undefined;
let file: FileHandle | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "agention-transfers-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await file?.close();
  file = undefined;
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

// serve starts a stand-in server and answers with an API to reach it.
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  server = createServer({ cert: certificate.cert, key: certificate.key }, handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return new AgentApi({ origin: `https://localhost:${port}`, clock: Date.now });
}

// sparseFile opens a file of a size that reads as zeros.
async function sparseFile(size: number): Promise<{ handle: FileHandle; size: number }> {
  const at = path.join(directory, "upload.bin");
  writeFileSync(at, "");
  truncateSync(at, size);
  file = await open(at, "r");
  return { handle: file, size };
}

const upload = (api: AgentApi, handle: FileHandle, size: number) =>
  api.upload(key, {
    path: "/s/builder/main/uploads",
    query: { name: "upload.bin" },
    file: handle,
    size,
    type: "application/octet-stream",
  });

// until waits in real time, which the faked timers leave alone, until a
// condition holds.
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await delay(10);
  }
}

// tracked says whether a promise has settled, without waiting for it.
function tracked<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const settle = () => {
    done = true;
  };
  promise.then(settle, settle);
  return { promise, settled: () => done };
}

describe("an upload", () => {
  it("is abandoned once its bytes stop moving for the idle limit", async () => {
    let received = 0;
    // Reads a little of the body, then nothing more and never answers.
    const api = await serve((request) => {
      request.once("data", (chunk: Buffer) => {
        received += chunk.length;
        request.pause();
      });
    });
    const { handle, size } = await sparseFile(maxFileBytes);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const call = tracked(upload(api, handle, size));
    // In real time, until the socket's buffers are full and nothing moves.
    await until(() => received > 0);
    await delay(500);
    await vi.advanceTimersByTimeAsync(transferIdle - 1);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(call.promise).rejects.toBeInstanceOf(BridgeError);
  });

  it("is cut off by the server's listener with a 408 that reads as the server's own refusal", async () => {
    // The listener's own deadlines, here with an idle limit of a fifth of a
    // second, before a route that never reads the body.
    const deadlines = new Deadlines({
      limits: { bodyIdle: 200, request: 60_000 },
      securityHeaders: () => new Map([["x-content-type-options", "nosniff"]]),
    });
    const api = await serve((request, response) => deadlines.track(request, response));
    deadlines.start();
    try {
      const { handle, size } = await sparseFile(maxFileBytes);
      const failure = await upload(api, handle, size).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiFailure);
      expect((failure as ApiFailure).body.error.code).toBe("invalid_input");
    } finally {
      deadlines.stop();
    }
  });
});

describe("a download", () => {
  // answerSlowly answers 200 with a body of the length given, sending a byte
  // each time the test calls send.
  async function answerSlowly(length: number) {
    let response: ServerResponse | undefined;
    const api = await serve((_, answer) => {
      answer.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(length),
        [agentApiHeader]: String(agentApi.version),
      });
      answer.flushHeaders();
      response = answer;
    });
    const send = async () => {
      await until(() => response !== undefined);
      response?.write("x");
      await delay(100);
    };
    return { api, send };
  }

  const download = (api: AgentApi, into: Writable) =>
    api.download(key, { path: "/s/builder/main/threads/1/messages/1/files/a.txt" }, into);

  it("is abandoned once its bytes stop arriving for the idle limit", async () => {
    const { api, send } = await answerSlowly(10);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const into = new PassThrough();
    into.resume();
    const call = tracked(download(api, into));
    await send();
    await vi.advanceTimersByTimeAsync(transferIdle - 1);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(call.promise).rejects.toBeInstanceOf(BridgeError);
  });

  it("has no total deadline while its bytes keep arriving", async () => {
    const { api, send } = await answerSlowly(4);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const into = new PassThrough();
    const chunks: Buffer[] = [];
    into.on("data", (chunk: Buffer) => chunks.push(chunk));
    const call = tracked(download(api, into));
    for (let i = 0; i < 4; i++) {
      await send();
      await vi.advanceTimersByTimeAsync(transferIdle - 1000);
    }
    expect(await call.promise).toEqual({ size: 4, servedType: "text/plain; charset=utf-8" });
    expect(Buffer.concat(chunks).toString()).toBe("xxxx");
  });

  it("fails when its body ends short of the length the answer states", async () => {
    const api = await serve((_, answer) => {
      answer.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": "10",
        [agentApiHeader]: String(agentApi.version),
      });
      // Once the bridge has the answer's start, the connection ends.
      answer.write("short", () => setTimeout(() => answer.socket?.destroy(), 100));
    });
    const into = new PassThrough();
    into.resume();
    await expect(download(api, into)).rejects.toBeInstanceOf(BridgeError);
  });

  it("leaves a failure to write what arrives to its caller", async () => {
    const { api, send } = await answerSlowly(4);
    const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    const into = new Writable({ write: (_chunk, _encoding, done) => done(full) });
    const refused = expect(download(api, into)).rejects.toBe(full);
    await send();
    await refused;
  });
});
