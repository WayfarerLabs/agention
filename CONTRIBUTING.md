# Contributing

Contributions of every size are welcome, from typo fixes to features. For anything beyond a small
fix, please open an issue or discussion first so the approach can be agreed before you invest in it.

Agention holds a high bar for design, code and documentation. This guide explains what a change
needs before it can merge.

## Prerequisites

- **Node.js** at the exact version in [`.node-version`](.node-version), with the npm it bundles.
  Version managers such as mise and asdf can read `.node-version` once their idiomatic (legacy)
  version file support is enabled for Node.
- **Git** and **Bash**.

Install the locked npm dependencies once, and again whenever `package-lock.json` changes:

```bash
npm ci --ignore-scripts
```

`.npmrc` also disables lifecycle scripts for every npm command, so no dependency's install script
ever runs. `scripts/check.sh` runs `npm ci` itself as its first gate.

The browser gate needs Chromium's headless shell, at the version the lockfile pins. Install it once
after installing the dependencies, and again when the `@playwright/test` version changes:

```bash
npx playwright install --only-shell chromium
```

On Linux, `npx playwright install --with-deps --only-shell chromium` also installs the system
libraries it needs, as CI does.

## Repository structure

Every component is an npm workspace, listed in the root `package.json`, and one root
`package-lock.json` locks them all. The root `package.json` also holds the repository's own tools:
TypeScript, Vitest, esbuild, Prettier, markdownlint-cli2 and cspell.

| Workspace                | Package                                          | What it is                                                              |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------- |
| `packages/api`           | `@wayfarerlabs/agention-api` (private)           | The API contract the bridge shares with the server and the web UI       |
| `packages/build`         | `@wayfarerlabs/agention-build` (private)         | The bundle build the published packages use                             |
| `packages/private-files` | `@wayfarerlabs/agention-private-files` (private) | The private-file rule the server and the bridge share                   |
| `packages/server-api`    | `@wayfarerlabs/agention-server-api` (private)    | The rest of the API contract, which only the server and the web UI ship |
| `apps/server`            | `@wayfarerlabs/agention`                         | The server and the `agention` operator CLI                              |
| `apps/bridge`            | `@wayfarerlabs/agention-mcp`                     | The agent bridge, the `agention-mcp` command                            |
| `apps/web`               | `@wayfarerlabs/agention-web` (private)           | The React web UI, built with Vite                                       |
| `apps/agent-plugin`      | `@wayfarerlabs/agention-agent-plugin` (private)  | The canonical plugin definition and its generator                       |

The API contract's packages, `@wayfarerlabs/agention-api` and `@wayfarerlabs/agention-server-api`,
have no build step: their `exports` point at their TypeScript source, so a workspace that imports
them type-checks against the contract itself, and a change to the contract fails the type check of
every side it breaks. `@wayfarerlabs/agention-server-api` builds on `@wayfarerlabs/agention-api` and
never the reverse, and the bridge never bundles it, which `apps/bridge/src/bundle.test.ts` holds;
[architecture](docs/architecture.md#source-and-packages) says which package a module belongs in.

A workspace that imports another declares it in its `package.json` with the range `*`. The published
packages declare it under `devDependencies`, like everything else their bundles include (see
[Dependencies](#dependencies)).

### TypeScript

Node runs the TypeScript sources directly by stripping their types, in development and for the
plugin generator; Vitest compiles them for the tests. Each workspace's `tsconfig.json` extends
[`tsconfig.base.json`](tsconfig.base.json), which keeps every source runnable under Node:

- only erasable syntax (`erasableSyntaxOnly`): no enums, namespaces or parameter properties;
- type-only imports and exports marked with `type` (`verbatimModuleSyntax`);
- relative imports name the `.ts` file they import, such as `./cli.ts`.

The base configuration is strict, including `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. The web UI overrides only what a browser bundle needs.

## Building

The server and the bridge each build into a single-file esbuild bundle, which is what their npm
packages contain, through `packages/build`. The server's build first builds the web UI, with Vite
and then, through `packages/build`, the diagram frame's script, and copies it into
`apps/server/web/`, which the server package ships and serves. Beside each bundle the build writes
`THIRD-PARTY-NOTICES.txt`, the license of every npm package the bundle includes and, for the server,
of every package in the web UI's build. Each bundle also includes its package's `package.json`, so
it reports the version it was built at:

```bash
npm run -w apps/server build      # apps/web/dist/, apps/server/web/, apps/server/dist/agention.js
node apps/server/dist/agention.js version

npm run -w apps/bridge build      # apps/bridge/dist/agention-mcp.js
node apps/bridge/dist/agention-mcp.js --version

npm run -w apps/web build         # apps/web/dist/ alone
```

During development you can run a command from source instead, for example
`node apps/server/src/main.ts version`. Run from source, the server serves the web UI in
`apps/server/web/` if a build put one there, and a placeholder page otherwise.

## Checks

`scripts/check.sh` runs every gate CI requires, in CI's order. CI runs the same script, so a local
pass means CI will pass the same checks.

```bash
scripts/check.sh                  # everything CI runs
scripts/check.sh --fast           # skips the agent and server compatibility and release order gates, the builds and the browser gate
scripts/check.sh --packages DIR   # only the install and the build, keeping the checked tarballs in DIR
```

| Gate                       | What it guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency integrity       | A clean install matching the lockfile's checksums, and npm registry signatures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Format and lint            | Formatting, Markdown structure and spelling (`scripts/lint-files.sh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Types                      | `tsc --noEmit` in every workspace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Tests                      | The Vitest suite of every workspace, the committed OpenAPI document matching the code's among them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Vulnerabilities            | Known advisories of high severity or above in npm dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Plugin drift               | Committed plugin outputs match their sources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SDD records                | A completed plan checkbox in `docs/sdd/` never changes once merged, and a locked SDD changes only its `locked.md` (`scripts/check-sdd.sh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Release order tests        | The release order gate's decisions, on fixture repositories with npm stubbed (`scripts/check-release-order.test.sh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Server compatibility tests | The releases the server compatibility gate selects, on fixture repositories (`scripts/check-server-compatibility.test.sh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Agent compatibility        | Every released bridge, from the agent line's tags, installed from npm with its signatures and provenance checked, drives every tool it has against the agent routes at HEAD (`scripts/check-agent-compatibility.sh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Server compatibility       | The bridge at HEAD against the newest server release of each older agent API version, from the server line's tags, installed from npm with its signatures and provenance checked: every tool call refused, and nothing recorded but, before 0.3.0, a pending registration (`scripts/check-server-compatibility.sh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Release order              | On the agent line's release pull request, the newest server release serves its agent API version and npm has it (`scripts/check-release-order.sh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Build                      | Both bundles, the server's with the web UI; each package, installed from its tarball, runs and prints its version, and the server serves its web UI and begins a passkey sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Browser                    | The web UI, served by the built server over TLS, in Chromium with virtual passkey authenticators: the server's name, passkey link and sign-in, a second passkey, approval and the Sessions tab's count of registrations waiting, answers, a message's detail, a stale write, Send kept on a short phone's screen and the way back under the composer, Markdown, hostile text, unread marks and the Threads tab's count of unread threads, archiving, the list's filters, their counts, its order, the order's direction and grouping, a grouped header folding by a click on its bar and its label adding its session to the filters, and the sessions view, at a phone's width too, with a session's status and log, a row unfolding by a click on its title, its folds by group, a group's and a tag's links to their threads and the links to stranded threads, a thread started there and stranded's reason; diagrams drawn in their sandboxed frame against hostile sources, falling back to their source, and in the viewer at a phone's width; Settings in sections, at a desktop's width and a phone's, with voice set up and tried, dictation through Chromium's fake microphone and a stub transcription provider, at a phone's width too, reading a message aloud, storage shown, and an API key created, its secret shown once and copied, used on the operator API within its scope and refused once revoked, at a phone's width too; and attachments: a file attached and an image pasted, Attach's menu on a touch device at a phone's width, each item its own picker, arriving with the message and in the thread's files, images, video, audio and text shown in place, a PDF opening in a tab, a missing file marked, every file downloading under its name, and HTML and script bytes declared as each served type running nothing in the page or opened on their own |

Read [`scripts/check.sh`](scripts/check.sh) for the exact commands; it is the single definition of
the gates.

The install, signature, vulnerability, agent compatibility, server compatibility and release order
checks need network access. The agent compatibility, server compatibility and release order gates
also need the repository's release tags, which a clone may lack; fetch them with `git fetch --tags`.
A local Node version that differs from `.node-version` produces a warning, not a failure, since CI
checks on the pinned version, and on the oldest supported Node as well.

### Formatting and spelling

Format and lint every file you change:

```bash
scripts/lint-files.sh --fix
```

`--fix` applies Prettier and the markdownlint fixes it can, then re-checks. cspell cannot fix
anything: correct the spelling, or add a genuine word to `.cspell.json`.

### Working on one component

Each workspace has its own scripts for work on it alone:

```bash
npm run -w apps/server test        # Vitest, for any workspace
npm run -w apps/server typecheck   # tsc --noEmit, for any workspace
npm run -w apps/web test:browser   # the browser tests, against the server's last build
```

The web UI talks only to the server that serves it, and passkeys need that server's HTTPS origin, so
try UI changes by building the server package and running it as the
[operator guide](docs/operator-guide.md#running-the-server) describes.

### Generated plugins

The Claude Code and Codex plugins under `out/` and the catalogs in `.claude-plugin/` and
`.agents/plugins/` are generated from `apps/agent-plugin/plugin.json` and
`apps/agent-plugin/skills/` by `apps/agent-plugin/gen/`, which Node runs directly. Never edit the
outputs by hand. After changing the sources or the generator, regenerate and commit the outputs in
the same change:

```bash
scripts/generate-plugins.sh
```

To try an unreleased bridge on a host, pack it and render the plugins against the tarball, each time
into a new directory of your own:

```bash
dev="${XDG_CACHE_HOME:-$HOME/.cache}/agention-dev"
mkdir -p "$dev"
render="$(mktemp -d "$dev/XXXXXX")"
npm run -w apps/bridge build
tarball="$(npm pack --silent -w apps/bridge --pack-destination "$render")"
scripts/generate-plugins.sh --bridge-package "$render/$tarball" --out "$render/plugins"
```

The plugins it writes run the bridge with `npx -y --package=<tarball> agention-mcp`, and differ from
the committed plugins in nothing else. Depending on the npm version, npx can keep running a bridge
it installed earlier from the same tarball path, so each render packs into a new directory; the
generator also refuses an `--out` that already exists.

`$render/plugins` is laid out like the repository, with each host's catalog: add it to the host as a
local plugin marketplace and install `agention` from it. When you are done, uninstall the plugin and
remove the marketplace from the host, then delete the directory.

The committed plugins run `npx -y @wayfarerlabs/agention-mcp@<version>`. A host started inside a
checkout of this repository runs that command in the checkout, where npx finds the workspace package
of the same name and version and runs it instead of the published one. Until the bridge is built and
linked there, it fails with `agention-mcp: not found`. To use an installed plugin while working
here, either start the host in a checkout of a commit that predates the bridge workspace, or build
and link the bridge:

```bash
npm ci
npm run -w apps/bridge build
npm rebuild -w apps/bridge
```

npm links a workspace's command only when its target exists, so the rebuild is what links it. The
host then runs this checkout's build, with the session's Agention key, until you rebuild and the
host restarts the bridge, so build only code you trust.

### Generated API document

`docs/api/openapi.json`, the OpenAPI document of the operator API and the agent API, is generated
from the server's operation declarations and the API contract's schemas they use, by
`apps/server/generate-api-docs.ts`, which Node runs directly. Never edit it by hand. After changing
an operation or a schema one uses, regenerate it and commit it in the same change, so the contract's
change is reviewed as a diff:

```bash
scripts/generate-api-docs.sh
```

A test in the server's suite, `apps/server/src/http/api-docs.test.ts`, fails while the committed
document differs from what generation would write, so the Tests gate catches a stale one.
`agention serve --api-docs` serves the document, and a page rendered from it, as
[the operator guide](docs/operator-guide.md#using-the-operator-api) describes.

### The agent API

Agents run whatever bridge their plugin pins, so the agent routes only grow: each release's agent
routes accept what every released bridge sends and answer what it reads. The bridge and the server
state the agent API version they speak on every request and answer, `agentApi` in
`packages/api/src/agent-api.ts`. Every change to the agent contract, a new route or a new field on
one, bumps its `version` by one; its `oldest`, the oldest version the server still serves, moves
only by a maintainer's decision.

The agent compatibility gate holds the rule. For each agent line tag, `agention-mcp-v*`, reachable
from HEAD and not on HEAD itself, `scripts/check-agent-compatibility.sh` installs that release's
bridge from npm by its exact version into a scratch directory, with the seven-day wait off (see
[Dependencies](#dependencies)), and checks its registry signatures and provenance with
`npm audit signatures`. The bridge's suite, `apps/bridge/src/released-bridges.compat.ts`, then
starts each installed bundle as an agent host would, over standard input and output, against the
server at HEAD, and drives register, approval and every tool the release has, with the fields it
sends: asks and answers, a withdrawal, a replacement, a stale write, a later message's ask, topic,
detail and references, the list's filters and waits. Every release also reads messages carrying
files: the operator's, which wakes its wait, and one of its own it replaces without keeping the
file, with the messages' `attachments` and the thread's file totals passing through; a release that
has the file tools drives `file_get` and `file_upload` too. Any refusal of valid input fails it, and
so does any answer the release cannot read. A tag whose version npm does not have yet, as for a
minute after a release, fails it too, named with npm's own error, and so does a clone without tags.
A new tool or field joins the suite. `scripts/check.sh --fast` skips the gate, which needs the
network.

The server compatibility gate holds the other direction: a bridge newer than its server refuses
every call, saying what to upgrade, and the server records nothing the operator must act on. For
each agent API version older than HEAD's, `scripts/check-server-compatibility.sh` takes the newest
server line tag, `agention-v*`, reachable from HEAD at that version, reading `agentApi` at each tag;
a release without `packages/api/src/agent-api.ts`, as every one before 0.3.0 is, states no version
and counts as one version older than any other. One release per version suffices, since releases at
one version serve one contract, and a version at HEAD's or above is the agent compatibility gate's.
`--list` prints the releases it takes. It installs each from npm as the agent compatibility gate
installs bridges, and the suite, `apps/bridge/src/released-servers.compat.ts`, starts each as an
operator would, `agention serve` on the loopback with its own data directory under the system's
temporary directory and a certificate made for the run, and starts the bridge at HEAD as an agent
host would, reaching it through `AGENTION_CONNECT`. Every tool, `register` first and each with valid
input, must fail with the bridge's refusal of a server stating what that release states, and the
release's database, read before and after, must not change, but for the one pending registration a
release before 0.3.0 records for a new key, which expires within the hour. A new tool joins the
suite's list of calls. `scripts/check.sh --fast` skips the gate, and runs its fixture test.

The agent contract is in `packages/api`, which both release lines ship, so a change to it releases
both, the server first: the release order gate keeps the agent line's release pull request from
merging until a published server serves its agent API version ([Releasing](#releasing)).

## Dependencies

- Pin every dependency exactly. npm packages are pinned by exact versions in the workspaces'
  `package.json` files and by the single root `package-lock.json`; there are no separate version
  files. GitHub Actions are pinned by full commit SHA with the version in a comment.
- No dependency may need an install script, since lifecycle scripts never run. That rules out native
  addons; tools with native binaries, such as esbuild and TypeScript, ship them as optional platform
  packages that work without one.
- The server and bridge packages are bundles that declare no dependencies, so installing them
  resolves nothing beyond what the lockfile built. They list everything their bundles include, other
  workspaces too, under `devDependencies`; the build gate fails a published package that declares
  `dependencies`, `optionalDependencies`, `peerDependencies` or bundled dependencies.
- Each published package ships a copy of the repository's `LICENSE`, its own `README.md`, which npm
  shows as the package's page, and, beside its bundle, the license notices of the npm packages the
  bundle includes. The build gate checks all three are in the tarball and that the `LICENSE` copy
  matches.
- A package a bundle includes may have inlined other npm packages in its own build, as the MCP SDK
  builds in its JSON Schema validator. The build's notice check names each one whose license notice
  it cannot find; pin each it names under the bundling package's `devDependencies` at the inlined
  version, so its license notice ships and the vulnerability check covers it, and pin no others.
  Those pins move only with the package that carries them inlined, so `.github/dependabot.yml`
  ignores them, and upgrading that package means updating them in the same change.
- Every package a bundle includes ships with its license text, and the build fails for one whose
  notice would carry none. When a package's own files do not give the build what its notice needs,
  `suppliedNotices` in `packages/build/src/supplied-notices.ts` holds that text for its version,
  quoted from the package: license terms that live only in its README, or in a license file the Vite
  build does not read, such as `MIT-License.txt`. A package under the Eclipse Public License always
  needs an entry, since it must keep the copyright notices in its code, which minification strips,
  and come with a statement of where its source code is available; the build fails for one whose
  license field or license file names the EPL and that has none, and the diagram frame's script
  carries that text too. Adding or upgrading such a package means writing its entry for the new
  version; a test fails while an entry names a version that is not installed or quotes text its
  package's files do not contain.
- When adding or upgrading, choose the newest stable release that is at least seven days old, check
  its advisories and provenance, and change the manifest and lockfile together. The wait gives a
  broken or compromised release time to be caught. `.npmrc` sets npm's `min-release-age` to 7, so an
  install resolves only releases at least seven days old across the whole tree, and Dependabot waits
  as long before proposing one. Apply the same wait by hand to Node.js and the GitHub Actions.
  `.node-version` follows Node.js's current LTS line, 26, which builds, checks and publishes the
  packages. CI also runs the fast checks on the oldest line the published packages support, 24
  (their `engines`), at the exact version in `.github/workflows/ci.yml`. `@types/node` follows that
  oldest line, so the types refuse an API newer than it, and Dependabot ignores its major updates.
- The agent and server compatibility gates ([The agent API](#the-agent-api)) install Agention's own
  released bridges and servers with the wait turned off, since each checks a release as soon as it
  is published; those installs are the only exceptions. The bridge and the server are bundles that
  declare no dependencies, so nothing else resolves.
- A security fix may skip the wait. When a published advisory affects a pinned or locked version and
  no fixed release in the release line in use is seven days old, take the first fixed release and
  only the new releases it requires, pinned exactly, and add each npm package among them to
  `min-release-age-exclude` in `.npmrc`. Record the advisory and the releases in this list, and
  remove the record and the exclusions at the first deliberate update after the releases turn seven
  days old.
- An `overrides` entry in the root `package.json` replaces a vulnerable transitive dependency that
  its parent pins exactly, with the parent named so the override reaches nothing else, at the
  release closest to the parent's pin that fixes the advisory. Remove it once the parent depends on
  a fixed version: an override left behind keeps forcing that version on later releases of the
  parent, which may need another.
- A dependency that shapes the architecture or the supply chain (a framework, an authentication or
  storage library) gets an ADR recording the choice and its alternatives.
- Dependabot proposes weekly updates. Review them like any other change.
- Advisories below the vulnerability gate's threshold that remain, and why:
  - `fast-uri` (`GHSA-w74x-v6f9-j3xg` and `GHSA-wjr9-j795-jxcr`, moderate; `GHSA-xhq7-xmqj-769h` and
    `GHSA-333x-w4r6-6crp`, low), in the copy inlined in `@modelcontextprotocol/server`, which the
    bridge bundles. The bridge registers no output schemas and uses no elicitation, so nothing
    reaches the affected code. It moves with that package, once a release carries a fixed
    `fast-uri`.
  - `katex` (`GHSA-238p-pmpm-9mq7`, low), reached through markdownlint-cli2, which only reads this
    repository's own Markdown. Every fixed release is outside micromark-extension-math's `^0.16.0`
    range, so it stays until markdownlint takes the fix.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). release-please
reads them to choose each release line's next version and write its changelog, so the type matters:
`feat`, `fix` and `perf` release and appear in the changelog, and a `BREAKING CHANGE:` footer marks
a breaking change; other types release nothing. Keep each footer to one paragraph.

Pull requests merge with a merge commit, whose message GitHub fills with the pull request's title.
release-please reads every Conventional Commits line in a commit's message as a change, so a pull
request's title is plain words, such as "Rework the skill around the bridge", never a commit type
such as `fix(plugin):`, which would list its change a second time; the commits carry the types.

Agention is pre-1.0. Releases start at 0.1.0; until 1.0.0, `feat` and breaking changes bump the
minor version and `fix` bumps the patch version, so no change bumps the major version on its own. A
maintainer cuts 1.0.0 deliberately, with a `Release-As: 1.0.0` footer on a commit to `main`.

Agention releases on two lines, each with its own version ([Releasing](#releasing)): the server
line, `@wayfarerlabs/agention` with the web UI, and the agent line, `@wayfarerlabs/agention-mcp`
with the plugins that run it. Each line's release pull request writes its version everywhere it
appears ([architecture](docs/architecture.md#versions) "Versions"), so never change a version by
hand.

A commit that releases goes to the line whose paths it touches, as the `exclude-paths` of each
line's configuration, `release-please-config.json` and `release-please-config.agent.json`, decide:
the server line excludes the agent line's directories and the agent line the server's, and both
exclude the directories that ship nothing, `docs/`, `scripts/` and `.github/`. A commit releases a
line unless every file it changes is excluded there, so one touching `packages/api`,
`packages/build`, `packages/private-files` or a file at the repository's root releases both. So:

- Keep a feature or fix to the paths of the line it changes, with its docs under `docs/` if it has
  any. A change to a file at the root that ships nothing, such as `CONTRIBUTING.md`, `README.md` or
  a word added to `.cspell.json`, goes in a commit of its own whose type releases nothing, such as
  `docs:` or `chore:`; release-please excludes only directories, so a feature or fix carrying it
  releases both lines.
- A dependency a feature or fix needs goes in its own `build(deps)` commit, which releases nothing,
  since every dependency change touches the root `package-lock.json`. A dependency change that is
  itself the fix, such as a security update, is `fix(deps)`, and releases both lines, even when only
  one line's manifest changed.
- A new top-level directory that ships nothing joins the `exclude-paths` of both configurations.
  Until it does, a feature or fix touching it releases both lines.

Releasing a line that a change did not touch is the safe failure: its new release ships what its
last one did.

A pull request should:

- do one thing, explained in its description;
- pass `scripts/check.sh`;
- include tests for changed behavior, written against behavior at a boundary rather than the shape
  of the implementation;
- update the documentation that the change makes stale, in the same pull request;
- add or supersede an ADR when it makes or changes a significant decision.

## Releasing

Maintainers release from `main`, and only CI publishes. Agention releases on two lines, each with
its own version, release pull request, changelog and tags
([architecture](docs/architecture.md#versions) "Versions"):

| Line   | Releases                                                     | Release pull request                      | Tag                   |
| ------ | ------------------------------------------------------------ | ----------------------------------------- | --------------------- |
| Server | `@wayfarerlabs/agention`, with the web UI                    | `chore(main): release agention X.Y.Z`     | `agention-vX.Y.Z`     |
| Agent  | `@wayfarerlabs/agention-mcp` and the plugins, at one version | `chore(main): release agention-mcp X.Y.Z` | `agention-mcp-vX.Y.Z` |

1. Changes land on `main` with Conventional Commit messages, and release-please keeps a release pull
   request open for each line a change released
   ([Commits and pull requests](#commits-and-pull-requests)), which sets that line's next version
   everywhere it appears and writes its changelog entry. The
   [release-please workflow](.github/workflows/release-please.yml) runs once per line's
   configuration. The agent line's release pull requests carry labels of their own,
   `autorelease-agent: pending` and then `autorelease-agent: tagged`, since release-please stops
   updating a line's release pull request while a merged one carrying that line's pending label is
   untagged: shared labels would let one line's untagged release hold up the other's.
2. Merging a release pull request tags its commit with its line's tag and publishes the GitHub
   release. That merge is a release's human approval; CI publishes with no further step.
3. The tag starts [`release.yml`](.github/workflows/release.yml). Its build job refuses a tag that
   is not the version of its line's package, and for the agent line of the plugin definition too,
   then runs `scripts/check.sh --packages DIR` and uploads the tarball of the tag's line it checked
   and kept in `DIR` as the run's artifact. Its publish job, the only one that can publish, runs no
   repository code: it checks that the tarball is the tag's package at the tag's version and
   publishes it through npm's trusted publishing, with provenance and no token. A version already on
   npm is skipped, so a run that failed after publishing finishes with **Re-run failed jobs**, which
   reuses the build's artifact while the repository keeps it, 90 days by default. **Re-run all
   jobs** would upload the artifact again, which collides with the one the first build uploaded.
4. The committed plugins already pin the new bridge, since the agent line's release pull request
   updated them with the rest. A host that installed the plugin unpinned takes it from `main`'s
   catalog, and Codex may refresh such a plugin by itself once the marketplace moves, so the merge
   itself can change the bridge those hosts run. Until the release workflow has published it, such a
   plugin names a bridge version npm does not have yet, so fix a failed release promptly.

When a change releases both lines, as a change to the agent API does, merge the server line's
release pull request first. The release order gate in `scripts/check.sh` fails the agent line's
release pull request until the newest server release serves its agent API version and npm has that
server, naming what to merge and publish first; once the release workflow has published the server,
run the check again, which reads the tags anew. Then merge the agent line's release pull request
promptly: as soon as an operator upgrades the server, the sessions view asks them to update a plugin
that speaks an older agent API version, and that update should exist.

`main` does not require a branch to be up to date before it merges, so a release pull request's
checks are as of its last update. Merge one only once release-please has updated it after the latest
change merged to `main` that it includes, and its checks have passed on that update.

### Checking a release

Run these outside a checkout of this repository, where the last command, `npx`, would run the
workspace's bridge instead of the published one. Each line has its own `X.Y.Z`.

```bash
# The server line, agention-vX.Y.Z
npm view @wayfarerlabs/agention@X.Y.Z dist.attestations.provenance.predicateType

# The agent line, agention-mcp-vX.Y.Z
npm view @wayfarerlabs/agention-mcp@X.Y.Z dist.attestations.provenance.predicateType
npx -y @wayfarerlabs/agention-mcp@X.Y.Z --version
```

The package's provenance names `https://slsa.dev/provenance/v1`, and its version's page on npmjs.com
shows the provenance, with the commit and the workflow run that built it. The bridge prints
`agention-mcp X.Y.Z`. A release publishes its line's package alone, so the other package has no
version for it.

### One-time setup

The repository's owner sets these up once, before the first release:

1. **Private vulnerability reporting.** Enable it in the repository's security settings. It is the
   channel [SECURITY.md](SECURITY.md) names, and a new public repository starts with it off.
2. **Branch protection on `main`.** Apply the branch protection Wayfarer uses across its
   repositories, or confirm it is applied: `main` takes changes only through reviewed pull requests,
   with the `ci-success` check required.
3. **The release-please GitHub App.** Create a GitHub App owned by the `WayfarerLabs` organization,
   with its webhook inactive and the repository permissions Contents and Pull requests set to read
   and write, and install it on the `agention` repository alone. Create an environment named
   `release-please` that only the `main` branch may deploy from, and set its secret
   `RELEASE_APP_PRIVATE_KEY` to a private key generated for the App. In the repository's Actions
   settings, set the variable `RELEASE_APP_CLIENT_ID` to the App's client ID; it can stay a
   repository variable, since the job's `if` reads it before any environment applies, and until it
   is set the release-please workflow is skipped. release-please opens its pull request and tags
   releases with the App's token, so CI runs on the pull request and the tag starts the release
   workflow. Then run the Release Please workflow from the Actions tab, or push to `main`, to open
   the first release pull requests.
4. **The tag rulesets.** Add two repository rulesets for tags matching `agention-v*`,
   `agention-mcp-v*` and `v*`, the tags of the releases before the lines split: one that restricts
   their creation, with the release-please App as its only bypass actor, and one that makes them
   immutable, refusing their update and deletion with no bypass actor, so a tag stays where the App
   put it and a moved tag cannot start a publish.
5. **The `npm` environment.** Create an environment named `npm` in the repository, and limit its
   deployment branches and tags to the tag patterns `agention-v*` and `agention-mcp-v*`, with no
   branch.
6. **Each package's trusted publisher.** npm sets up a trusted publisher only on a package that
   exists, so each package starts as a [placeholder](#the-placeholder). Then add the package's
   trusted publisher on npmjs.com, under its Settings → Trusted publishing: GitHub Actions,
   organization `WayfarerLabs`, repository `agention`, workflow filename `release.yml`, environment
   `npm`, and `npm publish` allowed beside the `npm stage publish` npm always allows. A trusted
   publisher that has not published within two days of being added expires, so add each one within
   the two days before the release that first publishes its package.
7. **No tokens.** Once that release is out and checked, set each package's Settings → Publishing
   access to "Require two-factor authentication and disallow tokens". Trusted publishing uses no
   token, so it goes on working.

Together these let only a merged release pull request publish: only the App may create release tags,
its key is usable only from `main`, which changes only through reviewed pull requests with the
required check, and only release tags may use the `npm` environment that each trusted publisher
names. The repository must stay public: npm attaches provenance only to a package published from a
public repository, and the release workflow's explicit `--provenance` fails a release otherwise.

A package added later starts the same way: publish and deprecate its placeholder, add it beside the
others to the package checks in `scripts/check.sh`, to `release.yml`'s mapping of tags to packages
and to its release line's configuration, add its trusted publisher within the two days before the
release that first publishes it, and disallow tokens once that release is out.

### The placeholder

A package's placeholder is version `0.0.0-placeholder`, never `0.0.0`, which the committed plugins
pin before the first release. It holds only a `package.json`. Signed in to npm (`npm login`) as a
member of the `@wayfarerlabs` organization who may publish, run this once for each package, with
`name` set to the package's name:

```bash
name=@wayfarerlabs/agention   # then @wayfarerlabs/agention-mcp
dir="$(mktemp -d)"
cat >"$dir/package.json" <<EOF
{
  "name": "$name",
  "version": "0.0.0-placeholder",
  "description": "Reserves this name for Agention, whose releases start at 0.1.0.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/WayfarerLabs/agention.git"
  }
}
EOF
npm publish "$dir" --tag placeholder --access public --dry-run
npm publish "$dir" --tag placeholder --access public
npm deprecate "$name@0.0.0-placeholder" "This version only reserves the name. Install 0.1.0 or later."
npm view "$name" dist-tags
rm -r "$dir"
```

The dry run shows what will be published. npm publishes a prerelease version only under a tag named
with `--tag`. A new package's first version takes `latest` as well, so until 0.1.0 is published,
`latest` names the deprecated placeholder, which installs no command; 0.1.0 then takes `latest`, as
every release does.

## Architecture decision records

Significant decisions are recorded as ADRs in [`docs/adrs/`](docs/adrs/), in the format of
[ADR 0000](docs/adrs/0000-record-architecture-decisions.md). Number them sequentially; `.adr-dir`
lets [adr-tools](https://github.com/npryce/adr-tools) find the directory. An accepted ADR is a
historical record: change a decision by writing a new ADR that supersedes it, and mark the old one
as superseded. The one exception is ADR 0001, which records the v1 architecture as a whole: until v1
is released it is edited in place to state each decision as it stands.

## Design documents

A significant effort is designed before it is built, in a spec-driven development (SDD) directory,
`docs/sdd/<YYYY>-<MM>-<DD>-<slug>/`: its requirements, architecture, plan and low-level designs, and
the maintainer's rulings that shaped them. Its decisions move into the ADRs and the permanent docs
before it locks, so nothing under `docs/sdd/` is needed to understand or work with the current
system. The SDD records gate in [Checks](#checks) keeps each record as it merged, until a locked SDD
is removed down to its `locked.md`.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
