import { testCertificate } from "@wayfarerlabs/agention/src/http/test-certificate.ts";
import { createServer } from "node:https";
import { once } from "node:events";
import { createServer as createTcpServer, type Socket } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTimeout } from "./agent-api.ts";
import { BridgeHarness, certificate } from "./test-harness.ts";

// Bridges that reach the server through AGENTION_CONNECT, as through a
// tunnel. The server's origin names a host under .test, which no resolver
// resolves, at the default port, where none of these tests listens: a bridge
// reaches it only at the address the server listens on. Its certificate, for
// that host, is trusted as the harness's own is.
const host = "agention.test";
const hostCertificate = testCertificate(host);
setDefaultCACertificates([...getCACertificates("default"), hostCertificate.cert]);

let harness: BridgeHarness;

beforeEach(async () => {
  harness = await new BridgeHarness().start({
    origin: `https://${host}`,
    certificate: hostCertificate,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.close();
});

// listening starts a server on 127.0.0.1 and returns its port.
async function listening(server: {
  listen(port: number, host: string, ready: () => void): unknown;
  address(): unknown;
}): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

describe("AGENTION_CONNECT", () => {
  it.each(["127.0.0.1", "localhost"])(
    "opens the bridge's connections at %s and the port, while TLS, Host and tokens name the origin",
    async (addressHost) => {
      const hosts: (string | null)[] = [];
      harness.beforeRequest = (request) => {
        hosts.push(request.headers.get("host"));
      };
      const bridge = await harness.bridge({ AGENTION_CONNECT: `${addressHost}:${harness.port}` });
      expect(await bridge.ok("register")).toMatchObject({ status: "pending" });
      await harness.approve(harness.keyOnDisk());
      const created = await bridge.ok("thread_create", { request_id: "r1", title: "A question" });
      expect(created).toMatchObject({ number: 1 });
      // The server takes a request only with its own Host and a token for its
      // origin, so each one answered also shows the token named it.
      expect(hosts.length).toBeGreaterThanOrEqual(2);
      expect(new Set(hosts)).toEqual(new Set([host]));
    },
  );

  // The certificate for another host also names 127.0.0.1, the address the
  // bridge connects to, so only a check against the origin's host refuses it.
  it.each([
    [
      "for another host, from an authority Node trusts",
      certificate,
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ],
    [
      "for the origin's host, from an authority Node does not trust",
      testCertificate(host),
      "DEPTH_ZERO_SELF_SIGNED_CERT",
    ],
  ])(
    "sends nothing to a listener at its address whose certificate is %s",
    async (_, impostorCertificate, failure) => {
      let reached = 0;
      const impostor = createServer(
        { cert: impostorCertificate.cert, key: impostorCertificate.key },
        (_, response) => {
          reached++;
          response.writeHead(200, { "content-type": "application/json" }).end("{}");
        },
      );
      const port = await listening(impostor);
      const bridge = await harness.bridge({ AGENTION_CONNECT: `127.0.0.1:${port}` });
      const answer = await bridge.call("register");
      await new Promise((resolve) => impostor.close(resolve));
      expect([answer.isError, answer.json]).toEqual([true, undefined]);
      expect(answer.text).toContain(failure);
      expect(reached).toBe(0);
    },
  );

  it("that nothing listens at is reported naming the setting and the address", async () => {
    const bridge = await harness.bridge({ AGENTION_CONNECT: "127.0.0.1:9" });
    const answer = await bridge.call("register");
    expect([answer.isError, answer.json]).toEqual([true, undefined]);
    expect(answer.text).toContain("ECONNREFUSED");
    expect(answer.text).toContain("AGENTION_CONNECT");
    expect(answer.text).toContain("127.0.0.1:9");
  });

  // As when a tunnel takes the connection but cannot reach the server.
  it("that never completes the TLS handshake is reported once the connection times out", async () => {
    const silent = createTcpServer();
    const port = await listening(silent);
    const accepted = once(silent, "connection") as Promise<[Socket]>;
    const bridge = await harness.bridge({ AGENTION_CONNECT: `127.0.0.1:${port}` });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answered = false;
    const calling = bridge.call("register").finally(() => (answered = true));
    // Once the connection is taken, the bridge has started its timer.
    const [socket] = await accepted;
    await vi.advanceTimersByTimeAsync(connectTimeout - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const answer = await calling;
    socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
    expect([answer.isError, answer.json]).toEqual([true, undefined]);
    expect(answer.text).toContain("ETIMEDOUT");
    expect(answer.text).toContain("AGENTION_CONNECT");
  });

  it("keeps a connection that opened however long the server takes to answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let entered: () => void = () => undefined;
    const received = new Promise<void>((resolve) => (entered = resolve));
    harness.beforeRequest = () => {
      entered();
      return new Promise<void>((resolve) => setTimeout(resolve, connectTimeout * 2));
    };
    const bridge = await harness.bridge({ AGENTION_CONNECT: `127.0.0.1:${harness.port}` });
    const calling = bridge.ok("register");
    // The request has reached the server, so its connection has opened.
    await received;
    await vi.advanceTimersByTimeAsync(connectTimeout * 2);
    expect(await calling).toMatchObject({ status: "pending" });
  });
});
