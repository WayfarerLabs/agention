import type { HarnessProfiles, Profile } from "./profile.ts";

// A profile, and the harness version from which it applies: the version whose
// screens it was captured from, or the first whose screens changed.
export interface VersionedProfile {
  readonly from: string;
  readonly profile: Profile;
}

// versionTable builds a harness's profiles from the versions where its
// screens changed, oldest first; each entry applies from its version until
// the next. It throws for an empty table, a version that is not plain
// major.minor.patch, or entries out of order, since each is a mistake in this
// package.
//
// forVersion reads the version the MCP client reports, which is outside
// input: anything but a plain version, a prerelease included, has no profile.
export function versionTable(
  harness: string,
  client: string,
  table: readonly VersionedProfile[],
): HarnessProfiles {
  const entries = table.map(({ from, profile }) => {
    const version = parseVersion(from);
    if (version === undefined) {
      throw new Error(`${harness}'s profiles name a version that is not plain: ${from}`);
    }
    return { version, profile };
  });
  if (entries.length === 0) {
    throw new Error(`${harness} has no profiles`);
  }
  entries.forEach((entry, i) => {
    if (i > 0 && compareVersions(entries[i - 1]!.version, entry.version) >= 0) {
      throw new Error(`${harness}'s profiles are not in version order`);
    }
  });
  return {
    harness,
    client,
    forVersion(text) {
      const version = parseVersion(text);
      if (version === undefined) {
        return undefined;
      }
      return entries.findLast((entry) => compareVersions(entry.version, version) <= 0)?.profile;
    },
  };
}

type Version = readonly [number, number, number];

function parseVersion(text: string): Version | undefined {
  const parts = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(text);
  return parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : undefined;
}

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
