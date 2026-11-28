// Test support for the component tests: a fake web API behind fetch, and
// fixtures shaped as the server answers.
import {
  type AttentionCounts,
  type ErrorBody,
  type ErrorCode,
  type GroupsAndTags,
  type Message,
  type NotificationsState,
  type Registration,
  type SessionState,
  type SessionSummary,
  type SettingsResult,
  statusByErrorCode,
  type ThreadCounts,
  type ThreadGetResult,
  type ThreadList,
  type ThreadSummary,
} from "@wayfarerlabs/agention-api";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { App } from "./App.tsx";

export interface Call {
  method: string;
  // The path below /api/web, with its query.
  path: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
}

// An answer: body as JSON, or text as it is, such as a proxy's error page.
export interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

export const csrf = "csrf-token-1";

// A thread's heading without the number that leads it, as in
// "#4 Pick a database".
const untitled = (text: string) => text.replace(/^#\d+ /, "");

// titled matches a thread's heading by its title, after its number.
export const titled = (title: string) => (name: string) =>
  /^#\d+ /.test(name) && untitled(name) === title;

// titleOf reads a thread's title from its heading, without its number.
export const titleOf = (heading: Element) => untitled(heading.textContent ?? "");

export const emptyList: ThreadList = { threads: [], total: 0, as_of: "as-of-0" };

// The counts of a list that holds nothing.
export const noCounts: ThreadCounts = {
  status: { any: 0, open: 0, answered: 0, withdrawn: 0, none: 0 },
  settled: { any: 0, only: 0, hide: 0 },
  priority: { any: 0, urgent: 0, high: 0, normal: 0, low: 0 },
  impact: { any: 0, blocking: 0, assuming: 0 },
  overdue: { any: 0, overdue: 0 },
  effort: { any: 0, quick: 0, under_15m: 0, under_1h: 0 },
  unread: { any: 0, unread: 0 },
  agent_read: { any: 0, unread: 0, stranded: 0 },
  include_archived: { hide: 0, show: 0 },
  agent: { agents: [], truncated: false },
  session: { sessions: [], truncated: false },
  topic: { topics: [], truncated: false },
  session_group: { groups: [], none: 0 },
  tag: { tags: [], truncated: false },
  pull_request: { pull_requests: [], truncated: false },
  branch: { branches: [], truncated: false },
  reset: 0,
};

// Nothing waiting on the operator.
export const noAttention: AttentionCounts = { unread_threads: 0, pending_registrations: 0 };

export const noGroupsOrTags: GroupsAndTags = { groups: [], tags: [], truncated: false };

// No device receives notifications and no view notifies, with a recent
// sign-in. The public key is the base64url of three bytes, 4, 0 and 0.
// cspell:ignore BAAA
export const noNotifications: NotificationsState = {
  public_key: "BAAA",
  recent: true,
  devices: [],
  notifying: [],
};

// The settings of a server without voice or files.
export const noSettings: SettingsResult = { voice: null, storage: { count: 0, bytes: 0 } };

export const signedIn: SessionState = {
  signed_in: true,
  operator: { name: "operator" },
  csrf_token: csrf,
};

export function failure(
  code: ErrorCode,
  message: string,
  details: Partial<ErrorBody["error"]> = {},
): Reply {
  return { status: statusByErrorCode[code], body: { error: { code, message, ...details } } };
}

// FakeApi answers the web API's requests from handlers registered by method
// and path (without the query), records every call, and answers anything
// unregistered as an internal error, recorded in unhandled. As fetch does, it
// stops waiting for a handler when the request is aborted.
export class FakeApi {
  readonly calls: Call[] = [];
  readonly unhandled: string[] = [];
  readonly #routes = new Map<string, Handler>();

  // Signed in, with an empty thread list, no sessions, nothing waiting on
  // the operator, no groups, tags or saved views, and no device or view that
  // notifies, unless a test registers other answers.
  constructor() {
    this.on("GET", "/session", { body: signedIn });
    this.on("GET", "/threads", { body: emptyList });
    this.on("GET", "/threads/counts", { body: noCounts });
    this.on("GET", "/sessions", { body: { agents: [] } });
    this.on("GET", "/attention", { body: noAttention });
    this.on("GET", "/groups-and-tags", { body: noGroupsOrTags });
    this.on("GET", "/saved-views", { body: { views: [] } });
    this.on("GET", "/settings", { body: noSettings });
    this.on("GET", "/notifications", { body: noNotifications });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      this.#fetch(input, init),
    );
  }

  on(method: "GET" | "POST", pathname: string, handler: Handler): this {
    this.#routes.set(`${method} ${pathname}`, handler);
    return this;
  }

  // callsTo returns the calls made to a path, without its query.
  callsTo(method: string, pathname: string): Call[] {
    return this.calls.filter(
      (call) => call.method === method && call.url.pathname === `/api/web${pathname}`,
    );
  }

  async #fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input), "https://agention.test");
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const path = url.pathname.replace(/^\/api\/web/, "") + url.search;
    const call: Call = { method, path, url, body, headers };
    this.calls.push(call);
    const handler = this.#routes.get(`${method} ${url.pathname.replace(/^\/api\/web/, "")}`);
    let reply: Reply;
    if (handler === undefined) {
      this.unhandled.push(`${method} ${path}`);
      reply = failure("internal", "internal error");
    } else {
      // A request aborted before its answer fails as fetch's does; one
      // aborted after it is answered already.
      const aborted = new Promise<never>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
      aborted.catch(() => undefined);
      reply =
        typeof handler === "function" ? await Promise.race([handler(call), aborted]) : handler;
    }
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: {
        "content-type": reply.text === undefined ? "application/json" : "text/html",
        ...reply.headers,
      },
    });
  }
}

// FakeUpload is one request XMLHttpRequest sent, as the page uploads files:
// what it was sent, and controls a test answers it with.
export class FakeUpload {
  method = "";
  url = "";
  readonly headers: Record<string, string> = {};
  body: unknown;
  aborted = false;
  status = 0;
  responseText = "";
  readonly upload: { onprogress: ((event: { loaded: number }) => void) | null } = {
    onprogress: null,
  };
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  #responseHeaders: Record<string, string> = {};
  readonly #sent: FakeUpload[];

  constructor(sent: FakeUpload[]) {
    this.#sent = sent;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  getResponseHeader(name: string): string | null {
    return this.#responseHeaders[name.toLowerCase()] ?? null;
  }

  send(body: unknown): void {
    this.body = body;
    this.#sent.push(this);
  }

  abort(): void {
    if (!this.aborted && this.status === 0) {
      this.aborted = true;
      this.onabort?.();
    }
  }

  // The query of the request's URL.
  get query(): URLSearchParams {
    return new URL(this.url, "https://agention.test").searchParams;
  }

  progress(loaded: number): void {
    this.upload.onprogress?.({ loaded });
  }

  // respond answers with reply, as the server would.
  respond(reply: Reply): void {
    this.status = reply.status ?? 200;
    this.responseText = reply.text ?? JSON.stringify(reply.body ?? {});
    this.#responseHeaders = Object.fromEntries(
      Object.entries(reply.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    this.onload?.();
  }

  // fail ends the request with no answer, as a dropped connection does.
  fail(): void {
    this.onerror?.();
  }
}

// installUploads stands in for XMLHttpRequest, recording each request sent.
export function installUploads(): FakeUpload[] {
  const sent: FakeUpload[] = [];
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      constructor() {
        return new FakeUpload(sent);
      }
    },
  );
  return sent;
}

// uploadAnswer is the server's answer to an upload, by its reference.
export function uploadAnswer(
  upload: string,
  name: string,
  size: number,
  type = "image/png",
  expiresAt = "2099-01-01T00:00:00.000Z",
): Reply {
  return {
    body: { upload, name, size, type, served_type: type, expires_at: expiresAt },
  };
}

// jsdom has no modal dialogs. This stand-in opens one and closes it as
// browsers do, firing close, so a view's dialog can be driven in a test.
if (HTMLDialogElement.prototype.showModal === undefined) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (this.hasAttribute("open")) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    }
  };
}

// stubWidth stands in for the window's width, which jsdom has none of: at a
// desktop's, where a tab's list and what is open stand side by side
// (views/side-by-side.tsx), unless wide says narrower. It gives a way to
// take the page across that width, as a window resized does, or, before
// the page renders, to start it on the other side.
export function stubWidth(wide = true): (toWide: boolean) => void {
  // What follows the page's media queries.
  const followers = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return query === "(min-width: 64rem)" && wide;
    },
    addEventListener: (_: string, follow: () => void) => followers.add(follow),
    removeEventListener: (_: string, follow: () => void) => followers.delete(follow),
  }));
  return (toWide) =>
    act(() => {
      wide = toWide;
      followers.forEach((follow) => follow());
    });
}

// renderAt renders the application at a path, with state in its history
// entry, as a link that recorded state would leave it; strict renders it in
// StrictMode, as main.tsx does, which unmounts and mounts each component once
// more as it first mounts.
export function renderAt(path: string, state: unknown = null, { strict = false } = {}) {
  window.history.replaceState(state, "", path);
  return render(<App />, { reactStrictMode: strict });
}

// clickFold clicks a fold's header, then waits for the header to show the
// fold flipped. A view subscribes to the store holding its folds (device.ts)
// in a passive effect, after its render commits; a click landing between the
// two, as one can just after a find resolves, takes effect only once the view
// subscribes, not as the click returns.
export async function clickFold(header: HTMLElement) {
  const expanded = header.getAttribute("aria-expanded");
  fireEvent.click(header);
  await waitFor(() => expect(header.getAttribute("aria-expanded")).not.toBe(expanded));
}

const time = "2026-10-27T12:00:00.000Z";

export function threadSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  const lastSeq = overrides.last_seq ?? 1;
  const unread = overrides.unread ?? 1;
  return {
    agent: "builder",
    session: "main",
    number: 1,
    title: "Choose a database",
    created_at: time,
    updated_at: time,
    last_seq: lastSeq,
    read_through: lastSeq - unread,
    unread,
    message_count: lastSeq,
    archived: false,
    open_asks: { asks: [], count: 0, blocking: false, overdue: false },
    status: "none",
    links: { pull_requests: 0, branches: 0 },
    credential_active: true,
    presence: { last_seen_at: time, quiet: false },
    stranded: false,
    ...overrides,
  };
}

export function message(seq: number, overrides: Partial<Message> = {}): Message {
  return {
    seq,
    author: { kind: "session", agent: "builder", session: "main" },
    created_at: time,
    live: true,
    ...overrides,
  };
}

// The operator's message, as the server shows it.
export function operatorMessage(seq: number, overrides: Partial<Message> = {}): Message {
  return message(seq, { author: { kind: "person", name: "operator" }, ...overrides });
}

export type Ask = NonNullable<Message["asks"]>[number];

// Ask 1, with two suggested answers, open until the overrides say otherwise.
export function ask(overrides: Partial<Ask> = {}): Ask {
  return {
    number: 1,
    question: "Which database?",
    suggestions: [
      { label: "SQLite", description: "One file." },
      { label: "Postgres", description: "" },
    ],
    multiple: false,
    impact: "blocking",
    priority: "normal",
    open: true,
    ...overrides,
  };
}

// An answer as a message carries it, to ask 1 on message 1 unless the
// overrides say otherwise.
export function answerTo(
  overrides: Partial<NonNullable<Message["answers"]>[number]> = {},
): NonNullable<Message["answers"]>[number] {
  return {
    ask: 1,
    question: "Which database?",
    ask_seq: 1,
    ask_live: true,
    declined: false,
    ...overrides,
  };
}

// threadAnswer is a GET of a thread: the thread, its messages, both cursors,
// the operator's marks, and no files, pull requests or branches.
export function threadAnswer(
  thread: ThreadSummary,
  messages: Message[],
  cursors = { requester: thread.last_seq, audience: thread.last_seq - thread.unread },
  marks = { read_through: thread.last_seq - thread.unread, archived_through: 0 },
): ThreadGetResult {
  return {
    thread,
    messages,
    cursors,
    marks,
    files: { count: 0, bytes: 0 },
    pull_requests: { links: [], truncated: false },
    branches: { links: [], truncated: false },
  };
}

export function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    id: 1,
    code: "7KQ2M-X9DPA",
    status: "pending",
    proposed_agent: "builder",
    proposed_session: "main",
    created_at: time,
    expires_at: "2026-10-27T13:00:00.000Z",
    ...overrides,
  };
}

// A session as the sessions view lists it: seen now, with one credential,
// no status and nothing to show, unless the overrides say otherwise.
export function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session: "main",
    created_at: time,
    tags: [],
    presence: { last_seen_at: time, quiet: false },
    registrations: [{ id: 1, code: "7KQ2M-X9DPA" }],
    unread_updates: 0,
    threads: { total: 0, unread: 0, stranded: 0 },
    open_asks: { count: 0, blocking_count: 0 },
    ...overrides,
  };
}

// Passkeys as a browser with WebAuthn's JSON helpers offers them. The
// credentials' JSON is what the page must send on, as the browser made it.
export function installPasskeys(json: Record<string, unknown>) {
  class FakePublicKeyCredential {
    static parseCreationOptionsFromJSON = vi.fn((options: unknown) => ({ parsed: options }));
    static parseRequestOptionsFromJSON = vi.fn((options: unknown) => ({ parsed: options }));
  }
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  const credential = { toJSON: () => json };
  const credentials = {
    create: vi.fn(async () => credential),
    get: vi.fn(async () => credential),
  };
  Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });
  return { FakePublicKeyCredential, credentials };
}

// A recorder as a browser with MediaRecorder offers it, recording the types
// given. Each recording delivers its data on stop, as a browser's last
// dataavailable does: finalBytes of it, by default past the server's
// smallest size. refuse makes the microphone refuse to start, and failStart
// the recorder.
export function installRecorder(
  options: {
    types?: string[];
    refuse?: DOMException;
    finalBytes?: number;
    failStart?: boolean;
    // Holds the microphone from opening until it settles, as a browser's
    // prompt does.
    opened?: Promise<void>;
  } = {},
): {
  recorders: FakeMediaRecorder[];
  tracks: { stopped: boolean }[];
} {
  const types = options.types ?? ["audio/webm;codecs=opus"];
  const recorders: FakeMediaRecorder[] = [];
  const tracks: { stopped: boolean }[] = [];
  class Recorder extends FakeMediaRecorder {
    static isTypeSupported(type: string): boolean {
      return types.includes(type);
    }

    constructor(_stream: unknown, recorderOptions: MediaRecorderOptions) {
      super(recorderOptions, options.finalBytes ?? 4000);
      recorders.push(this);
    }

    override start(timeslice?: number): void {
      if (options.failStart === true) {
        throw new DOMException("the track ended", "InvalidStateError");
      }
      super.start(timeslice);
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  const getUserMedia = async () => {
    await options.opened;
    if (options.refuse !== undefined) {
      throw options.refuse;
    }
    const track = {
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    tracks.push(track);
    return { getTracks: () => [track] };
  };
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  return { recorders, tracks };
}

export class FakeMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  timeslice: number | undefined;
  readonly options: MediaRecorderOptions;
  readonly finalBytes: number;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(options: MediaRecorderOptions, finalBytes: number) {
    this.options = options;
    this.finalBytes = finalBytes;
  }

  start(timeslice?: number): void {
    this.state = "recording";
    this.timeslice = timeslice;
  }

  // emit delivers size bytes of recorded data, as each timeslice does.
  emit(size: number): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) });
  }

  stop(): void {
    if (this.state === "inactive") {
      return;
    }
    this.state = "inactive";
    queueMicrotask(() => {
      this.emit(this.finalBytes);
      this.onstop?.();
    });
  }
}

// Speech synthesis as a browser offers it, recording what each utterance
// says; finish ends the one speaking, as the browser does when it is done.
export function installSpeech(): {
  spoken: string[];
  cancels: () => number;
  finish(): void;
  fail(error: string): void;
} {
  const spoken: string[] = [];
  let queue: {
    text: string;
    onend: (() => void) | null;
    onerror: ((event: { error: string }) => void) | null;
  }[] = [];
  let cancels = 0;
  class Utterance {
    text: string;
    lang = "";
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;

    constructor(text: string) {
      this.text = text;
    }
  }
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("speechSynthesis", {
    speak(utterance: Utterance) {
      spoken.push(utterance.text);
      queue.push(utterance);
    },
    cancel() {
      cancels++;
      queue = [];
    },
  });
  return {
    spoken,
    cancels: () => cancels,
    finish() {
      queue.shift()?.onend?.();
    },
    // fail ends the utterance speaking with the error given, as a device
    // without voices does.
    fail(error: string) {
      queue.shift()?.onerror?.({ error });
    },
  };
}
