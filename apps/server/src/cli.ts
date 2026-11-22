// esbuild copies this import into the bundle, so a built server carries the
// version it was built at.
import packageJson from "../package.json" with { type: "json" };
import { canonicalOrigin, name, quoted } from "@wayfarerlabs/agention-api";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { issuePasskeyLink, passkeyLinkLifetime } from "./auth/passkey-links.ts";
import { BackupError, backupDatabase } from "./database/backup.ts";
import { Database, DatabaseOpenError } from "./database/database.ts";
import { createApp, securityHeaderValues } from "./http/app.ts";
import { ListenerConfigError, listen, planListener } from "./http/listener.ts";
import {
  createStore,
  findOperator,
  serverName,
  storedName,
  storeName,
  sweepFilesRegularly,
} from "./store/index.ts";
import { readVoiceEnvironment, VoiceEnvironmentError } from "./transcription/environment.ts";

const usage = `Usage: agention <command> [options]

Commands:
  serve         Run the server
  passkey-link  Print a one-use link that registers the operator's passkeys
  backup        Write a consistent copy of the server's database
  version       Print the Agention version

Run agention <command> --help for a command's options.

Options:
  -h, --help  Print this help
`;

const serveUsage = `Usage: agention serve --data DIR --origin URL [options]

Options:
  --data DIR          The data directory, private to this user
  --origin URL        The HTTPS origin people and agents reach the server at
  --listen ADDR       The IP address and port to listen on (default 127.0.0.1:8080)
  --tls-cert FILE     The TLS certificate chain, in PEM; needs --tls-key
  --tls-key FILE      The TLS private key, in PEM; needs --tls-cert
  --allow-plain-http  Allow plain HTTP on a non-loopback address
  --quiet-minutes N   Minutes, 1 to 10080, after which a session not seen is
                      quiet (default 15)
  --name NAME         The server's name, 1 to 40 characters, which its web UI
                      shows as its title and its passkeys carry; set by the
                      first start that serves (default Agention), and never
                      changed after
  --api-docs          Serve the API's documentation, without sign-in, at
                      /docs/api/ and its OpenAPI document at
                      /docs/api/openapi.json
  -h, --help          Print this help

Environment, read once at start, each optional; each supplies one field of
Settings' voice exactly as entering it there would, and Settings show it as
set by the server's environment:
  AGENTION_TRANSCRIPTION_URL    The transcription provider's base URL
  AGENTION_TRANSCRIPTION_MODEL  The provider's model
  AGENTION_TRANSCRIPTION_KEY    The provider's key; needs
                                AGENTION_TRANSCRIPTION_URL
`;

const passkeyLinkUsage = `Usage: agention passkey-link --data DIR --origin URL [--operator-name NAME]

The first link creates the operator; each later one replaces the operator's
passkeys and signs out their browsers. Issuing one revokes every unused link.
To add a passkey beside the others, use Settings in the web UI instead.

Options:
  --data DIR            The server's data directory
  --origin URL          The server's HTTPS origin, as given to agention serve
  --operator-name NAME  The operator's name, for the link that creates them
                        (default operator)
  -h, --help            Print this help
`;

const backupUsage = `Usage: agention backup --data DIR FILE

Writes a consistent copy of the database in the data directory to FILE,
whether the server is running or not, and checks it. It never changes what
the database holds; SQLite may leave an empty -wal and a -shm file beside a
database no server has open. FILE must not exist, nor be a file SQLite keeps
beside the database, and its directory must belong to this user
with mode 0700, since the copy holds the instance's key and the passkeys'
records. The copy is created with mode 0600.

To restore a copy, stop the server, move agention.db and its -wal and -shm
files out of the data directory, copy the backup in as agention.db with
mode 0600, and start the server.

Options:
  --data DIR  The server's data directory
  -h, --help  Print this help
`;

// Usage errors exit with a different code than failures, so scripts can tell a
// mistyped command from one that ran and failed.
const exitOK = 0;
const exitFailure = 1;
const exitUsage = 2;

export interface Output {
  write(text: string): unknown;
}

export interface Io {
  stdout: Output;
  stderr: Output;
  // Aborts when the process is asked to stop, which ends agention serve.
  stop: AbortSignal;
  // The process's environment, which agention serve reads its voice
  // settings from.
  env: Readonly<Record<string, string | undefined>>;
}

// The web UI's build, which the server package carries beside the directory
// holding this module: dist/ once built, src/ when run from source.
const webDirectory = fileURLToPath(new URL("../web/", import.meta.url));

const isHelp = (arg: string | undefined) => arg === "-h" || arg === "--help";

// A command-line mistake, reported as a usage error.
class UsageError extends Error {}

type Command = (args: string[], io: Io) => Promise<number>;

// Each command, with its help text.
const commands = new Map<string, [string, Command]>([
  ["serve", [serveUsage, serve]],
  ["passkey-link", [passkeyLinkUsage, passkeyLink]],
  ["backup", [backupUsage, backup]],
  ["version", [usage, version]],
]);

// run dispatches a command line and returns the process exit code. Data goes
// to stdout; diagnostics go to stderr.
export async function run(args: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined) {
    io.stderr.write(usage);
    return exitUsage;
  }
  if (isHelp(command)) {
    io.stdout.write(usage);
    return exitOK;
  }
  const entry = commands.get(command);
  if (entry === undefined) {
    io.stderr.write(`agention: unknown command ${JSON.stringify(command)}\n\n${usage}`);
    return exitUsage;
  }
  const [help, handler] = entry;
  if (isHelp(rest[0])) {
    io.stdout.write(help);
    return exitOK;
  }
  try {
    return await handler(rest, io);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ListenerConfigError ||
      error instanceof VoiceEnvironmentError
    ) {
      io.stderr.write(`agention ${command}: ${error.message}\n`);
      return exitUsage;
    }
    if (error instanceof DatabaseOpenError) {
      io.stderr.write(`agention ${command}: ${error.message} (${error.reason})\n`);
      return exitFailure;
    }
    if (error instanceof BackupError) {
      io.stderr.write(`agention ${command}: ${error.message}\n`);
      return exitFailure;
    }
    throw error;
  }
}

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T) {
  return parseWithPositionals(args, options, 0).values;
}

// parseWithPositionals reads options and exactly the number of positional
// arguments given.
function parseWithPositionals<T extends NonNullable<ParseArgsConfig["options"]>>(
  args: string[],
  options: T,
  count: number,
) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: count > 0 });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (parsed.positionals.length > count) {
    throw new UsageError(`unexpected argument ${JSON.stringify(parsed.positionals[count])}`);
  }
  return parsed;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new UsageError(`${flag} is required`);
  }
  return value;
}

function originFlag(value: string | undefined): string {
  try {
    return canonicalOrigin(required(value, "--origin"));
  } catch (error) {
    throw new UsageError(`--origin: ${(error as Error).message}`);
  }
}

const databaseFile = (data: string) => path.join(data, "agention.db");

// serverLog writes what the server logs, the database's open and the routes'
// failures among it, to stderr, a line each, under the prefix every line of
// the server's own carries.
const serverLog = (io: Io) => (message: string) => io.stderr.write(`agention: ${message}\n`);

// The bounds of --quiet-minutes: a minute, since last seen is kept to the
// minute, up to a week.
const quietMinutes = { min: 1, max: 10_080 };

// quietAfterFlag reads --quiet-minutes as the time in milliseconds after
// which a session not seen is quiet.
function quietAfterFlag(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const minutes = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!(minutes >= quietMinutes.min && minutes <= quietMinutes.max)) {
    throw new UsageError(
      `--quiet-minutes must be a whole number from ${quietMinutes.min} to ${quietMinutes.max}`,
    );
  }
  return minutes * 60_000;
}

// nameFlag reads --name, the server's name, which the first start to serve
// stores and every later one may leave out or repeat.
function nameFlag(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const named = serverName.safeParse(value);
  if (!named.success) {
    throw new UsageError(`--name ${named.error.issues[0]?.message ?? "is not a name"}`);
  }
  return named.data;
}

// renamed refuses a start whose name differs from the one the server keeps.
function renamed(kept: string): UsageError {
  return new UsageError(
    `--name: this server is named ${quoted(kept)}, and a server's name never changes; ` +
      "leave --name out or give that name",
  );
}

async function version(args: string[], io: Io): Promise<number> {
  if (args.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(args[0])}`);
  }
  io.stdout.write(`agention ${packageJson.version}\n`);
  return exitOK;
}

async function serve(args: string[], io: Io): Promise<number> {
  const flags = parse(args, {
    data: { type: "string" },
    origin: { type: "string" },
    listen: { type: "string", default: "127.0.0.1:8080" },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    "allow-plain-http": { type: "boolean", default: false },
    "quiet-minutes": { type: "string" },
    name: { type: "string" },
    "api-docs": { type: "boolean", default: false },
  });
  const data = required(flags.data, "--data");
  const origin = originFlag(flags.origin);
  const quietAfter = quietAfterFlag(flags["quiet-minutes"]);
  const givenName = nameFlag(flags.name);
  const voiceEnvironment = readVoiceEnvironment(io.env);
  const plan = planListener({
    listen: flags.listen,
    tlsCert: flags["tls-cert"],
    tlsKey: flags["tls-key"],
    allowPlainHttp: flags["allow-plain-http"],
  });
  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (plan.tls !== undefined) {
    try {
      tls = { cert: readFileSync(plan.tls.certFile), key: readFileSync(plan.tls.keyFile) };
    } catch (error) {
      io.stderr.write(`agention serve: cannot read the TLS files: ${(error as Error).message}\n`);
      return exitFailure;
    }
  }

  const log = serverLog(io);
  const db = Database.open(databaseFile(data), { log });
  const shutdown = new AbortController();
  let sweeps: ReturnType<typeof sweepFilesRegularly> | undefined;
  try {
    // The server's name is the stored one or, on a new database, the one
    // given, Agention without one. A later start may repeat it but never
    // change it.
    const stored = storedName(db);
    if (stored !== undefined && givenName !== undefined && givenName !== stored) {
      throw renamed(stored);
    }
    const name = stored ?? givenName ?? "Agention";
    const store = createStore(db, quietAfter === undefined ? {} : { quietAfter });
    // Before the server listens, no upload is arriving, so the first sweep
    // removes every one a crash or a failed abort left unfinished.
    sweeps = sweepFilesRegularly(store, log);
    await sweeps.first;
    const app = createApp({
      store,
      origin,
      name,
      webRoot: webDirectory,
      voiceEnvironment,
      shutdown: shutdown.signal,
      log,
      apiDocs: flags["api-docs"],
    });
    let listening;
    try {
      listening = await listen(app, plan.address, tls, () => securityHeaderValues(origin));
    } catch (error) {
      io.stderr.write(
        `agention serve: cannot listen on ${flags.listen}: ${(error as Error).message}\n`,
      );
      return exitFailure;
    }
    try {
      // The name is stored only once the server is listening, so a start that
      // fails before serving leaves it unset. Of starts racing to serve a new
      // database, the first to store its name keeps it; one with the same name
      // serves too, and one with another stops.
      const kept = storeName(db, name);
      if (kept !== name) {
        // A start that gave another name is refused for it; one that gave
        // none made no usage error, and fails.
        if (givenName !== undefined) {
          throw renamed(kept);
        }
        io.stderr.write(
          `agention serve: this server is named ${quoted(kept)} by a start that served first; ` +
            "start it again\n",
        );
        return exitFailure;
      }
      const { host, port } = listening.address;
      const scheme = tls === undefined ? "http" : "https";
      io.stderr.write(
        `agention: serving ${origin} on ${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}\n`,
      );
      if (!io.stop.aborted) {
        await new Promise((resolve) => io.stop.addEventListener("abort", resolve, { once: true }));
      }
      io.stderr.write("agention: shutting down\n");
    } finally {
      shutdown.abort();
      await listening.close();
    }
    return exitOK;
  } finally {
    await sweeps?.stop();
    db.close();
  }
}

async function passkeyLink(args: string[], io: Io): Promise<number> {
  const flags = parse(args, {
    data: { type: "string" },
    origin: { type: "string" },
    "operator-name": { type: "string" },
  });
  const data = required(flags.data, "--data");
  const origin = originFlag(flags.origin);
  const operatorName = flags["operator-name"] ?? "operator";
  const named = name.safeParse(operatorName);
  if (!named.success) {
    throw new UsageError(`--operator-name ${named.error.issues[0]?.message ?? "is not a name"}`);
  }
  // agention serve creates the database; a link in a database it never opens
  // would be no use.
  if (!existsSync(databaseFile(data))) {
    io.stderr.write(
      `agention passkey-link: ${data} holds no Agention database; start agention serve ` +
        "with it first, or check --data\n",
    );
    return exitFailure;
  }
  const db = Database.open(databaseFile(data), { log: serverLog(io) });
  try {
    const operator = findOperator(db);
    if (operator !== undefined && flags["operator-name"] !== undefined) {
      throw new UsageError(
        `the operator already exists as ${operator.name}; --operator-name applies only to the first link`,
      );
    }
    const token = issuePasskeyLink(createStore(db), operatorName);
    io.stdout.write(`${origin}/link#token=${token}\n`);
    io.stderr.write(
      `Open this link within ${passkeyLinkLifetime / 60_000} minutes; it works once. ` +
        (operator === undefined
          ? `It creates the operator, named ${operatorName}, with a passkey.\n`
          : `It replaces ${operator.name}'s passkeys and signs out their browsers.\n`) +
        "Anyone with the link can register a passkey, so keep it private.\n",
    );
    return exitOK;
  } finally {
    db.close();
  }
}

async function backup(args: string[], io: Io): Promise<number> {
  const { values: flags, positionals } = parseWithPositionals(
    args,
    { data: { type: "string" } },
    1,
  );
  const data = required(flags.data, "--data");
  const [file] = positionals;
  if (file === undefined || file === "") {
    throw new UsageError("name the FILE to write the backup to");
  }
  const result = await backupDatabase(databaseFile(data), file);
  io.stdout.write(
    `${result.file}: ${result.bytes} bytes, schema version ${result.schemaVersion}\n`,
  );
  return exitOK;
}
