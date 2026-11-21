import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { canonicalOrigin } from "@wayfarerlabs/agention-api";
import { homedir } from "node:os";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { AgentApi } from "./agent-api.ts";
import { type ConnectAddress, parseConnectAddress } from "./connect-address.ts";
import { settingProblem } from "./errors.ts";
import { Session, type SessionEnvironment } from "./session.ts";
import { type Connection, registerTools } from "./tools.ts";

// The variables the bridge reads: the server's origin and where to open
// connections to it, the names of the session an agent host runs, which
// register's arguments override, and Node's switch for skipping certificate
// checks, which the bridge refuses.
export interface BridgeEnvironment extends SessionEnvironment {
  AGENTION_URL?: string | undefined;
  AGENTION_CONNECT?: string | undefined;
  NODE_TLS_REJECT_UNAUTHORIZED?: string | undefined;
}

export interface BridgeOptions {
  environment: BridgeEnvironment;
  // The home directory, under which the session's key lives.
  home: string;
  // The clock tokens are minted by, in Unix milliseconds.
  clock?: () => number;
}

// The skill's first rule, which the bridge gives every agent host when it
// connects, so the agent has it before the plugin's skill loads. Codex shows
// only the first 250 characters until the agent loads the tools, so it stays
// within that.
export const instructions =
  "Ask your user every question, decision or approval in Agention, and never wait at your " +
  "terminal for an answer: no question tool that waits (AskUserQuestion, request_user_input), " +
  "no ending your turn to wait. Load the agention skill first.";

// createBridge builds the bridge's MCP server for one agent session. A setting
// the bridge cannot work with does not stop it: every tool answers with what
// the operator must change, so the agent can tell them.
export function createBridge(options: BridgeOptions): McpServer {
  const server = new McpServer(
    { name: "agention", version: packageJson.version },
    { capabilities: { tools: {} }, instructions },
  );
  registerTools(server, connect(options));
  return server;
}

function connect(options: BridgeOptions): Connection {
  const { environment, home } = options;
  // Tokens and message text never cross TLS the bridge has not verified.
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    return {
      problem: settingProblem(
        "NODE_TLS_REJECT_UNAUTHORIZED is 0, and the bridge sends its tokens and message text " +
          "only over TLS whose certificate Node has verified",
        "unset NODE_TLS_REJECT_UNAUTHORIZED",
      ),
    };
  }
  // The key file's path appears in messages, so a home no file system would
  // take is refused before it can make one long.
  if (home === "" || !path.isAbsolute(home) || Buffer.byteLength(home) > 4096) {
    return {
      problem: settingProblem(
        "HOME is not an absolute directory of at most 4,096 bytes, under which the bridge keeps " +
          "the session's key",
        "set HOME to an absolute directory of at most 4,096 bytes",
      ),
    };
  }
  const url = environment.AGENTION_URL;
  if (url === undefined || url === "") {
    return {
      problem: settingProblem(
        "AGENTION_URL is not set",
        "set AGENTION_URL to the Agention server's origin, such as https://agention.example.com",
      ),
    };
  }
  let origin: string;
  try {
    origin = canonicalOrigin(url);
  } catch (error) {
    return {
      problem: settingProblem(
        `AGENTION_URL ${(error as Error).message}`,
        "set AGENTION_URL to the Agention server's origin",
      ),
    };
  }
  // An empty AGENTION_CONNECT counts as unset, as an empty AGENTION_URL
  // does, so one passed along empty connects at the origin's host.
  const connectSetting = environment.AGENTION_CONNECT;
  let connectAddress: ConnectAddress | undefined;
  if (connectSetting !== undefined && connectSetting !== "") {
    try {
      connectAddress = parseConnectAddress(connectSetting);
    } catch (error) {
      return {
        problem: settingProblem(
          `AGENTION_CONNECT ${(error as Error).message}`,
          "set AGENTION_CONNECT to the host and port the bridge connects to in place of the " +
            "origin's, such as a tunnel's 127.0.0.1:8443, or unset it",
        ),
      };
    }
  }
  const api = new AgentApi({ origin, connectAddress, clock: options.clock ?? Date.now });
  return { api, session: new Session({ api, home, environment }) };
}

// serveStdio runs the bridge for the agent host that started this process,
// on its standard input and output, and resolves once the host closes them.
// It serves the protocol revisions hosts negotiate with initialize.
export async function serveStdio(): Promise<void> {
  const server = createBridge({ environment: process.env, home: homedir() });
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new StdioServerTransport());
  await closed;
}
