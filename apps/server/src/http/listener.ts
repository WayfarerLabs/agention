import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { BlockList, isIP, type Socket } from "node:net";

// The listener's address and TLS mode are independent of the origin people
// reach the server at: Agention can terminate TLS itself on any address, or
// serve plain HTTP on loopback behind a terminator such as tailscale serve.
// Plain HTTP anywhere else would carry tokens and cookies in the clear, so it
// needs an explicit flag.

// A listening configuration the operator got wrong, with a message naming
// what to change.
export class ListenerConfigError extends Error {
  override name = "ListenerConfigError";
}

export interface ListenAddress {
  host: string;
  port: number;
}

// parseListenAddress reads host:port, where the host is an IP address
// (IPv6 in brackets). Names are refused, so whether the address is loopback
// never depends on name resolution.
export function parseListenAddress(value: string): ListenAddress {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  const family = match?.[1] === undefined ? 4 : 6;
  if (host === undefined || isIP(host) !== family || port > 65535) {
    throw new ListenerConfigError(
      `--listen ${JSON.stringify(value)} must be an IP address and port, such as ` +
        "127.0.0.1:8080 or [::1]:8080",
    );
  }
  return { host, port };
}

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

export function isLoopback(host: string): boolean {
  return loopback.check(host, isIP(host) === 6 ? "ipv6" : "ipv4");
}

export interface ListenerFlags {
  listen: string;
  tlsCert: string | undefined;
  tlsKey: string | undefined;
  allowPlainHttp: boolean;
}

export interface ListenerPlan {
  address: ListenAddress;
  tls: { certFile: string; keyFile: string } | undefined;
}

// planListener decides how to listen from the flags, refusing plain HTTP on a
// non-loopback address unless --allow-plain-http says to.
export function planListener(flags: ListenerFlags): ListenerPlan {
  const address = parseListenAddress(flags.listen);
  if ((flags.tlsCert === undefined) !== (flags.tlsKey === undefined)) {
    throw new ListenerConfigError("--tls-cert and --tls-key go together; give both or neither");
  }
  if (flags.tlsCert !== undefined && flags.tlsKey !== undefined) {
    if (flags.allowPlainHttp) {
      throw new ListenerConfigError("--allow-plain-http contradicts --tls-cert and --tls-key");
    }
    return { address, tls: { certFile: flags.tlsCert, keyFile: flags.tlsKey } };
  }
  if (!isLoopback(address.host) && !flags.allowPlainHttp) {
    throw new ListenerConfigError(
      `refusing plain HTTP on ${flags.listen}, which is not a loopback address: give ` +
        "--tls-cert and --tls-key, listen on loopback behind a TLS terminator, or pass " +
        "--allow-plain-http if the network path is already encrypted",
    );
  }
  return { address, tls: undefined };
}

// The server's timeouts: a client gets 10 seconds to send its headers and 30
// to send its whole request, and an idle keep-alive connection closes after
// 120 seconds. A long poll's response takes longer, which these allow: they
// bound only how long the request takes to arrive.
export const timeouts = { headers: 10_000, request: 30_000, keepAlive: 120_000 };

// After shutdown starts, connections get this long to finish what they are
// doing before they are closed anyway, whatever state they are in.
export const shutdownGrace = 3000;

export interface Listening {
  server: Server;
  // The address actually bound, with the port the system chose for port 0.
  address: ListenAddress;
  // close stops accepting connections and resolves once the open ones end,
  // within the shutdown grace. Every response from then on closes its
  // connection, so a keep-alive connection does not hold the server open once
  // its request is answered.
  close(): Promise<void>;
}

// listen starts serving the app as planned, with the certificate and key
// already read when the plan terminates TLS.
export async function listen(
  app: Hono,
  address: ListenAddress,
  tls: { cert: Buffer; key: Buffer } | undefined,
): Promise<Listening> {
  // The adapter replaces the global Request and Response with its own, as it
  // does by default; Hono's middleware relies on them matching its requests.
  const handler = getRequestListener(app.fetch);
  let closing = false;
  const unanswered = new Set<ServerResponse>();
  const serve = (request: IncomingMessage, response: ServerResponse) => {
    if (closing) {
      response.setHeader("Connection", "close");
    } else {
      unanswered.add(response);
      response.once("close", () => unanswered.delete(response));
    }
    void handler(request, response);
  };
  const server: Server =
    tls === undefined
      ? createHttpServer(serve)
      : createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.3" }, serve);
  // Every socket the server accepts, in whatever state: a TLS socket still in
  // its handshake has not reached HTTP, so only this set can close it.
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.headersTimeout = timeouts.headers;
  server.requestTimeout = timeouts.request;
  server.keepAliveTimeout = timeouts.keepAlive;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : address.port;
  return {
    server,
    address: { host: address.host, port },
    close: () =>
      new Promise<void>((resolve) => {
        closing = true;
        for (const response of unanswered) {
          if (!response.headersSent) {
            response.setHeader("Connection", "close");
          }
        }
        const force = setTimeout(() => {
          for (const socket of sockets) {
            socket.destroy();
          }
        }, shutdownGrace);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}
