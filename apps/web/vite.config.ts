import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // The server package ships this build, so its license notices list the npm
  // packages the build includes, from this file.
  build: { license: { fileName: ".vite/license.json" } },
  // Component tests run in jsdom; the browser tests in e2e/ run in Playwright.
  // Under machine load a component test can run past Vitest's default 5
  // seconds; a test that hangs still fails, at 30.
  test: {
    environment: "jsdom",
    testTimeout: 30_000,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
