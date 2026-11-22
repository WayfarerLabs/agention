// An agent for the browser tests: it holds a session key and calls the agent
// API the way the agent bridge does, with a token it signs for every request.
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { request as httpsRequest } from "node:https";

export interface AgentServer {
  origin: string;
  // Where the server listens, and the certificate it presents for the
  // origin's host.
  port: number;
  certificate: string;
}

export interface Answer<T = unknown> {
  status: number;
  body: T;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export class Agent {
  readonly publicKey: string;
  readonly #privateKey: KeyObject;
  readonly #server: AgentServer;

  constructor(server: AgentServer) {
    const keys = generateKeyPairSync("ed25519");
    this.publicKey = keys.publicKey.export({ format: "jwk" }).x as string;
    this.#privateKey = keys.privateKey;
    this.#server = server;
  }

  // token is a compact JWS over Ed25519, naming the key and bound to the
  // server's origin for two minutes.
  token(): string {
    const header = base64url(JSON.stringify({ alg: "EdDSA", kid: this.publicKey }));
    const claims = base64url(
      JSON.stringify({ aud: this.#server.origin, exp: Math.floor(Date.now() / 1000) + 120 }),
    );
    const signature = sign(null, Buffer.from(`${header}.${claims}`), this.#privateKey);
    return `${header}.${claims}.${base64url(signature)}`;
  }

  send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Answer<T>> {
    return callServer(
      this.#server,
      method,
      `/api/agent${path}`,
      `Bearer ${this.token()}`,
      body === undefined
        ? undefined
        : { type: "application/json", bytes: Buffer.from(JSON.stringify(body)) },
    );
  }

  // upload sends bytes as the body of a POST, declared as type, as the
  // bridge uploads a file.
  upload<T>(path: string, bytes: Buffer, type: string): Promise<Answer<T>> {
    return callServer(this.#server, "POST", `/api/agent${path}`, `Bearer ${this.token()}`, {
      type,
      bytes,
    });
  }
}

// callServer sends one request to the server over TLS, trusting its test
// certificate, with an Authorization header and no cookie, as a program
// outside the browser does: the agent bridge, or a client holding an API key.
export function callServer<T>(
  server: AgentServer,
  method: "GET" | "POST",
  path: string,
  authorization: string,
  payload?: { type: string; bytes: Buffer },
): Promise<Answer<T>> {
  const { origin, port, certificate } = server;
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        servername: url.hostname,
        ca: certificate,
        method,
        path,
        headers: {
          host: url.host,
          authorization,
          ...(payload === undefined
            ? {}
            : { "content-type": payload.type, "content-length": payload.bytes.length }),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as T }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload?.bytes);
  });
}
