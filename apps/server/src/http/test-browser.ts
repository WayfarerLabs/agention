// A server over a fresh database with no operator yet, and a browser that
// keeps its cookies, for the passkey ceremonies' tests.
import type { ErrorBody, SessionState } from "@wayfarerlabs/agention-api";
import type { Hono } from "hono";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { type Answer, TestAuthenticator } from "../auth/test-authenticator.ts";
import { openTestDatabase } from "../database/test-database.ts";
import { createStore, type Store, storeName } from "../store/index.ts";
import { start } from "../store/test-fixture.ts";
import { createApp } from "./app.ts";
import { defaultRates, type Rates } from "./rates.ts";

export class TestServer {
  readonly root = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-passkeys-")));
  readonly db = openTestDatabase(path.join(this.root, "agention.db"));
  readonly origin: string;
  readonly store: Store;
  readonly app: Hono;
  now = start;

  constructor(origin = "https://agention.test", rates: Rates = defaultRates, name = "Agention") {
    this.origin = origin;
    this.store = createStore(this.db, { clock: () => this.now });
    storeName(this.db, name);
    this.app = createApp({ store: this.store, origin, name, webRoot: undefined, rates });
  }

  close(): void {
    this.db.close();
    rmSync(this.root, { recursive: true, force: true });
  }

  count(table: string): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
}

export interface Reply {
  status: number;
  body: unknown;
  setCookies: string[];
}

export const codeOf = (reply: Reply) =>
  reply.status < 400 ? "ok" : (reply.body as ErrorBody).error.code;

export type Options = Record<string, unknown>;

// What a browser talks to: a server's app, at its origin, such as a
// TestServer or a Harness.
export interface BrowsedServer {
  readonly origin: string;
  readonly app: Hono;
}

// TestBrowser keeps cookies and the CSRF token the way a browser on the
// server's origin would.
export class TestBrowser {
  readonly cookies = new Map<string, string>();
  csrf: string | undefined;
  readonly #server: BrowsedServer;

  constructor(server: BrowsedServer) {
    this.#server = server;
  }

  async send(method: string, target: string, body?: unknown): Promise<Reply> {
    const { origin } = this.#server;
    const headers: Record<string, string> = { host: new URL(origin).host, origin };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.csrf !== undefined) {
      headers["x-csrf-token"] = this.csrf;
    }
    const response = await this.#server.app.request(`/api/web${target}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookies = response.headers.getSetCookie();
    for (const line of setCookies) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
      if (/Max-Age=0/.test(line)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    const reply = { status: response.status, body: await response.json(), setCookies };
    const state = reply.body as Partial<SessionState> & { csrf_token?: string };
    if (state.signed_in === true) {
      this.csrf = state.csrf_token;
    }
    return reply;
  }

  post(target: string, body?: unknown): Promise<Reply> {
    return this.send("POST", target, body);
  }

  async begin(target: string, body?: unknown): Promise<Options> {
    const begun = await this.post(target, body);
    expect(begun.status).toBe(200);
    return (begun.body as { options: Options }).options;
  }

  async link(
    token: string,
    authenticator: TestAuthenticator,
    answer: Answer = {},
    name = "Laptop",
  ) {
    const options = await this.begin("/auth/link/begin", { token, name });
    return this.post("/auth/link/finish", {
      credential: authenticator.create(options, this.#server.origin, answer),
    });
  }

  // addPasskey adds a passkey on this device, as the passkeys page does.
  async addPasskey(authenticator: TestAuthenticator, name: string) {
    const options = await this.begin("/passkeys/register/begin", { name });
    return this.post("/passkeys/register/finish", {
      credential: authenticator.create(options, this.#server.origin),
    });
  }

  async signIn(authenticator: TestAuthenticator, answer: Answer = {}) {
    const options = await this.begin("/auth/signin/begin");
    return this.post("/auth/signin/finish", {
      credential: authenticator.get(options, this.#server.origin, answer),
    });
  }
}

export { TestAuthenticator };
