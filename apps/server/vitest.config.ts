import { defineConfig } from "vitest/config";

// The server's tests run in a temporary directory of their own that must be
// empty once they finish (src/test-tmpdir.ts). They do real disk and socket
// work, which under machine load can run past Vitest's default 5 seconds; a
// test that hangs still fails, at 30.
export default defineConfig({
  test: { globalSetup: ["src/test-tmpdir.ts"], testTimeout: 30_000 },
});
