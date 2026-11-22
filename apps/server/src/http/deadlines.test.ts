import { agentApi, agentApiHeader } from "@wayfarerlabs/agention-api";
import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { securityHeaderValues } from "./app.ts";
import { Deadlines } from "./deadlines.ts";
import { timeouts } from "./listener.ts";
import { type AgentKey, Harness, host, newAgentKey, newThread, origin } from "./test-harness.ts";

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

// until waits for a condition that real I/O makes true.
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) {
    throw new Error(`timed out waiting for ${what}`);
  }
}

// A raw connection: what it has received, and whether it has closed.
interface Connection {
  socket: Socket;
  received: () => string;
  closed: () => boolean;
}

function open(port: number, head: string): Connection {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  let received = "";
  let closed = false;
  socket.on("data", (data: Buffer) => (received += data.toString()));
  socket.on("close", () => (closed = true));
  socket.write(head);
  return { socket, received: () => received, closed: () => closed };
}

function headOf(method: string, path: string, headers: Record<string, string>): string {
  const lines = Object.entries({ host, ...headers }).map(([name, value]) => `${name}: ${value}`);
  return `${method} ${path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
}

// headersOf reads a raw response's status and headers.
function headersOf(raw: string): { status: number; headers: Record<string, string> } {
  const [head = ""] = raw.split("\r\n\r\n");
  const [statusLine = "", ...lines] = head.split("\r\n");
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1]),
    headers: Object.fromEntries(
      lines.map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
      }),
    ),
  };
}

describe("the listener's deadlines, on a fake clock", () => {
  let server: Server;
  let port: number;
  let now: number;
  let deadlines: Deadlines;

  // The app behind the deadlines, as the listener serves it, on a clock the
  // test moves.
  beforeEach(async () => {
    now = 0;
    deadlines = new Deadlines({
      limits: { bodyIdle: timeouts.bodyIdle, request: timeouts.request },
      securityHeaders: () => securityHeaderValues(origin),
      now: () => now,
    });
    const handler = getRequestListener(harness.app.fetch);
    server = createServer((request, response) => {
      deadlines.track(request, response);
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const advance = (milliseconds: number) => {
    now += milliseconds;
    deadlines.check();
  };

  const agentHead = async (path: string, length: number, type = "application/json") =>
    headOf("POST", `/api/agent${path}`, {
      authorization: `Bearer ${await harness.token(agent)}`,
      "content-type": type,
      "content-length": String(length),
    });

  const count = (table: string) =>
    (harness.fixture.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("cut an upload whose body stops for 30 seconds, answering 408, and remove what arrived", async () => {
    const errors = vi.spyOn(console, "error");
    const size = 3 * 1024 * 1024;
    const connection = open(
      port,
      await agentHead("/s/builder/main/uploads?name=big.bin", size, "application/octet-stream"),
    );
    connection.socket.write(Buffer.alloc(1024 * 1024 + 10));
    await until(() => count("file_chunks") === 1, "the first chunk");
    // The check that sees the bytes arrive starts the idle time.
    advance(0);
    advance(timeouts.bodyIdle - 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connection.received()).toBe("");
    advance(1);
    await until(() => connection.closed(), "the connection to close");
    const { status, headers } = headersOf(connection.received());
    expect(status).toBe(408);
    expect(headers).toMatchObject({
      ...Object.fromEntries(securityHeaderValues(origin)),
      [agentApiHeader.toLowerCase()]: String(agentApi.version),
      "content-type": "application/json",
      connection: "close",
    });
    expect(connection.received()).toContain('"code":"invalid_input"');
    await until(() => count("files") === 0, "the partial upload to go");
    expect(count("file_chunks")).toBe(0);
    // The route's own answer, once its body read failed, came too late and
    // was dropped without a word.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).not.toHaveBeenCalled();
    expect(deadlines.tracking).toBe(0);
  });

  // The head of an upload of size bytes, on the agent mount or, with an API
  // key, the operator mount.
  const uploadHead = async (mount: "agent" | "operator", size: number) => {
    const path = "/s/builder/main/uploads?name=slow.txt";
    if (mount === "agent") {
      return agentHead(path, size, "text/plain");
    }
    const { secret } = await harness.createKey(["threads:write"]);
    return headOf("POST", `/api/operator/v1${path}`, {
      authorization: `Bearer ${secret}`,
      "content-type": "text/plain",
      "content-length": String(size),
    });
  };

  it.each(["agent", "operator"] as const)(
    "let an upload on the %s mount trickling a byte a second finish long past 30 seconds",
    async (mount) => {
      const size = 45;
      const connection = open(port, await uploadHead(mount, size));
      for (let sent = 0; sent < size; sent++) {
        const before = connection.socket.bytesWritten;
        connection.socket.write("x");
        await until(() => connection.socket.bytesWritten > before, "the byte to go");
        await new Promise((resolve) => setTimeout(resolve, 5));
        advance(1000);
      }
      await until(() => connection.received().includes("\r\n\r\n{"), "the answer");
      expect(headersOf(connection.received()).status).toBe(200);
      expect(count("files")).toBe(1);
    },
  );

  it("cut any other request still arriving 30 seconds after its headers, however it trickles", async () => {
    await harness.agent(agent, "POST", "/s/builder/main/threads", newThread("r-1"));
    const connection = open(port, await agentHead("/s/builder/main/threads/1/read", 100));
    for (let second = 1; second < 30; second++) {
      connection.socket.write(" ");
      await new Promise((resolve) => setTimeout(resolve, 5));
      advance(1000);
    }
    expect(connection.received()).toBe("");
    connection.socket.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 5));
    advance(1000);
    await until(() => connection.closed(), "the connection to close");
    expect(headersOf(connection.received()).status).toBe(408);
  });

  it("close a connection whose body still trickles in once its answer has gone", async () => {
    // A GET carrying a body is answered without reading it, and Node then
    // discards the rest of the body as it arrives, on a keep-alive connection
    // whose idle timer every byte resets.
    const connection = open(
      port,
      headOf("GET", "/api/web/session", { "content-length": String(1_000_000) }),
    );
    await until(() => connection.received().includes("\r\n\r\n{"), "the answer");
    expect(headersOf(connection.received()).status).toBe(200);
    for (let second = 1; second < 30; second++) {
      connection.socket.write("x");
      await new Promise((resolve) => setTimeout(resolve, 5));
      advance(1000);
    }
    expect(connection.closed()).toBe(false);
    connection.socket.write("x");
    await new Promise((resolve) => setTimeout(resolve, 5));
    advance(1000);
    await until(() => connection.closed(), "the connection to close");
    expect(deadlines.tracking).toBe(0);
  });

  it("leave a long poll alone however long it waits, and the web mount's answers without the version", async () => {
    const poll = open(
      port,
      headOf("GET", "/api/agent/s/builder/main/wait?wait=25", {
        authorization: `Bearer ${await harness.token(agent)}`,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    advance(120_000);
    expect(deadlines.tracking).toBe(0);
    expect(poll.closed()).toBe(false);
    poll.socket.destroy();

    const web = open(
      port,
      headOf("POST", "/api/web/auth/link/begin", {
        origin,
        "content-type": "application/json",
        "content-length": "10",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    advance(0);
    advance(timeouts.bodyIdle);
    await until(() => web.closed(), "the connection to close");
    const { status, headers } = headersOf(web.received());
    expect(status).toBe(408);
    expect(headers[agentApiHeader.toLowerCase()]).toBeUndefined();
    expect(headers["content-security-policy"]).toBe(
      securityHeaderValues(origin).get("content-security-policy"),
    );
  });
});

describe("the listener's deadlines, on real timers", () => {
  it(
    "cut headers at 10 seconds and a stalled body at 30, each within a second",
    async () => {
      const listening = await harness.listen();
      try {
        const { port } = listening.address;
        const started = performance.now();
        // closedAfter resolves with the time from the start to when a
        // connection closed.
        const closedAfter = (connection: Connection) =>
          new Promise<number>((resolve) => {
            const poll = setInterval(() => {
              if (connection.closed()) {
                clearInterval(poll);
                resolve(performance.now() - started);
              }
            }, 10);
          });
        const headers = open(port, `POST /api/web/session HTTP/1.1\r\nhost: ${host}\r\n`);
        const body = open(
          port,
          headOf("POST", "/api/agent/registrations", {
            authorization: `Bearer ${await harness.token(newAgentKey())}`,
            "content-type": "application/json",
            "content-length": "100",
          }) + "{",
        );
        const [headersCut, bodyCut] = await Promise.all([closedAfter(headers), closedAfter(body)]);
        expect(headersCut).toBeGreaterThanOrEqual(timeouts.headers - 50);
        expect(headersCut).toBeLessThan(timeouts.headers + 1500);
        expect(headersOf(headers.received()).status).toBe(408);
        expect(bodyCut).toBeGreaterThanOrEqual(timeouts.bodyIdle - 50);
        expect(bodyCut).toBeLessThan(timeouts.bodyIdle + 1500);
        const answer = headersOf(body.received());
        expect(answer.status).toBe(408);
        expect(answer.headers).toMatchObject({
          ...Object.fromEntries(securityHeaderValues(origin)),
          [agentApiHeader.toLowerCase()]: String(agentApi.version),
        });
      } finally {
        await listening.close();
      }
    },
    timeouts.bodyIdle + 15_000,
  );
});
