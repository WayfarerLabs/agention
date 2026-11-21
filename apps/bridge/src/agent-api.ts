import {
  agentApi,
  agentApiHeader,
  agentApiVersion,
  type ErrorBody,
} from "@wayfarerlabs/agention-api";
import { SignJWT } from "jose";
import packageJson from "../package.json" with { type: "json" };
import type { OutgoingHttpHeaders } from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import type { Duplex } from "node:stream";
import { text as readText } from "node:stream/consumers";
import type { TLSSocket } from "node:tls";
import { type ConnectAddress, formatAddress } from "./connect-address.ts";
import { ApiFailure, BridgeError, operatorProblem, settingProblem } from "./errors.ts";
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
// and nothing the bridge writes includes a token. A body is always sent whole,
// as a string, so Node declares its length.
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
    const url = new URL(`/api/agent${request.path}`, this.origin);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    const token = await agentToken(key, this.origin, this.#clock());
    const timeout = AbortSignal.timeout(answerTimeout + (request.wait ?? 0));
    const signals = request.signal === undefined ? [timeout] : [timeout, request.signal];
    const sent = request.body === undefined ? undefined : JSON.stringify(request.body);
    let status: number;
    let version: string | undefined;
    let text: string;
    try {
      ({ status, text, version } = await this.#send(
        url,
        {
          method: request.method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            [agentApiHeader]: String(agentApi.version),
            ...(sent === undefined ? {} : { "content-type": "application/json" }),
          },
          signal: AbortSignal.any(signals),
        },
        sent,
      ));
    } catch (error) {
      throw this.#unreachable(error, request.signal, timeout);
    }
    if (status >= 300 && status < 400) {
      throw settingProblem(
        `The server at ${this.origin} redirected the bridge's request, and the bridge sends its ` +
          "requests to that origin alone",
        "set AGENTION_URL to the Agention server's own origin",
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (status >= 200 && status < 300 && body !== undefined) {
      this.#requireVersion(version);
      return body;
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
  // redirect, and resolves with the answer's status, the agent API version it
  // states, if any, and its body.
  #send(
    url: URL,
    options: { method: string; headers: OutgoingHttpHeaders; signal: AbortSignal },
    body: string | undefined,
  ): Promise<{ status: number; version: string | undefined; text: string }> {
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest(url, { ...options, agent: this.#agent }, (response) => {
        const stated = response.headers[agentApiHeader.toLowerCase()];
        const version = typeof stated === "string" ? stated : undefined;
        readText(response).then(
          (text) => resolve({ status: response.statusCode ?? 0, version, text }),
          reject,
        );
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }

  #unreachable(error: unknown, cancel: AbortSignal | undefined, timeout: AbortSignal): BridgeError {
    const timedOut =
      timeout.aborted || (cancel?.reason as Error | undefined)?.name === "TimeoutError";
    if (cancel?.aborted && !timedOut) {
      return new BridgeError(
        "The tool call was cancelled; call the tool again if you still need it.",
      );
    }
    if (timedOut) {
      return new BridgeError(
        `Try again later, since the Agention server at ${this.origin} did not answer in time, ` +
          "and tell the operator at your terminal if it keeps happening.",
      );
    }
    const failure = error as { code?: unknown; message?: unknown };
    const detail = String(failure.code ?? failure.message);
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
      return operatorProblem(
        `The Agention server at ${this.origin} cannot be reached${through} (${detail})`,
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
