// Uploads and file reads through the app, on either mount, for the HTTP
// tests of files.
import { type ErrorBody, type UploadResult } from "@wayfarerlabs/agention-api";
import { type AgentKey, type Harness, host, origin, sessionCookie } from "./test-harness.ts";

export type Mount = "agent" | "web";

export interface Sent {
  status: number;
  headers: Headers;
  bytes: Buffer;
}

// mountHeaders are the headers a request on a mount authenticates with: the
// agent's token, or the operator's cookie, with the CSRF token and origin
// for a change.
export async function mountHeaders(
  harness: Harness,
  mount: Mount,
  agent: AgentKey,
  method: string,
): Promise<Record<string, string>> {
  if (mount === "agent") {
    return { authorization: `Bearer ${await harness.token(agent)}` };
  }
  return {
    cookie: `${sessionCookie}=${harness.cookie}`,
    ...(method === "GET" || method === "HEAD" ? {} : { "x-csrf-token": harness.csrf, origin }),
  };
}

// send makes a request through the app with exactly the headers given, and
// the host, and reads its body as bytes.
export async function send(
  harness: Harness,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Uint8Array,
): Promise<Sent> {
  const response = await harness.app.request(path, {
    method,
    headers: { host, ...headers },
    ...(body === undefined ? {} : { body: body as Uint8Array<ArrayBuffer> }),
  });
  return {
    status: response.status,
    headers: response.headers,
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

export const json = (sent: Sent): unknown => JSON.parse(sent.bytes.toString("utf8"));

export const codeOf = (sent: Sent): string =>
  sent.status < 400 ? "ok" : (json(sent) as ErrorBody).error.code;

// upload uploads bytes on a mount to builder/main, under a name, declaring a
// type unless it is null.
export async function upload(
  harness: Harness,
  mount: Mount,
  agent: AgentKey,
  bytes: Uint8Array,
  options: { name?: string; type?: string | null; length?: number; session?: string } = {},
): Promise<Sent> {
  const type = options.type === undefined ? "text/plain" : options.type;
  return send(
    harness,
    "POST",
    `/api/${mount}/s/builder/${options.session ?? "main"}/uploads?name=${encodeURIComponent(
      options.name ?? "notes.txt",
    )}`,
    {
      ...(await mountHeaders(harness, mount, agent, "POST")),
      ...(type === null ? {} : { "content-type": type }),
      "content-length": String(options.length ?? bytes.length),
    },
    bytes,
  );
}

export async function uploaded(
  harness: Harness,
  mount: Mount,
  agent: AgentKey,
  bytes: Uint8Array,
  options: { name?: string; type?: string | null } = {},
): Promise<UploadResult> {
  const sent = await upload(harness, mount, agent, bytes, options);
  if (sent.status !== 200) {
    throw new Error(`upload failed: ${sent.bytes.toString()}`);
  }
  return json(sent) as UploadResult;
}

// readFile reads a file of thread 1 of builder/main on a mount.
export async function readFile(
  harness: Harness,
  mount: Mount,
  agent: AgentKey,
  seq: number,
  name: string,
  options: { file?: string | undefined; headers?: Record<string, string>; method?: string } = {},
): Promise<Sent> {
  const method = options.method ?? "GET";
  const query = options.file === undefined ? "" : `?file=${options.file}`;
  return send(
    harness,
    method,
    `/api/${mount}/s/builder/main/threads/1/messages/${seq}/files/${encodeURIComponent(name)}${query}`,
    { ...(await mountHeaders(harness, mount, agent, method)), ...options.headers },
  );
}
