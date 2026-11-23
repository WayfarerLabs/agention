# Separate releases: the release lines LLD

- Status: Draft, for delivery 3
- Date: 2026-11-23
- Requirements: [FRD](frd.md) R1 to R4, C2, C3, E1, E2 and rulings 2 and 3; [HLA](hla.md) "Release
  lines" and "A newer bridge against an older server"; [plan](plan.md) delivery 3; research
  [prior-art-research.md](prior-art-research.md) F1 to F7
- Code cited at 65fd7e5, the delivery's base; release-please cited at 17.6.0, the version
  googleapis/release-please-action@45996ed (v5.0.0) bundles, as its `package-lock.json` at that
  commit locks it. Its sources are cited by their path in the release-please repository at
  `v17.6.0`; the npm package carries each compiled under `build/`.

This settles what the HLA leaves to delivery 3: the two configurations, the release workflow's tag
handling, the release order gate, the reworded refusals, the dry run that tried the configurations,
and the commit rules contributors follow. The configuration files are the only copy of their values;
this document gives the rules behind them.

## One finding against the HLA

The HLA's "Neither" row lists the root's Markdown and its lint and editor configuration among the
paths that ship nothing, to be excluded from both lines. release-please 17.6.0 cannot exclude a file
at the root. `CommitExclude.isRelevant` (`src/util/commit-exclude.ts`) matches a file against an
excluded path `p` only when the file starts with `p/`, after `normalizePaths`
(`src/util/commit-utils.ts`) strips any leading and trailing slash, so an excluded path is always a
directory, and no entry matches `CONTRIBUTING.md` or `.cspell.json`. A releasing commit that touches
a root file therefore releases both lines, which the dry run shows (fixtures F7 and F11 below).

Three ways to meet R2 for root files, none taken without the lead's ruling:

1. **A commit rule, as for dependencies** (what this delivery documents, pending that ruling): a
   change to a root file that ships nothing goes in a commit of its own whose type releases nothing,
   such as `docs:`, so the feature or fix it accompanies touches only its line's paths. A missed
   split over-releases, the safe failure, as the HLA's dependency rule already accepts.
2. **Moving what moves often into a directory.** `.cspell.json`, which features change for new
   words, could move to a directory both lines exclude, if cspell reads it there; the root Markdown
   (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`) stays where GitHub looks for it.
3. **Accepting the over-release** without a rule, which R2 does not allow.

F2 and F3 hold as stated: a commit reaches a root package unless every file it changes is excluded,
and two root packages in two configurations route shared and root changes to both.

## The configurations

`release-please-config.json` and `.release-please-manifest.json` are the server line;
`release-please-config.agent.json` and `.release-please-manifest.agent.json` the agent line. Each
holds one root package, `"."`, since only a root package sees commits outside every package's
directory (`CommitSplit.split`, `src/util/commit-split.ts`, skips `.`, and
`Manifest.buildPullRequests` in `src/manifest.ts` hands the root package every commit), and both
manifests start at `0.6.0`.

**What each line ships, and so excludes.** A line excludes the directories only the other line
ships, and the directories that ship nothing:

- the server line ships `apps/server`, `apps/web` and `packages/server-api`, and excludes the agent
  line's `apps/bridge`, `apps/agent-plugin`, `out`, `.claude-plugin` and `.agents`;
- the agent line ships those, and excludes the server line's three;
- both exclude `docs`, `scripts` and `.github`;
- what neither excludes is shared: `packages/api`, `packages/build`, `packages/private-files`, and
  every root file, the root `package.json` and the lockfile among them.

A new top-level directory that ships nothing joins both lists; until it does, it releases both
lines, the safe failure.

**Options, each read at 17.6.0.** `parseConfig` and `extractReleaserConfig` in `src/manifest.ts`
read every option used:

| Option                   | Where                 | Why                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-type`           | package               | `node` for the server line, which writes the root `package.json` and the lockfile's root entries (`src/strategies/node.ts`, `src/updaters/node/package-lock-json.ts`); `simple` for the agent line, whose only own file, `version.txt`, is written only if it exists (`src/strategies/simple.ts`) |
| `component`              | package               | The tag `<component>-v<version>` (`src/util/tag-name.ts`, `include-component-in-tag` defaulting to true in `src/strategies/base.ts`), the release branch `release-please--branches--main--components--<component>`, and the release pull request's title                                          |
| `package-name`           | package, server line  | Kept as it was; the component no longer falls back to it                                                                                                                                                                                                                                          |
| `changelog-path`         | package, agent line   | `apps/bridge/CHANGELOG.md`; the server line keeps the default, `CHANGELOG.md`                                                                                                                                                                                                                     |
| `exclude-paths`          | package               | Above                                                                                                                                                                                                                                                                                             |
| `extra-files`            | package               | Every other place the line's version appears: the server's `package.json` and lockfile entry; the bridge's `package.json` and lockfile entry, the plugin definition, both generated manifests, and the bridge's package spec in both generated `.mcp.json` files                                  |
| `label`, `release-label` | top level, agent line | `autorelease-agent: pending` and `autorelease-agent: tagged`; the server line keeps the defaults, `autorelease: pending` and `autorelease: tagged` (`DEFAULT_LABELS` and `DEFAULT_RELEASE_LABELS` in `src/manifest.ts`)                                                                           |
| `bump-minor-pre-major`   | package               | As before, both lines                                                                                                                                                                                                                                                                             |

`include-component-in-tag: false` goes, so tags carry the component. The server line's component,
`agention`, matches the branch name its open release pull request already has, since a package's
branch component was its package name before (`getBranchComponent` in `src/strategies/base.ts`), so
an open release pull request is taken over, as the HLA says.

**Why the labels differ.** `createPullRequests` in `src/manifest.ts` opens or updates no release
pull request while `findMergedReleasePullRequests` finds a merged pull request carrying all of the
configuration's pending labels, and `createReleases` tags only those. Shared labels would make one
line's merged, untagged release pull request stop the other line's updates, and offer it to the
other line's tagging, which its component check would then skip. The labels are top-level options:
`parseConfig` reads them into the manifest's options, which both searches use.

**Legacy tags.** Releases tagged `v0.1.0` to `v0.6.0` parse with no component (`TagName.parse`,
`src/util/tag-name.ts`), which neither configuration has, so both skip them (`getLatestReleases` in
`src/manifest.ts`) and fall back to the tag the manifest's version names, `agention-v0.6.0` or
`agention-mcp-v0.6.0` (`backfillReleasesFromTags`), as F6 says. Without that tag a line walks back
up to 500 commits, which is why the operator seeds the tags first.

**The agent line's changelog** is new, with a heading `[0.6.0 and earlier]` that points at the
root's changelog. release-please inserts each entry before the first `## [` or `## <digit>` heading
(`Changelog.updateContent`, `src/updaters/changelog.ts`), so entries land above it. It is ignored by
Prettier and cspell as `CHANGELOG.md` already is (their patterns match at any depth), and added to
markdownlint's ignores, whose pattern is rooted.

## The release workflow

`release.yml` triggers on `agention-v*` and `agention-mcp-v*`; the first does not match the second.
A workflow-level `env` maps the tag's prefix to the line's prefix and package, from
`github.ref_name` alone, so the publish job, which runs no repository code, reads them without
trusting the build job.

- The build job runs `scripts/check-release-tag.sh "$GITHUB_REF_NAME"`. The script finds the line
  whose configuration's component, followed by `-v`, starts the tag; the version is the rest. It
  checks the manifest's `"."`, the files the release type writes (for `node`: `package.json`
  `$.version`, and the lockfile's `$.version` and `$.packages[''].version`; for `simple`: none, and
  any other type fails), and every `extra-files` entry, by evaluating its jsonpath (the forms `$`,
  `.name`, `['name']` and `[n]`; any other fails). A place holds the version when the first version
  in its string is the version, as release-please's JSON updater replaces the first one
  (`src/updaters/generic-json.ts`). Every mismatch is named, then it fails.
- `scripts/check.sh --packages` builds and checks both packages, as before, into a scratch
  directory, and only the tag's package's tarball moves to the uploaded artifact.
- The publish job checks the tarball's `name@version` against the tag's package and version, skips
  it if npm has that version, and publishes it otherwise. The bridge-first order goes, since one run
  publishes one package.

`scripts/check-release-tag.test.sh` copies the script, both configurations and every file they write
into a scratch directory, sets the lines to versions of its own, and checks that each line's tag
passes, the other line's version and a legacy `v` tag fail, and a single place out of step fails its
own line and not the other.

## The agent compatibility gate

`scripts/check-agent-compatibility.sh` lists `agention-mcp-v*` tags reachable from HEAD, apart from
those on HEAD, instead of `v*`, and installs each version, as before.

## The release order gate

`scripts/check-release-order.sh`, a `scripts/check.sh` step after agent compatibility, skipped by
`--fast`:

1. The agent line's version is the agent manifest's `"."`. If a tag `agention-mcp-v<version>`
   exists, HEAD is no agent release; it passes. That is every pull request but the agent line's
   release pull request, and `main` once its tag exists.
2. The server release is the newest `agention-v*` tag by version
   (`git tag --sort=-version:refname`), among every fetched tag, reachable from HEAD or not: a
   re-run checks the same merge commit, which predates the server's release, while CI's checkout
   fetches every tag anew, and the tag rulesets let only the release App create these tags. None
   fails, asking for `git fetch --tags`.
3. `agentApi` is read at HEAD and at that tag from `packages/api/src/agent-api.ts`, compiled with
   the repository's esbuild and run with its imports resolved from the contract's directory, so the
   value read is the one built, however the source is written. The repository's TypeScript, 7, has
   no JavaScript compiler API to read it with.
4. It fails unless the server's `oldest` to `version` includes HEAD's `version`, naming both and
   asking for the server line's release to be merged and published first and the check run again.
5. It fails unless `npm view @wayfarerlabs/agention@<server version> version` prints that version,
   with npm's own error above. This is its one network call.

`ci-success` requires the `check` job, which runs it, so the agent release pull request cannot merge
first. Its fixture test, `scripts/check-release-order.test.sh`, builds repositories with a copy of
the gate and the agent manifest and contract, tags commits as the lines would, and puts an `npm`
stub first on `PATH` that knows only the versions a case publishes. The cases: an agent version
already tagged passes whatever the servers; an untagged one passes only when the newest server
serves it and npm has it; a server without the version, or no longer serving it, fails; the newest
by version wins over a later-created lower one; a tag HEAD does not reach counts; a legacy `v` tag
is no server release. Both fixture tests run in a "Release scripts" step that needs no network.

Until the operator creates the seed tags, `agention-mcp-v0.6.0` does not exist, so on this
delivery's own pull request the gate acts and fails for want of an `agention-v*` tag, as the agent
compatibility gate fails for want of an `agention-mcp-v*` one. Both pass once the tags exist.

## The refusals

`#requireVersion` (`apps/bridge/src/agent-api.ts:392-402`) names the server's stated agent API
version, or that it states none (as servers before 0.3.0 do; a missing header otherwise reads as 1,
so it is checked first), or that it states none the bridge can read, then the bridge's release and
agent API version, and asks the operator to upgrade the server to its newest release and restart the
session (FRD C3). The settings guide's link (`apps/bridge/src/errors.ts:44-46`) names the bridge's
release tag, `agention-mcp-v<version>`, since no `v<version>` tag exists for a later bridge.

`requireServedAgentApiVersion` (`apps/server/src/http/agent-api-version.ts:31-49`) asks an older
bridge's operator to update the plugin to its newest release and a newer client's to upgrade the
server to its newest release, still naming only agent API versions.

Tests assert behavior, not wording: an older server's refusal is the same for its answers and its
failures and differs between a server stating an older version and one stating none
(`apps/bridge/src/tools.test.ts`); a newer server's `unsupported_version` refusal reaches the agent
as the server gave it, which is how bridges relay the older-bridge refusal; and the server's
existing tests refuse both directions as `unsupported_version` before recording anything
(`apps/server/src/http/agent-api.test.ts`, `agent-api-oldest.test.ts`).

## The dry run

release-please 17.6.0 was installed exactly, from a lockfile, with lifecycle scripts off, into a
scratch directory, outside the repository's lockfile. The version is pinned below the newest stable
release (17.11.2 at the time) because the dry run tries what the pinned action runs. npm verified
its registry signatures.

The scratch branch `scratch/release-lines-dry-run` held this delivery's first four commits, with the
configurations as 798ee39 commits them, then one dry-run-only commit setting `last-release-sha` in
both configurations to the last of those four (the seed tags it stands in for did not exist yet),
then one fixture commit per case, each of a type that releases. Each configuration was run with:

```bash
node <scratch>/node_modules/release-please/build/src/bin/release-please.js release-pr \
  --dry-run --trace --token <read token> --repo-url WayfarerLabs/agention \
  --target-branch scratch/release-lines-dry-run \
  --config-file <configuration> --manifest-file <manifest>
```

The dry run builds the release pull requests and prints them without writing anything
(`src/bin/release-please.ts`). A line released a fixture when its release pull request's changelog
lists that fixture's commit; `--trace` shows each file the pull request would change.

| Fixture | Commit                                              | Server line | Agent line | As the HLA expects |
| ------- | --------------------------------------------------- | ----------- | ---------- | ------------------ |
| F1      | `feat(server)`, `apps/server` only                  | yes         | no         | yes                |
| F2      | `feat(bridge)`, `apps/bridge` only                  | no          | yes        | yes                |
| F3      | `fix(api)`, `packages/api` only                     | yes         | yes        | yes                |
| F4      | `feat`, `docs/` only                                | no          | no         | yes                |
| F5      | `fix`, `scripts/` and `.github/` only               | no          | no         | yes                |
| F6      | `fix(deps)`, `apps/server/package.json`, lockfile   | yes         | yes        | yes                |
| F7      | `feat(server)`, `apps/server` and `CONTRIBUTING.md` | yes         | yes        | no: server only    |
| F8      | `feat(server)`, `apps/server` and `docs/`           | yes         | no         | yes                |
| F9      | `feat`, `packages/server-api` only                  | yes         | no         | yes                |
| F10     | `feat(plugin)`, the usage skill only                | no          | yes        | yes                |
| F11     | `fix`, `.cspell.json` only                          | yes         | yes        | no: neither        |

Each line's release pull request was its own: `chore(<branch>): release agention 0.7.0` on
`release-please--branches--<branch>--components--agention`, and
`chore(<branch>): release agention-mcp 0.7.0` on `...--components--agention-mcp`, each comparing
against its own `0.6.0` tag. The server's would change the root and server `package.json`, the
lockfile's root and server entries, `CHANGELOG.md` and its manifest; the agent's the bridge's
`package.json` and lockfile entry, the plugin definition, both generated manifests and `.mcp.json`
files, `apps/bridge/CHANGELOG.md`, above its earlier-releases heading, and its manifest, and no
`version.txt`. Both skipped the `v*` releases as having no component. The branch was deleted from
the repository afterwards.

## The commit rules

CONTRIBUTING "Commits and pull requests" states which line a commit releases and three rules: a
feature or fix keeps to its line's paths, with any docs under `docs/`, and a change to a root file
that ships nothing goes in a commit of its own that releases nothing (pending the lead's ruling
above); a dependency a feature or fix needs goes in its own `build(deps)` commit, while one that is
itself the fix is `fix(deps)` and releases both lines; a new top-level directory that ships nothing
joins both configurations' exclusions.
