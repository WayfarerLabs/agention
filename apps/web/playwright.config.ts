import { defineConfig } from "@playwright/test";

// The browser tests drive the built server and web UI in Chromium's headless
// shell. They need the server package built (npm run -w apps/server build)
// and the shell installed (npx playwright install --only-shell chromium).
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  forbidOnly: process.env.CI !== undefined,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
  },
});
