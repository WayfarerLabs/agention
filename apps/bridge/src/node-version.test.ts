import { expect, it } from "vitest";
import { nodeVersionProblem } from "./node-version.ts";

it.each(["24.0.0", "24.22.1", "25.1.0", "v30.0.0"])("runs on Node %s", (version) => {
  expect(nodeVersionProblem(version)).toBeUndefined();
});

it.each(["22.12.0", "v20.19.0", "18.0.0", "unknown"])("refuses Node %s, naming it", (version) => {
  expect(nodeVersionProblem(version)).toContain(version);
});
