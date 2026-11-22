import {
  agentApi,
  agentApiHeader,
  type ErrorBody,
  timedOutBodyStatus,
} from "@wayfarerlabs/agention-api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isUploadRequest } from "./uploads.ts";

// The listener's own deadlines on request bodies, in place of Node's
// whole-request timeout, which is server-wide, cannot be lifted for one
// request and is checked only every 30 seconds. Every request whose body is
// still arriving is cut off once its body sends nothing for the idle limit,
// and, unless it is an upload, once it is still arriving the total limit
// after its headers. An upload has no total limit, so a slow link finishes.
// A request whose body is complete, a long poll's among them, is never
// touched, however long its answer takes. A request answered before its
// body is complete, such as a GET that carries one, keeps its deadlines, so
// the rest of its body cannot hold the connection open.

export interface DeadlineLimits {
  // How long a body may send nothing, in milliseconds.
  bodyIdle: number;
  // How long any request but an upload may take to arrive.
  request: number;
}

interface Tracked {
  request: IncomingMessage;
  response: ServerResponse;
  upload: boolean;
  arrivedAt: number;
  // The socket's bytesRead when last checked, and when it last grew. It grows
  // as bytes arrive whether or not the route reads them, so it measures the
  // client rather than the route.
  bytesRead: number;
  grewAt: number;
}

// Deadlines tracks requests from when their headers arrive and cuts off those
// past a deadline, checking them all every second once started.
export class Deadlines {
  readonly #limits: DeadlineLimits;
  readonly #securityHeaders: () => ReadonlyMap<string, string>;
  readonly #now: () => number;
  readonly #tracked = new Set<Tracked>();
  #timer: NodeJS.Timeout | undefined;

  // securityHeaders gives the headers every answer carries, which the
  // listener's own answer, written outside the app, carries too.
  constructor(options: {
    limits: DeadlineLimits;
    securityHeaders: () => ReadonlyMap<string, string>;
    now?: () => number;
  }) {
    this.#limits = options.limits;
    this.#securityHeaders = options.securityHeaders;
    this.#now = options.now ?? Date.now;
  }

  // track starts the deadlines of a request whose headers have arrived.
  track(request: IncomingMessage, response: ServerResponse): void {
    const now = this.#now();
    this.#tracked.add({
      request,
      response,
      upload: isUploadRequest(request.method ?? "", request.url ?? ""),
      arrivedAt: now,
      bytesRead: request.socket.bytesRead,
      grewAt: now,
    });
  }

  // How many requests are tracked, for the tests.
  get tracking(): number {
    return this.#tracked.size;
  }

  // check drops the requests whose bodies are complete or whose connections
  // have closed, and cuts off those past a deadline.
  check(): void {
    const now = this.#now();
    for (const tracked of this.#tracked) {
      const { request } = tracked;
      if (request.complete || request.destroyed || request.socket.destroyed) {
        this.#tracked.delete(tracked);
        continue;
      }
      const bytesRead = request.socket.bytesRead;
      if (bytesRead > tracked.bytesRead) {
        tracked.bytesRead = bytesRead;
        tracked.grewAt = now;
      }
      if (now - tracked.grewAt >= this.#limits.bodyIdle) {
        this.#cut(tracked, "the request body stopped arriving");
      } else if (!tracked.upload && now - tracked.arrivedAt >= this.#limits.request) {
        this.#cut(
          tracked,
          `the request took longer than ${this.#limits.request / 1000} seconds to arrive`,
        );
      }
    }
  }

  // start checks every second, on a timer that never holds the process open.
  start(): void {
    this.#timer ??= setInterval(() => this.check(), 1000);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  // cut answers a request 408 when its answer has not started, closing the
  // connection, and otherwise ends the connection. Either way the request is
  // then destroyed, so the route's read of the body fails, rather than waiting
  // on a body Node has stopped delivering, and an upload removes what arrived.
  // A request already answered has left the response, and Node discards the
  // rest of its body, so its socket is destroyed itself.
  // The answer carries what the app's middleware would have added: the
  // security headers, and on the agent mount the agent API version, without
  // which a bridge would take it for the answer of a server older than itself.
  #cut(tracked: Tracked, message: string): void {
    this.#tracked.delete(tracked);
    const { request, response } = tracked;
    const cutOff = new Error(message);
    if (response.writableFinished) {
      request.socket.destroy();
      return;
    }
    if (response.headersSent) {
      request.destroy(cutOff);
      return;
    }
    const body: ErrorBody = { error: { code: "invalid_input", message } };
    const text = JSON.stringify(body);
    const headers: Record<string, string> = {
      ...Object.fromEntries(this.#securityHeaders()),
      ...((request.url ?? "").startsWith("/api/agent/")
        ? { [agentApiHeader.toLowerCase()]: String(agentApi.version) }
        : {}),
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
      connection: "close",
    };
    response.writeHead(timedOutBodyStatus, headers);
    response.end(text, () => request.destroy(cutOff));
    // The route answers too once its read fails, to a response this answer
    // has ended. The adapter would report the second set of headers as an
    // error of its own, so they go nowhere, and the end that follows them
    // finds the response already finished.
    response.writeHead = () => response;
  }
}
