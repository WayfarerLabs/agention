import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { olderServerRefusal } from "./agent-api.ts";
import { KeyFile } from "./key-file.ts";
import {
  agent,
  certificate,
  session,
  sourceEntry,
  startBridgeProcess,
  type TestBridge,
} from "./test-harness.ts";

// The server compatibility suite, which CONTRIBUTING.md "The agent API"
// describes: the bridge at HEAD against each released server that
// scripts/check-server-compatibility.sh installs, under its version in
// AGENTION_RELEASED_SERVERS, beside a file agent-api holding the agent API
// version the release states, or none. Each is older than the bridge, so
// every tool call is refused, and the release records nothing but, before it
// stated a version, the registration a new key makes.

const releases = process.env.AGENTION_RELEASED_SERVERS;
if (releases === undefined || releases === "") {
  throw new Error(
    "AGENTION_RELEASED_SERVERS must name the directory of installed server releases; " +
      "scripts/check-server-compatibility.sh sets it",
  );
}
const versions = readdirSync(releases).sort();
if (versions.length === 0) {
  throw new Error(`${releases} holds no installed server release`);
}

// The origin every release serves at. It names no port, so a release starts
// before its port is known, and the bridge reaches it through
// AGENTION_CONNECT.
const origin = "https://localhost";

// How long a pending registration lasts at most, an hour (FRD C4).
const registrationLifetime = 60 * 60 * 1000;

interface Serving {
  port: number;
  output: () => string;
  stop: () => Promise<void>;
}

// serve starts a released server's agention serve on a free loopback port,
// and resolves once it says where it serves, reading only the port.
async function serve(bin: string, args: string[]): Promise<Serving> {
  const child = spawn(bin, ["serve", ...args], {
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = once(child, "exit");
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  };
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start within 10 s:\n${output}`)), 10_000);
    const read = (chunk: Buffer): void => {
      output += chunk.toString();
      const served = / on https:\/\/127\.0\.0\.1:([0-9]+)$/m.exec(output);
      if (served !== null) {
        clearTimeout(timer);
        resolve(Number(served[1]));
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`exited before serving:\n${output}`));
    });
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  return { port, output: () => output, stop };
}

// contents reads every table of a database, read-only, as each row's JSON,
// sorted, by table name, so two reads compare whatever the release's schema.
function contents(file: string): Map<string, string[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const bytes = (_: string, value: unknown) =>
      value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value;
    return new Map(
      tables.map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM "${name}"`)
          .all()
          .map((row) => JSON.stringify(row, bytes))
          .sort(),
      ]),
    );
  } finally {
    db.close();
  }
}

describe.each(versions)("the server released as %s", (version) => {
  const release = path.join(releases, version);
  const declared = readFileSync(path.join(release, "agent-api"), "utf8").trim();
  // The agent API version the release states on its answers, or none.
  const stated = declared === "none" ? undefined : declared;
  let scratch: string;
  let server: Serving | undefined;
  let bridge: TestBridge | undefined;

  beforeEach(() => {
    // Under the system's temporary directory, since a release refuses a data
    // directory any of whose ancestors another user owns or can write to.
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-server-")));
  });

  afterEach(async () => {
    await bridge?.close();
    await server?.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  it(
    "refuses every tool call, and records nothing the operator must act on",
    { timeout: 60_000 },
    async () => {
      const [data, home, tls] = ["data", "home", "tls"].map((name) => {
        const dir = path.join(scratch, name);
        mkdirSync(dir, { mode: 0o700 });
        return dir;
      }) as [string, string, string];
      const [cert, key] = [path.join(tls, "cert.pem"), path.join(tls, "key.pem")];
      writeFileSync(cert, certificate.cert);
      writeFileSync(key, certificate.key, { mode: 0o600 });
      server = await serve(path.join(release, "node_modules", ".bin", "agention"), [
        "--data",
        data,
        "--origin",
        origin,
        "--listen",
        "127.0.0.1:0",
        "--tls-cert",
        cert,
        "--tls-key",
        key,
      ]);
      const database = path.join(data, "agention.db");
      const before = contents(database);

      ({ bridge } = await startBridgeProcess({
        entry: sourceEntry,
        home,
        environment: {
          AGENTION_URL: origin,
          AGENTION_CONNECT: `127.0.0.1:${server.port}`,
          AGENTWORKS_AGENT: agent,
          AGENTWORKS_SESSION: session,
        },
        authority: cert,
      }));
      const upload = path.join(home, "notes.txt");
      writeFileSync(upload, "Notes.\n");
      // Valid arguments for every tool. register comes first: it creates the
      // session's key, without which every other tool fails in the bridge.
      const calls: [string, Record<string, unknown>][] = [
        ["register", {}],
        ["thread_create", { request_id: "compat-1", title: "Release notes", text: "Ready." }],
        ["message_send", { thread: 1, request_id: "compat-2", seen_through: 1, text: "Done." }],
        ["thread_get", { thread: 1 }],
        ["thread_list", {}],
        ["thread_read", { thread: 1, through: 1 }],
        ["thread_archive", { thread: 1, through: 1 }],
        ["message_wait", { wait_seconds: 0 }],
        ["session_update", { state: "working" }],
        ["file_upload", { path: upload }],
        ["file_get", { thread: 1, seq: 1, name: "notes.txt" }],
      ];
      const { tools } = await bridge.client.listTools();
      expect(calls.map(([tool]) => tool).sort()).toEqual(tools.map((tool) => tool.name).sort());

      // Each is the refusal of a server stating what this release states: plain
      // text, not an answer in Agention's JSON.
      const refusal = olderServerRefusal(origin, stated).message;
      for (const [tool, args] of calls) {
        const answer = await bridge.call(tool, args);
        expect([tool, answer.isError, answer.json, answer.text]).toEqual([
          tool,
          true,
          undefined,
          refusal,
        ]);
      }

      await bridge.close();
      bridge = undefined;
      await server.stop();
      const after = contents(database);
      if (stated === undefined) {
        // A release stating no version records a new key's registration before
        // the bridge refuses its answer: one, pending, expiring within the hour.
        const publicKey = new KeyFile(home, origin, { agent, session }).read()?.publicKey;
        const rows = (name: string, of: Map<string, string[]>) => of.get(name) ?? [];
        const recorded = rows("registrations", after)
          .filter((row) => !rows("registrations", before).includes(row))
          .map((row) => JSON.parse(row) as Record<string, unknown>);
        expect(recorded).toMatchObject([
          {
            status: "pending",
            public_key: publicKey,
            proposed_agent: agent,
            proposed_session: session,
          },
        ]);
        const [{ created_at, expires_at }] = recorded as [
          { created_at: number; expires_at: number },
        ];
        expect([expires_at > created_at, expires_at - created_at <= registrationLifetime]).toEqual([
          true,
          true,
        ]);
        expect(rows("registrations", after).length).toBe(rows("registrations", before).length + 1);
        for (const name of ["registrations", "sqlite_sequence"]) {
          before.delete(name);
          after.delete(name);
        }
      }
      expect(after).toEqual(before);
    },
  );
});
