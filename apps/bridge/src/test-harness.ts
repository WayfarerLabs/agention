// A real Agention server over TLS, run in this process from apps/server, and
// bridges connected to it through the MCP SDK's client, in this process or
// as processes of their own, for the bridge's tests; and bridge processes
// alone, for a server run elsewhere, such as a released one.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  agentApi,
  agentApiHeader,
  type PublicKey,
  publicKey,
  type UploadResult,
} from "@wayfarerlabs/agention-api";
import { createApp, securityHeaderValues } from "@wayfarerlabs/agention/src/http/app.ts";
import { type Listening, listen } from "@wayfarerlabs/agention/src/http/listener.ts";
import { defaultRates } from "@wayfarerlabs/agention/src/http/rates.ts";
import {
  type TestCertificate,
  testCertificate,
} from "@wayfarerlabs/agention/src/http/test-certificate.ts";
import { Harness } from "@wayfarerlabs/agention/src/http/test-harness.ts";
import { Hono } from "hono";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { AgentApi } from "./agent-api.ts";
import { type BridgeEnvironment, createBridge } from "./bridge.ts";
import { KeyFile, type SessionKey } from "./key-file.ts";

// The server's certificate, made once for the test file, which this process
// trusts the way NODE_EXTRA_CA_CERTS makes a bridge trust a private authority.
export const certificate = testCertificate();
setDefaultCACertificates([...getCACertificates("default"), certificate.cert]);

// The names the bridges propose unless a test says otherwise.
export const agent = "builder";
export const session = "main";

// The bridge's entry point in this source tree, which Node runs directly.
export const sourceEntry = fileURLToPath(new URL("main.ts", import.meta.url));

// serverJson answers a request in place of the server, as this release's
// server would: with the JSON given, stating the agent API version it speaks.
export function serverJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { [agentApiHeader]: String(agentApi.version) },
  });
}

// What a tool answered: its text, the JSON it holds if any, whether it is an
// error, and every content block, the text's first.
export interface Answer {
  isError: boolean;
  text: string;
  json: unknown;
  content: Record<string, unknown>[];
}

export class TestBridge {
  readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<Answer> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = result.content as Record<string, unknown>[];
    const text = typeof content[0]?.text === "string" ? content[0].text : "";
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: result.isError === true, text, json, content };
  }

  // ok calls a tool that must succeed and returns its JSON.
  async ok(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const answer = await this.call(name, args);
    if (answer.isError) {
      throw new Error(`${name} failed: ${answer.text}`);
    }
    return answer.json as Record<string, unknown>;
  }

  // error calls a tool that must fail and returns its API error.
  async error(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ code: string; message: string; field?: string; missed?: unknown[] }> {
    const answer = await this.call(name, args);
    const body = answer.json as { error?: { code: string; message: string } } | undefined;
    if (!answer.isError || body?.error === undefined) {
      throw new Error(`${name} did not fail with an API error: ${answer.text}`);
    }
    return body.error;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

// startBridgeProcess starts a bridge as an agent host starts one: a process of
// its own, from entry, speaking MCP on standard input and output, configured
// only by its environment, with home as HOME, and trusting the certificate
// authority in the file authority names through NODE_EXTRA_CA_CERTS.
export async function startBridgeProcess(options: {
  entry: string;
  home: string;
  environment: Record<string, string>;
  authority?: string;
}): Promise<{ bridge: TestBridge; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.entry],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: options.home,
      ...options.environment,
      ...(options.authority === undefined ? {} : { NODE_EXTRA_CA_CERTS: options.authority }),
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: "agention-process-test", version: "0.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    // Closing the transport ends the process it started.
    await transport.close();
    throw error;
  }
  return { bridge: new TestBridge(client), stderr: () => stderr };
}

export class BridgeHarness {
  // The operator's side: the server's store, with a signed-in browser.
  readonly server = new Harness();
  readonly home = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-bridge-")));
  readonly bridges: TestBridge[] = [];
  readonly logged: string[] = [];
  // Runs before the server handles each request on the TLS listener, which
  // waits for it; a response it returns answers the request instead.
  beforeRequest: ((request: Request) => Response | void | Promise<Response | void>) | undefined;
  // Runs once the server has answered each request on the TLS listener,
  // before the answer goes out, which waits for it.
  afterAnswer: ((request: Request) => void | Promise<void>) | undefined;
  #listening: Listening | undefined;
  #origin = "";

  // start runs the server on 127.0.0.1 with the certificate for localhost, at
  // https://localhost and the port it listens on, unless options give another
  // certificate and origin. That origin names the port the listener is given,
  // so the server's app is made once it listens, behind a front that hands it
  // each request.
  async start(options: { origin?: string; certificate?: TestCertificate } = {}): Promise<this> {
    const tls = options.certificate ?? certificate;
    let app: Hono | undefined;
    const front = new Hono().all("*", async (c) => {
      const answer = await this.beforeRequest?.(c.req.raw);
      if (answer !== undefined) {
        return answer;
      }
      if (app === undefined) {
        throw new Error("the server is not ready");
      }
      const response = await app.fetch(c.req.raw, c.env);
      await this.afterAnswer?.(c.req.raw);
      return response;
    });
    this.#listening = await listen(
      front,
      { host: "127.0.0.1", port: 0 },
      { cert: Buffer.from(tls.cert), key: Buffer.from(tls.key) },
      () => securityHeaderValues(this.#origin),
    );
    this.#origin = options.origin ?? `https://localhost:${this.#listening.address.port}`;
    app = createApp({
      store: this.server.fixture.store,
      origin: this.#origin,
      name: "Agention",
      webRoot: undefined,
      // The fixture's clock stands still, so no budget refills; these tests
      // are not about budgets.
      rates: { ...defaultRates, key: { burst: 10_000, interval: 1000 } },
      shutdown: this.server.shutdown.signal,
      log: (message) => this.logged.push(message),
    });
    return this;
  }

  get origin(): string {
    return this.#origin;
  }

  // The port the server listens on, on 127.0.0.1.
  get port(): number {
    return this.#listening?.address.port ?? 0;
  }

  // bridge starts a bridge with the environment an agent host would give it,
  // signing with the server's clock, and connects a client to it.
  async bridge(environment: BridgeEnvironment = {}, home = this.home): Promise<TestBridge> {
    const server = createBridge({
      environment: {
        AGENTION_URL: this.#origin,
        AGENTWORKS_AGENT: agent,
        AGENTWORKS_SESSION: session,
        ...environment,
      },
      home,
      clock: () => this.server.fixture.now,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "agention-bridge-test", version: "0.0.0" });
    await client.connect(clientTransport);
    const bridge = new TestBridge(client);
    this.bridges.push(bridge);
    return bridge;
  }

  // process starts a bridge process from entry against this server, as
  // startBridgeProcess does, trusting the server's certificate authority
  // unless told not to. A bridge process signs with the real clock, so the
  // server's clock is set to it, and the operator signs in again as it
  // stands.
  async process(
    options: { entry?: string; trust?: boolean } = {},
  ): Promise<{ bridge: TestBridge; stderr: () => string }> {
    const { entry = sourceEntry, trust = true } = options;
    this.server.fixture.now = Date.now();
    this.server.signIn();
    const authority = path.join(this.home, "authority.pem");
    writeFileSync(authority, certificate.cert);
    const started = await startBridgeProcess({
      entry,
      home: this.home,
      environment: {
        AGENTION_URL: this.#origin,
        AGENTWORKS_AGENT: agent,
        AGENTWORKS_SESSION: session,
      },
      ...(trust ? { authority } : {}),
    });
    this.bridges.push(started.bridge);
    return started;
  }

  // keyFile is where the bridges keep a session's key.
  keyFile(names: { agent: string; session: string } = { agent, session }): string {
    const server = new URL(this.#origin).host;
    return path.join(
      this.home,
      ".config",
      "agention",
      server,
      names.agent,
      names.session,
      "key.pem",
    );
  }

  // keyOnDisk is the public key of the key the key file now holds.
  keyOnDisk(names?: { agent: string; session: string }): PublicKey {
    const privateKey = createPrivateKey(readFileSync(this.keyFile(names), "utf8"));
    return publicKey.parse(createPublicKey(privateKey).export({ format: "jwk" }).x);
  }

  registrations(): { id: number; public_key: string; status: string }[] {
    return this.server.fixture.db
      .prepare("SELECT id, public_key, status FROM registrations ORDER BY id")
      .all() as { id: number; public_key: string; status: string }[];
  }

  // The operator's decisions, through the web API.

  approve(
    key: PublicKey,
    granted: { agent: string; session: string } = { agent, session },
  ): Promise<void> {
    return this.server.approveKey(key, granted);
  }

  reject(key: PublicKey): Promise<void> {
    return this.#decide(key, "reject");
  }

  revoke(key: PublicKey): Promise<void> {
    return this.#decide(key, "revoke");
  }

  async #decide(key: PublicKey, decision: string): Promise<void> {
    const response = await this.server.web(
      "POST",
      `/registrations/${this.server.registrationId(key)}/${decision}`,
    );
    if (response.status !== 200) {
      throw new Error(`${decision} failed: ${JSON.stringify(response.body)}`);
    }
  }

  // asAgent acts as the agent of the session without a bridge: the agent API,
  // signing with the key the bridges keep on disk for it and the server's
  // clock.
  asAgent(): { api: AgentApi; key: SessionKey } {
    const key = new KeyFile(this.home, this.#origin, { agent, session }).read();
    if (key === undefined) {
      throw new Error("the session has no key on disk");
    }
    const api = new AgentApi({ origin: this.#origin, clock: () => this.server.fixture.now });
    return { api, key };
  }

  // operatorUploads uploads a file as the operator, through the web API, to
  // the session.
  async operatorUploads(
    bytes: Uint8Array,
    options: { name: string; type: string },
  ): Promise<UploadResult> {
    const response = await this.server.web(
      "POST",
      `/s/${agent}/${session}/uploads?name=${encodeURIComponent(options.name)}`,
      bytes,
      { headers: { "content-type": options.type, "content-length": String(bytes.length) } },
    );
    if (response.status !== 200) {
      throw new Error(`the operator's upload failed: ${JSON.stringify(response.body)}`);
    }
    return response.body as UploadResult;
  }

  // operatorWrites sends a message to a thread as the operator, through the
  // web API, and returns the message's sequence.
  async operatorWrites(
    thread: number,
    message: Record<string, unknown>,
    names: { agent: string; session: string } = { agent, session },
  ): Promise<number> {
    const path = `/s/${names.agent}/${names.session}/threads/${thread}`;
    const read = await this.server.web("GET", path);
    const seenThrough = (read.body as { thread: { last_seq: number } }).thread.last_seq;
    const response = await this.server.web("POST", `${path}/messages`, {
      request_id: `operator-${thread}-${seenThrough}`,
      seen_through: seenThrough,
      ...message,
    });
    if (response.status !== 200) {
      throw new Error(`the operator's write failed: ${JSON.stringify(response.body)}`);
    }
    return (response.body as { seq: number }).seq;
  }

  async close(): Promise<void> {
    await Promise.all(this.bridges.map((bridge) => bridge.close()));
    // Shutting down ends the long polls, so the listener can close.
    this.server.shutdown.abort();
    await this.#listening?.close();
    this.server.close();
    rmSync(this.home, { recursive: true, force: true });
  }
}
