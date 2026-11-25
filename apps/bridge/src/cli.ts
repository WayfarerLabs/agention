import { profileNames } from "@wayfarerlabs/agention-harness-observer";
import { parseArgs } from "node:util";
// esbuild copies this import into the bundle, so a built bridge carries the
// version it was built at.
import packageJson from "../package.json" with { type: "json" };
import type { MonitoringOptions } from "./monitoring.ts";

const usage = `Usage: agention-mcp [--tmux-socket PATH] [--harness-profile NAME] [--nudge TYPE]
       agention-mcp --version | --help

Without --version or --help, runs the Agention agent bridge: an MCP server on
standard input and output, for an agent host such as Claude Code or Codex to
start. It reaches the Agention server at the origin in AGENTION_URL, opening
its connections at the host and port in AGENTION_CONNECT when that is set,
and serves the session that register names, else the one AGENTWORKS_AGENT
and AGENTWORKS_SESSION name.

Once the session is approved, the bridge reports to the server that it is
connected, and monitors the session's terminal when it is given the socket of
the tmux server the agent host runs in, whose one pane it reads, on Linux with
tmux 3.3 or later: what it reports is the session's condition, such as running
or at its prompt, never the screen's text. With the nudge on, and the terminal
read with the agent host's own profile, never a generic one, it also nudges
the agent at its prompt when the operator writes and the agent has not
checked in since: it shows a warning the operator can type over to stop it,
then submits one fixed message telling the agent to check in. An option wins
over its variable.

Options:
  --tmux-socket PATH      The tmux server's socket; by default
                          AGENTION_TMUX_SOCKET, and without either the bridge
                          monitors no terminal
  --harness-profile NAME  How to read the terminal: auto, the default, for
                          the agent host the bridge runs under, or one of
                          ${profileNames.join(", ")};
                          by default AGENTION_HARNESS_PROFILE
  --nudge TYPE            Turn the nudge on: tmux, the one type, which types
                          into the pane --tmux-socket names; by default
                          AGENTION_NUDGE, and without either the nudge is off
  --version               Print the version
  -h, --help              Print this help
`;

const exitOK = 0;
const exitUsage = 2;

export interface Output {
  write(text: string): unknown;
}

export interface Io {
  stdout: Output;
  stderr: Output;
  // Runs the bridge on standard input and output until the host closes them,
  // with the command line's monitoring options.
  serve(options: MonitoringOptions): Promise<void>;
}

// run handles a command line and returns the process exit code. Data goes to
// stdout; diagnostics go to stderr. Serving owns stdout, so only the options
// that print and exit write to it.
export async function run(args: readonly string[], io: Io): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        "tmux-socket": { type: "string" },
        "harness-profile": { type: "string" },
        nudge: { type: "string" },
      },
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
  await io.serve({
    tmuxSocket: values["tmux-socket"],
    harnessProfile: values["harness-profile"],
    nudge: values.nudge,
  });
  return exitOK;
}
