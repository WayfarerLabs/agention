import {
  agentApi,
  agentApiHeader,
  agentApiVersion,
  type ErrorBody,
} from "@wayfarerlabs/agention-api";
import { SignJWT } from "jose";
import packageJson from "../package.json" with { type: "json" };
import { ApiFailure, BridgeError, operatorProblem, settingProblem } from "./errors.ts";
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
// minted for it and stating the agent API version the bridge speaks. Requests
// go only to the origin: a redirect is answered as an error, never followed,
// and nothing the bridge writes includes a token. A body is always sent as a
// string, so it declares its length.
export class AgentApi {
  readonly origin: string;
  readonly #clock: () => number;

  constructor(options: AgentApiOptions) {
    this.origin = options.origin;
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
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          [agentApiHeader]: String(agentApi.version),
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
      this.#requireVersion(response);
      return body;
    }
    if (isErrorBody(body)) {
      this.#requireVersion(response);
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
  #requireVersion(response: Response): void {
    const stated = agentApiVersion.safeParse(response.headers.get(agentApiHeader) ?? undefined);
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
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const detail = String(cause?.code ?? cause?.message ?? (error as Error).message);
    if (untrustedCertificate.has(detail)) {
      return settingProblem(
        `Node does not trust the certificate of the Agention server at ${this.origin} (${detail})`,
        "set NODE_EXTRA_CA_CERTS to a file with the certificate of the authority that issued it",
      );
    }
    return operatorProblem(
      `The Agention server at ${this.origin} cannot be reached (${detail})`,
      `check that it is running and that AGENTION_URL is its origin, ${restartAfterURL}`,
    );
  }
}

// A changed AGENTION_URL, like every setting, takes effect once the session
// restarts.
const restartAfterURL = "restarting the session after changing AGENTION_URL";

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
