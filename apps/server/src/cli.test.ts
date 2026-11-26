import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { SignJWT } from "jose";
import { execFileSync } from "node:child_process";
import { Agent, get } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { run } from "./cli.ts";
import { Database } from "./database/database.ts";
import { openBrowserSession } from "./auth/browser-sessions.ts";
import { issuePasskeyLink } from "./auth/passkey-links.ts";
import { hashOfSecret } from "./auth/secrets.ts";
import { type AgentKey, newAgentKey } from "./http/test-harness.ts";
import { identityForBrowserSession } from "./identity.ts";
import { insertTestPasskey, testOrigin } from "./store/test-fixture.ts";
import { testDirectory } from "./test-directory.ts";
import {
  approveRegistration,
  beginUpload,
  createStore,
  findRegistrationByKey,
  insertOperator,
  storedName,
  storeName,
  submitRegistration,
} from "./store/index.ts";

// The first sweep's pass, which a test may hold open to see what serve does
// meanwhile; the real pass runs either way.
const firstSweep = vi.hoisted(() => ({ held: Promise.resolve() }));
vi.mock("./store/sweep.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./store/sweep.ts")>();
  return {
    ...real,
    sweepRegularly: (...args: Parameters<typeof real.sweepRegularly>) => {
      const sweeps = real.sweepRegularly(...args);
      return { ...sweeps, first: sweeps.first.then(() => firstSweep.held) };
    },
  };
});

function capture() {
  return {
    text: "",
    write(text: string, callback?: (error?: Error | null) => void) {
      this.text += text;
      callback?.();
    },
  };
}

async function runCaptured(
  args: string[],
  stop = new AbortController().signal,
  env: Record<string, string> = {},
) {
  const stdout = capture();
  const stderr = capture();
  const code = await run(args, { stdout, stderr, stop, env });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const origin = "https://agention.test";

describe("agention", () => {
  it("prints the package version", async () => {
    expect(await runCaptured(["version"])).toEqual({
      code: 0,
      stdout: `agention ${packageJson.version}\n`,
      stderr: "",
    });
  });

  it.each([
    "--help",
    "-h",
    "version --help",
    "version -h",
    "serve --help",
    "passkey-link -h",
    "backup --help",
    "audit --help",
    "audit forget-sink -h",
  ])("prints help on stdout for %s", async (line) => {
    const result = await runCaptured(line.split(" "));
    expect(result.code).toBe(0);
    expect(result.stdout).not.toBe("");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["no command", []],
    ["an unknown command", ["serve-everything"]],
    ["an extra argument", ["version", "extra"]],
    ["an unknown option", ["version", "--verbose"]],
    ["help for an unknown command", ["serve-everything", "--help"]],
    ["audit without a command", ["audit"]],
    ["an unknown audit command", ["audit", "forget-everything"]],
  ])("rejects %s with a usage error on stderr", async (_, args) => {
    const result = await runCaptured(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });
});

describe("agention serve and passkey-link", () => {
  let root: string;
  let data: string;

  beforeEach(() => {
    root = testDirectory("cli");
    data = path.join(root, "data");
  });

  const serve = (...flags: string[]) => ["serve", "--data", "DATA", "--origin", origin, ...flags];
  const link = (...flags: string[]) => [
    "passkey-link",
    "--data",
    data,
    "--origin",
    origin,
    ...flags,
  ];

  // createDatabase makes the database agention serve would, with an operator
  // and an approved agent when asked, and returns the agent's key; and with
  // an upload a crash left unfinished, when asked too.
  function createDatabase(withAgent = false, unfinished = false): AgentKey | undefined {
    const db = Database.open(path.join(data, "agention.db"));
    try {
      if (!withAgent) {
        return undefined;
      }
      const store = createStore(db);
      const operator = db.transaction(() => insertOperator(db, "morgan", Date.now()));
      const { token } = db.transaction(() =>
        openBrowserSession(
          db,
          operator.personId,
          insertTestPasskey(db, operator.personId, Date.now()),
          Date.now(),
        ),
      );
      const identity = identityForBrowserSession(
        db,
        hashOfSecret(token) ?? Buffer.alloc(0),
        testOrigin,
      );
      const key = newAgentKey();
      submitRegistration(store, key.publicKey, { agent: "builder", session: "main" }, testOrigin);
      approveRegistration(
        store,
        identity ?? (undefined as never),
        findRegistrationByKey(db, key.publicKey)?.id ?? 0,
        { agent: { name: "builder", existing: false }, session: { name: "main", existing: false } },
      );
      if (unfinished) {
        beginUpload(
          store,
          identity ?? (undefined as never),
          { agent: "builder", session: "main" },
          { name: "left.bin", type: "application/octet-stream", size: 10 },
        );
      }
      return key;
    } finally {
      db.close();
    }
  }

  // serving runs agention serve on a free loopback port until stop aborts,
  // with any further flags given.
  async function serving(stop: AbortSignal, ...flags: string[]) {
    return servingWith({}, stop, ...flags);
  }

  // servingWith runs agention serve as serving does, in the environment given.
  async function servingWith(env: Record<string, string>, stop: AbortSignal, ...flags: string[]) {
    const stdout = capture();
    const stderr = capture();
    const running = run(
      ["serve", "--data", data, "--origin", `${origin}/`, "--listen", "127.0.0.1:0", ...flags],
      { stdout, stderr, stop, env },
    );
    let port: number | undefined;
    for (let i = 0; i < 200 && port === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const match = /on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr.text)?.[1];
      port = match === undefined ? undefined : Number(match);
    }
    return { running, port: port ?? 0, stdout, stderr };
  }

  function getJson(
    port: number,
    target: string,
    headers: Record<string, string> = {},
    agent?: Agent,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const request = get(
        {
          host: "127.0.0.1",
          port,
          path: target,
          headers: { host: "agention.test", ...headers },
          agent,
        },
        (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => (text += chunk.toString()));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }),
          );
        },
      );
      request.on("error", reject);
    });
  }

  it.each([
    ["serve without --data", ["serve", "--origin", origin]],
    ["serve with an empty --data", ["serve", "--data", "", "--origin", origin]],
    ["serve without --origin", ["serve", "--data", "DATA"]],
    ["passkey-link without --origin", ["passkey-link", "--data", "DATA"]],
    ["passkey-link with an empty --data", ["passkey-link", "--data", "", "--origin", origin]],
    ["an origin over plain HTTP", ["serve", "--data", "DATA", "--origin", "http://agention.test"]],
    ["an origin with the default port", ["serve", "--data", "DATA", "--origin", `${origin}:443`]],
    ["an origin with a path", ["passkey-link", "--data", "DATA", "--origin", `${origin}/x`]],
    [
      "an origin that is an address",
      serve().map((arg) => (arg === origin ? "https://127.0.0.1" : arg)),
    ],
    ["a certificate without a key", serve("--tls-cert", "cert.pem")],
    ["plain HTTP on every address", serve("--listen", "0.0.0.0:8080")],
    ["a listen address by name", serve("--listen", "localhost:8080")],
    ["a quiet threshold of no minutes", serve("--quiet-minutes", "0")],
    ["a quiet threshold past a week", serve("--quiet-minutes", "10081")],
    ["a quiet threshold that is not a whole number", serve("--quiet-minutes", "1.5")],
    ["an empty server name", serve("--name", "")],
    ["a server name past 40 characters", serve("--name", "w".repeat(41))],
    ["a server name of white space", serve("--name", " ")],
    ["a server name on two lines", serve("--name", "Work\nPlay")],
    ["a server name holding a control character", serve("--name", "Work\u0007")],
    [
      "an operator name outside the grammar",
      ["passkey-link", "--data", "DATA", "--origin", origin, "--operator-name", "Morgan"],
    ],
    [
      "passkey-link given a server's --name",
      ["passkey-link", "--data", "DATA", "--origin", origin, "--name", "personal"],
    ],
    ["an audit group without an audit directory", serve("--audit-group", "agention")],
    ["audit files to keep without an audit directory", serve("--audit-keep-days", "3")],
    ["an empty audit directory", serve("--audit-dir", "")],
    ["no audit files to keep", serve("--audit-dir", "AUDIT", "--audit-keep-days", "0")],
    ["audit files kept past 3650", serve("--audit-dir", "AUDIT", "--audit-keep-days", "3651")],
    ["an audit retention past 36500 days", serve("--audit-retention-days", "36501")],
    ["an audit retention that is not a whole number", serve("--audit-retention-days", "1.5")],
    ["a negative audit retention", serve("--audit-retention-days", "-1")],
    [
      "an audit group that does not exist",
      serve("--audit-dir", "AUDIT", "--audit-group", "agention-no-such-group"),
    ],
    // The superuser is in every group.
    ...(process.geteuid?.() === 0
      ? []
      : [
          [
            "an audit group this user is not in",
            serve("--audit-dir", "AUDIT", "--audit-group", "root"),
          ] as [string, string[]],
        ]),
    ["forget-sink without a kind", ["audit", "forget-sink", "--data", "DATA"]],
    ["forget-sink of an unknown kind", ["audit", "forget-sink", "--data", "DATA", "otlp"]],
  ])("refuses %s before touching the data directory", async (_, args) => {
    const audit = path.join(root, "audit");
    const result = await runCaptured(
      args.map((arg) => (arg === "DATA" ? data : arg === "AUDIT" ? audit : arg)),
    );
    expect(existsSync(audit)).toBe(false);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe("");
    expect(existsSync(data)).toBe(false);
  });

  // Values that break the voice variables' bounds or the base URL rule, each
  // holding a word that must never be printed.
  const url = "AGENTION_TRANSCRIPTION_URL";
  const model = "AGENTION_TRANSCRIPTION_MODEL";
  const key = "AGENTION_TRANSCRIPTION_KEY";
  it.each([
    ["a base URL over plain http to a name", url, { [url]: "http://secret.example/v1" }],
    ["a link-local base URL", url, { [url]: "https://169.254.169.254/secret" }],
    ["a metadata address", url, { [url]: "http://100.100.100.200/secret" }],
    ["a base URL with a query", url, { [url]: "https://api.example/v1?secret=1" }],
    ["an empty base URL", url, { [url]: "" }],
    ["a model outside ASCII", model, { [model]: "secret-model-\u00e9" }],
    ["a model past 200 characters", model, { [model]: `secret${"m".repeat(200)}` }],
    ["a key holding a space", key, { [url]: "https://api.openai.com/v1", [key]: "sk secret" }],
    ["a key without a base URL", key, { [key]: "sk-secret" }],
  ])(
    "refuses %s in the environment before touching the data directory, naming only the variable",
    async (_, variable, env) => {
      const result = await runCaptured(
        serve().map((arg) => (arg === "DATA" ? data : arg)),
        undefined,
        env,
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(variable);
      expect(result.stderr).not.toContain("secret");
      expect(existsSync(data)).toBe(false);
    },
  );

  it("serves with every voice variable set", async () => {
    const stop = new AbortController();
    const { running, port } = await servingWith(
      { [url]: "https://api.openai.com/v1/", [model]: "gpt-transcribe", [key]: "sk-test" },
      stop.signal,
    );
    expect(port).not.toBe(0);
    stop.abort();
    expect(await running).toBe(0);
  });

  it("names --allow-plain-http when refusing plain HTTP off loopback", async () => {
    const args = serve("--listen", "0.0.0.0:8080").map((arg) => (arg === "DATA" ? data : arg));
    expect((await runCaptured(args)).stderr).toContain("--allow-plain-http");
  });

  // storedNameOf reads the name the server's database holds.
  function storedNameOf(): string | undefined {
    const db = Database.open(path.join(data, "agention.db"));
    try {
      return storedName(db);
    } finally {
      db.close();
    }
  }

  it.each([
    ["by default", [], "Agention"],
    ["with a quiet threshold of its own", ["--quiet-minutes", "10080"], "Agention"],
    // Each counts once, though JavaScript stores it as two code units.
    ["with a name of 40 characters", ["--name", "\u{1F4BC}".repeat(40)], "\u{1F4BC}".repeat(40)],
  ])("serves %s until asked to stop, naming the server", async (_, flags, named) => {
    const stop = new AbortController();
    const { running, port } = await serving(stop.signal, ...flags);
    expect((await getJson(port, "/api/web/session")).body).toEqual({
      signed_in: false,
      operator_exists: false,
    });
    stop.abort();
    expect(await running).toBe(0);
    expect(storedNameOf()).toBe(named);
  });

  it.each([
    ["with --api-docs", ["--api-docs"], 200],
    ["without --api-docs", [], 404],
  ])("serves the API's documentation only %s", async (_, flags, status) => {
    const stop = new AbortController();
    const { running, port } = await serving(stop.signal, ...flags);
    expect((await getJson(port, "/docs/api/openapi.json")).status).toBe(status);
    stop.abort();
    expect(await running).toBe(0);
  });

  // start serves with the flags given until it is listening, then stops.
  async function start(...flags: string[]) {
    const stop = new AbortController();
    const { running, port } = await serving(stop.signal, ...flags);
    expect(port).not.toBe(0);
    stop.abort();
    return running;
  }

  // The refusal of a name other than the one the server keeps.
  const renamed = (kept: string) =>
    `agention serve: --name: this server is named "${kept}", and a server's name never ` +
    "changes; leave --name out or give that name\n";

  // onBusyPort runs agention serve with the flags given on a loopback port
  // something else holds, so a start that gets as far as listening fails.
  async function onBusyPort(...flags: string[]) {
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = busy.address() as AddressInfo;
      const args = serve("--listen", `127.0.0.1:${port}`, ...flags).map((arg) =>
        arg === "DATA" ? data : arg,
      );
      return await runCaptured(args);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  }

  it("keeps the name the first start to serve gave, served with it left out or repeated, and refuses another", async () => {
    expect(await start("--name", "Work")).toBe(0);
    expect(await start()).toBe(0);
    expect(await start("--name", "Work")).toBe(0);
    // Refused before it listens, which would fail.
    expect(await onBusyPort("--name", "Play")).toEqual({
      code: 2,
      stdout: "",
      stderr: renamed("Work"),
    });
    expect(storedNameOf()).toBe("Work");
  });

  it("leaves the name unset when a start fails before serving", async () => {
    const failed = await onBusyPort("--name", "Typo");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("cannot listen");
    expect(storedNameOf()).toBeUndefined();
    expect(await start("--name", "Right")).toBe(0);
    expect(storedNameOf()).toBe("Right");
  });

  it("keeps one name when first starts race, and stops the others", async () => {
    // The listeners open in this process, counted on a later turn of the event
    // loop, once those already closed have released their sockets.
    const listeners = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return process.getActiveResourcesInfo().filter((each) => each === "TCPServerWrap").length;
    };
    const before = await listeners();
    const stop = new AbortController();
    // Each reads the name unset before any listens, as they run in one process.
    const starts = ["One", "Two", "Three", "Four", "Five", "Six"].map((name) => {
      const stderr = capture();
      const running = run(
        ["serve", "--data", data, "--origin", origin, "--listen", "127.0.0.1:0", "--name", name],
        { stdout: capture(), stderr, stop: stop.signal, env: {} },
      );
      return { name, stderr, running };
    });
    let served: typeof starts = [];
    for (let i = 0; i < 500 && served.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      served = starts.filter((each) => each.stderr.text.includes("agention: serving"));
    }
    expect(served).toHaveLength(1);
    const [winner] = served as [(typeof starts)[number]];
    // Each other start listened, found the winner's name stored, and closed
    // its listener before it exited.
    for (const loser of starts.filter((each) => each !== winner)) {
      expect(await loser.running).toBe(2);
      expect(loser.stderr.text).toBe(renamed(winner.name));
    }
    expect(await listeners()).toBe(before + 1);
    stop.abort();
    expect(await winner.running).toBe(0);
    expect(await listeners()).toBe(before);
    expect(storedNameOf()).toBe(winner.name);
  });

  it("fails a start that gave no name when another stores one first", async () => {
    const args = serve("--listen", "127.0.0.1:0").map((arg) => (arg === "DATA" ? data : arg));
    // The start reads the name unset before it first waits, to listen; another
    // start stores its name in that wait.
    const running = runCaptured(args);
    const db = Database.open(path.join(data, "agention.db"));
    try {
      storeName(db, "Work");
    } finally {
      db.close();
    }
    expect(await running).toEqual({
      code: 1,
      stdout: "",
      stderr:
        'agention serve: this server is named "Work" by a start that served first; start it again\n',
    });
  });

  it("sweeps before it listens, removing an upload a crash left unfinished", async () => {
    createDatabase(true, true);
    const files = () => {
      const db = new DatabaseSync(path.join(data, "agention.db"), { readOnly: true });
      try {
        return (db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    expect(files()).toBe(1);
    let release = () => {};
    firstSweep.held = new Promise((resolve) => (release = resolve));
    const stop = new AbortController();
    const stderr = capture();
    const running = run(["serve", "--data", data, "--origin", origin, "--listen", "127.0.0.1:0"], {
      stdout: capture(),
      stderr,
      stop: stop.signal,
      env: {},
    });
    const listening = () => /on http:\/\/127\.0\.0\.1:\d+/.test(stderr.text);
    try {
      for (let i = 0; i < 200 && files() > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The pass has run, and while it is held the server does not listen.
      expect(files()).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(listening()).toBe(false);
      release();
      for (let i = 0; i < 200 && !listening(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(listening()).toBe(true);
    } finally {
      firstSweep.held = Promise.resolve();
      release();
      stop.abort();
    }
    expect(await running).toBe(0);
  });

  it("stops promptly while a keep-alive client holds a long poll", async () => {
    const key = createDatabase(true);
    const stop = new AbortController();
    const { running, port } = await serving(stop.signal);
    const agent = new Agent({ keepAlive: true });
    try {
      const token = `Bearer ${await signedToken(key)}`;
      const poll = getJson(
        port,
        "/api/agent/s/builder/main/wait?wait=25",
        { authorization: token },
        agent,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stopped = Date.now();
      stop.abort();
      expect((await poll).status).toBe(200);
      expect(await running).toBe(0);
      expect(Date.now() - stopped).toBeLessThan(2000);
    } finally {
      agent.destroy();
    }
  });

  it("prints a link carrying its token in the fragment, and revokes the one before", async () => {
    createDatabase();
    const first = await runCaptured(link());
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/^https:\/\/agention\.test\/link#token=[\w-]{43}\n$/);
    const second = await runCaptured(link("--operator-name", "morgan"));
    expect(second.stdout).not.toBe(first.stdout);

    // Only the second remains, to create the operator it names.
    const db = Database.open(path.join(data, "agention.db"));
    try {
      expect(db.prepare("SELECT operator_name FROM passkey_links").all()).toEqual([
        { operator_name: "morgan" },
      ]);
    } finally {
      db.close();
    }
  });

  it("refuses a data directory with no database", async () => {
    const result = await runCaptured(link());
    expect(result.code).toBe(1);
    expect(existsSync(data)).toBe(false);
  });

  // The superuser can search any directory.
  it.skipIf(process.geteuid?.() === 0)(
    "refuses a data directory it cannot reach as it refuses an unsafe one",
    async () => {
      const locked = path.join(root, "locked");
      mkdirSync(locked, { mode: 0o700 });
      chmodSync(locked, 0o600);
      try {
        const args = serve("--listen", "127.0.0.1:0").map((arg) =>
          arg === "DATA" ? path.join(locked, "data") : arg,
        );
        const result = await runCaptured(args);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("(inaccessible)");
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  // auditLines waits until a sink's lines hold count events, and answers each
  // line's action.
  async function auditLines(read: () => string, count: number): Promise<string[]> {
    const actions = () =>
      read()
        .split("\n")
        .filter((line) => line !== "")
        .map(
          (line) => (JSON.parse(line) as { metadata: { event_code: string } }).metadata.event_code,
        );
    for (let i = 0; i < 200 && actions().length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return actions();
  }

  it("delivers the audit log to standard output and a file, writing nothing else to stdout", async () => {
    createDatabase(true);
    const audit = path.join(root, "audit");
    const stop = new AbortController();
    const { running, stdout } = await serving(stop.signal, "--audit-stdout", "--audit-dir", audit);
    const file = path.join(audit, "audit.jsonl");
    const recorded = ["register", "approveRegistration"];
    expect(await auditLines(() => stdout.text, 2)).toEqual(recorded);
    expect(await auditLines(() => (existsSync(file) ? readFileSync(file, "utf8") : ""), 2)).toEqual(
      recorded,
    );
    stop.abort();
    expect(await running).toBe(0);
    expect([statSync(audit).mode & 0o777, statSync(file).mode & 0o777]).toEqual([0o700, 0o600]);
  });

  it("keeps the cursor of a sink no longer configured until audit forget-sink removes it", async () => {
    createDatabase(true);
    const stop = new AbortController();
    const first = await serving(stop.signal, "--audit-stdout");
    expect(await auditLines(() => first.stdout.text, 2)).toHaveLength(2);
    stop.abort();
    expect(await first.running).toBe(0);

    const again = new AbortController();
    const second = await serving(again.signal);
    expect(second.stdout.text).toBe("");
    again.abort();
    expect(await second.running).toBe(0);
    const cursors = () => {
      const db = new DatabaseSync(path.join(data, "agention.db"));
      try {
        return db.prepare("SELECT name, delivered_seq FROM audit_sinks").all();
      } finally {
        db.close();
      }
    };
    expect(cursors()).toEqual([{ name: "stdout", delivered_seq: 2 }]);

    const forget = ["audit", "forget-sink", "--data", data, "stdout"];
    expect((await runCaptured(forget)).code).toBe(0);
    expect((await runCaptured(forget)).code).toBe(2);
    expect(cursors()).toEqual([]);
    const db = new DatabaseSync(path.join(data, "agention.db"));
    try {
      expect(
        db.prepare("SELECT action, credential_kind FROM audit_events ORDER BY seq").all(),
      ).toEqual([
        { action: "register", credential_kind: "registration" },
        { action: "approveRegistration", credential_kind: "browser_session" },
        { action: "forgetSink", credential_kind: "cli" },
      ]);
    } finally {
      db.close();
    }
  });

  it("shares the audit directory with the group --audit-group names", async () => {
    // A group this user is in, by the name the system's group database gives
    // it.
    const gid =
      process.getgroups?.().find((each) => each !== process.getegid?.()) ?? process.getegid?.();
    const name = execFileSync("getent", ["group", String(gid)], { encoding: "utf8" }).split(":")[0];
    const audit = path.join(root, "audit");
    const stop = new AbortController();
    const { running } = await serving(
      stop.signal,
      "--audit-dir",
      audit,
      "--audit-group",
      name ?? "",
    );
    stop.abort();
    expect(await running).toBe(0);
    const file = path.join(audit, "audit.jsonl");
    expect([statSync(audit).mode & 0o777, statSync(audit).gid]).toEqual([0o750, gid]);
    expect([statSync(file).mode & 0o777, statSync(file).gid]).toEqual([0o640, gid]);
  });

  it("refuses an audit directory others can reach, changing nothing", async () => {
    const audit = path.join(root, "audit");
    mkdirSync(audit, { mode: 0o755 });
    chmodSync(audit, 0o755);
    const args = serve("--listen", "127.0.0.1:0", "--audit-dir", audit).map((arg) =>
      arg === "DATA" ? data : arg,
    );
    const result = await runCaptured(args);
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining("--audit-dir")]);
    expect(statSync(audit).mode & 0o777).toBe(0o755);
    // The directory is refused before the database is opened.
    expect(existsSync(path.join(data, "agention.db"))).toBe(false);
  });

  it("delivers to a new sink what retention would remove, before removing it", async () => {
    const db = Database.open(path.join(data, "agention.db"));
    try {
      issuePasskeyLink(createStore(db, { clock: () => Date.now() - 400 * 24 * 60 * 60_000 }), "op");
    } finally {
      db.close();
    }
    const stop = new AbortController();
    const { running, stdout } = await serving(stop.signal, "--audit-stdout");
    expect(await auditLines(() => stdout.text, 1)).toEqual(["issuePasskeyLink"]);
    stop.abort();
    expect(await running).toBe(0);
  });

  it("refuses --operator-name once the operator exists", async () => {
    createDatabase(true);
    expect((await runCaptured(link("--operator-name", "other"))).code).toBe(2);
    expect((await runCaptured(link())).code).toBe(0);
  });
});

describe("agention backup", () => {
  let root: string;
  let data: string;

  beforeEach(() => {
    root = testDirectory("cli");
    data = path.join(root, "data");
  });

  it("writes a copy of the database, and prints where", async () => {
    Database.open(path.join(data, "agention.db")).close();
    const copy = path.join(root, "copy.db");
    const result = await runCaptured(["backup", "--data", data, copy]);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout.startsWith(`${copy}:`)).toBe(true);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
  });

  it("fails, writing nothing, when there is no database or the copy exists", async () => {
    const copy = path.join(root, "copy.db");
    const missing = await runCaptured(["backup", "--data", data, copy]);
    expect([missing.code, missing.stdout, existsSync(copy)]).toEqual([1, "", false]);
    expect(missing.stderr).not.toBe("");

    Database.open(path.join(data, "agention.db")).close();
    writeFileSync(copy, "", { mode: 0o600 });
    const existing = await runCaptured(["backup", "--data", data, copy]);
    expect([existing.code, existing.stdout]).toEqual([1, ""]);
  });

  it.each([
    ["no file", ["--data", "DATA"]],
    ["two files", ["--data", "DATA", "one.db", "two.db"]],
    ["no data directory", ["copy.db"]],
  ])("rejects %s with a usage error", async (_, args) => {
    const result = await runCaptured([
      "backup",
      ...args.map((arg) => (arg === "DATA" ? data : arg)),
    ]);
    expect([result.code, result.stdout]).toEqual([2, ""]);
  });
});

// signedToken mints a token as the bridge does, for the test origin.
function signedToken(key: AgentKey | undefined): Promise<string> {
  if (key === undefined) {
    throw new Error("no agent key");
  }
  return new SignJWT({ aud: origin, exp: Math.floor(Date.now() / 1000) + 120 })
    .setProtectedHeader({ alg: "EdDSA", kid: key.publicKey })
    .sign(key.privateKey);
}
