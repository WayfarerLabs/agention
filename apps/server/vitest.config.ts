import { defineConfig } from "vitest/config";

// The server's tests run with Vitest's defaults, in a temporary directory of
// their own that must be empty once they finish (src/test-tmpdir.ts).
export default defineConfig({ test: { globalSetup: ["src/test-tmpdir.ts"] } });
