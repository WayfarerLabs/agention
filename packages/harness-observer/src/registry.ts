import { claudeCode } from "./claude-code-profile.ts";
import { codex } from "./codex-profile.ts";
import { genericLenient, genericStrict } from "./generic-profiles.ts";
import type { HarnessProfiles, Profile } from "./profile.ts";

// The harness a caller runs under, as its MCP client named itself in
// `initialize`, such as { name: "claude-code", version: "2.1.331" }.
export interface HarnessClient {
  readonly name: string;
  readonly version: string;
}

// The profiles this package ships: the generic ones, and each harness's. Each
// harness's name and MCP client name is its own, and none is "auto" or a
// generic profile's name.
const generics: readonly Profile[] = [genericStrict, genericLenient];
const harnesses: readonly HarnessProfiles[] = [claudeCode, codex];

// Every name selectProfile chooses by besides "auto": the generic profiles'
// and each harness's. A caller configures one of them, or "auto".
export const profileNames: readonly string[] = [
  ...generics.map((profile) => profile.name),
  ...harnesses.map((entry) => entry.harness),
];

// selectProfile returns the profile a configured name chooses. "auto" chooses
// the harness whose MCP client the client is, and a harness's name chooses
// that harness's profiles; either takes the entry for the client's version.
// The strict generic profile reads every other case: a harness with no
// profiles, a version below the oldest entry, no client, or a name that is
// none of profileNames, which a caller checks for itself.
export function selectProfile(name: string, client: HarnessClient | undefined): Profile {
  const generic = generics.find((profile) => profile.name === name);
  if (generic !== undefined) {
    return generic;
  }
  const harness = harnesses.find((entry) =>
    name === "auto" ? entry.client === client?.name : entry.harness === name,
  );
  return (client && harness?.forVersion(client.version)) ?? genericStrict;
}
