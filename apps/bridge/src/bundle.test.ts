import { bundleInputs } from "@wayfarerlabs/agention-build";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The directory of a workspace package, found as Node resolves it from here,
// through the link npm makes, to its real path, as the bundle's inputs are.
function packageDir(name: string): string {
  const entry = createRequire(import.meta.url).resolve(name);
  return path.dirname(path.dirname(entry));
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

describe("the bridge's bundle", () => {
  // The bridge releases only when what it ships changes, so the parts of
  // the API contract only the server and the web UI use stay out of it.
  // Nothing else stops an import: npm links every workspace package where
  // the bridge resolves it.
  it("includes no module of the server's own API contract", async () => {
    const inputs = await bundleInputs(path.join(import.meta.dirname, "main.ts"));
    const sharedDir = packageDir("@wayfarerlabs/agention-api");
    const serverDir = packageDir("@wayfarerlabs/agention-server-api");
    // The shared contract is in the bundle, so the paths compare as they should.
    expect(inputs.some((input) => inside(sharedDir, input))).toBe(true);
    expect(inputs.filter((input) => inside(serverDir, input))).toEqual([]);
  });
});
