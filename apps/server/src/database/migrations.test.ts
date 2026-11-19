import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { migrations } from "./migrations.ts";

// The SHA-256 of each migration a release has shipped, in order. An
// operator's database ran each as it shipped, so changing one would leave
// that database unlike a new one: a schema change is a new migration.
const shipped = [
  // Migration 1, frozen at 0.1.0.
  "f9b61056f8a1369831725f57006632e262c2192c83611bfc1179f7e6cccc75c4",
];

it("keeps every shipped migration as it shipped", () => {
  shipped.forEach((hash, index) => {
    const migration = migrations[index] ?? "";
    expect(
      createHash("sha256").update(migration).digest("hex"),
      `migration ${index + 1} has shipped and must not change; add a new migration instead`,
    ).toBe(hash);
  });
});
