import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Listening,
  ListenerConfigError,
  listen,
  type ListenerFlags,
  parseListenAddress,
  planListener,
  shutdownGrace,
} from "./listener.ts";
import { testCertificate } from "./test-certificate.ts";
import { maxBodyBytes } from "./app.ts";
import { Harness, host, newAgentKey } from "./test-harness.ts";

const flags = (listen: string, changes: Partial<ListenerFlags> = {}): ListenerFlags => ({
  listen,
  tlsCert: undefined,
  tlsKey: undefined,
  allowPlainHttp: false,
  ...changes,
});

const tls = { tlsCert: "cert.pem", tlsKey: "key.pem" };

describe("the listener mode", () => {
  it.each(["127.0.0.1:8080", "127.0.0.2:8080", "[::1]:8080"])(
    "serves plain HTTP on the loopback address %s",
    (address) => {
      expect(planListener(flags(address)).tls).toBeUndefined();
    },
  );

  it.each(["0.0.0.0:8080", "192.0.2.10:8080", "[::]:8080", "[2001:db8::1]:8080"])(
    "refuses plain HTTP on %s without --allow-plain-http",
    (address) => {
      expect(() => planListener(flags(address))).toThrow(ListenerConfigError);
      expect(() => planListener(flags(address))).toThrow(/--allow-plain-http/);
      expect(planListener(flags(address, { allowPlainHttp: true })).tls).toBeUndefined();
    },
  );

  it.each(["127.0.0.1:8443", "0.0.0.0:8443", "[::]:8443"])(
    "terminates TLS on %s given a certificate and key",
    (address) => {
      expect(planListener(flags(address, tls)).tls).toEqual({
        certFile: "cert.pem",
        keyFile: "key.pem",
      });
    },
  );

  it.each([
    ["a certificate without a key", { tlsCert: "cert.pem" }],
    ["a key without a certificate", { tlsKey: "key.pem" }],
    ["TLS together with --allow-plain-http", { ...tls, allowPlainHttp: true }],
  ])("refuses %s", (_, changes) => {
    expect(() => planListener(flags("0.0.0.0:8443", changes))).toThrow(ListenerConfigError);
  });

  it.each([
    "localhost:8080",
    "8080",
    "127.0.0.1",
    "::1:8080",
    "[::1]",
    "[127.0.0.1]:8080",
    "127.0.0.1:65536",
    "1.2.3:8080",
  ])("refuses the address %s", (address) => {
    expect(() => parseListenAddress(address)).toThrow(ListenerConfigError);
  });
});

describe("a real listener", () => {
  let harness: Harness;
  let listening: Listening | undefined;

  beforeEach(() => {
    harness = new Harness();
  });

  afterEach(async () => {
    harness.close();
    await listening?.close();
    listening = undefined;
  });

  function get(
    port: number,
    path: string,
    ca?: string,
  ): Promise<{ status: number; body: string; protocol?: string }> {
    return new Promise((resolve, reject) => {
      const options = { host: "127.0.0.1", port, path, headers: { host } };
      const done = (response: IncomingMessage) => {
        const protocol =
          ca === undefined ? {} : { protocol: (response.socket as TLSSocket).getProtocol() ?? "" };
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body, ...protocol }));
      };
      const request =
        ca === undefined
          ? httpRequest(options, done)
          : httpsRequest({ ...options, ca, servername: "localhost" }, done);
      request.on("error", reject);
      request.end();
    });
  }

  it("terminates TLS 1.3 with the certificate it is given, on loopback or not", async () => {
    const certificate = testCertificate();
    const keys = { cert: Buffer.from(certificate.cert), key: Buffer.from(certificate.key) };
    for (const address of ["127.0.0.1:0", "0.0.0.0:0"]) {
      listening = await listen(harness.app, parseListenAddress(address), keys);
      const response = await get(listening.address.port, "/api/web/session", certificate.cert);
      expect(response).toMatchObject({ status: 200, protocol: "TLSv1.3" });
      await expect(get(listening.address.port, "/api/web/session")).rejects.toThrow();
      const { port } = listening.address;
      // handshake reports the protocol a TLS client agrees on, or that the
      // server refused it.
      const handshake = (maxVersion?: "TLSv1.2") =>
        new Promise<string>((resolve) => {
          const socket = tlsConnect(
            {
              host: "127.0.0.1",
              port,
              ca: certificate.cert,
              servername: "localhost",
              ...(maxVersion === undefined ? {} : { maxVersion }),
            },
            () => {
              resolve(socket.getProtocol() ?? "");
              socket.destroy();
            },
          );
          socket.on("error", () => resolve("refused"));
        });
      expect(await handshake()).toBe("TLSv1.3");
      const refused = await handshake("TLSv1.2");
      expect(refused).toBe("refused");
      await listening.close();
      listening = undefined;
    }
  });

  it("serves plain HTTP when planned", async () => {
    for (const plan of [
      planListener(flags("127.0.0.1:0")),
      planListener(flags("0.0.0.0:0", { allowPlainHttp: true })),
    ]) {
      listening = await listen(harness.app, plan.address, undefined);
      expect((await get(listening.address.port, "/api/web/session")).status).toBe(200);
      await listening.close();
      listening = undefined;
    }
  });

  // send writes a POST on a raw socket, its body with a length or in chunks
  // without one, a piece at a time, or with neither when there is no body, and
  // returns the response's status.
  // A raw socket keeps reading the response the server sends before it has
  // read the whole body, which an HTTP client gives up on.
  async function send(
    port: number,
    path: string,
    headers: Record<string, string>,
    body?: string,
    chunked = false,
  ): Promise<number> {
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    let received = "";
    const status = new Promise<number>((resolve) => {
      socket.on("data", (data: Buffer) => {
        received += data.toString();
        const match = /^HTTP\/1\.1 (\d{3}) /.exec(received);
        if (match !== null) {
          resolve(Number(match[1]));
        }
      });
    });
    const head = Object.entries({
      host,
      ...headers,
      ...(chunked
        ? { "transfer-encoding": "chunked" }
        : body === undefined
          ? {}
          : { "content-length": `${body.length}` }),
    }).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.write(`POST ${path} HTTP/1.1\r\n${head.join("")}\r\n`);
    for (let at = 0; body !== undefined && at < body.length; at += 65_536) {
      const piece = body.slice(at, at + 65_536);
      socket.write(chunked ? `${piece.length.toString(16)}\r\n${piece}\r\n` : piece);
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (chunked) {
      socket.write("0\r\n\r\n");
    }
    const result = await status;
    socket.destroy();
    return result;
  }

  it("takes request bodies over the socket with a length, and bounds them", async () => {
    listening = await listen(harness.app, parseListenAddress("127.0.0.1:0"), undefined);
    const { port } = listening.address;
    const browser = { origin: "https://agention.test" };
    expect(await send(port, "/api/web/auth/signin/begin", browser)).toBe(200);
    const key = newAgentKey();
    const agent = {
      authorization: `Bearer ${await harness.token(key)}`,
      "content-type": "application/json",
    };
    const registration = JSON.stringify({ agent: "builder", session: "main" });
    expect(await send(port, "/api/agent/registrations", agent, registration)).toBe(200);
    const oversized = `{"pad":"${"x".repeat(maxBodyBytes)}"}`;
    expect(await send(port, "/api/agent/registrations", agent, oversized)).toBe(413);
  });

  it("refuses a body without a length before authenticating it", async () => {
    listening = await listen(harness.app, parseListenAddress("127.0.0.1:0"), undefined);
    const { port } = listening.address;
    const registration = JSON.stringify({ agent: "builder", session: "main" });
    const signed = {
      authorization: `Bearer ${await harness.token(newAgentKey())}`,
      "content-type": "application/json",
    };
    expect(await send(port, "/api/agent/registrations", signed, registration, true)).toBe(411);
    const unsigned = { "content-type": "application/json" };
    expect(await send(port, "/api/agent/registrations", unsigned, registration, true)).toBe(411);
    const oversized = `{"pad":"${"x".repeat(maxBodyBytes)}"}`;
    expect(await send(port, "/api/agent/registrations", signed, oversized, true)).toBe(411);
    expect(harness.fixture.db.prepare("SELECT 1 FROM registrations").get()).toBeUndefined();
  });

  it(
    "closes every connection by the end of the shutdown grace, a stalled TLS handshake included",
    async () => {
      const agent = await harness.approvedAgent("builder", "main");
      const certificate = testCertificate();
      const keys = { cert: Buffer.from(certificate.cert), key: Buffer.from(certificate.key) };
      listening = await listen(harness.app, parseListenAddress("127.0.0.1:0"), keys);
      const { port } = listening.address;

      // A TCP connection that never sends a ClientHello, so it never reaches HTTP.
      const stalled = connect(port, "127.0.0.1");
      stalled.on("error", () => undefined);
      const stalledClosed = new Promise((resolve) => stalled.once("close", resolve));
      // An HTTPS long poll that nothing ends, since the app's shutdown signal
      // is not aborted here.
      const poll = httpsRequest({
        host: "127.0.0.1",
        port,
        path: "/api/agent/s/builder/main/wait?wait=25",
        ca: certificate.cert,
        servername: "localhost",
        headers: { host, authorization: `Bearer ${await harness.token(agent)}` },
      });
      poll.on("error", () => undefined);
      poll.end();
      const { server } = listening;
      const connections = () =>
        new Promise<number>((resolve) => server.getConnections((_, count) => resolve(count)));
      for (let i = 0; i < 200 && (await connections()) < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(await connections()).toBe(2);

      const started = performance.now();
      await listening.close();
      listening = undefined;
      await stalledClosed;
      expect(performance.now() - started).toBeLessThan(shutdownGrace + 1000);
    },
    shutdownGrace + 5000,
  );

  it("ends a long poll when its client disconnects", async () => {
    const agent = await harness.approvedAgent("builder", "main");
    listening = await listen(harness.app, parseListenAddress("127.0.0.1:0"), undefined);
    const token = await harness.token(agent);
    const request = httpRequest({
      host: "127.0.0.1",
      port: listening.address.port,
      path: "/api/agent/s/builder/main/wait?wait=25",
      headers: { host, authorization: `Bearer ${token}` },
    });
    request.on("error", () => undefined);
    request.end();
    const { notifier } = harness.fixture.store;
    const session = (harness.fixture.db.prepare("SELECT id FROM sessions").get() as { id: number })
      .id;
    for (let i = 0; i < 200 && notifier.waiting(session) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(notifier.waiting(session)).toBe(1);
    request.destroy();
    for (let i = 0; i < 200 && notifier.waiting(session) > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(notifier.waiting(session)).toBe(0);
  });
});
