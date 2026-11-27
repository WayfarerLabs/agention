import { describe, expect, it } from "vitest";
import { claudeCode } from "./claude-code-profile.ts";
import { codex } from "./codex-profile.ts";
import { genericLenient, genericStrict } from "./generic-profiles.ts";
import { profileNames, selectProfile } from "./registry.ts";

const claudeCodeProfile = claudeCode.forVersion("2.1.331");
const codexProfile = codex.forVersion("0.171.0");

describe("selectProfile", () => {
  it("names the generic profiles and each harness", () => {
    expect(profileNames).toEqual(["generic-strict", "generic-lenient", "claude-code", "codex"]);
  });

  it("chooses a generic profile by name, whatever the client", () => {
    const client = { name: "claude-code", version: "2.1.332" };
    expect(selectProfile("generic-strict", client)).toBe(genericStrict);
    expect(selectProfile("generic-lenient", client)).toBe(genericLenient);
    expect(selectProfile("generic-lenient", undefined)).toBe(genericLenient);
  });

  it("chooses by the client's MCP client name and version for auto", () => {
    expect(selectProfile("auto", { name: "claude-code", version: "2.1.332" })).toBe(
      claudeCodeProfile,
    );
    expect(selectProfile("auto", { name: "codex-mcp-client", version: "0.172.0" })).toBe(
      codexProfile,
    );
  });

  it("chooses a named harness's profile for the client's version", () => {
    expect(selectProfile("codex", { name: "another", version: "0.171.0" })).toBe(codexProfile);
  });

  it("falls back to the strict generic profile where no harness profile applies", () => {
    // Codex's configured name is not its MCP client's.
    expect(selectProfile("auto", { name: "codex", version: "0.171.0" })).toBe(genericStrict);
    expect(selectProfile("auto", { name: "another", version: "1.0.0" })).toBe(genericStrict);
    expect(selectProfile("auto", { name: "claude-code", version: "2.1.330" })).toBe(genericStrict);
    expect(selectProfile("auto", { name: "claude-code", version: "2.1.332-beta" })).toBe(
      genericStrict,
    );
    expect(selectProfile("auto", undefined)).toBe(genericStrict);
    expect(selectProfile("claude-code", undefined)).toBe(genericStrict);
    expect(selectProfile("claude", { name: "claude-code", version: "2.1.332" })).toBe(
      genericStrict,
    );
  });
});
