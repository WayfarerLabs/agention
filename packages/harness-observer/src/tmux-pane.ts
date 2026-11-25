import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Pane, Snapshot } from "./pane.ts";

const run = promisify(execFile);

export interface TmuxPaneOptions {
  // The tmux command, found on PATH unless it is a path; "tmux" by default.
  readonly tmux?: string;
  // Where Linux's process information is mounted; "/proc" by default.
  readonly proc?: string;
}

// The pane's formats, on the first line of a reading.
const paneFormat = [
  "pane_pid",
  "pane_dead",
  "pane_width",
  "pane_height",
  "cursor_x",
  "cursor_y",
  "cursor_flag",
]
  .map((name) => `#{${name}}`)
  .join(" ");

// The line that ends what tmux itself prints and starts the screen. Nothing
// before it can be this line, so the screen cannot imitate the fields above.
const screenStart = "screen";

// TmuxPane reads the one pane of the tmux server at a socket path. It runs
// the tmux client directly, never through a shell, and without TMUX or
// TMUX_PANE, so a tmux the caller happens to run in never picks the pane: the
// socket is the caller's to name.
export class TmuxPane implements Pane {
  readonly #socket: string;
  readonly #tmux: string;
  readonly #proc: string;

  constructor(socket: string, options: TmuxPaneOptions = {}) {
    this.#socket = socket;
    this.#tmux = options.tmux ?? "tmux";
    this.#proc = options.proc ?? "/proc";
  }

  // snapshot reads the pane with one tmux client call, and the pane process's
  // terminal from /proc. It rejects when tmux cannot be run, cannot reach the
  // server, or prints what it should not; a missing /proc reads as the
  // harness not holding the terminal.
  async snapshot(): Promise<Snapshot> {
    const stdout = await this.#run([
      "display-message",
      "-p",
      paneFormat,
      ";",
      "list-panes",
      "-a",
      "-F",
      "pane",
      ";",
      "display-message",
      "-p",
      screenStart,
      ";",
      "capture-pane",
      "-p",
    ]);
    const at = Date.now();
    const output = stdout.endsWith("\n") ? stdout.slice(0, -1).split("\n") : stdout.split("\n");
    const start = output.indexOf(screenStart);
    const fields = /^(\d+) ([01]) (\d+) (\d+) (\d+) (\d+) ([01])$/.exec(output[0] ?? "");
    if (fields === null || start < 0) {
      throw new Error(`tmux at ${this.#socket} printed an unexpected reading`);
    }
    const [pid, dead, width, height, x, y, visible] = fields.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    let panes = 0;
    for (const line of output.slice(1, start)) {
      if (line !== "pane") {
        throw new Error(`tmux at ${this.#socket} printed an unexpected reading`);
      }
      panes++;
    }
    const lines = output.slice(start + 1, start + 1 + height);
    while (lines.length < height) {
      lines.push("");
    }
    return {
      lines,
      width,
      cursor: { x, y, visible: visible === 1 },
      hostHasTerminal: dead === 0 && (await this.#leadsForeground(pid)),
      onePane: panes === 1,
      at,
    };
  }

  // run runs one tmux client call on the socket and returns what it printed.
  // An error carries what tmux said, which names the socket, never the pane's
  // text.
  async #run(args: readonly string[]): Promise<string> {
    try {
      const { TMUX: _tmux, TMUX_PANE: _pane, ...env } = process.env;
      const { stdout } = await run(this.#tmux, ["-S", this.#socket, ...args], {
        env,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const said = (error as { stderr?: unknown }).stderr;
      const reason = typeof said === "string" && said.trim() !== "" ? said.trim() : String(error);
      throw new Error(`tmux at ${this.#socket} failed: ${reason}`, { cause: error });
    }
  }

  // leadsForeground reports whether a process leads its process group and
  // that group is its terminal's foreground group, from /proc/<pid>/stat.
  async #leadsForeground(pid: number): Promise<boolean> {
    let stat: string;
    try {
      stat = await readFile(`${this.#proc}/${pid}/stat`, "utf8");
    } catch {
      return false;
    }
    // The command name, in parentheses, may hold spaces and parentheses, so
    // the fields are read after the last ")": state, ppid, pgrp, session,
    // tty_nr and tpgid.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(" ");
    const pgrp = Number(fields[2]);
    const tpgid = Number(fields[5]);
    return pgrp === pid && tpgid === pid;
  }
}
