import { genericLenient, genericStrict } from "./generic-profiles.ts";
import type { HarnessProfiles, Profile } from "./profile.ts";

// The harness a caller runs under, as its MCP client named itself in
// `initialize`, such as { name: "claude-code", version: "2.1.331" }.
export interface HarnessClient {
  readonly name: string;
  readonly version: string;
}

// Maps profile names to profiles. A caller configures one of `names`, or
// "auto" for the profile of the harness it runs under.
export interface ProfileRegistry {
  // Every name select accepts besides "auto": the generic profiles' and each
  // harness's.
  readonly names: readonly string[];
  // select returns the profile a configured name chooses, or undefined for a
  // name the registry does not know. "auto" chooses by the client's harness,
  // and a harness's name chooses that harness's profiles; either takes the
  // entry for the client's version, and the strict generic profile when the
  // harness has no profiles, the version is below the oldest entry, or there
  // is no client.
  select(name: string, client: HarnessClient | undefined): Profile | undefined;
}

const generics: readonly Profile[] = [genericStrict, genericLenient];

// profileRegistry builds a registry of the given harnesses' profiles beside
// the generic ones. It throws for two harnesses of one name, or a harness
// named "auto" or like a generic profile, since either is a mistake in this
// package.
export function profileRegistry(harnesses: readonly HarnessProfiles[]): ProfileRegistry {
  const byHarness = new Map<string, HarnessProfiles>();
  const reserved = new Set(["auto", ...generics.map((profile) => profile.name)]);
  for (const entry of harnesses) {
    if (reserved.has(entry.harness) || byHarness.has(entry.harness)) {
      throw new Error(`a harness's profiles cannot be named ${entry.harness}`);
    }
    byHarness.set(entry.harness, entry);
  }
  return {
    names: [...generics.map((profile) => profile.name), ...byHarness.keys()],
    select(name, client) {
      const generic = generics.find((profile) => profile.name === name);
      if (generic !== undefined) {
        return generic;
      }
      if (name !== "auto" && !byHarness.has(name)) {
        return undefined;
      }
      const harness = byHarness.get(name === "auto" ? (client?.name ?? "") : name);
      return (client && harness?.forVersion(client.version)) ?? genericStrict;
    },
  };
}

// The profiles this package ships. Harness profiles join it as their
// captured screens are added.
export const profiles: ProfileRegistry = profileRegistry([]);
