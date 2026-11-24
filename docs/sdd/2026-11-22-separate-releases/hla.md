# Separate releases: High-Level Architecture

- Status: Draft, against the FRD as accepted (its ruling 2)
- Date: 2026-11-22
- Ownership: the effort lead
- Inputs: [frd.md](frd.md), [prior-art-research.md](prior-art-research.md) (findings F1 to F11)

## Overview

Three changes, each complete on its own:

1. **Release lines.** Two release-please configurations, one per line, replace the one that stamps
   one version everywhere. Each line has its own tags, changelog, release pull request and publish
   run. A check on the agent line's release pull request keeps it from merging before the server
   release it needs is on npm (C2).
2. **A newer bridge against an older server.** Both sides word a version mismatch in terms that hold
   when the lines' versions differ (C3), and a new gate runs the bridge at HEAD against the newest
   released server of each older agent API version (C5).
3. **The plugin-is-behind signal.** The server records the agent API version each session's bridge
   states and marks a session whose bridge is behind in the sessions view and the operator API (U2);
   a bridge from this effort on sees from the server's own answers that it is behind and says so in
   its register answer (U3). Neither needs a change to the agent contract.

```mermaid
flowchart LR
  subgraph serverLine["Server line: agention-vX.Y.Z"]
    server["apps/server"]
    web["apps/web"]
    opApi["packages/server-api"]
  end
  subgraph agentLine["Agent line: agention-mcp-vX.Y.Z"]
    bridge["apps/bridge"]
    plugin["apps/agent-plugin, out/, catalogs"]
  end
  shared["packages/api, packages/build, packages/private-files, root package.json, lockfile"]
  none["docs/, scripts/, .github/, root docs and configs"]
  shared --> serverLine
  shared --> agentLine
  bridge -- "Agention-Agent-API" --> server
  server -- "Agention-Agent-API" --> bridge
```

## 1. Release lines

### What each line ships

| Line    | Component      | Tag                   | Paths                                                                                    | Publishes                    |
| ------- | -------------- | --------------------- | ---------------------------------------------------------------------------------------- | ---------------------------- |
| Server  | `agention`     | `agention-vX.Y.Z`     | `apps/server`, `apps/web`, `packages/server-api`                                         | `@wayfarerlabs/agention`     |
| Agent   | `agention-mcp` | `agention-mcp-vX.Y.Z` | `apps/bridge`, `apps/agent-plugin`, `out/`, `.claude-plugin/`, `.agents/`                | `@wayfarerlabs/agention-mcp` |
| Shared  | both           |                       | `packages/api`, `packages/build`, `packages/private-files`, `package.json`, the lockfile | both                         |
| Neither |                |                       | `docs/`, `scripts/`, `.github/`, the root's Markdown, lint and editor configuration      | nothing                      |

**The server-only contract.** `packages/api` today holds both the contract the bridge and server
share and modules only the server and web UI use (API keys, settings, attention, passkeys, the
operator schemas). The bridge imports the whole package through its index, so a change to any of
those modules changes the bridge's bundle too. Moving them into a package of their own makes R2 hold
(FRD ruling 2). The rule for what stays is what the bridge's bundle needs: some files are split, not
moved, since shared code uses parts of them (`thread-lists.ts` and `sessions.ts` use group and tag
names from `groups-and-tags.ts`). The low-level design draws the line in those files.

Nothing in the build stops the bridge importing the new package: npm links every workspace package
into the root `node_modules`, and the bridge's test harness depends on the server, which depends on
it. A test over the bridge's bundle, which the build already describes in a metafile, fails if any
of the new package's modules is in it, and that test is what holds the line. Ruling 2 says the build
enforces this; in practice, a CI test over the bridge's build does.

### Configuration

release-please gives only a root package the commits outside every package's path (F2), so each line
is the root package of its own configuration, excluding what it does not ship (F3):

- `release-please-config.json` and `.release-please-manifest.json`: the server line, release type
  `node`, component `agention`, the changelog `CHANGELOG.md` (which keeps the history through the
  last combined release), and `extra-files` for `apps/server/package.json` and its lockfile entry.
  The root `package.json` version, which the `node` type writes, follows the server line.
- `release-please-config.agent.json` and `.release-please-manifest.agent.json`: the agent line,
  release type `simple` (so it writes no root `package.json`, F4), component `agention-mcp`, the
  changelog `apps/bridge/CHANGELOG.md`, its own `label` and `release-label`, and `extra-files` for
  every place the agent version appears today: the bridge's `package.json` and lockfile entry, the
  plugin definition, both generated plugin manifests, and the bridge's package spec in both
  generated `.mcp.json` files.

Each configuration's `exclude-paths` lists the other line's paths and the directories that ship
nothing, so a feature that carries its docs releases only its own line, and a change to shared paths
releases both. release-please drops a commit from a package only when every file it touches is
excluded (F2), so a new top-level directory that ships nothing and is missing from the lists
releases both lines: the safe failure. CONTRIBUTING says where to add one. release-please excludes
only directories, so the root's Markdown and lint and editor configuration, which ship nothing,
cannot be listed: a change to them goes in its own non-releasing commit (Risks, Root files).

The agent configuration's labels differ from the server's because release-please stops updating a
release pull request while any merged one still carries its pending label: shared labels would let
one line's untagged release freeze the other's.

The release-please workflow runs the action twice, once per configuration, each with its own release
pull request and outputs. `node-workspace` and `linked-versions` are not used (F5). Only `feat`,
`fix` and `perf` commits and breaking changes release (F7).

### Publishing

`.github/workflows/release.yml` triggers on `agention-v*` and `agention-mcp-v*` (which the first
does not match) instead of `v*`. The build job reads the line from the tag's prefix, refuses a tag
that is not that line's version everywhere a shipped artifact carries it, runs
`scripts/check.sh --packages DIR`, and keeps only that line's tarball; the publish job, which runs
no repository code, publishes it. A version already on npm is skipped, as today.

### Release order (C2, U4)

A plugin is in effect released when its release pull request merges, not when its bridge reaches
npm: the marketplace catalogs serve the plugin from `main`, so the merge changes the bridge every
unpinned host runs (Codex at its next session start, F9), and creates the tag a pinned host moves to
when the operator re-pins. The order is therefore enforced at that merge.

A new gate in `scripts/check.sh`, "Release order", acts only when HEAD's agent line version has no
tag yet, which is true only on the agent line's release pull request. It reads the agent API version
at HEAD and at the newest `agention-v*` tag (versions only grow, so the newest suffices), and fails
unless that server serves HEAD's version and npm has it, naming the server release to merge and
publish first, and asking for the check to be run again. It reads every fetched tag rather than
those reachable from HEAD: a re-run checks the same merge commit, which predates the server's
release, while its checkout fetches every tag anew, and the tag ruleset already lets only the
release App create these tags, so reachability adds no trust. `ci-success` requires it, so the agent
release cannot merge first. The gate needs the network, so `--fast` skips it, as it does the
compatibility gates.

`main` does not require a branch to be up to date before it merges, so the gate's pass is as of its
last run. A change to the agent API version is a feature or fix of shared code, which makes
release-please refresh the agent release pull request and CI run the gate again; the residue is the
minute between such a merge and that refresh, which the maintainer closes by merging release pull
requests only once they are current, as CONTRIBUTING "Releasing" says.

When the agent API changes, CONTRIBUTING has the maintainer merge the agent release pull request as
soon as the server's release is published, so the window in which the sessions view asks for a
plugin that is not yet released lasts minutes (U4).

### Gates

- **Agent compatibility** keeps its meaning (every released bridge against the agent routes at
  HEAD), and finds released bridges from the `agention-mcp-v*` tags, which Migration step 1 gives
  every release.
- **Server compatibility** is new (section 2).
- **Release order** is new (above).
- `scripts/check.sh` otherwise does not change: CI checks both lines on every pull request.

### Migration

Both lines start from the last combined release, `vX.Y.Z` below: 0.6.0 (released 2026-11-23, UTC),
or a later one cut before the switch (R4, FRD ruling 3). Releases go on as usual until the operator
starts step 1. From then until the release-lines pull request merges, a matter of hours, no release
pull request merges, since a combined release cut after step 2 would need tags only the release App
could then create. An open release pull request is harmless: the server configuration's component
keeps the release branch's name and takes it over.

1. The operator creates `agention-vX.Y.Z` and `agention-mcp-vX.Y.Z` on the commit of every `v*`
   release, 0.1.0 to `vX.Y.Z`, since each published both packages. That starts no run while the
   workflow triggers on `v*` only, and the tag ruleset, whose only bypass actor is the release App,
   does not yet cover them. The `vX.Y.Z` pair seeds each line's history, so release-please neither
   walks back 500 commits nor compares the first changelog against a tag that does not exist (F6),
   and the rest let every gate read one prefix per line, never the legacy `v*` beside it.
2. The operator extends both tag rulesets to `agention-v*` and `agention-mcp-v*`: the one that
   restricts creation to the release App, and the one that makes version tags immutable (no update
   or deletion, no bypass), so a tag stays where the App put it and a moved tag cannot start a
   publish. They also extend the npm environment's tag rule, so only those tags can publish, and
   drop `v*` from it once the release workflow no longer triggers on it. Both rulesets keep
   protecting `v*`.
3. The two configurations are tried with release-please's dry run, pinned to the version the release
   action bundles and installed from a lock, against a scratch branch of fixture commits
   (server-only, agent-only, shared, docs-only, one that changes no shipped path, and a `fix(deps)`
   changing one line's manifest and the lockfile, which releases both), since the two-configuration
   pattern rests on reading the source (F3). The branch is deleted afterwards.
4. The release-lines pull request merges, with both manifests at `X.Y.Z`.

## 2. A newer bridge against an older server

### What the bridge says

The bridge already refuses every answer from a server older than itself (`#requireVersion` in
`apps/bridge/src/agent-api.ts`), errors included, so the server's own refusal of a newer bridge
never reaches an agent through a bridge: the bridge's message is the one C3 governs, and the one its
tests and the gate check. It is reworded to name the server's stated version, or its silence, and
the bridge's, and the operator's fix in terms of the lines' own releases: upgrade the Agention
server to its newest release, which by C2 serves every released bridge, and restart the session. It
no longer names the server "at the bridge's release", which stops meaning anything once the versions
differ.

### What the server says

The agent mount's `unsupported_version` refusals are reworded the same way. The refusal of a bridge
older than the server's oldest version, which bridges relay as the server wrote it, asks for the
plugin's newest release. The refusal of a newer bridge reaches only clients other than Agention's
bridges, and asks for the server's newest release. As today, both name agent API versions, never the
server's release.

### Servers before 0.3.0 (C3, C4)

Servers from 0.3.0 check the agent API version before any route, the registration route included, so
a newer bridge's call is refused before anything is recorded or done (proved at HEAD by the server's
agent API tests). Servers before 0.3.0, current for two days, state no version, so they act on a
request before the bridge refuses their answer. The bridge learns its session's grant only from a
registration answer it accepts, so a bridge that starts against such a server sends only
registration checks: a new key's registration is recorded pending, and expires unapproved within the
hour, and no tool call is carried out. Only a bridge that learned its grant before its server was
replaced by such a release has a call carried out there, without the fields that server does not
know, and then reported as failed. (The FRD's ruling 3 was asked on the broader reading, that any
approved session's call is carried out; delivery 4's design found the narrower behavior.) The bridge
could prevent both by checking the server's version once when it starts, but the operator chose to
accept and document it as a known limit of those three releases (FRD ruling 3), so the bridge does
not change; the operator guide says so, narrowing its statement that any older server leaves a
registration waiting to servers before 0.3.0.

### The server compatibility gate (C5)

A new gate in `scripts/check.sh`, beside agent compatibility and skipped by `--fast`, mirrors it in
the other direction. For each agent API version older than the bridge's at HEAD (a server that
states none counting as one), it takes the newest released server at that version (`agention-v*`
tags reachable from HEAD), today 0.2.1 (none), 0.4.0 (2) and 0.6.0 (3), and installs
`@wayfarerlabs/agention` from npm by exact version with signatures and provenance checked, starts
`agention serve` on loopback with a throwaway TLS certificate and data directory (every release
accepts `--tls-cert` and `--tls-key`), and runs the bridge at HEAD against it as an agent host
would. Every tool call fails with C3's refusal, and for servers from 0.3.0 the database holds no
registration afterwards. A server that serves the bridge's version is skipped: the agent
compatibility gate already covers bridges against the server at HEAD, and a server at the same
version serves the same contract, which is also why one server per older version suffices (FRD
ruling 4). The gate drives only unapproved sessions: approval changes nothing a starting bridge
sends to a server before 0.3.0, and from 0.3.0 the server refuses the version before authenticating.
The low-level design measures its run time against CI's limit for the `check` job.

## 3. The plugin-is-behind signal

### What the server records

The session row gains the agent API version stated on its last approved call (1 when the header is
missing), written on the path that already marks the session seen, and only when it changes. A
column rather than a value in memory, so the mark appears right after a server upgrade, before the
session calls again. The store adds it with an append-only migration.

### When a session is behind

A session is behind when it is live, having not reported `stopped` and holding an active credential,
and its recorded version is below the server's own (FRD ruling 5): a finished or revoked session's
fix no longer applies, so it is not marked. A session with no recorded call yet is not marked
either. Every released bridge states its version or, before 0.3.0, none, which reads as 1, so this
covers them all (U2).

### Where it shows

- **Sessions view**: the session's row carries a notice saying the server offers features its plugin
  cannot use, and the fix: update the Agention plugin on that agent's host to its newest release and
  restart the session. A current session shows nothing.
- **Operator API**: the sessions read gains a field carrying the same status, which is additive and
  stays in operator API v1, and the generated OpenAPI document shows it.
- **Register answer**: every answer already states the server's agent API version, so a bridge from
  this effort on that sees a newer server than itself adds a sentence to its register answer asking
  the agent to tell the operator, without failing the call (U3). The agent contract does not change,
  so the agent API version does not move.

## Alternatives considered

- **One configuration with `linked-versions` or `node-workspace`** (F5): neither routes a change to
  shared code to both lines, and `node-workspace` would release the bridge on every server release.
- **Checking the release order when the bridge publishes**: too late, since the merge has already
  changed the plugin unpinned hosts run and created the tag pinned ones move to; holding the publish
  only turns C3's refusal into a failed `npx` install.
- **Serving the plugin from a release tag** (F10): catalog entries with a `ref` would keep hosts off
  unreleased plugin changes on `main`, but the tag still exists before the bridge is on npm, and the
  catalog's ref becomes one more thing each release stamps. Not needed for this effort's
  requirements; a later change can adopt it.
- **A version check when the bridge starts**: it would spare servers before 0.3.0 their pending
  registrations, and the calls a bridge running across a downgrade has carried out, at a request per
  bridge start; the operator chose to document the limit instead (FRD ruling 3).
- **A separate plugin version**: the FRD excludes it.

## Documentation

- A new ADR 0005, "Separate release lines", supersedes ADR 0001's "One version covers the server,
  the bridge and the plugins", and ADR 0001's status names it.
- `docs/architecture.md`: "Source and packages" (the server-only contract), "Versions", "Generated
  plugins", "Agent bridge" (the refusal), "HTTP API" (the refusal wording), "Store" (the recorded
  version), "Web UI" (the notice).
- `CONTRIBUTING.md`: "Releasing" (two release pull requests, their merge order, the tags, where a
  new path that ships nothing is listed), "Checking a release", "Checks" (the server compatibility
  and release order gates), "The agent API", "One-time setup" (both tag rulesets, the npm
  environment and the release-please configurations), and "Commits and pull requests" (its
  one-version paragraph, and the rule for dependency commits).
- `docs/operator-guide.md`: "Installing the plugins" and "Upgrading", which pin the marketplace to a
  `v*` tag and will name an `agention-mcp-v*` one; upgrading the server and updating the plugin as
  separate steps; the one rule of U1; the sessions view's notice; the update steps on each host (F8,
  F9); and corrections to the claims that the hosts replace a plugin only when its version changes
  and that any older server leaves a registration waiting.
- `SECURITY.md` "Supported versions", which says only the latest release is supported: the latest of
  each line.
- `README.md` "Status" and repository layout, `docs/development-context.md` (gates, release facts,
  the contract packages), and `docs/review-checklist.md` or `docs/live-testing.md` where they name
  releases, the one version or a moved contract module.
- The comments in `.github/workflows/release-please.yml` and `release.yml` that name `v*`.
- The generated OpenAPI document, for the operator API's new field.

## Risks

- **Undocumented release-please pattern.** Mitigated by the dry run of Migration step 3, and by the
  release workflow's own check that a tag matches its line's versions.
- **Codex follows `main`.** A Codex host refreshes its plugin as soon as an agent release pull
  request merges, before the operator may have upgraded the server (F9). C2 orders the releases but
  cannot order the operator's installs; C3's refusal is what such a host sees. Graceful fallback is
  agention#16's, out of scope here.
- **Two approvals for a shared change.** A shared fix becomes two release pull requests; the release
  order gate keeps the agent one from merging first.
- **A stale gate pass.** Since `main` does not require current branches, the release order gate's
  pass can predate a change on `main` by the minute before release-please refreshes the pull request
  (Release order). Requiring current branches would close it for every pull request, at the cost of
  an update before each merge.
- **Dependency commits.** A dependency change touches the root lockfile, which both lines count as
  shared, so a feature or fix that also adds a server-only dependency would release an unchanged
  bridge. CONTRIBUTING has a dependency that a feature or fix needs go in its own `build(deps)`
  commit, which releases nothing, so the feature or fix touches only its line's paths. A dependency
  change that is itself the fix, such as a security bump, is `fix(deps)` and releases both lines,
  even when only one line's manifest changed: a residual of R2, accepted because the alternative
  would not release the fix at all, and cheap, since the agent API version does not move and the
  sessions view marks nothing. Nothing enforces the convention, and a missed split over-releases,
  the safe failure.
- **Exclusion lists drift.** A directory that ships nothing but is missing from both lists releases
  both lines; over-releasing is the safe failure, and review catches the list.
- **Root files.** release-please excludes only directories, so a releasing commit that also touches
  a root file that ships nothing (such as `CONTRIBUTING.md` or `.cspell.json`) releases both lines.
  CONTRIBUTING has such a change go in its own `docs:` or `chore:` commit, as with dependencies.
  Nothing enforces it, and a missed split over-releases, the safe failure: a residual of R2,
  reported to the operator.
