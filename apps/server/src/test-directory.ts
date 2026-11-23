// A temporary directory for one test, which is removed once the test
// finishes, whether it passed, failed or timed out, and whatever the test's
// other hooks do. It must be made while a test runs, in the test or one of
// its beforeEach hooks.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

// testDirectory makes an empty directory named agention-<name>-<random>
// under the system's temporary directory and returns its real path.
export function testDirectory(name: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), `agention-${name}-`));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return realpathSync(directory);
}
