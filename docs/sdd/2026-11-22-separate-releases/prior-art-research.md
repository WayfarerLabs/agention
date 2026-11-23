# Separate releases: Prior art and research

- Date: 2026-11-22
- Scope: how release-please releases several lines from one repository, and how Claude Code and
  Codex pick up a new plugin version. Each finding names the design decision it informs.

## Summary

- release-please routes a commit to a package by the paths it touches, and only the root package
  `"."` sees commits outside every package's directory. No single configuration gives two lines that
  both release on a change to shared code (`packages/`), which R2 needs; two configurations, each a
  root package excluding the other line's paths, do, though no documentation shows that pattern.
- Moving from the one `v*` line to component tags needs a seeded starting point per line, or
  release-please walks most of the history for its first changelog.
- Claude Code replaces an installed plugin only when its version changes, and does not update
  third-party marketplaces on its own by default, so once server-only releases stop changing the
  plugin's version, nothing tells the operator a plugin update exists unless Agention does (U2, U3).
- Codex, by its source, refreshes plugins from a git marketplace whenever the marketplace's revision
  moves, whatever their version, which makes the release order (C2) matter more there.

## Findings

### Release tooling

**F1. Components and tags.** In manifest mode each package takes a `component`, and
`include-component-in-tag` (default true) tags its releases `<component>-v<version>`, such as
`agention-v0.7.0` and `agention-mcp-v0.7.0`. A changelog path is per package. With more than one
package in one configuration, `separate-pull-requests` defaults to false, giving one combined
release pull request. Sources: S1, S2, S3. Informs: the tag names, and the release workflow's
triggers (`agention-v*` does not match `agention-mcp-v*`).

**F2. Routing commits.** A commit belongs to a package when a file it changes lies under the
package's path; files outside every package's path reach only the root package `"."`.
`exclude-paths` drops a commit from a package only when all its files are excluded. There is no
option to add paths to a package: `additional-paths` is an open pull request (S5), in no release.
Sources: S4, S6. Informs: R2's routing, which one configuration cannot give, since `packages/api`
changes would reach only one line.

**F3. Two configurations.** Two configurations, each with one root package and `exclude-paths` for
the other line's directories, route shared and root changes to both lines and each line's own
changes to it alone. Each runs as its own step of the release-please action, with its own manifest
and outputs, and keeps its own release pull request. Inferred from the source of release-please
17.6.0 (the version the pinned action bundles), not documented or tried. Informs: the HLA's release
configuration, and its verification step before the first split release.

**F4. Updating more than one file.** `extra-files` with the `json` type and a `jsonpath` replaces
only the semantic version inside a string, so the bridge's package spec in each generated
`.mcp.json` keeps updating as today; the `simple` release type writes no `package.json`, which lets
the agent line avoid the root `package.json` the server line owns. Sources: S7, S8. Informs: the
agent line's configuration.

**F5. Plugins to avoid.** `node-workspace` would bump the bridge on every server release, through
its workspace dependency, which defeats R2; `linked-versions` ties components in one configuration
but cannot route shared commits. Source: S9. Informs: the HLA's alternatives.

**F6. Migrating from `v*`.** Once components are set, tags without a component (`v0.6.0`) match no
package and are ignored. release-please then looks for `<component>-v<manifest version>`, and
without it walks back to `bootstrap-sha` or up to 500 commits. Seeding `agention-v0.6.0` and
`agention-mcp-v0.6.0` on the 0.6.0 release commit avoids both the walk and a changelog comparing
against a tag that does not exist. The seed tags must exist before the tag ruleset covers their
prefixes, since its only bypass actor is the release App. Source: S10. Informs: R4 and the HLA's
migration order.

**F7. Commit types that release.** Only `feat`, `fix` and `perf` commits, and breaking changes,
release. Dependabot here commits as `chore`, and docs, tests, refactors and CI changes use their own
types. But a feature or fix usually carries its docs, and any file outside a line's path reaches the
other configuration: of the four releasing commits between 0.5.0 and 0.6.0, three touch both a
line's path and docs, `CONTRIBUTING.md`, `.cspell.json` or `packages/api`. Across main's history, 19
of 90 releasing commits touch `packages/` and no agent-line path (18 of them `packages/api`), and
about 12 of those are work only the server uses. Since 0.1.0 no releasing commit has touched the
lockfile: every dependency change was its own non-releasing commit (Dependabot's `chore(deps)` and
one `build(deps)`), so the HLA's rule for dependency commits writes down existing practice. Source:
the repository's `.github/dependabot.yml` and history. Informs: the HLA's exclusion of paths that
ship nothing, its move of the server-only contract out of `packages/api`, and its rule for
dependency commits.

### Agent hosts

**F8. Claude Code updates by version.** Claude Code replaces an installed plugin only when its
computed version differs from the installed one, takes the version from `plugin.json` first, and
caches each version in its own directory. Auto-update is on only for Anthropic's own marketplaces;
for a third-party marketplace each user turns it on. A running session keeps its MCP servers on the
old version until `/reload-plugins` or a restart. Sources: S11, S12, S13. Informs: R2's benefit (no
update prompt for an unchanged plugin), U1 to U3 (nothing else tells the operator), and the operator
guide's update steps, where `marketplace update` then `plugin update` suffices.

**F9. Codex refreshes by revision.** Codex's source starts a background upgrade of every git
marketplace at session start, reinstalling its plugins whenever the marketplace's revision moved,
regardless of version, and asks running threads to restart their MCP servers. Codex's documentation
does not say either. Source: S14, S15. Informs: C2, since a Codex host following `main` picks up a
new bridge as soon as its release pull request merges; and a correction to the operator guide, which
says the hosts replace a plugin only when its version changes. Unverified live.

**F10. Pinning a plugin to a tag.** Both hosts' marketplaces accept a `git-subdir` plugin source
with a `ref`, so a marketplace could serve the plugin from a release tag instead of the default
branch. Sources: S13, S14. Informs: an alternative the HLA weighs against C2's release order.

**F11. No host announces updates.** Neither host lets a plugin or MCP server tell the user an update
is available; Claude Code reports only an update it already made. Sources: S12, S14. Informs: U2 and
U3, which put the signal in Agention.

## Refuted or not relied on

- `additional-paths` as a way to route shared code to a second package: not released (S5).
- `linked-versions` as a way to keep both lines in step: it ties versions, not commit routing (S9).
- The plugin version gating updates on Codex: its source reinstalls regardless (F9).

## Open questions

- Whether two release-please configurations behave as the source suggests, which the plan verifies
  on a fork or a dry run before the first split release.
- Whether Codex restarts a running session's bridge on upgrade, which a live test checks.

## Sources

| ID  | Source                                                                                         | Quality                     | Angle                     |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------- | ------------------------- |
| S1  | <https://github.com/googleapis/release-please/blob/v17.6.0/docs/manifest-releaser.md>          | Official docs               | Manifest configuration    |
| S2  | <https://github.com/googleapis/release-please/blob/v17.6.0/src/manifest.ts>                    | Source, pinned version      | Defaults, release lookup  |
| S3  | <https://github.com/googleapis/release-please/blob/v17.6.0/src/util/tag-name.ts>               | Source, pinned version      | Tag parsing               |
| S4  | <https://github.com/googleapis/release-please/blob/v17.6.0/src/util/commit-split.ts>           | Source, pinned version      | Commit routing            |
| S5  | <https://github.com/googleapis/release-please/pull/2534>                                       | Open pull request           | `additional-paths`        |
| S6  | <https://github.com/googleapis/release-please/blob/v17.6.0/src/util/commit-exclude.ts>         | Source, pinned version      | `exclude-paths`           |
| S7  | <https://github.com/googleapis/release-please/blob/v17.6.0/docs/customizing.md>                | Official docs               | `extra-files`             |
| S8  | <https://github.com/googleapis/release-please/blob/v17.6.0/src/updaters/generic-json.ts>       | Source, pinned version      | JSON updater              |
| S9  | <https://github.com/googleapis/release-please/blob/v17.6.0/docs/manifest-releaser.md#plugins>  | Official docs               | Plugins                   |
| S10 | <https://github.com/googleapis/release-please/blob/v17.6.0/docs/manifest-releaser.md>          | Official docs and source    | Bootstrapping             |
| S11 | <https://code.claude.com/docs/en/plugins/host-marketplace.md>                                  | Official docs               | Versions and releases     |
| S12 | <https://code.claude.com/docs/en/plugins/loading.md>                                           | Official docs               | Updates, cache, reloading |
| S13 | <https://code.claude.com/docs/en/plugins/marketplace-reference.md>                             | Official docs               | Plugin sources and refs   |
| S14 | <https://developers.openai.com/plugins/build/plugins>                                          | Official docs               | Codex marketplaces        |
| S15 | <https://github.com/openai/codex>, `codex-rs/core-plugins/src/manager.rs` and `store.rs`, main | Source, unreleased revision | Codex auto-upgrade        |
