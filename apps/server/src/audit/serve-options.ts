import { quoted } from "@wayfarerlabs/agention-api";
import { PrivateFileError } from "@wayfarerlabs/agention-private-files";
import { execFileSync } from "node:child_process";
import { UsageError, wholeNumberFlag } from "../cli-flags.ts";
import { privateFileRefusal } from "../database/database-file.ts";
import type { Sink } from "./dispatcher.ts";
import { defaultRetentionDays, maxRetentionDays } from "./retention.ts";
import { defaultKeepDays, FileSink, maxKeepDays } from "./sinks/file.ts";
import { type LineStream, stdoutSink } from "./sinks/stdout.ts";

// agention serve's audit options: reading them, and opening the sinks they
// configure.

// Standard output, which reports its errors to a listener when it can fail,
// as a pipe can.
export type StandardOutput = LineStream & {
  on?(event: "error", listener: (error: Error) => void): unknown;
};

// The audit log's sinks and retention, as agention serve's options give them.
export interface AuditOptions {
  stdout: boolean;
  file:
    | {
        directory: string;
        gid: number | undefined;
        groupName: string | undefined;
        keepDays: number;
      }
    | undefined;
  retentionDays: number;
}

// auditFlags reads the audit log's options: a sink of each kind given, and
// the retention.
export function auditFlags(flags: {
  "audit-stdout": boolean;
  "audit-dir"?: string | undefined;
  "audit-group"?: string | undefined;
  "audit-keep-days"?: string | undefined;
  "audit-retention-days"?: string | undefined;
}): AuditOptions {
  const directory = flags["audit-dir"];
  if (directory === "") {
    throw new UsageError("--audit-dir names no directory");
  }
  for (const needsDirectory of ["audit-group", "audit-keep-days"] as const) {
    if (flags[needsDirectory] !== undefined && directory === undefined) {
      throw new UsageError(`--${needsDirectory} needs --audit-dir`);
    }
  }
  const keepDays = wholeNumberFlag("--audit-keep-days", flags["audit-keep-days"], {
    min: 1,
    max: maxKeepDays,
  });
  const retentionDays = wholeNumberFlag("--audit-retention-days", flags["audit-retention-days"], {
    min: 0,
    max: maxRetentionDays,
  });
  return {
    stdout: flags["audit-stdout"],
    file:
      directory === undefined
        ? undefined
        : {
            directory,
            gid: readingGroupFlag(flags["audit-group"]),
            groupName: flags["audit-group"],
            keepDays: keepDays ?? defaultKeepDays,
          },
    retentionDays: retentionDays ?? defaultRetentionDays,
  };
}

// How long getent may take to answer, as when a directory service it asks is
// slow to.
const getentTimeout = 10_000;

// readingGroupFlag resolves --audit-group's name to its group's id, through
// the system's own group database, which getent reads as the system is set
// up to, LDAP and the like included, run without a shell. The server's user
// must be in the group, as it is when its session began.
function readingGroupFlag(name: string | undefined): number | undefined {
  if (name === undefined) {
    return undefined;
  }
  let answer: string;
  try {
    answer = execFileSync("getent", ["group", "--", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: getentTimeout,
    });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") {
      throw new UsageError(
        "--audit-group needs getent to find the group, and this system has none",
      );
    }
    if (code === "ETIMEDOUT") {
      throw new UsageError(
        `--audit-group: getent did not answer within ${getentTimeout / 1000} seconds`,
      );
    }
    throw new UsageError(`--audit-group: there is no group named ${quoted(name)}`);
  }
  const gid = Number(answer.split(":")[2]);
  if (!Number.isInteger(gid) || gid < 0) {
    throw new UsageError(`--audit-group: getent answered no group id for ${quoted(name)}`);
  }
  const held = [...(process.getgroups?.() ?? []), process.getegid?.()];
  if (!held.includes(gid)) {
    throw new UsageError(
      `--audit-group: this user is not in group ${quoted(name)}; add it, then start a new ` +
        "login session or restart its service manager, so the server starts in the group",
    );
  }
  return gid;
}

// openSinks opens the audit log's sinks the options configure, or answers
// why the file sink's directory or file is refused. The stdout sink answers
// by its writes' callbacks, so an error standard output reports otherwise,
// as a closed pipe does, is heard and left to them.
export function openSinks(options: AuditOptions, stdout: StandardOutput): Sink[] | string {
  const sinks: Sink[] = [];
  if (options.stdout) {
    stdout.on?.("error", () => undefined);
    sinks.push(stdoutSink(stdout));
  }
  if (options.file !== undefined) {
    const { directory, gid, groupName, keepDays } = options.file;
    try {
      sinks.push(FileSink.open({ directory, gid, keepDays, clock: Date.now }));
    } catch (error) {
      if (error instanceof PrivateFileError) {
        const shared = groupName === undefined ? undefined : `group ${quoted(groupName)}`;
        return `--audit-dir: ${privateFileRefusal(error, "audit directory", shared)}`;
      }
      throw error;
    }
  }
  return sinks;
}
