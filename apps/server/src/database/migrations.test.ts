import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { migrations } from "./migrations.ts";

// The SHA-256 of each migration a release has shipped, in order. An
// operator's database ran each as it shipped, so changing one would leave
// that database unlike a new one: a schema change is a new migration.
const shipped = [
  // Migration 1, frozen at 0.1.0.
  "f9b61056f8a1369831725f57006632e262c2192c83611bfc1179f7e6cccc75c4",
  // Migration 2, the session log, frozen at 0.3.0.
  "600b158072dc5e03dc9a0464667439694d13f59a86f3959db67f56c561796804",
  // Migration 3, groups, tags and the message index, frozen at 0.4.0.
  "8372811d0732312937988851d44b200dd3ca27b6e9d1077a96021d595395d34f",
  // Migration 4, voice settings, frozen at 0.4.0.
  "652c9ccd78799758a2e6a52829d49d0fd0565a25e2b42181ab44e5cb2219e55c",
  // Migration 5, files and attachments, frozen at 0.5.0.
  "863fc3b963e757568831d85aca8f91f37adae21bc3c1abf0a45951410562fa2e",
  // Migration 6, API keys, frozen at 0.5.0.
  "218c1f48f752ead9bf86b7d31c82eeafd8a8498f70ac98ba70a57cae61bbc5de",
  // Migration 7, message positions, frozen at 0.5.0.
  "00ee3ad5db44b38f532362f9ba4aa10c0e653871fe186c51d0de6d1e80650050",
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
