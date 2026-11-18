# Agention v1: Repository LLD

- Status: Delivery 1 implemented the Go shape (agention#3); amended 2026-10-27 for the move to
  TypeScript (FRD ruling 28), which Delivery 2 implements
- Date: 2026-10-25
- Governs: plan Delivery 1, and the repository move in Delivery 2
- Requirements: FRD R35 (generated plugins), R37 (open source, TypeScript), R38 (reproducible,
  consistent with siblings), R39 (public-ready); rulings 20 (task runner) and 28 (TypeScript), and
  the workspace FRD W4/W5.

## Layout

```text
agention/
  package.json, package-lock.json   npm workspaces and repository tooling; one lockfile
  tsconfig.base.json            shared strict compiler options
  packages/api/                 request and response schemas, bounds, error codes (private)
  packages/build/               the bundler and its third-party notices (private)
  packages/private-files/       the private-file rule the server and the bridge share (private)
  apps/server/                  @wayfarerlabs/agention: the server and operator CLI
  apps/bridge/                  @wayfarerlabs/agention-mcp: the agent bridge
  apps/web/                     React UI (private; its build ships inside the server package)
  apps/agent-plugin/            canonical plugin definition and its generator
  out/claude-plugin/            generated Claude Code plugin, committed
  out/codex-plugin/             generated Codex plugin, committed
  .claude-plugin/marketplace.json   generated Claude Code catalog
  .agents/plugins/marketplace.json  generated Codex catalog
  docs/                         architecture, operator guide, security
  docs/adrs/                    decision records (.adr-dir), agentworks format
  scripts/                      check, lint, plugin generation (bash, sibling style)
  README.md CONTRIBUTING.md SECURITY.md LICENSE CHANGELOG.md
```

- Every component is an npm workspace. The root `package.json` lists them and holds the repository's
  own tools (Prettier, markdownlint-cli2, cspell, TypeScript, Vitest, esbuild).
- `packages/api` is imported as source by the server, the bridge and the web UI, so a contract
  change fails the type check of every side it breaks.
- `packages/private-files` holds the one rule for secrets on disk, which the server applies to its
  data directory and database and the bridge to each session's key; both bundles inline it.
- Source runs directly under Node's type stripping in development and tests, so `tsconfig` enables
  `erasableSyntaxOnly` and `verbatimModuleSyntax`, and imports name their `.ts` files. Published
  packages are esbuild bundles.
- The plugin generator is TypeScript (`node apps/agent-plugin/gen/main.ts`), tested with the rest.
  It follows nerftools' shape: one canonical definition renders per-host plugin directories and both
  catalogs. The outputs are fixed paths owned by the generator, which replaces them wholesale; it
  refuses to follow a symlink anywhere on an output path and writes each file by rename, so a
  checked-out tree cannot redirect a write outside the repository.

## Task runner

Bash scripts in the sibling style, no Nx and no Makefile (ruling 20 leaves the choice open; this is
the simplest that covers backend, frontend and plugin generation):

| Script                                  | Does                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `scripts/check.sh`                      | Every CI gate in CI's order; `--fast` skips the builds and the browser run |
| `scripts/lint-files.sh [--fix]`         | Prettier, markdownlint, cspell on the repository                           |
| `scripts/generate-plugins.sh [--check]` | Render the plugins and catalogs, or fail on drift without writing          |

CI runs `scripts/check.sh`, so local and CI gates cannot diverge. Workspace `npm` scripts stay for
single-component work (`dev`, `test`, `build`).

## Toolchain and supply chain

- `.node-version` pins Node; npm is the version bundled with it (no separate npm pin, which broke
  installs in the predecessor). A local Node that differs from the pin is a warning, since CI
  installs the pinned version.
- `.npmrc` sets `ignore-scripts=true`, so every install, including `npm install` of a new
  dependency, skips lifecycle scripts. No dependency may need an install script, which also rules
  out native addons; SQLite comes from `node:sqlite`. `npm audit signatures` runs in CI.
- Every tool and dependency is pinned exactly by the lockfile alone, with no separate version files.
  Line width is configured once, in `.prettierrc`.
- Actions pinned by full SHA with the version in a comment, verified against the release tag.
- Dependabot: `npm` and `github-actions` at `/`, weekly on Monday, patch and minor grouped, majors
  standalone, `chore(deps)` Conventional Commit prefixes, as in the siblings.
- The published packages are bundles that declare no dependencies, so `npx` and `npm install`
  resolve nothing beyond what the lockfile built: what a bundle inlines, other workspaces included,
  is a `devDependency`, and the pack check fails a package that declares any dependency. The build
  writes `THIRD-PARTY-NOTICES.txt` beside each bundle, and each published package carries a copy of
  the repository's `LICENSE`.
- Private workspaces use the `@wayfarerlabs` scope too, so no workspace name sits in a scope someone
  else could publish under.
- Dependency choices with supply-chain weight are recorded in ADR 0001's repository and supply chain
  section.

## Checks

| Gate                 | Command (inside `scripts/check.sh`)                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency integrity | `npm ci`, `npm audit signatures`                                                                                                                                 |
| Format and lint      | `scripts/lint-files.sh`                                                                                                                                          |
| Types                | `tsc --noEmit` for each workspace                                                                                                                                |
| Tests                | `vitest run` across the workspaces                                                                                                                               |
| Vulnerabilities      | `npm audit --audit-level=high`                                                                                                                                   |
| Build                | The web build, then the server and bridge bundles; each package is packed, and its bin, run from the unpacked package outside the repository, prints its version |
| Browser              | The Playwright run (Delivery 2 adds it)                                                                                                                          |
| Plugin drift         | `scripts/generate-plugins.sh --check` (extra, missing and changed entries)                                                                                       |

CI runs the gates in one job, `check`; an aggregate `ci-success` job is the required status check,
the name the shared preferred GitHub configuration requires in every Wayfarer repository.

## Releases and versioning

release-please with one component (`.`) of release type `node` (Delivery 1 used `go`), Conventional
Commits, `CHANGELOG.md`. Releases start at 0.1.0 (`initial-version`, since release-please ignores a
`0.0.0` manifest entry and would otherwise start at 1.0.0) and stay below 1.0.0
(`bump-minor-pre-major`) until the operator cuts 1.0.0 with a `Release-As: 1.0.0` footer. The
version flows, through release-please `extra-files` JSON paths, to:

- the root `package.json` and the lockfile's root entry, which the `node` release type updates
  itself;
- `$.version` in `apps/server/package.json` and `apps/bridge/package.json`, and their entries in
  `package-lock.json`, so the next `npm install` changes nothing; each bundle embeds its package's
  version at build time, and `agention version` prints it;
- `$.version` in the canonical `apps/agent-plugin/plugin.json` and in both generated manifests;
- the bridge's package spec in both generated MCP entries (the canonical definition names the
  package alone, and the generator appends the plugin's version). The JSON updater replaces only the
  version inside a string, so `@wayfarerlabs/agention-mcp@0.1.0` stays one argument.

JSON cannot carry an `x-release-please-version` comment, and updating the generated files in the
same commit keeps the release pull request drift-free without a second job or bot commit.

A tag-triggered release workflow, `release.yml`, publishes both packages to npm through trusted
publishing, with provenance. Its build job holds no OIDC token: it refuses a tag that is not both
packages' and the plugin's version, and runs the package checks of `scripts/check.sh`, which keep
the tarballs they proved. Its publish job runs no repository code: in an `npm` environment that only
`v*` tags may use, it publishes exactly those tarballs, bridge first, skipping a version already on
npm. Each package's trusted publisher names the workflow and the environment, and a tag ruleset
leaves creating `v*` tags to the release-please App alone, whose key is a secret of an environment
only `main` may use, and `main` takes changes only through reviewed pull requests with the required
checks (the preferred configuration's branch protection), so only a release pull request merged to
`main` publishes; the tagged commit supplies its own workflow, so a guard inside it could not stand
in for the ruleset (ruling 52). npm sets a trusted publisher only on a package that exists, and
expires one that has not published within two days of being set up, so a new package starts as a
stub `0.0.0-placeholder`, published by the operator and deprecated, and its trusted publisher is set
up just before the release that first publishes it; `0.0.0` itself stays unpublished, since that is
what the committed plugins pin before the first release. The first release, 0.1.0, ends Delivery 2
(ruling 50).

## Public documentation (R39)

- `README.md`: what Agention is, its status, the trust model in one sentence linking `SECURITY.md`,
  and pointers to CONTRIBUTING and the repository layout. The quick start and the Tailscale guide
  link arrive with the server they describe.
- `CONTRIBUTING.md`: the development contract's public facts (prerequisites, `scripts/check.sh`,
  each gate, commit convention, pull request expectations, ADR process).
- `SECURITY.md`: reporting, supported versions, the security model's invariants.
- `docs/architecture.md`, `docs/operator-guide.md` (including running behind `tailscale serve`).
- `docs/adrs/`: `0000-record-architecture-decisions.md` and `0001-agention-v1-architecture.md`
  recording the v1 architecture (decisions promoted from this SDD).

No Rulesync sources or generated agent guidance in the repository (R39).

## Moving from Go (Delivery 2)

Delivery 1 built this layout's Go form: a root `go.mod`, `cmd/agention` printing its version, and a
Go plugin generator, with `gofmt`, `go vet`, staticcheck, govulncheck and race tests in the checks.
Delivery 2 removes all of it in the same change that adds the TypeScript components, along with the
Go toolchain pins, the `gomod` Dependabot entry, the Go steps in CI and the `go` release type, and
updates ADR 0001, CONTRIBUTING, SECURITY, `docs/architecture.md`, the operator guide and the README
to match. Nothing in Go survives the delivery.

## Delivery 1 definition of done

- The layout's Go form exists with an empty but buildable server (`agention version`), a minimal web
  app, and a plugin generator that renders a placeholder plugin.
- `scripts/check.sh` passes locally and in CI on a pull request; Dependabot and release-please are
  configured.
- The public documentation skeleton exists, with ADR 0001 recording the v1 architecture.
- `docs/projects/agention.md` in the workspace indexes the new docs instead of naming gaps.
