import { describe, expect, it } from "vitest";
import type { Profile } from "./profile.ts";
import { versionTable } from "./version-table.ts";

const first: Profile = { name: "first", screen: () => ({ kind: "other" }) };
const second: Profile = { name: "second", screen: () => ({ kind: "other" }) };

describe("versionTable", () => {
  const table = versionTable("harness", "harness-client", [
    { from: "1.9.0", profile: first },
    { from: "1.10.2", profile: second },
  ]);

  it("names the harness and its MCP client", () => {
    expect(table.harness).toBe("harness");
    expect(table.client).toBe("harness-client");
  });

  it("applies each entry from its version until the next, comparing numerically", () => {
    expect(table.forVersion("1.9.0")).toBe(first);
    expect(table.forVersion("1.9.12")).toBe(first);
    expect(table.forVersion("1.10.1")).toBe(first);
    expect(table.forVersion("1.10.2")).toBe(second);
    expect(table.forVersion("2.0.0")).toBe(second);
  });

  it("has no profile below the oldest entry, or for a version that is not plain", () => {
    for (const version of ["1.8.99", "0.0.0", "1.10.2-beta.1", "1.10", "v1.10.2", "", "1.1e3.0"]) {
      expect(table.forVersion(version)).toBeUndefined();
    }
  });

  it("refuses an empty table, a version that is not plain, or entries out of order", () => {
    expect(() => versionTable("harness", "client", [])).toThrow();
    expect(() => versionTable("harness", "client", [{ from: "1.0", profile: first }])).toThrow();
    expect(() =>
      versionTable("harness", "client", [
        { from: "1.10.0", profile: first },
        { from: "1.9.0", profile: second },
      ]),
    ).toThrow();
    expect(() =>
      versionTable("harness", "client", [
        { from: "1.0.0", profile: first },
        { from: "1.0.0", profile: second },
      ]),
    ).toThrow();
  });
});
