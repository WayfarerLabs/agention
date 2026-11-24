import { defineConfig } from "vitest/config";

// The bridge's tests run in a temporary directory of their own that must be
// empty once they finish, as the server's do. They start real servers and
// wait on real long polls, which under machine load can run past Vitest's
// default 5 seconds; a test that hangs still fails, at 30.
export default defineConfig({
  test: { globalSetup: ["@wayfarerlabs/agention/src/test-tmpdir.ts"], testTimeout: 30_000 },
});
