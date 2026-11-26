import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// Takes the README's screenshots, which scripts/generate-screenshots.sh runs.
// The browser tests' own configuration never matches this file, so the
// checks do not retake them.
export default defineConfig(base, { testMatch: "readme-screenshots.ts", timeout: 180_000 });
