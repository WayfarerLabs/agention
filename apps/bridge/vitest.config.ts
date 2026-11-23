import { defineConfig } from "vitest/config";

// The bridge's tests run in a temporary directory of their own that must be
// empty once they finish, as the server's do.
export default defineConfig({
  test: { globalSetup: ["@wayfarerlabs/agention/src/test-tmpdir.ts"] },
});
