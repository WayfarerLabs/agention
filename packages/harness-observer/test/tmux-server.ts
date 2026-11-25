import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// The command that runs the scripted harness in a pane.
export const scriptedHarness = [
  process.execPath,
  "--no-warnings",
  path.join(import.meta.dirname, "scripted-harness.ts"),
];

// The longest path a Unix socket can have on Linux, in bytes.
const longestSocketPath = 107;

// A tmux server of a test's own, with no configuration, in a temporary
// directory with a short path, since a Unix socket's path is limited to 107
// bytes. A test kills it when it finishes, pass or fail, which also removes
// the directory.
export class TmuxServer {
  readonly directory: string;
  readonly socket: string;
  readonly #clients: ChildProcess[] = [];

  private constructor(directory: string) {
    this.directory = directory;
    this.socket = path.join(directory, "s");
  }

  // start starts a server whose one pane runs a command, 80 columns by 12 rows.
  // It fails at once, saying why, where TMPDIR is too long for the socket.
  static async start(command: readonly string[]): Promise<TmuxServer> {
    const server = new TmuxServer(mkdtempSync(path.join(tmpdir(), "ho-")));
    if (Buffer.byteLength(server.socket) > longestSocketPath) {
      await server.kill();
      throw new Error(
        `a tmux socket at ${server.socket} would be longer than ${longestSocketPath} bytes: ` +
          "run the tests with a shorter TMPDIR",
      );
    }
    try {
      await server.tmux(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-x",
        "80",
        "-y",
        "12",
        "--",
        ...command,
      );
    } catch (error) {
      await server.kill();
      throw error;
    }
    return server;
  }

  // tmux runs a tmux client command on this server, never through a shell.
  async tmux(...args: string[]): Promise<string> {
    const { TMUX: _tmux, TMUX_PANE: _pane, ...env } = process.env;
    const { stdout } = await run("tmux", ["-S", this.socket, ...args], { encoding: "utf8", env });
    return stdout;
  }

  // keys sends keys to the pane, as tmux's send-keys names them.
  async keys(...keys: string[]): Promise<void> {
    await this.tmux("send-keys", ...keys);
  }

  // attach attaches a client to the server through a terminal of its own,
  // as an operator's terminal does, using util-linux's script for the
  // terminal, and returns a function that types into it. The client is
  // killed with the server.
  async attach(): Promise<(keys: string) => void> {
    const { TMUX: _tmux, TMUX_PANE: _pane, ...env } = process.env;
    const command = `tmux -S '${this.socket}' attach`;
    const client = spawn("script", ["--quiet", "--flush", "--command", command, "/dev/null"], {
      env: { ...env, TERM: "xterm" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    this.#clients.push(client);
    const deadline = Date.now() + 5000;
    while ((await this.tmux("list-clients")).trim() === "") {
      if (Date.now() > deadline) {
        throw new Error("the client never attached");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return (keys) => client.stdin!.write(keys);
  }

  // kill ends the server, if it still runs, and its clients, and removes its
  // directory.
  async kill(): Promise<void> {
    for (const client of this.#clients) {
      client.kill();
    }
    try {
      await this.tmux("kill-server");
    } catch {
      // Already gone.
    }
    rmSync(this.directory, { recursive: true, force: true });
  }
}
