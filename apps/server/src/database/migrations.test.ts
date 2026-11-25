import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { migrations } from "./migrations.ts";

// The SHA-256 of every migration, in order. An operator's database ran each
// one as a release shipped it, so changing one would leave that database
// unlike a new one: a schema change is a new migration. Every migration is
// frozen, released or not, so none can reach a release unfrozen: a change that
// adds a migration adds its hash here, and one that edits a migration no
// release has shipped yet updates its hash with it.
const frozen = [
  // 1, the first schema.
  "f9b61056f8a1369831725f57006632e262c2192c83611bfc1179f7e6cccc75c4",
  // 2, the session status log.
  "600b158072dc5e03dc9a0464667439694d13f59a86f3959db67f56c561796804",
  // 3, session groups.
  "8372811d0732312937988851d44b200dd3ca27b6e9d1077a96021d595395d34f",
  // 4, voice settings.
  "652c9ccd78799758a2e6a52829d49d0fd0565a25e2b42181ab44e5cb2219e55c",
  // 5, uploaded files.
  "863fc3b963e757568831d85aca8f91f37adae21bc3c1abf0a45951410562fa2e",
  // 6, API keys.
  "218c1f48f752ead9bf86b7d31c82eeafd8a8498f70ac98ba70a57cae61bbc5de",
  // 7, message positions.
  "00ee3ad5db44b38f532362f9ba4aa10c0e653871fe186c51d0de6d1e80650050",
  // 8, inferred session updates.
  "25c3c21b1c1e7aca5a5c42c10e97df84fb6bef573e74bd09bc1e02afe90ba754",
  // 9, group colors and order, and tags of their own.
  "c2f5bcfd9cacfcbbb7f23688a119ed71244d4071fd77f4dcddb836329465be63",
  // 10, monitoring: check-in versions, background requests and monitor reports.
  "3b0f284828ec191467b7be179d5d53a176dded2bad571a7f7ad49c89a788f895",
  // 11, the nudge: whether a session can be nudged, and its latest nudge.
  "e0c4abe7f2f0532d3c38f2620e0d40f2039ff1c44fda0c10b6b9cf00f6b80873",
];

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

it("keeps every migration as its hash froze it", () => {
  expect(
    migrations.map(sha256),
    "the migrations differ from their frozen hashes in migrations.test.ts: add a new migration's " +
      "hash to frozen; for a changed migration, if a release has shipped it, restore it and add a " +
      "new migration instead, and if none has, update its hash",
  ).toEqual(frozen);
});
