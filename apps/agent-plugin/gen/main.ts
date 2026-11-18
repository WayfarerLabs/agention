// Renders the Agention agent plugins from their canonical definition; see
// cli.ts. Run from the repository root:
//
//   node apps/agent-plugin/gen/main.ts [--root DIR] [--check]
//   node apps/agent-plugin/gen/main.ts [--root DIR] --bridge-package FILE --out DIR
import { run } from "./cli.ts";

process.exitCode = run(process.argv.slice(2), process.stdout, process.stderr);
