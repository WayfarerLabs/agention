import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { SignJWT } from "jose";
import { Agent, get } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { run } from "./cli.ts";
import { Database } from "./database/database.ts";
import { openBrowserSession } from "./auth/browser-sessions.ts";
import { hashOfSecret } from "./auth/secrets.ts";
import { type AgentKey, newAgentKey } from "./http/test-harness.ts";
import { identityForBrowserSession } from "./identity.ts";
import { insertTestPasskey } from "./store/test-fixture.ts";
import {
  approveRegistration,
  createStore,
  findRegistrationByKey,
  insertOperator,
  storedName,
  storeName,
  submitRegistration,
} from "./store/index.ts";

function capture() {
  return {
    text: "",
    write(text: string) {
      this.text += text;
    },
  };
}

async function runCaptured(args: string[], stop = new AbortController().signal) {
  const stdout = capture();
  const stderr = capture();
  const code = await run(args, { stdout, stderr, stop });
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
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-cli-")));
    data = path.join(root, "data");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
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
  // and an approved agent when asked, and returns the agent's key.
  function createDatabase(withAgent = false): AgentKey | undefined {
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
      const identity = identityForBrowserSession(db, hashOfSecret(token) ?? Buffer.alloc(0));
      const key = newAgentKey();
      submitRegistration(store, key.publicKey, { agent: "builder", session: "main" });
      approveRegistration(
        store,
        identity ?? (undefined as never),
        findRegistrationByKey(db, key.publicKey)?.id ?? 0,
        { agent: { name: "builder", existing: false }, session: { name: "main", existing: false } },
      );
      return key;
    } finally {
      db.close();
    }
  }

  // serving runs agention serve on a free loopback port until stop aborts,
  // with any further flags given.
  async function serving(stop: AbortSignal, ...flags: string[]) {
    const stderr = capture();
    const running = run(
      ["serve", "--data", data, "--origin", `${origin}/`, "--listen", "127.0.0.1:0", ...flags],
      { stdout: capture(), stderr, stop },
    );
    let port: number | undefined;
    for (let i = 0; i < 200 && port === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const match = /on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr.text)?.[1];
      port = match === undefined ? undefined : Number(match);
    }
    return { running, port: port ?? 0 };
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
  ])("refuses %s before touching the data directory", async (_, args) => {
    const result = await runCaptured(args.map((arg) => (arg === "DATA" ? data : arg)));
    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe("");
    expect(existsSync(data)).toBe(false);
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
        { stdout: capture(), stderr, stop: stop.signal },
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
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-cli-")));
    data = path.join(root, "data");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
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
