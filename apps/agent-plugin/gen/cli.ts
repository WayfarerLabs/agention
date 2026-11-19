import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadSources } from "./definition.ts";
import { check, write } from "./output.ts";
import { render } from "./render.ts";

const usage = `Usage: node apps/agent-plugin/gen/main.ts [--root DIR] [--check]
       node apps/agent-plugin/gen/main.ts [--root DIR] --bridge-package FILE --out DIR

Reads apps/agent-plugin/plugin.json and apps/agent-plugin/skills/, and writes a
self-contained plugin per host (out/claude-plugin, out/codex-plugin) plus each
host's repository catalog (.claude-plugin/marketplace.json,
.agents/plugins/marketplace.json).

With --bridge-package, the plugins run the MCP server from a package tarball
instead of the published package, and are written to the same paths below the
--out directory, which must not exist yet.

Options:
  --root DIR             The repository root (default: the current directory)
  --check                Write nothing; fail if the outputs differ from what
                         would be written
  --bridge-package FILE  A tarball of the MCP server's package, as npm pack
                         writes it (.tgz, .tar.gz or .tar), for the plugins to run
  --out DIR              A new directory for the plugins that run --bridge-package
  -h, --help             Print this help
`;

const exitOK = 0;
const exitFail = 1;
const exitUsage = 2;

// npm takes a package path for a tarball only by these extensions; it reads
// any other path as a package directory.
const tarballPattern = /\.(tgz|tar\.gz|tar)$/i;

export interface Output {
  write(text: string): unknown;
}

// run handles a command line and returns the process exit code.
export function run(args: readonly string[], stdout: Output, stderr: Output): number {
  const usageError = (message: string): number => {
    stderr.write(`gen: ${message}\n\n${usage}`);
    return exitUsage;
  };
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        root: { type: "string", default: "." },
        check: { type: "boolean", default: false },
        "bridge-package": { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    return usageError((error as Error).message);
  }
  if (values.help) {
    stdout.write(usage);
    return exitOK;
  }
  const { root, "bridge-package": bridgePackage, out } = values;
  if ((bridgePackage === undefined) !== (out === undefined)) {
    return usageError("--bridge-package and --out go together");
  }
  if (values.check && out !== undefined) {
    return usageError("--check compares the repository's outputs and takes no --bridge-package");
  }
  if (out === "") {
    return usageError("--out names no directory");
  }

  try {
    if (bridgePackage !== undefined && out !== undefined) {
      const packageFile = resolve(bridgePackage);
      if (
        !tarballPattern.test(packageFile) ||
        statSync(packageFile, { throwIfNoEntry: false })?.isFile() !== true
      ) {
        throw new Error(`--bridge-package ${packageFile} is not a package tarball`);
      }
      const generated = render(loadSources(root), packageFile);
      // Creating the directory is what checks that it is new, so nothing it
      // names, the repository included, can be overwritten.
      try {
        mkdirSync(out, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`--out ${resolve(out)} already exists; name a new directory`);
        }
        throw error;
      }
      write(out, generated);
      stdout.write(`Generated plugin outputs that run ${packageFile} in ${resolve(out)}.\n`);
      return exitOK;
    }

    const generated = render(loadSources(root));
    if (!values.check) {
      write(root, generated);
      stdout.write("Generated plugin outputs.\n");
      return exitOK;
    }
    const drift = check(root, generated);
    if (drift.length > 0) {
      stderr.write("gen: generated plugin outputs are out of date with their sources:\n");
      stderr.write(drift.map((difference) => `  ${difference}\n`).join(""));
      stderr.write("Run scripts/generate-plugins.sh and commit the result.\n");
      return exitFail;
    }
    stdout.write("Generated plugin outputs match their sources.\n");
    return exitOK;
  } catch (error) {
    stderr.write(`gen: ${(error as Error).message}\n`);
    return exitFail;
  }
}
