import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { type Key, type Pane, PaneUnusable, refusePaste, type Snapshot } from "./pane.ts";

export interface TmuxPaneOptions {
  // The tmux command, found on PATH unless it is a path; "tmux" by default.
  readonly tmux?: string;
  // Where Linux's process information is mounted; "/proc" by default.
  readonly proc?: string;
  // A process the pane's first process must be an ancestor of, such as the
  // reader's own, so a socket that names some other pane is refused rather
  // than read. Unset, any pane is read.
  readonly requireAncestorOf?: number;
}

// The pane's formats, on the first line of a reading.
const paneFormats = [
  "pane_pid",
  "pane_dead",
  "pane_width",
  "pane_height",
  "cursor_x",
  "cursor_y",
  "cursor_flag",
  "pane_in_mode",
  "pane_input_off",
];

// tmux's names for the keys a pane sends.
const keyNames: Record<Key, string> = { Backspace: "BSpace", Enter: "Enter" };

// The line that ends what tmux itself prints and starts the screen. Nothing
// before it can be this line, so the screen cannot imitate the fields above.
const screenStart = "screen";

// How many parents a walk up the process tree reads at most, far more than
// any real tree is deep, so a tree that changes as it is read still ends.
const deepest = 256;

// TmuxPane reads and writes the one pane of the tmux server at a socket
// path. It runs the tmux client directly, never through a shell, and without
// TMUX or TMUX_PANE, so a tmux the caller happens to run in never picks the
// pane: the socket is the caller's to name.
export class TmuxPane implements Pane {
  readonly #socket: string;
  readonly #tmux: string;
  readonly #proc: string;
  readonly #ancestorOf: number | undefined;

  constructor(socket: string, options: TmuxPaneOptions = {}) {
    this.#socket = socket;
    this.#tmux = options.tmux ?? "tmux";
    this.#proc = options.proc ?? "/proc";
    this.#ancestorOf = options.requireAncestorOf;
  }

  // snapshot reads the pane with one tmux client call, and the pane process's
  // terminal from /proc. It rejects when tmux cannot be run, cannot reach the
  // server, or prints what it should not, and with PaneUnusable for a tmux
  // that leaves the formats empty, a machine with no /proc, or a live pane
  // whose first process is not an ancestor of the one the options require.
  async snapshot(): Promise<Snapshot> {
    const stdout = await this.#run([
      "display-message",
      "-p",
      paneFormats.map((name) => `#{${name}}`).join(" "),
      ";",
      "list-panes",
      "-a",
      "-F",
      "pane",
      ";",
      "list-clients",
      "-F",
      "client #{client_activity}",
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
    const first = output[0] ?? "";
    const fields = /^(\d+) ([01]) (\d+) (\d+) (\d+) (\d+) ([01]) ([01]) ([01])$/.exec(first);
    const parts = first.split(" ");
    // tmux's CHANGES names none of these formats as new in 3.3, so 3.3 is the
    // floor only as the oldest version tested, and this check guards against
    // a tmux that prints them empty.
    if (fields === null && parts.length === paneFormats.length && parts.includes("")) {
      throw new PaneUnusable("old-tmux", `tmux at ${this.#socket} left the pane's formats empty`);
    }
    if (fields === null || start < 0) {
      throw new Error(`tmux at ${this.#socket} printed an unexpected reading`);
    }
    const [pid, dead, width, height, x, y, visible, inMode, inputOff] = fields
      .slice(1)
      .map(Number) as [number, number, number, number, number, number, number, number, number];
    let panes = 0;
    // tmux gives a client's activity to the second, so a key it names came
    // at the end of that second at the latest.
    let lastTyped: number | undefined;
    for (const line of output.slice(1, start)) {
      const client = /^client (\d+)$/.exec(line);
      if (client !== null) {
        lastTyped = Math.max(lastTyped ?? 0, Number(client[1]) * 1000 + 999);
      } else if (line === "pane") {
        panes++;
      } else {
        throw new Error(`tmux at ${this.#socket} printed an unexpected reading`);
      }
    }
    const lines = output.slice(start + 1, start + 1 + height);
    while (lines.length < height) {
      lines.push("");
    }
    // A dead pane's process is gone, so it holds no terminal and is no one's
    // ancestor; tmux keeps such a pane only with remain-on-exit.
    let hostHasTerminal = false;
    if (dead === 0) {
      await this.#requireAncestor(pid);
      hostHasTerminal = await this.#leadsForeground(pid);
    }
    return {
      lines,
      width,
      cursor: { x, y, visible: visible === 1 },
      hostHasTerminal,
      onePane: panes === 1,
      keysBlocked: inMode === 1 || inputOff === 1,
      lastTyped,
      at,
    };
  }

  // paste pastes one line through a buffer of its own, which it loads from
  // the tmux client's input rather than its arguments, since tmux reads an
  // argument ending in ";" as the end of a command, and deletes once pasted,
  // so the operator's buffers are never read, replaced or reordered.
  async paste(line: string): Promise<void> {
    refusePaste(line);
    const buffer = `harness-observer-${randomBytes(8).toString("hex")}`;
    await this.#run(
      ["load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-p", "-d", "-b", buffer],
      line,
    );
  }

  async key(key: Key): Promise<void> {
    await this.#run(["send-keys", keyNames[key]]);
  }

  // run runs one tmux client call on the socket, with input for the
  // client's standard input if any, and returns what it printed. An error
  // carries what tmux said, which names the socket, never the pane's text.
  async #run(args: readonly string[], input?: string): Promise<string> {
    const { TMUX: _tmux, TMUX_PANE: _pane, ...env } = process.env;
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.#tmux,
        ["-S", this.#socket, ...args],
        { env, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          const reason = stderr.trim() !== "" ? stderr.trim() : String(error);
          reject(new Error(`tmux at ${this.#socket} failed: ${reason}`, { cause: error }));
        },
      );
      // A client that ends before reading its input closes the pipe, which
      // the callback reports; the stream's own error says nothing more.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input ?? "");
    });
  }

  // requireAncestor rejects unless the pane's first process is an ancestor of
  // the process the options require, or the options require none.
  async #requireAncestor(panePid: number): Promise<void> {
    if (this.#ancestorOf === undefined) {
      return;
    }
    let pid = this.#ancestorOf;
    for (let depth = 0; depth < deepest && pid > 0; depth++) {
      if (pid === panePid) {
        return;
      }
      const stat = await this.#stat(pid);
      if (stat === undefined) {
        break;
      }
      pid = stat.ppid;
    }
    throw new PaneUnusable(
      "not-ancestor",
      `the pane of tmux at ${this.#socket} runs process ${panePid}, which is not an ancestor ` +
        `of process ${this.#ancestorOf}`,
    );
  }

  // leadsForeground reports whether a process leads its process group and
  // that group is its terminal's foreground group.
  async #leadsForeground(pid: number): Promise<boolean> {
    const stat = await this.#stat(pid);
    return stat !== undefined && stat.pgrp === pid && stat.tpgid === pid;
  }

  // stat reads a process's parent, process group and terminal foreground
  // group from /proc/<pid>/stat, or undefined for a process that is gone. It
  // rejects with PaneUnusable where there is no /proc at all.
  async #stat(pid: number): Promise<{ ppid: number; pgrp: number; tpgid: number } | undefined> {
    let stat: string;
    try {
      stat = await readFile(path.join(this.#proc, String(pid), "stat"), "utf8");
    } catch {
      try {
        await access(path.join(this.#proc, "self", "stat"));
      } catch {
        throw new PaneUnusable("no-proc", `there is no process information at ${this.#proc}`);
      }
      return undefined;
    }
    // The command name, in parentheses, may hold spaces and parentheses, so
    // the fields are read after the last ")": state, ppid, pgrp, session,
    // tty_nr and tpgid.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(" ");
    return { ppid: Number(fields[1]), pgrp: Number(fields[2]), tpgid: Number(fields[5]) };
  }
}
