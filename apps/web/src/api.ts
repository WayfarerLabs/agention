import {
  type AgentsPage,
  type ErrorCode,
  errorBody,
  type Message,
  maxListed,
} from "@wayfarerlabs/agention-api";

// The web UI's client for the server's web API, mounted at /api/web. Requests
// carry the browser session's cookie, which the page cannot read, and every
// change also carries the session's CSRF token.

// Why a request failed: one of the API's error codes, "network" when no answer
// arrived, or "unexpected" when something other than the API answered, such as
// a TLS terminator's error page.
export type FailureCode = ErrorCode | "network" | "unexpected";

export class ApiFailure extends Error {
  override name = "ApiFailure";
  readonly code: FailureCode;
  // The input at fault, as a dotted path such as "session.name".
  readonly field: string | undefined;
  // The messages a stale write missed.
  readonly missed: Message[] | undefined;
  // For rate_limited, how many seconds to wait.
  readonly retryAfter: number | undefined;

  constructor(
    code: FailureCode,
    message: string,
    details: { field?: string; missed?: Message[]; retryAfter?: number } = {},
  ) {
    super(message);
    this.code = code;
    this.field = details.field;
    this.missed = details.missed;
    this.retryAfter = details.retryAfter;
  }
}

export interface RequestOptions {
  body?: unknown;
  // The session's CSRF token, which every change needs.
  csrf?: string | undefined;
}

// The answer is read as an error body only when it has the API's error shape:
// a proxy in front of the server can answer with anything.
async function failureOf(response: Response): Promise<ApiFailure> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  const body = errorBody.safeParse(parsed);
  if (!body.success) {
    return new ApiFailure("unexpected", `The server answered with status ${response.status}.`);
  }
  const { code, message, field, missed } = body.data.error;
  const retryAfter = Number(response.headers.get("retry-after") ?? "");
  return new ApiFailure(code, message, {
    ...(field === undefined ? {} : { field }),
    ...(missed === undefined ? {} : { missed }),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
  });
}

// No request waits longer than this for its answer, so one that hangs fails
// like one that got no answer, and refreshes and retries carry on.
export const requestTimeout = 30_000;

// request sends one request to the web API and returns its JSON answer, or
// throws an ApiFailure. The answer's type is the API contract's; the server
// that serves this page is the one that answers it.
export async function request<T>(
  method: "GET" | "POST",
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.csrf !== undefined) {
    headers["x-csrf-token"] = options.csrf;
  }
  // The bound covers reading the answer too: aborting stops its body.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), requestTimeout);
  const noAnswer = () =>
    timeout.signal.aborted
      ? new ApiFailure("network", "Agention did not answer in time. Check the connection.")
      : new ApiFailure("network", "Agention could not be reached. Check the connection.");
  try {
    let response: Response;
    try {
      response = await fetch(`/api/web${path}`, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        signal: timeout.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw noAnswer();
    }
    if (!response.ok) {
      throw await failureOf(response);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw timeout.signal.aborted
        ? noAnswer()
        : new ApiFailure("unexpected", "The server's answer could not be read.");
    }
  } finally {
    clearTimeout(timer);
  }
}

export type QueryValues = Record<string, string | number | boolean | readonly string[] | undefined>;

// query builds a query string from the values that are set, a list as one
// parameter for each of its values.
export function query(values: QueryValues): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      value.forEach((each: string) => params.append(key, each));
    } else if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

// threadPath is the API path of a thread, or of one of its routes.
export function threadPath(agent: string, session: string, thread: number, rest = ""): string {
  return `/s/${agent}/${session}/threads/${thread}${rest}`;
}

// Every agent with its sessions, each by name, each agent saying whether it
// left any of its sessions out.
export type Agents = AgentsPage["agents"];

// The agents as listAgents reads them, and whether it left any out.
export interface AgentList {
  agents: Agents;
  truncated: boolean;
}

// How many agents a page of agents holds.
const agentPage = 100;

// listAgents reads the agents with their sessions, at most maxListed of them
// a page at a time, saying whether it stopped with agents left to read.
export async function listAgents(): Promise<AgentList> {
  const agents: Agents = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxListed / agentPage; page++) {
    const answer = await request<AgentsPage>(
      "GET",
      `/agents${query({ cursor, limit: agentPage })}`,
    );
    agents.push(...answer.agents);
    cursor = answer.next;
    if (cursor === undefined) {
      break;
    }
  }
  return { agents, truncated: cursor !== undefined };
}

// PasskeyFailure is a passkey ceremony the browser refused or could not
// finish, with a message to show as it is.
export class PasskeyFailure extends Error {
  override name = "PasskeyFailure";
}

// describeFailure says what went wrong as a sentence for the page. The API's
// messages are lowercase phrases.
export function describeFailure(failure: unknown): string {
  if (failure instanceof PasskeyFailure) {
    return failure.message;
  }
  if (!(failure instanceof ApiFailure)) {
    return "Something went wrong.";
  }
  const text = failure.message.charAt(0).toUpperCase() + failure.message.slice(1);
  const sentence = /[.!?]$/.test(text) ? text : `${text}.`;
  return failure.retryAfter === undefined
    ? sentence
    : `${sentence} Try again in ${failure.retryAfter} seconds.`;
}
