import { defineConfig } from "vitest/config";

// The agent compatibility suite, which scripts/check-agent-compatibility.sh
// runs against the released bridges it installs. The bridge's own tests run
// with Vitest's defaults, which leave it out.
export default defineConfig({ test: { include: ["src/**/*.compat.ts"] } });
