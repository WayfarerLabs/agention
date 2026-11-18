import type { ErrorBody } from "@wayfarerlabs/agention-api";
import { SignJWT } from "jose";
import { ApiFailure, BridgeError } from "./errors.ts";
import type { SessionKey } from "./key-file.ts";

// How long a token the bridge mints stays valid. The server accepts tokens
// expiring up to five minutes ahead of its clock, so this leaves two minutes
// of clock skew either way.
export const tokenLifetimeSeconds = 120;

// How long the server has to answer, beyond any time the request asks it to
// wait.
export const answerTimeout = 30_000;

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
  clock: () => number;
}

// AgentApi makes requests on the server's agent API, each signed by a token
// minted for it. Requests go only to the origin: a redirect is answered as an
// error, never followed, and nothing the bridge writes includes a token. A
// body is always sent as a string, so it declares its length.
export class AgentApi {
  readonly origin: string;
  readonly #clock: () => number;

  constructor(options: AgentApiOptions) {
    this.origin = options.origin;
    this.#clock = options.clock;
  }

  // request returns the body of a successful answer. It throws ApiFailure
  // for an answer in the API's error shape, and BridgeError when the server
  // cannot be reached or answers with something else.
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
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: "manual",
        signal: AbortSignal.any(signals),
      });
      text = await response.text();
    } catch (error) {
      throw this.#unreachable(error, request.signal, timeout);
    }
    const { status } = response;
    if (status >= 300 && status < 400) {
      throw new BridgeError(
        `Check AGENTION_URL, since the server at ${this.origin} redirected the request and the ` +
          "bridge sends its requests to that origin alone.",
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (status >= 200 && status < 300 && body !== undefined) {
      return body;
    }
    if (isErrorBody(body)) {
      throw new ApiFailure(body);
    }
    throw new BridgeError(
      `Check AGENTION_URL, since the server at ${this.origin} answered ${status} with ` +
        "something other than Agention's JSON.",
    );
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
        `Try again later, since the Agention server at ${this.origin} did not answer in time.`,
      );
    }
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const detail = String(cause?.code ?? cause?.message ?? (error as Error).message);
    if (untrustedCertificate.has(detail)) {
      return new BridgeError(
        `Set NODE_EXTRA_CA_CERTS to a file with the certificate of the authority that issued ` +
          `the certificate of the Agention server at ${this.origin}, which Node does not trust ` +
          `(${detail}).`,
      );
    }
    return new BridgeError(
      `Check that the Agention server at ${this.origin} is running and reachable (${detail}).`,
    );
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
