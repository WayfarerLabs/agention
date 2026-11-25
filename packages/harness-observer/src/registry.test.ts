import { describe, expect, it } from "vitest";
import { genericLenient, genericStrict } from "./generic-profiles.ts";
import type { Profile } from "./profile.ts";
import { profileRegistry, profiles } from "./registry.ts";
import { versionTable } from "./version-table.ts";

const older: Profile = { name: "harness", screen: () => ({ kind: "other" }) };
const newer: Profile = { name: "harness", screen: () => ({ kind: "other" }) };

// A harness with profiles from version 1 and from version 2, whose MCP client
// names itself differently from the harness.
const harness = versionTable("harness", "harness-client", [
  { from: "1.0.0", profile: older },
  { from: "2.0.0", profile: newer },
]);

describe("profileRegistry", () => {
  const registry = profileRegistry([harness]);

  it("names the generic profiles and each harness", () => {
    expect(registry.names).toEqual(["generic-strict", "generic-lenient", "harness"]);
  });

  it("chooses a generic profile by name, whatever the client", () => {
    const client = { name: "harness-client", version: "2.0.0" };
    expect(registry.select("generic-strict", client)).toBe(genericStrict);
    expect(registry.select("generic-lenient", client)).toBe(genericLenient);
    expect(registry.select("generic-lenient", undefined)).toBe(genericLenient);
  });

  it("chooses by the client's MCP client name and version for auto", () => {
    expect(registry.select("auto", { name: "harness-client", version: "2.1.0" })).toBe(newer);
    expect(registry.select("auto", { name: "harness-client", version: "1.9.0" })).toBe(older);
  });

  it("chooses a named harness's profile for the client's version", () => {
    expect(registry.select("harness", { name: "another", version: "1.0.0" })).toBe(older);
  });

  it("falls back to the strict generic profile where no harness profile applies", () => {
    expect(registry.select("auto", { name: "harness", version: "2.0.0" })).toBe(genericStrict);
    expect(registry.select("auto", { name: "another", version: "2.0.0" })).toBe(genericStrict);
    expect(registry.select("auto", { name: "harness-client", version: "0.9.0" })).toBe(
      genericStrict,
    );
    expect(registry.select("auto", undefined)).toBe(genericStrict);
    expect(registry.select("harness", undefined)).toBe(genericStrict);
  });

  it("chooses nothing for a name it does not know", () => {
    expect(registry.select("another", { name: "another", version: "1.0.0" })).toBeUndefined();
    expect(registry.select("harness-client", undefined)).toBeUndefined();
  });

  it("refuses two harnesses of one name or MCP client, or one named like a generic profile or auto", () => {
    expect(() => profileRegistry([harness, harness])).toThrow();
    expect(() => profileRegistry([harness, { ...harness, harness: "another" }])).toThrow();
    expect(() => profileRegistry([{ ...harness, harness: "generic-strict" }])).toThrow();
    expect(() => profileRegistry([{ ...harness, harness: "auto" }])).toThrow();
  });
});

describe("the shipped registry", () => {
  it("serves Claude Code and Codex by their configured names", () => {
    expect(profiles.names).toEqual(["generic-strict", "generic-lenient", "claude-code", "codex"]);
  });
});
