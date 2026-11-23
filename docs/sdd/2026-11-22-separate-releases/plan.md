# Separate releases: Plan

- Requirements: [FRD](frd.md), accepted (ruling 2); architecture: [HLA](hla.md); research:
  [prior-art-research.md](prior-art-research.md)
- Vehicle: coordinated pull requests in this repository, each complete on its own and merged in
  order: the SDD (agention#61, this directory's artifacts, merged once the operator directs it),
  then deliveries 1 to 4 below, each on its own branch from `main`. Each delivery carries its own
  LLD, permanent docs and tests, and checks its boxes in its own pull request, citing it.
- Operator steps sit inside the delivery that needs them; the effort lead asks for each through
  Agention when it can be acted on, and checks it after.

## Delivery 1: the server-only contract

Deliberately a refactor that releases nothing (`refactor:` commits), so R2 holds from the first
split release.

- [ ] `contract-split-lld.md`: the new workspace package's name, the modules that move (API keys,
      settings, attention, passkeys, groups and tags, the operator schemas, and the operator parts
      of `sessions.ts`), what stays shared, and how the bridge is kept from depending on it.
- [ ] The modules moved into the new package, the server, web UI and OpenAPI generation importing
      them from it, `packages/api` keeping only what the bridge or both sides use; no behavior,
      route, schema or generated document changes (`docs/api/openapi.json` unchanged byte for byte).
- [ ] The boundary enforced: the bridge does not depend on the new package, and a test fails if the
      bridge's bundle includes any of its modules.
- [ ] Permanent docs: `docs/architecture.md` "Source and packages" and "API contract", README's
      repository layout, CONTRIBUTING where it names the contract package.
- [ ] Reviewed (project review, complexity pass, correctness lane) and CI green.

Done when the bridge's bundle is byte-identical before and after a change to any moved module, the
OpenAPI document is unchanged, and `scripts/check.sh` passes.

## Delivery 2: release lines

- [ ] `release-lines-lld.md`: both configurations in full (paths, `exclude-paths`, labels,
      `extra-files`), the release workflow's tag handling, the release order gate's algorithm and
      its network use, the agent compatibility gate's tag sources, and the CONTRIBUTING rule for new
      paths that ship nothing.
- [ ] Operator step: `agention-v0.6.0` and `agention-mcp-v0.6.0` created on the `v0.6.0` commit,
      before step 2 (HLA Migration 1). Checked by `git ls-remote --tags`.
- [ ] Operator step: the tag ruleset and the npm environment's tag rule extended to `agention-v*`
      and `agention-mcp-v*` (HLA Migration 2). Checked by the operator's confirmation and a refused
      tag push from a non-App identity, where the bed allows one.
- [ ] Two release-please configurations and manifests at 0.6.0, the agent line's changelog, and the
      release-please workflow running both (R1 to R4).
- [ ] The release workflow: the two tag prefixes, the per-line version check, one line's tarball
      built and published per tag (R3, E2).
- [ ] The agent compatibility gate reading legacy `v*` and `agention-mcp-v*` tags (C1, E2).
- [ ] The release order gate, required through `ci-success`, failing an agent release pull request
      whose agent API version no published server serves (C2), with a test of its decision on
      fixture tags.
- [ ] Dry run (HLA Migration 3): both configurations against a fork or release-please's dry run
      show, for a fixture history, which line each of a server-only, agent-only, shared and
      docs-only commit releases, and that each line's release pull request is its own.
- [ ] Permanent docs: ADR 0005 and ADR 0001's status; `docs/architecture.md` "Versions" and
      "Generated plugins"; CONTRIBUTING "Releasing" (two pull requests, the merge order when the
      agent API changes, U4), "Checking a release", "Checks", "The agent API"; SECURITY.md
      "Supported versions"; the operator guide's upgrading, U1's rule, and the update steps on each
      host with the Codex correction (F8, F9); README "Status"; `docs/development-context.md`; the
      workflows' comments.
- [ ] Reviewed (project review, complexity pass, correctness lane) and CI green.

Done when, after merge, release-please opens or updates one release pull request per line with only
that line's changes (or none), and the first release on a line alone publishes only that line's
package with its own tag and changelog (FRD definition of done).

## Delivery 3: a newer bridge against an older server

- [ ] `older-server-lld.md`: the refusal wording on both sides, and the server compatibility gate:
      which releases, installing and checking them, certificates, data directories, how the bridge
      at HEAD is driven, and how the database is read across releases for C4.
- [ ] The bridge's refusal of an older server reworded (C3), with tests at the bridge's boundary for
      a server stating an older version and one stating none.
- [ ] The server's `unsupported_version` refusals reworded (C3), with the older-bridge wording
      tested as bridges relay it.
- [ ] The server compatibility gate: every released server older than the bridge's agent API
      version, from npm with signatures checked, refusing every tool call with C3's message and,
      from 0.3.0, recording no registration (C4, C5); skipped by `--fast`.
- [ ] Permanent docs: `docs/architecture.md` "Agent bridge" and "HTTP API"; CONTRIBUTING "Checks"
      and "The agent API"; the operator guide's version paragraph, narrowed to servers before 0.3.0
      for the waiting registration (C4).
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
      operator guide's sessions view and upgrading; `docs/live-testing.md` where it lists surfaces.
- [ ] Reviewed (project review, complexity pass, correctness lane) and CI green.
- [ ] Live run on Claude Code: a session on a plugin speaking an older agent API version (0.4.0's)
      marked in the sessions view; a session on a dev build of this delivery's bridge, against a dev
      server stating a newer agent API version, told at register (FRD definition of done).

## Closeout

- [ ] Every requirement traced to the delivery that met it, every material decision promoted to the
      permanent homes, and `locked.md` written with the last delivery's merge or after it.
