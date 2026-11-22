// An HTTP application over a fresh store, with an operator signed in on one
// browser and helpers to sign agent requests, for the HTTP tests.
import {
  type ErrorBody,
  type PublicKey,
  publicKey,
  type RegistrationState,
} from "@wayfarerlabs/agention-api";
import type { Hono } from "hono";
import { SignJWT } from "jose";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { openBrowserSession } from "../auth/browser-sessions.ts";
import { findOperator, type VoiceEnvironment } from "../store/index.ts";
import type { TranscriptionProvider } from "../transcription/provider.ts";
import { Fixture } from "../store/test-fixture.ts";
import { createApp } from "./app.ts";
import type { Rates } from "./rates.ts";
import { cookieNames } from "./web-api.ts";

export const origin = "https://agention.test";
export const host = "agention.test";

// The cookies a server at the test origin sets.
export const { session: sessionCookie, challenge: challengeCookie } = cookieNames(origin);

export interface AgentKey {
  publicKey: PublicKey;
  privateKey: KeyObject;
}

export function newAgentKey(): AgentKey {
  const keys = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.parse(keys.publicKey.export({ format: "jwk" }).x),
    privateKey: keys.privateKey,
  };
}

export interface Claims {
  aud?: unknown;
  exp?: unknown;
}

export interface TokenOptions {
  claims?: Claims;
  kid?: string;
  signWith?: KeyObject;
}

export interface WebRequestOptions {
  cookie?: string | null;
  csrf?: string | null;
  origin?: string | null;
  headers?: Record<string, string>;
}

export interface Response {
  status: number;
  headers: Headers;
  body: unknown;
}

export class Harness {
  readonly fixture = new Fixture();
  readonly app: Hono;
  readonly shutdown = new AbortController();
  readonly logged: string[] = [];
  // The operator's browser: its session cookie and CSRF token.
  cookie: string;
  csrf: string;

  constructor(
    options: {
      rates?: Rates;
      webRoot?: string;
      name?: string;
      voiceEnvironment?: VoiceEnvironment;
      transcription?: TranscriptionProvider;
      freeBytes?: (directory: string) => Promise<number>;
    } = {},
  ) {
    this.app = createApp({
      ...(options.voiceEnvironment === undefined
        ? {}
        : { voiceEnvironment: options.voiceEnvironment }),
      ...(options.transcription === undefined ? {} : { transcription: options.transcription }),
      ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
      store: this.fixture.store,
      origin,
      name: options.name ?? "Agention",
      webRoot: options.webRoot,
      ...(options.rates === undefined ? {} : { rates: options.rates }),
      shutdown: this.shutdown.signal,
      log: (message) => this.logged.push(message),
    });
    const session = this.#openBrowserSession();
    this.cookie = session.token;
    this.csrf = session.csrfToken;
  }

  // signIn opens a new browser session for the operator as the clock now
  // stands, such as once the clock has moved past the last one's expiry.
  signIn(): void {
    const session = this.#openBrowserSession();
    this.cookie = session.token;
    this.csrf = session.csrfToken;
  }

  #openBrowserSession() {
    const operator = findOperator(this.fixture.db);
    if (operator === undefined) {
      throw new Error("the fixture has no operator");
    }
    return this.fixture.db.transaction(() =>
      openBrowserSession(
        this.fixture.db,
        operator.personId,
        this.fixture.passkeyId,
        this.fixture.now,
      ),
    );
  }

  close(): void {
    this.shutdown.abort();
    this.fixture.close();
  }

  // token mints a token as the bridge does, signed by the key it names and
  // expiring two minutes from now, unless the options say otherwise.
  async token(key: AgentKey, options: TokenOptions = {}): Promise<string> {
    const claims = {
      aud: origin,
      exp: Math.floor(this.fixture.now / 1000) + 120,
      ...options.claims,
    };
    return new SignJWT(claims as Record<string, unknown>)
      .setProtectedHeader({ alg: "EdDSA", kid: options.kid ?? key.publicKey })
      .sign(options.signWith ?? key.privateKey);
  }

  async request(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { host, ...init.headers };
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (init.body !== undefined) {
      body =
        typeof init.body === "string" || init.body instanceof Uint8Array
          ? (init.body as string | Uint8Array<ArrayBuffer>)
          : JSON.stringify(init.body);
      headers["content-type"] ??= "application/json";
    }
    const response = await this.app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: the web UI's pages.
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }

  // agent makes a request on the agent mount with a freshly minted token.
  async agent(
    key: AgentKey,
    method: string,
    path: string,
    body?: unknown,
    options: TokenOptions & { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const authorization = `Bearer ${await this.token(key, options)}`;
    return this.request(method, `/api/agent${path}`, {
      body,
      headers: { authorization, ...options.headers },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  // web makes a request on the web mount as the signed-in operator's browser:
  // with the session cookie, and for a change the CSRF token and origin.
  async web(
    method: string,
    path: string,
    body?: unknown,
    options: WebRequestOptions = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    const cookie = options.cookie === undefined ? this.cookie : options.cookie;
    if (cookie !== null) {
      headers.cookie = `${sessionCookie}=${cookie}`;
    }
    if (method !== "GET") {
      const csrf = options.csrf === undefined ? this.csrf : options.csrf;
      const requestOrigin = options.origin === undefined ? origin : options.origin;
      if (csrf !== null) {
        headers["x-csrf-token"] = csrf;
      }
      if (requestOrigin !== null) {
        headers.origin = requestOrigin;
      }
    }
    return this.request(method, `/api/web${path}`, {
      body,
      headers: { ...headers, ...options.headers },
    });
  }

  // register submits a key's registration through the agent mount.
  async register(key: AgentKey, agent: string, session: string): Promise<RegistrationState> {
    const response = await this.agent(key, "POST", "/registrations", { agent, session });
    if (response.status !== 200) {
      throw new Error(`registration failed: ${JSON.stringify(response.body)}`);
    }
    return response.body as RegistrationState;
  }

  // registrationId finds the registration of a key, given as an agent key or
  // its public half.
  registrationId(key: AgentKey | PublicKey): number {
    const row = this.fixture.db
      .prepare("SELECT id FROM registrations WHERE public_key = ?")
      .get(typeof key === "string" ? key : key.publicKey) as { id: number };
    return row.id;
  }

  // approvedAgent registers a new key and approves it through the web mount
  // for agent/session, creating either if it does not exist yet.
  async approvedAgent(agent: string, session: string): Promise<AgentKey> {
    const key = newAgentKey();
    await this.register(key, agent, session);
    await this.approveKey(key.publicKey, { agent, session });
    return key;
  }

  // approveKey approves the registration of a key through the web mount for
  // the names given, creating the agent and the session if they do not exist
  // yet.
  async approveKey(key: PublicKey, names: { agent: string; session: string }): Promise<void> {
    const exists = (sql: string, ...params: string[]) =>
      this.fixture.db.prepare(sql).get(...params) !== undefined;
    const response = await this.web("POST", `/registrations/${this.registrationId(key)}/approve`, {
      agent: {
        name: names.agent,
        existing: exists("SELECT 1 FROM agents WHERE name = ?", names.agent),
      },
      session: {
        name: names.session,
        existing: exists(
          `SELECT 1 FROM sessions s JOIN agents a ON a.id = s.agent_id
           WHERE a.name = ? AND s.name = ?`,
          names.agent,
          names.session,
        ),
      },
    });
    if (response.status !== 200) {
      throw new Error(`approval failed: ${JSON.stringify(response.body)}`);
    }
  }
}

// codeOf returns a response's error code, or "ok" for a success.
export function codeOf(response: Response): string {
  return response.status < 400 ? "ok" : (response.body as ErrorBody).error.code;
}

// A thread creation the schema accepts.
export function newThread(requestId: string, fields: Record<string, unknown> = {}) {
  return { request_id: requestId, title: "A question", ...fields };
}
