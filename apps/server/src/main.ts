#!/usr/bin/env node
import { run } from "./cli.ts";

// SIGINT and SIGTERM ask a running command to stop; agention serve then
// finishes its open requests and exits. A second signal, once the first
// listener has fired, ends the process at once.
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stop: stop.signal,
});
