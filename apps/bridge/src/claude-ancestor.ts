import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// The command name of a Claude Code process, which its MCP servers have
// among their ancestors: Claude Code starts the bridge, through npx.
export const claudeCommand = "claude";

// The most ancestors the bridge looks through for its Claude Code process,
// which bounds the walk on any system whatever the chain.
export const maxAncestors = 16;

export interface ProcessInfo {
  parent: number | undefined;
  command: string | undefined;
}

// nearestClaude returns the nearest ancestor of the process given whose
// command is claude, looking at most maxAncestors up, pid 1 included, as in a
// container whose entry point is Claude Code, or undefined when there is
// none, so a Claude Code process that started another one, which started
// the bridge, is never taken for the bridge's own. On Linux it reads /proc;
// elsewhere, as on macOS, it asks ps. A process it cannot read ends the walk.
export function nearestClaude(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  return nearestClaudeBy(pid, platform === "linux" ? fromProc : fromPs);
}

// nearestClaudeBy walks up from the process given, reading each process
// with read.
export function nearestClaudeBy(
  pid: number,
  read: (pid: number) => ProcessInfo,
): number | undefined {
  let parent = read(pid).parent;
  for (let looked = 0; looked < maxAncestors && parent !== undefined; looked++) {
    const info = read(parent);
    if (info.command === claudeCommand) {
      return parent;
    }
    parent = info.parent;
  }
  return undefined;
}

// fromProc reads a process's parent, the fourth field of /proc/<pid>/stat,
// and its command name, /proc/<pid>/comm. stat's second field is the command
// in brackets, which may hold spaces and brackets of its own, so the fields
// are read after its last one.
function fromProc(pid: number): ProcessInfo {
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(`/proc/${pid}/${file}`, "utf8");
    } catch {
      return undefined;
    }
  };
  const stat = read("stat");
  const fields = stat
    ?.slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(" ");
  return { parent: positiveInteger(fields?.[1]), command: read("comm")?.trim() };
}

// fromPs asks ps for a process's parent and command, as POSIX specifies
// them. macOS gives the command's path, whose last part is its name.
function fromPs(pid: number): ProcessInfo {
  try {
    const output = execFileSync("ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const match = /^\s*(\S+)\s+(.*?)\s*$/.exec(output);
    return {
      parent: positiveInteger(match?.[1]),
      command: match?.[2] === undefined ? undefined : path.basename(match[2]),
    };
  } catch {
    return { parent: undefined, command: undefined };
  }
}

function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^[1-9][0-9]{0,9}$/.test(text)) {
    return undefined;
  }
  return Number(text);
}
