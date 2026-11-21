// Test support for the component tests: a fake web API behind fetch, and
// fixtures shaped as the server answers.
import {
  type ErrorBody,
  type ErrorCode,
  type GroupsAndTags,
  type Message,
  type Registration,
  type SessionState,
  type SessionSummary,
  statusByErrorCode,
  type ThreadCounts,
  type ThreadGetResult,
  type ThreadList,
  type ThreadSummary,
} from "@wayfarerlabs/agention-api";
import { render } from "@testing-library/react";
import { vi } from "vitest";
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

export const emptyList: ThreadList = { threads: [], total: 0 };

// The counts of a list that holds nothing.
export const noCounts: ThreadCounts = {
  status: { any: 0, open: 0, answered: 0, withdrawn: 0, none: 0 },
  priority: { any: 0, normal: 0, high: 0, urgent: 0 },
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
  reset: 0,
};

export const noGroupsOrTags: GroupsAndTags = { groups: [], tags: [], truncated: false };

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

  // Signed in, with an empty thread list, no sessions, none with unread
  // updates, and no groups or tags, unless a test registers other answers.
  constructor() {
    this.on("GET", "/session", { body: signedIn });
    this.on("GET", "/threads", { body: emptyList });
    this.on("GET", "/threads/counts", { body: noCounts });
    this.on("GET", "/sessions", { body: { agents: [] } });
    this.on("GET", "/sessions/unread-updates", { body: { sessions: 0 } });
    this.on("GET", "/groups-and-tags", { body: noGroupsOrTags });
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
      const aborted = new Promise<never>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
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

// renderAt renders the application at a path, with state in its history
// entry, as a link that recorded state would leave it.
export function renderAt(path: string, state: unknown = null) {
  window.history.replaceState(state, "", path);
  return render(<App />);
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

// threadAnswer is a GET of a thread: the thread, its messages, both cursors
// and the operator's marks.
export function threadAnswer(
  thread: ThreadSummary,
  messages: Message[],
  cursors = { requester: thread.last_seq, audience: thread.last_seq - thread.unread },
  marks = { read_through: thread.last_seq - thread.unread, archived_through: 0 },
): ThreadGetResult {
  return { thread, messages, cursors, marks };
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
