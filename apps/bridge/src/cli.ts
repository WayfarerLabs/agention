import { parseArgs } from "node:util";
// esbuild copies this import into the bundle, so a built bridge carries the
// version it was built at.
import packageJson from "../package.json" with { type: "json" };

const usage = `Usage: agention-mcp [--version | --help]

Without options, runs the Agention agent bridge: an MCP server on standard
input and output, for an agent host such as Claude Code or Codex to start. It
reaches the Agention server at the origin in AGENTION_URL, opening its
connections at the host and port in AGENTION_CONNECT when that is set, and
serves the session that register names, else the one AGENTWORKS_AGENT and
AGENTWORKS_SESSION name.

Options:
  --version   Print the version
  -h, --help  Print this help
`;

const exitOK = 0;
const exitUsage = 2;

export interface Output {
  write(text: string): unknown;
}

export interface Io {
  stdout: Output;
  stderr: Output;
  // Runs the bridge on standard input and output until the host closes them.
  serve(): Promise<void>;
}

// run handles a command line and returns the process exit code. Data goes to
// stdout; diagnostics go to stderr. Serving owns stdout, so only the options
// that print and exit write to it.
export async function run(args: readonly string[], io: Io): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { version: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    }));
  } catch (error) {
    io.stderr.write(`agention-mcp: ${(error as Error).message}\n\n${usage}`);
    return exitUsage;
  }
  if (values.help) {
    io.stdout.write(usage);
    return exitOK;
  }
  if (values.version) {
    io.stdout.write(`agention-mcp ${packageJson.version}\n`);
    return exitOK;
  }
  await io.serve();
  return exitOK;
}
