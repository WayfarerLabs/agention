import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { suppliedNotices } from "./supplied-notices.ts";

// The repository's installed packages, which the builds include.
const modules = fileURLToPath(new URL("../../../node_modules/", import.meta.url));

// packageFiles returns the text of every file in a package, leaving out the
// packages installed inside it.
function packageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : packageFiles(path);
    }
    return entry.isFile() ? [readFileSync(path, "utf8")] : [];
  });
}

describe("suppliedNotices", () => {
  for (const [key, supplied] of Object.entries(suppliedNotices)) {
    it(`supplies ${key} for the installed version, quoting its own files`, () => {
      const at = key.lastIndexOf("@");
      const dir = join(modules, key.slice(0, at));
      const manifest = join(dir, "package.json");

      // An entry for a version no longer installed fails here too.
      expect(existsSync(manifest), `${key} is not installed`).toBe(true);
      expect((JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version).toBe(
        key.slice(at + 1),
      );
      const files = packageFiles(dir);
      for (const block of supplied.quoted) {
        expect(
          files.some((file) => file.includes(block)),
          block,
        ).toBe(true);
      }
    });
  }
});
