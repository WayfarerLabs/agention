import { defineConfig } from "vitest/config";

// The observer's tests run in a temporary directory of their own that must be
// empty once they finish (test/tmpdir.ts), as the server's and the bridge's
// do. They start real tmux servers and sample at the observer's real rate,
// which under machine load can run past Vitest's default 5 seconds; a test
// that hangs still fails, at 30.
export default defineConfig({
  test: { globalSetup: ["test/tmpdir.ts"], testTimeout: 30_000 },
});
