import {
  agentApi,
  agentApiHeader,
  agentApiVersion,
  type ErrorBody,
  maxFileBytes,
} from "@wayfarerlabs/agention-api";
import { SignJWT } from "jose";
import packageJson from "../package.json" with { type: "json" };
import type { FileHandle } from "node:fs/promises";
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { type Duplex, Transform, type Writable } from "node:stream";
import { text as readText } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import type { TLSSocket } from "node:tls";
import { type ConnectAddress, formatAddress } from "./connect-address.ts";
import { ApiFailure, BridgeError, detailOf, operatorProblem, settingProblem } from "./errors.ts";
import type { SessionKey } from "./key-file.ts";

// How long a token the bridge mints stays valid. The server accepts tokens
// expiring up to five minutes ahead of its clock, so this leaves two minutes
// of clock skew either way.
export const tokenLifetimeSeconds = 120;

// How long the server has to answer, beyond any time the request asks it to
// wait.
export const answerTimeout = 30_000;

// How long a connection has to open, its TLS handshake included.
export const connectTimeout = 10_000;

// How long a file's bytes may stop moving, sent or received, before the
// bridge gives up on the transfer. A file's transfer has no total deadline,
// so a large file on a slow link finishes.
export const transferIdle = 30_000;

// agentToken mints the token for one request: a compact JWS signed with the
// session's key, naming the key and bound to the server's origin for two
// minutes.
export async function agentToken(key: SessionKey, origin: string, now: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: key.publicKey })
    .setAudience(origin)
    .setExpirationTime(Math.floor(now / 1000) + tokenLifetimeSeconds)
    .sign(key.privateKey);
}

export interface ApiRequest {
  method: "GET" | "POST";
  // The path below /api/agent.
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  // How long the server may wait before answering, in milliseconds.
  wait?: number;
  // Aborts the request, such as when the host cancels the tool call. Aborting
  // it with a TimeoutError reports that the server did not answer in time.
  signal?: AbortSignal;
}

// An upload: a file's bytes, sent as the body of a POST from the start of an
// open file, with its declared type.
export interface UploadRequest {
  path: string;
  query?: ApiRequest["query"];
  file: FileHandle;
  // How many bytes to send: the file's size when it was opened. A file that
  // has grown since sends only these; one that has shrunk fails the upload.
  size: number;
  type: string;
  signal?: AbortSignal;
}

// A download: a GET whose successful answer is a file's bytes.
export interface DownloadRequest {
  path: string;
  query?: ApiRequest["query"];
  signal?: AbortSignal;
}

// What a download wrote: its size, and the type the server served it as.
export interface Downloaded {
  size: number;
  servedType: string;
}

export interface AgentApiOptions {
  // The server's canonical origin.
  origin: string;
  // Where the bridge opens its connections when that is not the origin's own
  // host and port, as AGENTION_CONNECT sets it, such as a tunnel's port.
  connectAddress?: ConnectAddress | undefined;
  clock: () => number;
}

// AgentApi makes requests on the server's agent API, each signed by a token
// minted for it and stating the agent API version the bridge speaks. Requests
// go only to the origin: a redirect is answered as an error, never followed,
// and nothing the bridge writes includes a token. Every body states its
// length, so Node never sends one chunked: a JSON body is sent whole, as a
// string, and a file's bytes stream with the length its upload declares.
export class AgentApi {
  readonly origin: string;
  readonly #connectAddress: ConnectAddress | undefined;
  readonly #agent: OriginAgent;
  readonly #clock: () => number;

  constructor(options: AgentApiOptions) {
    this.origin = options.origin;
    this.#connectAddress = options.connectAddress;
    const { hostname, port } = new URL(options.origin);
    this.#agent = new OriginAgent(
      hostname,
      options.connectAddress ?? { host: hostname, port: Number(port || 443) },
    );
    this.#clock = options.clock;
  }

  // request returns the body of a successful answer. It throws ApiFailure
  // for an answer in the API's error shape, and BridgeError when the server
  // cannot be reached, is older than the bridge or answers with something
  // else.
  async request(key: SessionKey, request: ApiRequest): Promise<unknown> {
    const url = this.#url(request.path, request.query);
    const sent = request.body === undefined ? undefined : JSON.stringify(request.body);
    const headers = await this.#headers(
      key,
      sent === undefined ? {} : { "content-type": "application/json" },
    );
    const watchdog = new Watchdog();
    const signals = [watchdog.signal, ...(request.signal === undefined ? [] : [request.signal])];
    let answer: Answer;
    try {
      watchdog.arm(answerTimeout + (request.wait ?? 0), "answer");
      answer = await this.#send(
        url,
        { method: request.method, headers, signal: AbortSignal.any(signals) },
        (outgoing) => outgoing.end(sent),
        answerOf,
      );
    } catch (error) {
      throw this.#unreachable(error, request.signal, watchdog.expired);
    } finally {
      watchdog.stop();
    }
    return this.#answer(answer);
  }

  // upload sends a file's bytes and returns the body of a successful answer,
  // failing as request does. The bytes stream under the transfer's idle
  // limit, and its answer then has the usual time to arrive.
  async upload(key: SessionKey, upload: UploadRequest): Promise<unknown> {
    const url = this.#url(upload.path, upload.query);
    const headers = await this.#headers(key, {
      "content-type": upload.type,
      "content-length": String(upload.size),
    });
    const watchdog = new Watchdog();
    const signals = [watchdog.signal, ...(upload.signal === undefined ? [] : [upload.signal])];
    let changed = false;
    const sent = (): void => watchdog.arm(answerTimeout, "answer");
    const send = (outgoing: ClientRequest): void => {
      watchdog.arm(transferIdle, "stalled");
      if (upload.size === 0) {
        outgoing.end();
        sent();
        return;
      }
      let read = 0;
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          read += chunk.length;
          watchdog.arm(transferIdle, "stalled");
          done(null, chunk);
        },
        flush(done) {
          // The file ended before the size it had when it was opened.
          changed = read < upload.size;
          done(changed ? new Error("the file shrank while it was read") : null);
        },
      });
      const source = upload.file.createReadStream({
        start: 0,
        end: upload.size - 1,
        autoClose: false,
      });
      pipeline(source, counted, outgoing).then(sent, () => undefined);
    };
    let answer: Answer;
    try {
      answer = await this.#send(
        url,
        { method: "POST", headers, signal: AbortSignal.any(signals) },
        send,
        answerOf,
      );
    } catch (error) {
      if (changed) {
        throw new BridgeError(
          "The file changed while it was read, so nothing was uploaded; call file_upload again " +
            "once it stops changing.",
        );
      }
      throw this.#unreachable(error, upload.signal, watchdog.expired);
    } finally {
      watchdog.stop();
    }
    return this.#answer(answer);
  }

  // download writes the bytes of a successful answer into a stream and
  // returns their size and served type, failing as request does. The bytes
  // stream under the transfer's idle limit.
  async download(key: SessionKey, request: DownloadRequest, into: Writable): Promise<Downloaded> {
    const url = this.#url(request.path, request.query);
    const headers = await this.#headers(key, { accept: "*/*" });
    const watchdog = new Watchdog();
    const signals = [watchdog.signal, ...(request.signal === undefined ? [] : [request.signal])];
    let receiving = false;
    // A failure to write what arrives is the caller's to word. Whichever
    // stream fails first is where the failure is, since the others then fail
    // with it.
    let responseFailed = false;
    let writeFailure: unknown;
    into.once("error", (error) => {
      if (!responseFailed) {
        writeFailure = error;
      }
    });
    const receive = async (response: IncomingMessage): Promise<Answer | Downloaded> => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        return answerOf(response);
      }
      this.#requireVersion(versionOf(response));
      // Agention's server states a file's length, which Node then holds the
      // body to, and serves none larger than a file may be. Nothing of an
      // answer that does otherwise is written, so a server at the wrong
      // origin cannot fill the disk.
      const stated = response.headers["content-length"];
      if (stated === undefined || Number(stated) > maxFileBytes) {
        response.destroy();
        throw operatorProblem(
          `The server at ${this.origin} answered with a file ` +
            `${stated === undefined ? "without stating its length" : "larger than a file may be"}, ` +
            "which an Agention server never does",
          "check that AGENTION_URL is the Agention server's origin and that nothing on the way " +
            `changes its answers, ${restartAfterURL}`,
        );
      }
      receiving = true;
      response.once("error", () => (responseFailed = true));
      watchdog.arm(transferIdle, "stalled");
      let received = 0;
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          watchdog.arm(transferIdle, "stalled");
          done(null, chunk);
        },
      });
      await pipeline(response, counted, into);
      return { size: received, servedType: response.headers["content-type"] ?? "" };
    };
    let result: Answer | Downloaded;
    try {
      watchdog.arm(answerTimeout, "answer");
      result = await this.#send(
        url,
        { method: "GET", headers, signal: AbortSignal.any(signals) },
        (outgoing) => outgoing.end(),
        receive,
      );
    } catch (error) {
      if (error instanceof BridgeError || writeFailure !== undefined) {
        throw writeFailure ?? error;
      }
      const cancelled = request.signal?.aborted === true;
      if (receiving && watchdog.expired === undefined && !cancelled) {
        throw new BridgeError(
          `The file stopped arriving from the Agention server at ${this.origin} before it ` +
            `finished (${detailOf(error)}); try again, and tell the operator at your terminal ` +
            "if it keeps happening.",
        );
      }
      throw this.#unreachable(error, request.signal, watchdog.expired);
    } finally {
      watchdog.stop();
    }
    if ("text" in result) {
      return this.#failure(result, parsedJson(result.text));
    }
    return result;
  }

  // url is a path below /api/agent on the origin, with its query.
  #url(path: string, query: ApiRequest["query"]): URL {
    const url = new URL(`/api/agent${path}`, this.origin);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    return url;
  }

  // headers are a request's headers: a token minted for it, the agent API
  // version, and those given.
  async #headers(key: SessionKey, given: OutgoingHttpHeaders): Promise<OutgoingHttpHeaders> {
    const token = await agentToken(key, this.origin, this.#clock());
    return {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      [agentApiHeader]: String(agentApi.version),
      ...given,
    };
  }

  // answer reads an answer that is not a file's bytes: the body of a
  // successful one in Agention's JSON, or the failure it describes.
  #answer(answer: Answer): unknown {
    const body = parsedJson(answer.text);
    if (answer.status >= 200 && answer.status < 300 && body !== undefined) {
      this.#requireVersion(answer.version);
      return body;
    }
    return this.#failure(answer, body);
  }

  // failure throws what an answer that is not a success means.
  #failure({ status, version }: Answer, body: unknown): never {
    if (status >= 300 && status < 400) {
      throw settingProblem(
        `The server at ${this.origin} redirected the bridge's request, and the bridge sends its ` +
          "requests to that origin alone",
        "set AGENTION_URL to the Agention server's own origin",
      );
    }
    if (isErrorBody(body)) {
      this.#requireVersion(version);
      throw new ApiFailure(body);
    }
    // Agention answers its own failures in its JSON, so a server error
    // without it comes from a proxy, such as tailscale serve while the server
    // behind it is stopped, or one AGENTION_URL names by mistake.
    if (status >= 500) {
      throw operatorProblem(
        `The server at ${this.origin} answered ${status} without Agention's JSON, as a proxy ` +
          "does when the server behind it is not running",
        `check that the Agention server is running and that AGENTION_URL is its origin, ` +
          restartAfterURL,
      );
    }
    throw settingProblem(
      `The server at ${this.origin} answered ${status} with something other than Agention's JSON`,
      "set AGENTION_URL to the Agention server's origin",
    );
  }

  // requireVersion refuses an answer in Agention's JSON from a server that
  // states an older agent API version than the bridge's, or none, before
  // anything uses the answer: such a server ignores what it does not know of
  // a request, so a field the bridge sent could go missing without a word. A
  // newer server's answers are used: it serves this bridge's version, or
  // refuses it in words of its own.
  #requireVersion(version: string | undefined): void {
    const stated = agentApiVersion.safeParse(version);
    if (stated.success && stated.data >= agentApi.version) {
      return;
    }
    throw operatorProblem(
      `The Agention server at ${this.origin} is older than this bridge, ` +
        `${packageJson.version}, and does not speak its version of the agent API`,
      `upgrade the server to ${packageJson.version} or later, or pin the Agention plugin to ` +
        "the server's release and restart this session, resuming it to keep this conversation",
    );
  }

  // send makes one request through the origin's agent, which never follows a
  // redirect: write sends its body, and read reads the answer once it
  // arrives.
  #send<T>(
    url: URL,
    options: { method: string; headers: OutgoingHttpHeaders; signal: AbortSignal },
    write: (outgoing: ClientRequest) => void,
    read: (response: IncomingMessage) => Promise<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest(url, { ...options, agent: this.#agent }, (response) => {
        read(response).then(resolve, reject);
      });
      outgoing.on("error", reject);
      write(outgoing);
    });
  }

  // unreachable says why a request got no answer: the call was cancelled, a
  // limit ran out (the time to answer, or a transfer's idle limit), or the
  // server could not be reached.
  #unreachable(
    error: unknown,
    cancel: AbortSignal | undefined,
    expired: Limit | undefined,
  ): BridgeError {
    const timedOut =
      expired === "answer" || (cancel?.reason as Error | undefined)?.name === "TimeoutError";
    if (cancel?.aborted && !timedOut) {
      return new BridgeError(
        "The tool call was cancelled; call the tool again if you still need it.",
      );
    }
    if (expired === "stalled") {
      return new BridgeError(
        `The transfer stalled for ${transferIdle / 1000} seconds; try again, and tell the ` +
          "operator at your terminal if it keeps happening.",
      );
    }
    if (timedOut) {
      return new BridgeError(
        `Try again later, since the Agention server at ${this.origin} did not answer in time, ` +
          "and tell the operator at your terminal if it keeps happening.",
      );
    }
    const failure = error as { message?: unknown };
    const detail = detailOf(error);
    // Where the bridge connects, when AGENTION_CONNECT sets it.
    const through =
      this.#connectAddress === undefined
        ? ""
        : ` through ${formatAddress(this.#connectAddress)}, the address in AGENTION_CONNECT`;
    if (untrustedCertificate.has(detail)) {
      return settingProblem(
        `Node does not trust the certificate of the Agention server at ${this.origin}` +
          `${through} (${detail})`,
        "set NODE_EXTRA_CA_CERTS to a file with the certificate of the authority that issued it",
      );
    }
    if (this.#connectAddress !== undefined) {
      const problem = `The Agention server at ${this.origin} cannot be reached${through} (${detail})`;
      // A TLS handshake answered in plain text fails with OpenSSL's "wrong
      // version number": the address leads to a plain-text listener, such as
      // the server's own port behind a proxy that holds its certificate.
      if (/wrong version number/.test(String(failure.message))) {
        const { hostname, port } = new URL(this.origin);
        return operatorProblem(
          `${problem}: the address answers without TLS`,
          `make the tunnel or other forward lead to ${hostname}:${port || 443}, ` +
            "the server's HTTPS origin, not to the port the server itself listens on",
        );
      }
      return operatorProblem(
        problem,
        "check that the tunnel or other forward at that address is up and reaches the server, " +
          `and that AGENTION_CONNECT names it, ${restartAfter("AGENTION_CONNECT")}`,
      );
    }
    return operatorProblem(
      `The Agention server at ${this.origin} cannot be reached (${detail})`,
      `check that it is running and that AGENTION_URL is its origin, ${restartAfterURL}`,
    );
  }
}

// An answer that is not a file's bytes: its status, the agent API version it
// states, if any, and its body.
interface Answer {
  status: number;
  version: string | undefined;
  text: string;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function versionOf(response: IncomingMessage): string | undefined {
  const stated = response.headers[agentApiHeader.toLowerCase()];
  return typeof stated === "string" ? stated : undefined;
}

async function answerOf(response: IncomingMessage): Promise<Answer> {
  const text = await readText(response);
  return { status: response.statusCode ?? 0, version: versionOf(response), text };
}

// The limits a request runs under: the time its answer has to arrive, and
// the time a transfer's bytes may stop moving.
type Limit = "answer" | "stalled";

// Watchdog aborts its signal once the limit it was last armed with runs out,
// and says which limit that was. A transfer re-arms it as its bytes move. Its
// timer never holds the process open, so a bridge whose host has gone exits
// even while a call waits.
class Watchdog {
  readonly #controller = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  expired: Limit | undefined;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  arm(milliseconds: number, limit: Limit): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.expired = limit;
      this.#controller.abort(new DOMException(`The ${limit} limit ran out.`, "TimeoutError"));
    }, milliseconds).unref();
  }

  stop(): void {
    clearTimeout(this.#timer);
  }
}

// A changed setting takes effect once the session restarts.
const restartAfter = (setting: string) => `restarting the session after changing ${setting}`;
const restartAfterURL = restartAfter("AGENTION_URL");

// OriginAgent is the HTTPS agent for requests to the origin. It opens each
// connection at the connect address, which is the origin's own host and port
// unless AGENTION_CONNECT names another, and checks the server's certificate
// against the origin's host name there too, so a listener at that address
// without the server's certificate never receives a request.
class OriginAgent extends Agent {
  readonly #servername: string;
  readonly #address: ConnectAddress;

  constructor(servername: string, address: ConnectAddress) {
    // Node's global agent's settings: connections are kept alive, the one
    // used last is used next, and one idle for 5 seconds closes.
    super({ keepAlive: true, scheduling: "lifo", timeout: 5000 });
    this.#servername = servername;
    this.#address = address;
  }

  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const socket = super.createConnection(
      {
        ...options,
        host: this.#address.host,
        port: this.#address.port,
        servername: this.#servername,
      },
      callback,
    ) as TLSSocket;
    // A connection that does not open in time fails, as one refused does,
    // rather than holding the request until the server's time to answer
    // runs out.
    const timer = setTimeout(
      () => socket.destroy(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })),
      connectTimeout,
    );
    const stop = () => clearTimeout(timer);
    socket.once("secureConnect", stop).once("close", stop);
    return socket;
  }
}

// The TLS errors of a certificate whose authority Node does not trust.
const untrustedCertificate = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

// isErrorBody checks only what the bridge relies on, so an error a newer
// server adds reaches the agent as the server wrote it.
function isErrorBody(value: unknown): value is ErrorBody {
  const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return typeof error?.code === "string" && typeof error.message === "string";
}
