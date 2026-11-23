import {
  type ErrorCode,
  errorBody,
  type Message,
  maxListed,
  type SessionsPage,
  type UploadResult,
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
  // Aborting it ends the request as a network failure.
  signal?: AbortSignal | undefined;
}

// The answer is read as an error body only when it has the API's error shape:
// a proxy in front of the server can answer with anything.
function failureFrom(status: number, text: string, retryAfterHeader: string | null): ApiFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const body = errorBody.safeParse(parsed);
  if (!body.success) {
    return new ApiFailure("unexpected", `The server answered with status ${status}.`);
  }
  const { code, message, field, missed } = body.data.error;
  const retryAfter = Number(retryAfterHeader ?? "");
  return new ApiFailure(code, message, {
    ...(field === undefined ? {} : { field }),
    ...(missed === undefined ? {} : { missed }),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
  });
}

async function failureOf(response: Response): Promise<ApiFailure> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    // An unreadable body reads as an answer other than the API's.
  }
  return failureFrom(response.status, text, response.headers.get("retry-after"));
}

// No request waits longer than this for its answer, so one that hangs fails
// like one that got no answer, and refreshes and retries carry on.
export const requestTimeout = 30_000;

// The event request dispatches on the window once a change lands, so what
// counts the operator's data, such as the navigation's counts, reloads at
// once. Signing in and out change the browser's session, not the data, and
// the page reloads its views after either, so they dispatch none.
export const changeLanded = "agention:change-landed";

// request sends one request to the web API and returns its JSON answer, or
// throws an ApiFailure. The answer's type is the API contract's; the server
// that serves this page is the one that answers it.
export async function request<T>(
  method: "GET" | "POST",
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const answer = await exchange<T>(
    path,
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    options.csrf,
    requestTimeout,
  );
  if (method !== "GET" && !path.startsWith("/auth/")) {
    window.dispatchEvent(new Event(changeLanded));
  }
  return answer;
}

// upload sends bytes, such as a recording, as the body of a change, declared
// as type, and returns the JSON answer as request does. It waits up to
// timeout, and aborting signal, as a Cancel does, ends it as a network
// failure.
export function upload<T>(
  path: string,
  body: Blob,
  options: { type: string; csrf: string | undefined; timeout: number; signal: AbortSignal },
): Promise<T> {
  return exchange<T>(
    path,
    { method: "POST", headers: { "content-type": options.type }, body, signal: options.signal },
    options.csrf,
    options.timeout,
  );
}

async function exchange<T>(
  path: string,
  init: { method: string; headers: Record<string, string>; body?: BodyInit; signal?: AbortSignal },
  csrf: string | undefined,
  limit: number,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...init.headers };
  if (csrf !== undefined) {
    headers["x-csrf-token"] = csrf;
  }
  // The bound covers reading the answer too: aborting stops its body.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), limit);
  const signal =
    init.signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, init.signal]);
  const noAnswer = () =>
    timeout.signal.aborted
      ? new ApiFailure("network", "Agention did not answer in time. Check the connection.")
      : init.signal?.aborted === true
        ? new ApiFailure("network", "Cancelled.")
        : new ApiFailure("network", "Agention could not be reached. Check the connection.");
  try {
    let response: Response;
    try {
      response = await fetch(`/api/web${path}`, {
        method: init.method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        signal,
        ...(init.body === undefined ? {} : { body: init.body }),
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
      throw signal.aborted
        ? noAnswer()
        : new ApiFailure("unexpected", "The server's answer could not be read.");
    }
  } finally {
    clearTimeout(timer);
  }
}

// An upload of a file gives up once this long passes with no progress:
// longer than the server's own idle cut, so the server's answer arrives
// first. Nothing bounds an upload's whole length, so a slow uplink finishes.
const uploadIdle = 60_000;

// uploadFile sends a file to a session's uploads, declared as type, and
// returns the upload's answer, or throws an ApiFailure as request does. fetch
// reports no upload progress, so it goes by XMLHttpRequest, with the File as
// the body, so the browser sends its length; onProgress hears how many bytes
// have gone. Aborting signal, as Remove does, ends it as a network failure
// the caller drops.
export function uploadFile(
  path: string,
  file: Blob,
  options: {
    type: string;
    csrf: string | undefined;
    signal: AbortSignal;
    onProgress: (sent: number) => void;
  },
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const settle = () => {
      clearTimeout(idle);
      options.signal.removeEventListener("abort", abort);
    };
    const rearm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, uploadIdle);
    };
    const abort = () => xhr.abort();
    const noAnswer = () =>
      stalled
        ? new ApiFailure("network", "The upload stopped making progress. Check the connection.")
        : new ApiFailure("network", "Agention could not be reached. Check the connection.");
    xhr.open("POST", `/api/web${path}`);
    xhr.setRequestHeader("accept", "application/json");
    xhr.setRequestHeader("content-type", options.type);
    if (options.csrf !== undefined) {
      xhr.setRequestHeader("x-csrf-token", options.csrf);
    }
    xhr.upload.onprogress = (event) => {
      rearm();
      options.onProgress(event.loaded);
    };
    xhr.onload = () => {
      settle();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(failureFrom(xhr.status, xhr.responseText, xhr.getResponseHeader("retry-after")));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as UploadResult);
      } catch {
        reject(new ApiFailure("unexpected", "The server's answer could not be read."));
      }
    };
    xhr.onerror = xhr.onabort = () => {
      settle();
      reject(noAnswer());
    };
    options.signal.addEventListener("abort", abort);
    rearm();
    xhr.send(file);
  });
}

// fileUrl is the URL of a file a message carries, by the message's sequence,
// the name it carries the file under and the file's reference, which makes
// the URL name the same bytes for good, so the browser's cache can keep them.
export function fileUrl(
  target: { agent: string; session: string; number: number },
  seq: number,
  name: string,
  file: string,
): string {
  const rest = `/messages/${seq}/files/${encodeURIComponent(name)}${query({ file })}`;
  return `/api/web${threadPath(target.agent, target.session, target.number, rest)}`;
}

// readTextStart reads up to the first bytes of a file at url, by a range
// request, as UTF-8 with replacement. A cut through a character at the end
// leaves that character out. It reads no more than bytes, even from a server
// that ignores the range, and gives up after requestTimeout, as request does.
// It throws an ApiFailure as request does. It leaves the browser's cache on,
// since the bytes at a file's URL never change.
export async function readTextStart(url: string, bytes: number): Promise<string> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), requestTimeout);
  const noAnswer = () =>
    timeout.signal.aborted
      ? new ApiFailure("network", "Agention did not answer in time. Check the connection.")
      : new ApiFailure("network", "Agention could not be reached. Check the connection.");
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { range: `bytes=0-${bytes - 1}` },
        credentials: "same-origin",
        signal: timeout.signal,
      });
    } catch {
      throw noAnswer();
    }
    if (!response.ok) {
      throw await failureOf(response);
    }
    const start = new Uint8Array(bytes);
    let length = 0;
    const reader = response.body?.getReader();
    try {
      while (reader !== undefined && length < bytes) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const taken = value.subarray(0, bytes - length);
        start.set(taken, length);
        length += taken.length;
      }
    } catch {
      throw noAnswer();
    }
    if (length === bytes) {
      void reader?.cancel().catch(() => undefined);
    }
    return new TextDecoder("utf-8").decode(start.subarray(0, length), {
      stream: length === bytes,
    });
  } finally {
    clearTimeout(timer);
  }
}

export type QueryValues = Record<
  string,
  string | number | boolean | readonly (string | number)[] | undefined
>;

// query builds a query string from the values that are set, a list as one
// parameter for each of its values.
export function query(values: QueryValues): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      value.forEach((each: string | number) => params.append(key, String(each)));
    } else if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

// sessionPath is the API path of one of a session's routes.
export function sessionPath(agent: string, session: string, rest: string): string {
  return `/s/${agent}/${session}${rest}`;
}

// threadPath is the API path of a thread, or of one of its routes.
export function threadPath(agent: string, session: string, thread: number, rest = ""): string {
  return sessionPath(agent, session, `/threads/${thread}${rest}`);
}

// Every agent with its sessions, each agent saying whether it left any of its
// sessions out.
export type Agents = SessionsPage["agents"];

// The agents as listSessions reads them, and whether it left any out.
export interface AgentList {
  agents: Agents;
  truncated: boolean;
}

// How many agents a page of the sessions view holds.
const agentPage = 100;

// listSessions reads the agents with their sessions, as the sessions view
// shows them, at most maxListed agents a page at a time, saying whether it
// stopped with agents left to read. The view comes whole, as the approval
// form's choices need it. Aborting signal stops it before its next page.
export async function listSessions(signal?: AbortSignal): Promise<AgentList> {
  const agents: Agents = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxListed / agentPage; page++) {
    const answer = await request<SessionsPage>(
      "GET",
      `/sessions${query({ cursor, limit: agentPage })}`,
      { signal },
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
