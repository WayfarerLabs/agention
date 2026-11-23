import { bundleInputs } from "@wayfarerlabs/agention-build";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sharedDir = path.resolve(import.meta.dirname, "../../../packages/api");
const serverDir = path.resolve(import.meta.dirname, "../../../packages/server-api");

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

describe("the bridge's bundle", () => {
  // The bridge releases only when what it ships changes, so the parts of
  // the API contract only the server and the web UI ship stay out of it.
  // Nothing else stops an import: npm links every workspace package where
  // the bridge resolves it.
  it("includes no module of the server's own API contract", async () => {
    const inputs = await bundleInputs(path.join(import.meta.dirname, "main.ts"));
    // The shared contract is in the bundle, so the paths compare as they should.
    expect(inputs.some((input) => inside(sharedDir, input))).toBe(true);
    expect(inputs.filter((input) => inside(serverDir, input))).toEqual([]);
  });
});
