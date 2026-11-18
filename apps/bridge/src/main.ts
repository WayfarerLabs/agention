#!/usr/bin/env node
// The Node version is checked before the rest of the bridge loads, so an older
// Node says what the bridge needs instead of failing on something it lacks.
import { nodeVersionProblem } from "./node-version.ts";

const problem = nodeVersionProblem(process.versions.node);
if (problem === undefined) {
  const { run } = await import("./cli.ts");
  const { serveStdio } = await import("./bridge.ts");
  process.exitCode = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    serve: serveStdio,
  });
} else {
  process.stderr.write(`${problem}\n`);
  process.exitCode = 1;
}
