# Development context

Agention's development contract: the project facts that shared, project-neutral development guidance
reads for work in this repository, each pointing at the doc that records it, so it also serves as an
index of those docs.

- Integration branch: `main`
- Reviewer: `project-reviewer`, with Agention's project checks in `docs/review-checklist.md`
- Tester: none; live testing follows the shared `integration-testing` tester method with Agention's
  surfaces, layers, hunts and bed rails in `docs/live-testing.md`
- SDD location: `docs/sdd/` (`CONTRIBUTING.md` "Design documents"), no active effort on `main`; SDD
  check: `scripts/check-sdd.sh`, in the "SDD records" gate of `scripts/check.sh`

## Identity and design

- Overview, values, and architecture: `README.md` (its opening, "Status" and "Design");
  `SECURITY.md` "Security model"; `docs/architecture.md`, which describes what exists;
  `docs/adrs/0001-agention-v1-architecture.md`, the intended design and the alternatives considered
- Decision records: `docs/adrs/` (`.adr-dir`), in the format of ADR 0000; `CONTRIBUTING.md`
  "Architecture decision records"
- Permanent documentation homes, where SDD decisions are promoted before lock: `docs/adrs/`,
  `docs/architecture.md`, `docs/operator-guide.md`, `SECURITY.md`, `README.md`, `CONTRIBUTING.md`,
  `docs/review-checklist.md`, `docs/live-testing.md`, and this file
- Opinionated or deliberately plural (for the `project-review` principles-and-fit check):
  opinionated in the deliberate limits of ADR 0001 "Not doing"; plural in its agent hosts, Claude
  Code and Codex, each with a plugin generated from one definition (ADR 0001 "Distribution:
  generated agent plugins"), and in its network path, since nothing depends on Tailscale (ADR 0001
  "Transport independence")
- Load-bearing dependencies and optional integrations: ADR 0001 "Repository and supply chain", and
  `docs/architecture.md` "API contract" and "Web UI"; optional: Tailscale, one documented way to
  publish the server (`docs/operator-guide.md` "Publishing it with `tailscale serve`", ADR 0001
  "Transport independence"), Agentworks, whose `AGENTWORKS_AGENT` and `AGENTWORKS_SESSION` only
  default the session's names (`docs/operator-guide.md` "Agents"), a transcription provider for
  voice, off until the operator chooses one, reached through the OpenAI-compatible API
  (`docs/operator-guide.md` "Voice", ADR 0002), and programs the operator runs that call the
  operator API with an API key they created (`docs/operator-guide.md` "API keys", ADR 0003)
- Product shape, which selects the `project-review` conditional checks: long-lived managed entities
  agents, sessions, registrations and threads (ADR 0001 "Agents, sessions and threads";
  `docs/architecture.md` "Store"; `docs/operator-guide.md` "Approving agents"); persisted state and
  its source-of-truth layer: one SQLite database, which the store owns (ADR 0001 "One Node server
  and one SQLite database"; `docs/architecture.md` "Database" and "Store"); user and machine
  interfaces and their clients: the `agention` CLI (`docs/operator-guide.md` "Commands"), the agent
  bridge's MCP tools, which agent hosts run (`docs/architecture.md` "Agent bridge"), the HTTP API's
  agent and web mounts and the operator API, its versioned operator mount, whose clients are
  programs the operator runs with API keys (`docs/architecture.md` "HTTP API";
  `docs/operator-guide.md` "Using the operator API"), and the web UI in the operator's browsers
  (`docs/operator-guide.md` "Using the web UI"); supported environment matrix: a Linux server with
  Node.js 24 or later (`docs/operator-guide.md`, its opening and "Linux: a systemd user unit"; the
  macOS launchd setup is documented as untested in "macOS: a launchd agent"), mobile and desktop
  browsers with WebAuthn's JSON helpers (`docs/operator-guide.md` "Signing in" and "Using the web
  UI"), and Claude Code and Codex as agent hosts, with Node.js 24 or later for the bridge
  (`docs/operator-guide.md` "Agents" and "Installing the plugins")

## Contribution and gates

- Contribution process and commit convention: `CONTRIBUTING.md` "Commits and pull requests"
  (Conventional Commits, which release-please reads, and the pull request template in
  `.github/pull_request_template.md`), "Architecture decision records" and "Design documents"
- Toolchain pins and locked install: `.node-version`, with the npm it bundles; exact pins in each
  `package.json` and the one root `package-lock.json`; `.npmrc` (`save-exact`, `ignore-scripts`);
  `npm ci --ignore-scripts`, then `npx playwright install --only-shell chromium` for the browser
  gate (`CONTRIBUTING.md` "Prerequisites")
- Release-age setting and where dependency decisions are recorded: `.npmrc` (`min-release-age`),
  `.github/dependabot.yml` (`cooldown`); `CONTRIBUTING.md` "Dependencies"
- Format and lint (run on every edited file): `scripts/lint-files.sh` (`--fix` formats first):
  Prettier, markdownlint-cli2 and cspell (`CONTRIBUTING.md` "Formatting and spelling")
- Static and type checks: `npm run --workspaces typecheck`, `tsc --noEmit` in every workspace, or
  `npm run -w <workspace> typecheck` for one (`CONTRIBUTING.md` "Working on one component")
- Unit tests, with CI's selection: `npm run --workspaces test`, every workspace's Vitest suite,
  which CI runs whole; `npm run -w <workspace> test` for one
- Build and packaging: `npm run -w apps/server build` (the web UI, then the server's bundle) and
  `npm run -w apps/bridge build` (`CONTRIBUTING.md` "Building"); the "Build" gate packs, installs
  and runs each package, and `scripts/check.sh --packages DIR` keeps the tarballs it checked
- Security and dependency checks: `npm audit signatures` in the "Dependency integrity" gate, and for
  each released bridge in the "Agent compatibility" gate, and `npm audit --audit-level=high` in the
  "Vulnerabilities" gate of `scripts/check.sh`
- Generated outputs, their generator configuration, and drift check: `out/claude-plugin/`,
  `out/codex-plugin/`, `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`,
  generated from `apps/agent-plugin/plugin.json` and `apps/agent-plugin/skills/` by
  `apps/agent-plugin/gen/`; `scripts/generate-plugins.sh`, and `scripts/generate-plugins.sh --check`
  in the "Plugin drift" gate (`CONTRIBUTING.md` "Generated plugins"); and `docs/api/openapi.json`,
  generated from the server's operation declarations and the `packages/api` schemas they use by
  `apps/server/generate-api-docs.ts`, through `scripts/generate-api-docs.sh`, with the parity test
  `apps/server/src/http/api-docs.test.ts` in the "Tests" gate (`CONTRIBUTING.md` "Generated API
  document")
- Everything CI requires on a pull request, in order: `.github/workflows/ci.yml`: the `check` job
  runs `scripts/check.sh`, whose gates `CONTRIBUTING.md` "Checks" lists in order; then `ci-success`,
  the one required check, which passes only when `check` succeeded

## Invariants and collateral

- Trust model, security checklist, and invariants reviewers check clause by clause: `SECURITY.md`
  "Security model", with "Voice", "API keys", "Attachments", "Private files" and "The agent bridge";
  the project checks A1 to A19 in `docs/review-checklist.md`; the deliberate limits in ADR 0001 "Not
  doing"
- Collateral to keep in sync: docs `README.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `docs/architecture.md`, `docs/operator-guide.md`, `docs/adrs/`, `docs/review-checklist.md`,
  `docs/live-testing.md`, this file, and `.github/pull_request_template.md`; sample config none (the
  operator guide's systemd unit and launchd plist are its examples); CLI help and completions: the
  usage text in `apps/server/src/cli.ts` and `apps/bridge/src/cli.ts`, and no completions; product
  guidance: the usage skill in `apps/agent-plugin/skills/`, the plugin definition
  `apps/agent-plugin/plugin.json` and their generated outputs, the tool and field descriptions
  agents read, in `apps/bridge/src/tools.ts` and the `packages/api` schemas, and the operation
  summaries and field descriptions clients read in the generated `docs/api/openapi.json`
- Command or API reference: `agention --help` and each command's `--help`, with
  `docs/operator-guide.md` "Commands" and "Running the server"; `agention-mcp --help`; the API's
  request and response schemas in `packages/api` (`docs/architecture.md` "API contract") and the
  bridge's tool schemas, generated from them (`docs/architecture.md` "Agent bridge"); the OpenAPI
  document of the operator and agent APIs, `docs/api/openapi.json`, and the page rendered from it,
  which `agention serve --api-docs` serves at `/docs/api/` (`docs/architecture.md` "API
  documentation"; `docs/operator-guide.md` "Using the operator API")

## Testing

- Supported matrix and coverage axes: the environments under **Identity and design**. CI covers
  Linux (`ubuntu-24.04`) at the Node version in `.node-version`, with the web UI in Chromium's
  headless shell, and runs the fast checks and the package check again at the oldest supported Node,
  24; other browsers, real phones, macOS and the agent hosts are covered only by live testing
  (`docs/live-testing.md`), with the evidence kinds of `docs/review-checklist.md` A16
- Maintained test harnesses: the Vitest suites beside the sources in every workspace; the server's
  in-process HTTP harness, `apps/server/src/http/test-harness.ts`, which also creates API keys and
  calls the operator mount with them, with `apps/server/src/auth/test-authenticator.ts`, a software
  passkey authenticator; the bridge's harness, `apps/bridge/src/test-harness.ts`, which runs the
  server in process over TLS and bridges in process or as processes, released bundles among them
  (`docs/architecture.md` "Agent bridge"); the browser tests in `apps/web/e2e/`, which drive the
  built server in Chromium with virtual authenticators and Chromium's fake microphone
  (`docs/architecture.md` "Web UI"); the local stub transcription provider,
  `apps/server/src/transcription/test-provider.ts`, which the server's and the browser tests share;
  and `scripts/check-sdd.test.sh`
- Test environment setup and snapshot commands: disposable state only (temporary data directories,
  homes and `TMPDIR`); setup is the locked install and Chromium's headless shell (`CONTRIBUTING.md`
  "Prerequisites"), and the release tags for the agent compatibility gate (`CONTRIBUTING.md`
  "Checks")
- Integration test selection or markers: none; the bridge's in-process integration tests run in its
  Vitest suite, and the browser tests run with `npm run -w apps/web test:browser` against the
  server's last build, which `scripts/check.sh --fast` skips with the builds; the agent
  compatibility suite runs only in its gate, which `--fast` also skips (`CONTRIBUTING.md` "The agent
  API")
- Test beds: local loopback runs with temporary state; a live instance behind `tailscale serve` on
  an operator-chosen host, the operator running every Tailscale command; real-phone passkey
  acceptance, and dictation with a real transcription provider, by the operator; Codex used only for
  basic plugin-integration prompts (an operator bound); private inventory location: none
- Known acceptance gaps and standing issues not to re-report: the residual `fast-uri` and `katex`
  advisories recorded in `CONTRIBUTING.md` "Dependencies"; live Codex checks need an authenticated
  Codex session; the macOS launchd setup is untested (`docs/operator-guide.md` "macOS: a launchd
  agent"); installing the plugins from the repository's marketplace is not yet verified on either
  host (`docs/architecture.md` "Generated plugins"); dictation runs in no automated browser but
  Chromium, the only one with a fake microphone, so dictation in Apple browsers is untested; a PDF
  attachment's safety in Firefox's viewer and in Apple browsers is untested (`SECURITY.md`
  "Attachments")

## Process

- Process labels in use (among `review-requested`, `awaiting-direction`, `sdd:<slug>`,
  `saga:<name>`, `smol-dev`): `review-requested` and `awaiting-direction`; who creates them: the
  operator
- Standing workflows the operator has authorized, with bounds: per-PR integration-test pipeline
  none; `smol-dev-loop` none; sagas none
- Fix-round wait interval: 30 minutes
- Session identifier source and commit trailer key: the harness's session URL; no trailer key, since
  commits and pull request descriptions carry no attribution or session lines, at the operator's
  direction
