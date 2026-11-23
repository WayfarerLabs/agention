// Vitest's global setup for the server's tests: it gives the run a temporary
// directory of its own, which every test worker and every process a test
// starts inherits as TMPDIR, and fails the run if a test left anything in it.
// The directory is removed either way, so a failing run leaves nothing behind.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export default function setup(): () => void {
  const root = mkdtempSync(path.join(tmpdir(), "agention-server-tests-"));
  // Workers see this because Vitest starts them after the global setup.
  process.env.TMPDIR = root;
  return () => {
    const left = readdirSync(root);
    rmSync(root, { recursive: true, force: true });
    if (left.length > 0) {
      throw new Error(
        `the tests left ${left.join(", ")} in their temporary directory: ` +
          "remove what a test makes when it finishes, pass or fail, as testDirectory does",
      );
    }
  };
}
