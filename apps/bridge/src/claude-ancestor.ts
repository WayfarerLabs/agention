import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The most ancestors the bridge looks through for the agent host that started
// it. Claude Code starts it through npx, a few processes up; this bounds the
// walk on any system whatever the chain.
export const maxAncestors = 16;

// processAncestors lists the ancestors of the process given, its parent
// first, up to maxAncestors of them and stopping at the first process that
// has none, init or launchd. On Linux it reads /proc; elsewhere, as on macOS,
// it asks ps. A process it cannot read ends the list.
export function processAncestors(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): number[] {
  const parentOf = platform === "linux" ? linuxParent : psParent;
  const ancestors: number[] = [];
  for (let current = pid; ancestors.length < maxAncestors;) {
    const parent = parentOf(current);
    if (parent === undefined || parent <= 1) {
      break;
    }
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

// linuxParent reads a process's parent from /proc/<pid>/stat, whose fourth
// field it is. The second is the command's name in brackets, which may hold
// spaces and brackets of its own, so the fields are read after its last one.
function linuxParent(pid: number): number | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(" ");
  return positiveInteger(fields[1]);
}

// psParent asks ps for a process's parent, as POSIX specifies it.
function psParent(pid: number): number | undefined {
  try {
    const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return positiveInteger(output.trim());
  } catch {
    return undefined;
  }
}

function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^[1-9][0-9]{0,9}$/.test(text)) {
    return undefined;
  }
  return Number(text);
}
