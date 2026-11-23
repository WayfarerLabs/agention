import { defineConfig } from "vitest/config";

// The compatibility suites, which their gates' scripts run, each naming its
// own file: the agent compatibility suite against the released bridges
// scripts/check-agent-compatibility.sh installs, and the server compatibility
// suite against the released servers scripts/check-server-compatibility.sh
// installs. The bridge's own tests run with Vitest's defaults, which leave
// them out.
// A hook's cleanup may wait for a bridge's process and a server's to end,
// each killed after a few seconds if it does not.
export default defineConfig({ test: { include: ["src/**/*.compat.ts"], hookTimeout: 20_000 } });
