# Separate releases: Plan

- Requirements: [FRD](frd.md), accepted (ruling 2); architecture: [HLA](hla.md); research:
  [prior-art-research.md](prior-art-research.md)
- Vehicle: coordinated pull requests in this repository, each complete on its own and merged in
  order: the SDD (agention#61, this directory's artifacts, merged once the operator directs it),
  then deliveries 1 to 4 below, each on its own branch from `main`. Each delivery carries its own
  LLD, permanent docs and tests, and checks its boxes in its own pull request, citing it. Each
  delivery's docs describe only what is true once it merges: the split's own consequences (the tags,
  the refusals' wording) land with the split, and U1's rule with the signal that makes it true.
- No release pull request merges until delivery 2 does, so 0.6.0 stays the last release covering all
  three (R4, HLA Migration).
- Operator steps sit inside the delivery that needs them; the effort lead asks for each through
  Agention when it can be acted on, and checks it after.

## Delivery 1: the server-only contract

Deliberately a refactor that releases nothing (`refactor:` commits), so R2 holds from the first
split release.

- [ ] `contract-split-lld.md`: the new workspace package's name, the rule for what stays shared
      (what the bridge's bundle needs), the modules that move (API keys, settings, attention,
      passkeys, the operator schemas) and the files split rather than moved (`groups-and-tags.ts`,
      `thread-lists.ts`, `sessions.ts`).
- [ ] The modules moved into the new package, the server, web UI and OpenAPI generation importing
      them from it, `packages/api` keeping only what the bridge or both sides use; no behavior,
      route, schema or generated document changes.
- [ ] The boundary held by a test over the bridge's bundle metafile, failing if any module of the
      new package is in it.
- [ ] Permanent docs: `docs/architecture.md` "Source and packages" and "API contract", README's
      repository layout, CONTRIBUTING where it names the contract package,
      `docs/development-context.md` and `docs/review-checklist.md` where they name a moved module.
- [ ] Reviewed (project review, complexity pass, correctness lane) and CI green.

Done when `docs/api/openapi.json` is unchanged byte for byte, the bridge's bundle is unchanged by an
edit to any moved module, and `scripts/check.sh` passes.

## Delivery 2: release lines

- [ ] `release-lines-lld.md`: the rules behind both configurations (which paths each line ships, the
      exclusions, why the labels differ, which `extra-files`), with the configuration files as the
      only copy of the values; the release workflow's tag handling; the release order gate's
      algorithm, its network use and its re-run; the dry run's fixture commits and the pinned
      release-please CLI; and the CONTRIBUTING rule for new paths that ship nothing.
- [ ] Operator step: `agention-vX.Y.Z` and `agention-mcp-vX.Y.Z` created on the commit of every `v*`
      release from 0.1.0 to 0.6.0, before the next step (HLA Migration 1). Checked by
      `git ls-remote --tags` against the `v*` tags' commits.
- [ ] Operator step: both tag rulesets (creation restricted to the release App; version tags
      immutable) and the npm environment's tag rule extended to `agention-v*` and `agention-mcp-v*`
      (HLA Migration 2). Checked by reading both rulesets through the API, and the environment by
      the operator's confirmation.
- [ ] Dry run (HLA Migration 3) on a scratch branch the effort lead pushes and deletes: each fixture
      commit releases the lines the HLA says, and each line's release pull request is its own.
- [ ] Two release-please configurations and manifests at 0.6.0, the agent line's changelog, its own
      labels, and the release-please workflow running both (R1 to R4).
- [ ] The release workflow: the two tag prefixes, the per-line version check, one line's tarball
      built and published per tag (R3, E2).
- [ ] The agent compatibility gate reading `agention-mcp-v*` tags (C1, E2).
- [ ] The release order gate, required through `ci-success`, failing an agent release pull request
      whose agent API version no published server serves, with a test of its decision on fixture
      tags (C2).
- [ ] The bridge's refusal of an older server, and the server's `unsupported_version` refusals,
      reworded for two lines (C3), with tests at the bridge's boundary for a server stating an older
      version and one stating none, and of the older-bridge refusal as bridges relay it.
- [ ] Permanent docs: ADR 0005 and ADR 0001's status; `docs/architecture.md` "Versions", "Generated
      plugins", "Agent bridge" and "HTTP API"; CONTRIBUTING "Releasing" (two pull requests, the
      merge order when the agent API changes, U4, merging a release pull request only once it is
      current), "Checking a release", "Checks", "The agent API", "One-time setup" (both tag rulesets
      as they exist); SECURITY.md "Supported versions"; the operator guide's "Installing the
      plugins" and "Upgrading" (the new tags, the server and the plugin as separate steps, the
      update steps on each host with the Codex correction, F8, F9) and its version paragraph (the
      new refusal; servers before 0.3.0, C4); README "Status"; `docs/development-context.md`; the
      workflows' comments.
- [ ] Operator step: `v*` dropped from the npm environment's tag rule after the merge (HLA Migration
      2).
- [ ] Reviewed (project review, complexity pass, correctness lane) and CI green.

Done when, after merge, release-please keeps one release pull request per line carrying only that
line's changes, and the release workflow refuses a tag whose line's versions do not match.

## Delivery 3: the server compatibility gate

- [ ] `server-compat-lld.md`: which releases, installing and checking them, certificates and data
      directories, driving the bridge at HEAD, reading each release's database for C4, and the
      gate's run time against the `check` job's limit.
- [ ] The gate: every released server older than the bridge's agent API version, from npm with
      signatures checked, refusing every tool call with C3's message and, from 0.3.0, recording no
      registration (C4, C5); skipped by `--fast`.
- [ ] Permanent docs: CONTRIBUTING "Checks" and "The agent API", `docs/architecture.md` "Agent
      bridge", `docs/development-context.md`.
- [ ] Reviewed (project review, complexity pass, correctness lane) and CI green.

Done when the gate passes in CI against 0.1.0 to 0.4.0 (the releases older than agent API 3) and
fails when the bridge's refusal is broken.

## Delivery 4: the plugin-is-behind signal

- [ ] `signal-lld.md`: the session column and its migration, when it is written, the sessions read's
      new field and its name, the web UI's notice, and the bridge's register sentence.
- [ ] The store: an append-only migration adding the recorded agent API version, written on the seen
      path only when it changes, with tests across a missing header, an older and the current
      version (U2).
- [ ] The sessions read on the web and operator mounts carrying the behind status, and the
      regenerated OpenAPI document (U2).
- [ ] The web UI: the notice on a behind session's row, with its fix, and nothing on a current one,
      in the browser tests (U2).
- [ ] The bridge: a register answer from a newer server carrying the sentence for the operator,
      without failing (U3).
- [ ] Permanent docs: `docs/architecture.md` "Store", "HTTP API", "Web UI" and "Agent bridge"; the
      operator guide's sessions view, and U1's rule in its upgrading section; `docs/live-testing.md`
      where it lists surfaces.
- [ ] Reviewed (project review, complexity pass, correctness lane) and CI green.
- [ ] Live run on Claude Code: a session on a plugin speaking an older agent API version (0.4.0's)
      marked in the sessions view, and the notice gone once the plugin is updated and the session
      restarted.

Done when the browser tests show the notice for a behind session and none for a current one, the
operator API's sessions read carries the status, and the live run passes.

## Closeout

- [ ] The first release on a line alone after the split: its tag, changelog and the one npm package
      it published, citing its release pull request (FRD definition of done).
- [ ] Live run on Claude Code with the agent line's release carrying delivery 4's bridge, against a
      dev server stating a newer agent API version: the agent told at register, without failing (FRD
      definition of done).
- [ ] Every requirement traced to the delivery that met it, every material decision promoted to the
      permanent homes, and `locked.md` written with the last delivery's merge or after it.
