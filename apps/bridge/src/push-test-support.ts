// What push's tests share: a harness whose bridges run as Claude Code's do,
// under a host process with the watcher's mark, and ways to read what push
// wrote and what the server was asked.
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { claudeCommand } from "./claude-ancestor.ts";
import { claudeHostsDirectory } from "./host-directory.ts";
import { claudeCodeClient, lapseLine, type PushTiming } from "./push.ts";
import { type Answer, BridgeHarness, type TestBridge } from "./test-harness.ts";

// Fast enough for tests, and a wait that ends within a second, so a round
// with nothing to report comes around quickly.
export const timing: PushTiming = {
  waitSeconds: 1,
  stateEvery: 50,
  retryFirst: 20,
  retryMost: 100,
};

// The host process: the test's own, which is alive, as Claude Code is while
// its bridges run.
export const host = process.pid;

export async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let tries = 0; tries < 400; tries++) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The integers a notice names, in order: each thread's number and count.
export function integersOf(notice: string): number[] {
  return [...notice.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

export function lapsed(answer: Answer): boolean {
  return answer.content.some((block) => block.text === lapseLine);
}

// untilLapsed calls a tool until an answer ends with the lapse line.
export async function untilLapsed(bridge: TestBridge): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (lapsed(await bridge.call("thread_list"))) {
      return;
    }
    await delay(50);
  }
  throw new Error("timed out waiting for the lapse line");
}

// A thread the agent starts, which the operator then writes to.
export async function threadWith(bridge: TestBridge, title = "A question"): Promise<number> {
  const created = await bridge.ok("thread_create", {
    request_id: title.replace(/[^A-Za-z0-9]/g, "-"),
    title,
  });
  return created.number as number;
}

export class PushHarness extends BridgeHarness {
  // The host name the Claude Code bridges see, which a test may change.
  hostName = hostname();

  hostDirectory(pid = host, hostName = this.hostName): string {
    return path.join(claudeHostsDirectory(this.home, hostName), String(pid));
  }

  // markHost makes a host directory with the watcher's mark, as the watcher
  // writes it.
  markHost(pid = host): string {
    const directory = this.hostDirectory(pid);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, "hooked"), "", { mode: 0o600 });
    return directory;
  }

  // The names of the host directory's files of one kind, such as wake.
  filesOf(kind: string, pid = host): string[] {
    const directory = this.hostDirectory(pid);
    if (!existsSync(directory)) {
      return [];
    }
    return readdirSync(directory)
      .filter((name) => name.startsWith(`${kind}-`))
      .map((name) => path.join(directory, name));
  }

  // takeWakes takes every wake file as the watcher does, returning their
  // notices, or undefined when there is none.
  takeWakes(): string[] | undefined {
    const files = this.filesOf("wake");
    if (files.length === 0) {
      return undefined;
    }
    return files.map((file) => {
      const notice = readFileSync(file, "utf8");
      rmSync(file);
      return notice;
    });
  }

  // takeWake takes the one wake file there should be.
  async takeWake(what = "the wake file"): Promise<string> {
    const notices = await eventually(() => this.takeWakes(), what);
    if (notices.length !== 1) {
      throw new Error(`${notices.length} wake files, not one`);
    }
    return notices[0] ?? "";
  }

  claudeBridge(
    client = claudeCodeClient,
    names: Record<string, string> = {},
    pushTiming = timing,
  ): Promise<TestBridge> {
    return this.bridge(names, this.home, {
      client,
      host: () => host,
      hostName: () => this.hostName,
      pushTiming,
    });
  }

  // registered starts a Claude Code bridge whose session the operator has
  // approved, and returns it with its approved register answer.
  async registered(
    client = claudeCodeClient,
  ): Promise<{ bridge: TestBridge; answer: Record<string, unknown> }> {
    const bridge = await this.claudeBridge(client);
    await bridge.ok("register");
    await this.approve(this.keyOnDisk());
    return { bridge, answer: await bridge.ok("register") };
  }

  // approveWhileWaiting has the operator approve the bridge's session once
  // push has read its registration pending, as while the agent waits at its
  // prompt with no further register, and returns once push waits.
  async approveWhileWaiting(bridge: TestBridge): Promise<void> {
    await bridge.ok("register");
    const reads = this.counting("/registrations");
    await eventually(() => (reads() >= 1 ? true : undefined), "push reading the registration");
    const waits = this.counting("/wait");
    await this.approve(this.keyOnDisk());
    await eventually(() => (waits() > 0 ? true : undefined), "push waiting");
  }

  // counting counts the requests whose path ends with the one given, from
  // now on.
  counting(ending: string): () => number {
    let count = 0;
    const before = this.beforeRequest;
    this.beforeRequest = (request) => {
      if (new URL(request.url).pathname.endsWith(ending)) {
        count++;
      }
      return before?.(request);
    };
    return () => count;
  }
}

// A launcher named claude, a shell started through a link of that name, as
// Claude Code is an ancestor of its bridges. It writes its own pid to a file
// first, then runs Node with the arguments that follow, as a child, staying
// its parent. Its directory is removed when the test calls remove.
export function claudeLauncher(): {
  command: string;
  args: (pidFile: string, program?: string[]) => string[];
  remove: () => void;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "agention-claude-"));
  const command = path.join(directory, claudeCommand);
  symlinkSync("/bin/sh", command);
  const script = 'echo $$ >"$0"; "$@"; exit $?';
  return {
    command,
    args: (pidFile, program = [process.execPath]) => ["-c", script, pidFile, ...program],
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

// childUnder runs a long-lived process under the launcher, and returns the
// launcher's pid and the child's, once both have started.
export async function childUnder(launcher: ReturnType<typeof claudeLauncher>): Promise<{
  launcher: number;
  child: number;
  stop: () => void;
}> {
  const directory = mkdtempSync(path.join(tmpdir(), "agention-launched-"));
  const pidFile = path.join(directory, "launcher");
  const childFile = path.join(directory, "child");
  const running: ChildProcess = spawn(
    launcher.command,
    [
      ...launcher.args(pidFile),
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(childFile)}, String(process.pid));` +
        "setTimeout(() => {}, 60_000);",
    ],
    { stdio: "ignore" },
  );
  const read = (file: string) =>
    existsSync(file) && readFileSync(file, "utf8") !== ""
      ? Number(readFileSync(file, "utf8"))
      : undefined;
  const { outer, inner } = await eventually(() => {
    const outer = read(pidFile);
    const inner = read(childFile);
    return outer !== undefined && inner !== undefined ? { outer, inner } : undefined;
  }, "the launcher and its child");
  return {
    launcher: outer,
    child: inner,
    stop: () => {
      running.kill();
      try {
        process.kill(inner);
      } catch {
        // It has ended already.
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
