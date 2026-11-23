# 5. Separate release lines

Date: 2026-11-23

## Status

Accepted. Supersedes, in [ADR 0001](0001-agention-v1-architecture.md), "One version covers the
server, the bridge and the plugins" in "Distribution: generated agent plugins", the "one release
stream" of "Repository and supply chain", and its `v*` tags: the server, and the bridge with the
plugins, are released on lines of their own.

## Context

Agention ships three things: the server, with the web UI it serves; the agent bridge; and the Claude
Code and Codex plugins that run the bridge. Through 0.6.0 one version covered all three, so every
release gave the plugins a new version and pinned a new bridge, even when only the server changed.
Every operator was then asked to update the plugin on each agent host and restart their sessions, or
to work out from the release notes that they could skip it. As the bridge settles, most changes land
in the server alone.

The server serves every agent API version from its oldest, so an older plugin keeps working against
a newer server; and the sessions view marks a session whose plugin speaks an older agent API version
than the server, and an agent whose plugin is new enough says so at registration. What tells the
operator to update a plugin is therefore Agention itself, not a new version number.

release-please, which cuts releases from Conventional Commits, routes a commit to a package by the
paths it changes, and gives only a configuration's root package the commits outside every package's
directory. `exclude-paths` drops a commit from a package only when every file it changes is under an
excluded directory; a file at the repository's root cannot be excluded.

## Decision

- **Two lines, each with its own version.** The server line releases `@wayfarerlabs/agention` and
  the web UI it serves, tagged `agention-vX.Y.Z`, with `CHANGELOG.md`. The agent line releases
  `@wayfarerlabs/agention-mcp` and both plugins, which share its version and run the bridge of the
  same version, tagged `agention-mcp-vX.Y.Z`, with `apps/bridge/CHANGELOG.md`. Both start from
  0.6.0, the last combined release, and every combined release also carries both lines' tags, so
  each line's history and every gate reads one prefix per line.
- **One release-please configuration per line.** Each line is the root package of its own
  configuration, so a change to shared code (`packages/api`, `packages/build`,
  `packages/private-files`, the root `package.json` and the lockfile) releases both, and each
  excludes the other line's directories and those that ship nothing (`docs/`, `scripts/`,
  `.github/`). The server line keeps the `node` release type, which owns the root `package.json`;
  the agent line uses `simple`, which writes no `package.json`, and sets its version in the bridge's
  manifest and lockfile entry, the plugin definition and the generated plugins. Its release pull
  requests carry labels of their own, since release-please stops updating a line's release pull
  request while a merged one carrying its pending label is untagged. The release-please workflow
  runs once per configuration.
- **One release, one package.** The release workflow takes either line's tags, refuses a tag that is
  not its line's version everywhere that line's release pull request writes it, read from the line's
  configuration, and publishes that line's package alone, from a job that runs no repository code,
  as before.
- **The server is released first.** No bridge is released before a server that serves its agent API
  version. A plugin is in effect released when its release pull request merges, since hosts install
  it from `main`, so the order is held at that merge: a gate in `scripts/check.sh`, required through
  `ci-success`, fails the agent line's release pull request unless the newest server release serves
  its agent API version and is on npm. It reads every fetched tag rather than those HEAD reaches, so
  running it again on the same pull request passes once the server is published.
- **Refusals name versions and the newest release.** With two versions, "the server's release" and
  "the plugin's release" mean nothing to each other. A bridge refusing an older server names the
  agent API version each speaks, or that the server states none, and asks for the server's newest
  release, which serves every released bridge; the server asks an older bridge's operator for the
  plugin's newest release, and a newer client's for the server's.
- **One rule for the operator.** Upgrade the server whenever you choose; update the plugin when
  Agention says so.

## Consequences

- A server-only change releases only the server: no plugin update, no restarted sessions.
- A change to shared code is two release pull requests, merged server first. The window in which the
  sessions view asks for a plugin release that is not out yet lasts as long as the maintainer takes
  to merge the agent line's release pull request after the server's is published.
- `main` does not require a branch to be up to date, so the release order gate's pass is as of its
  last run; release-please refreshes a release pull request after each releasing change, and
  maintainers merge one only once it is current.
- A releasing commit that also touches a file at the repository's root, such as `CONTRIBUTING.md` or
  `.cspell.json`, or the lockfile, releases both lines, since release-please cannot exclude a root
  file. Contributors keep such changes, and a dependency a feature needs, in commits of their own
  that release nothing; a dependency change that is itself a fix releases both. A missed split
  releases a line that did not change, the safe failure.
- A Codex host following `main` may refresh its plugin as soon as an agent release merges, before
  its operator upgrades the server; that bridge then refuses the older server, saying which to
  upgrade, until they do.
- Servers before 0.3.0 state no agent API version, so they act on a call before a newer bridge can
  refuse their answer; the operator guide says to upgrade such a server first.
