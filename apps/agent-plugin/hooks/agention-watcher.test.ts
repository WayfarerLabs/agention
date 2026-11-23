import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";

// The watcher itself, run as Claude Code runs a hook: a process of its own,
// with Claude Code's variables and its input on stdin, here empty. Each shell
// it is run with is one an agent host's /bin/sh may be: dash on Debian and
// Ubuntu, and bash, in its POSIX mode, on macOS.

// These tests run real processes that look once a second, which a busy
// machine slows down, so each has more time than the default.
vi.setConfig({ testTimeout: 20_000 });

const script = join(import.meta.dirname, "agention-watcher.sh");

const shells: [string, string[]][] = [["sh", ["/bin/sh"]]];
if (spawnSync("bash", ["--version"]).status === 0) {
  shells.push(["bash --posix", ["bash", "--posix"]]);
}

interface Exit {
  code: number | null;
  stderr: string;
}

interface Watcher {
  child: ChildProcess;
  exited: Promise<Exit>;
}

function tempHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agention-watcher-")));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// A process standing in for Claude Code, alive until the test ends.
function hostProcess(): ChildProcess {
  const host = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  onTestFinished(() => {
    host.kill();
  });
  return host;
}

// The pid of a process that has ended.
function endedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("no process started");
  }
  return pid;
}

function hostDirectory(home: string, pid: number): string {
  return join(home, ".config", "agention", "_hosts", "claude", String(pid));
}

async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let tries = 0; tries < 400; tries++) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function lockHolder(home: string, pid: number): number | undefined {
  try {
    return Number(readFileSync(join(hostDirectory(home, pid), "watcher"), "utf8").trim());
  } catch {
    return undefined;
  }
}

describe.each(shells)("the watcher under %s", (_, shell) => {
  const start = (environment: Record<string, string | undefined>): Watcher => {
    const [command = "sh", ...args] = shell;
    const child = spawn(command, [...args, script], {
      env: { PATH: process.env.PATH ?? "", ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    onTestFinished(() => {
      child.kill();
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<Exit>((resolve) =>
      child.on("close", (code) => resolve({ code, stderr })),
    );
    return { child, exited };
  };

  // watching starts a watcher for a live host and waits until it holds the
  // lock, so it is in its loop.
  const watching = async (home: string, host: number): Promise<Watcher> => {
    const watcher = start({
      HOME: home,
      AGENTION_URL: "https://agention.example",
      CLAUDE_PID: `${host}`,
    });
    await eventually(
      () => (lockHolder(home, host) === watcher.child.pid ? true : undefined),
      "the watcher's lock",
    );
    return watcher;
  };

  it.each<[string, Record<string, string>]>([
    ["without AGENTION_URL", { CLAUDE_PID: String(process.pid) }],
    ["with an empty AGENTION_URL", { AGENTION_URL: "", CLAUDE_PID: String(process.pid) }],
    ["without CLAUDE_PID", { AGENTION_URL: "https://agention.example" }],
    ...["0", "-1", "012", "1.5", "../1", "1/2", "12a", " 12", "12345678901"].map(
      (pid): [string, Record<string, string>] => [
        `with CLAUDE_PID ${JSON.stringify(pid)}`,
        { AGENTION_URL: "https://agention.example", CLAUDE_PID: pid },
      ],
    ),
  ])("exits 0 at once, writing nothing, %s", async (_, environment) => {
    const home = tempHome();
    const exit = await start({ HOME: home, ...environment }).exited;
    expect(exit).toEqual({ code: 0, stderr: "" });
    expect(readdirSync(home)).toEqual([]);
  });

  it("exits 0 at once when its host process is gone", async () => {
    const home = tempHome();
    const ended = endedPid();
    const exit = await start({
      HOME: home,
      AGENTION_URL: "https://agention.example",
      CLAUDE_PID: String(ended),
    }).exited;
    expect(exit).toEqual({ code: 0, stderr: "" });
    expect(readdirSync(home)).toEqual([]);
  });

  it("exits 0 once its host process ends while it waits", async () => {
    const home = tempHome();
    const host = hostProcess();
    const watcher = await watching(home, host.pid ?? 0);
    host.kill();
    expect(await watcher.exited).toEqual({ code: 0, stderr: "" });
  });

  it("marks its host directory, privately, and holds the lock", async () => {
    const home = tempHome();
    const host = hostProcess().pid ?? 0;
    const watcher = await watching(home, host);
    const directory = hostDirectory(home, host);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const name of ["hooked", "watcher"]) {
      expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }
    expect(lockHolder(home, host)).toBe(watcher.child.pid);
  });

  it("runs one watcher per host process: a new one replaces the one waiting", async () => {
    const home = tempHome();
    const host = hostProcess().pid ?? 0;
    const first = await watching(home, host);
    const second = await watching(home, host);
    expect(await first.exited).toEqual({ code: 0, stderr: "" });
    writeFileSync(join(hostDirectory(home, host), "wake"), "notice\n", { mode: 0o600 });
    expect(await second.exited).toEqual({ code: 2, stderr: "notice\n" });
  });

  it("exits 2 only after taking a wake file, with its notice on stderr", async () => {
    const home = tempHome();
    const host = hostProcess().pid ?? 0;
    const watcher = await watching(home, host);
    const notice = "Agention: the operator wrote to you. Unread: thread 4 (2 messages).\n";
    // Written whole, as the bridge renames a finished file into place.
    const directory = hostDirectory(home, host);
    writeFileSync(join(directory, "wake.new"), notice, { mode: 0o600 });
    expect(spawnSync("mv", [join(directory, "wake.new"), join(directory, "wake")]).status).toBe(0);
    expect(await watcher.exited).toEqual({ code: 2, stderr: notice });
    // It leaves its mark and nothing else behind.
    expect(readdirSync(directory)).toEqual(["hooked"]);
  });

  it("takes a wake file written while no watcher ran, as the next turn's watcher", async () => {
    const home = tempHome();
    const host = hostProcess().pid ?? 0;
    const earlier = await watching(home, host);
    earlier.child.kill();
    expect((await earlier.exited).code).toBe(0);
    writeFileSync(join(hostDirectory(home, host), "wake"), "notice\n", { mode: 0o600 });
    const next = start({
      HOME: home,
      AGENTION_URL: "https://agention.example",
      CLAUDE_PID: String(host),
    });
    expect(await next.exited).toEqual({ code: 2, stderr: "notice\n" });
  });

  it("refuses a wake file others can read, printing nothing", async () => {
    const home = tempHome();
    const host = hostProcess().pid ?? 0;
    const watcher = await watching(home, host);
    const wake = join(hostDirectory(home, host), "wake");
    writeFileSync(wake, "notice\n", { mode: 0o644 });
    chmodSync(wake, 0o644);
    expect(await watcher.exited).toEqual({ code: 1, stderr: "" });
    expect(existsSync(wake)).toBe(false);
  });

  it("refuses a host directory below one others can write to", async () => {
    const home = tempHome();
    const host = hostProcess().pid ?? 0;
    mkdirSync(join(home, ".config"), { mode: 0o700 });
    chmodSync(join(home, ".config"), 0o777);
    const exit = await start({
      HOME: home,
      AGENTION_URL: "https://agention.example",
      CLAUDE_PID: String(host),
    }).exited;
    expect(exit).toEqual({ code: 1, stderr: "" });
    expect(existsSync(join(hostDirectory(home, host), "hooked"))).toBe(false);
  });

  it("refuses a host directory others can reach", async () => {
    const home = tempHome();
    const host = hostProcess().pid ?? 0;
    mkdirSync(hostDirectory(home, host), { recursive: true, mode: 0o700 });
    chmodSync(hostDirectory(home, host), 0o755);
    const exit = await start({
      HOME: home,
      AGENTION_URL: "https://agention.example",
      CLAUDE_PID: String(host),
    }).exited;
    expect(exit).toEqual({ code: 1, stderr: "" });
  });

  it("removes the directories of host processes that have ended", async () => {
    const home = tempHome();
    const host = hostProcess().pid ?? 0;
    const ended = hostDirectory(home, endedPid());
    mkdirSync(join(ended, "inner"), { recursive: true, mode: 0o700 });
    const other = hostProcess().pid ?? 0;
    mkdirSync(hostDirectory(home, other), { recursive: true, mode: 0o700 });
    await watching(home, host);
    expect(existsSync(ended)).toBe(false);
    expect(existsSync(hostDirectory(home, other))).toBe(true);
  });
});
