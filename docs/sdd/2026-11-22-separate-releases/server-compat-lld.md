# Separate releases: the server compatibility gate LLD

- Status: Draft, for delivery 4
- Date: 2026-11-23
- Requirements: [FRD](frd.md) C3, C4, C5 and rulings 3 and 4; [HLA](hla.md) "A newer bridge against
  an older server" and "Gates"; [plan](plan.md) delivery 4
- Code cited at 2bd3ed3, the delivery's base. Released code is cited at its `v*` tag
  (`git show v0.4.0:<path>`), the commit its `agention-v*` seed tag will name.
- Probe: on 2026-11-23 the bridge at 2bd3ed3, run from source, was driven by a scratch script
  against `@wayfarerlabs/agention` 0.2.1 and 0.4.0 installed from npm as below. What it showed is
  cited as "the probe"; nothing of it is committed.

This settles what the HLA leaves to delivery 4: which releases the gate runs, how it installs and
starts them, where their certificate and data live, how it drives the bridge at HEAD and what it
asserts, how it reads each release's database for C4, where it lives, and its run time.

## A finding: what an approved session meets before 0.3.0

FRD C3 says that against a server before 0.3.0 an approved session's call is carried out and
reported as failed, and the HLA and delivery 3's docs first said so too. At 2bd3ed3 that holds only
for a bridge process that already holds its grant when it meets such a server:

- Every tool but `register` acts under the names the operator granted, which the bridge learns only
  from a registration answer it accepted (`apps/bridge/src/session.ts:140-155`, `#learn` at
  `session.ts:229-236`), and keeps for the life of its process (`session.ts:146-148`).
- Until then each tool's request is a registration check, `POST /registrations` (`session.ts:149`,
  `#submit` at `session.ts:209-225`), whose answer `#requireVersion` refuses before anything reads
  it (`apps/bridge/src/agent-api.ts:351`, `agent-api.ts:395-415`). So a bridge never learns its
  grant from a server that states no version, and never sends that server a thread request.
- For a key the server knows, 0.2.1's registration route records nothing but, for an approved key,
  its session's last seen (`git show v0.2.1:apps/server/src/http/agent-api.ts`, lines 71-84;
  `submitRegistration` in `apps/server/src/store/registrations.ts` at `v0.2.1`, lines 130-141).

So a session whose bridge starts against a server before 0.3.0, which is how every session starts,
has every call refused and nothing carried out, approved or not; what reaches the server is one
pending registration for a new key, or a last-seen stamp for an approved one. A call is carried out
only when a bridge that accepted its grant from a server serving it then meets a server before 0.3.0
at the same origin within the same process: the operator replacing the server with a release before
0.3.0, such as by restoring a backup there, while the session runs. The known limit is real but
narrower than first stated. Delivery 3 (agention#90) narrowed the operator guide
(`docs/operator-guide.md:1315-1320`), `docs/architecture.md` "Agent bridge" and ADR 0005 to say so
(7c75d54), and the HLA with them (da07f20); the FRD's C3 is the operator's to amend. This design
does not depend on how C3 is worded (Driving the bridge, Approved sessions).

## Which releases

**Recommended: derived from the server line's tags.** For HEAD's agent API version `N`, the gate
checks the newest server release of each agent API version below `N`, a release stating none
counting as one version below every other (FRD C5, ruling 4):

1. HEAD's `N` is read from `packages/api/src/agent-api.ts` with the release order gate's match
   (`scripts/check-release-order.sh:56-66`), which moves into `scripts/_common.sh` as `agent_api_of`
   so both gates read the declaration one way. No match fails, naming the file.
2. The candidates are the tags `agention-vX.Y.Z` reachable from HEAD
   (`git tag --list 'agention-v*' --merged HEAD`), as the agent compatibility gate takes its own
   (`scripts/check-agent-compatibility.sh:21-30`), newest first by version (`--sort=-v:refname`). A
   tag that is not `X.Y.Z`, such as a prerelease, is skipped: an operator installs releases. A
   server tagged after HEAD's branch point is not reachable, and `main`'s own run checks it once
   merged.
3. Each tag's version is read at the tag the same way. A tag whose tree has no
   `packages/api/src/agent-api.ts` states none, as every release before 0.3.0 does: the file and the
   header arrived together in 96c481b, first released in 0.3.0, and no tag before it mentions
   `Agention-Agent-API` anywhere under `apps/` or `packages/`. A tag that has the file but no
   matching line fails, as in the release order gate. If the declaration ever moves, the gate's
   `contract` path moves with it, and releases from before the move then read as stating none; the
   selection cannot tell, but the suite does, since such a release states a version and its refusal
   then differs from the one for none (0.4.0's names version 2).
4. The first tag met at each version below `N` is that version's newest. A version at `N` or above
   is skipped: the agent compatibility gate covers bridges against the server at HEAD, and a server
   at HEAD's version serves the same contract (HLA). No server below `N`, as when no tag at all is
   reachable, fails, asking for `git fetch --tags`: this repository's history always has one, so its
   absence means tags are missing.

At 2bd3ed3, with the seed tags in place, that is 0.2.1 (none: 0.1.0, 0.2.0 and 0.2.1) and 0.4.0
(version 2: 0.3.0 and 0.4.0), while 0.5.0 and 0.6.0 speak 3, HEAD's (`git show <tag>:` at each tag;
`packages/api/src/agent-api.ts:12`).

**A fixed list instead.** `servers=(0.2.1 0.4.0)` in the script needs no tag reading and no fixture
test. Its cost is the case the gate exists for: the pull request that bumps `agentApi.version` must
also add the newest server of the version it leaves, by hand, and a forgotten entry passes silently,
leaving the bridge untested against the server an operator who has not upgraded most likely runs.
The derived list gets that server on the bump's own pull request.

**What deriving costs.** About thirty lines of the script, a fixture test of its decisions (Where it
lives), and the tags, which CI already fetches for the two gates delivery 3 touches
(`.github/workflows/ci.yml:29-32`, `fetch-depth: 0`) and which a local clone fetches with
`git fetch --tags`, as CONTRIBUTING "Checks" already says. The `agention-v*` tags are delivery 3's
operator step: until they exist on the remote (none did on 2026-11-23, by `git ls-remote`), the gate
fails as the agent compatibility gate does. The derived list is worth it: its one recurring case is
the one a fixed list gets wrong.

## Installing and checking them

`scripts/check-server-compatibility.sh` installs each selected release as
`scripts/check-agent-compatibility.sh:35-50` installs bridges: into `$scratch/servers/<version>`, a
`mktemp -d` directory removed on exit, with
`npm install --prefix <dir> --ignore-scripts --no-audit --no-fund --min-release-age=0` by exact
version, then `npm audit signatures --prefix <dir>`, which checks the registry signature and the
provenance attestation npm holds for it. The server package declares no dependencies (its
`package.json` lists only `devDependencies` at `v0.2.1` and `v0.4.0`, and the Build gate refuses a
package that declares any, `scripts/check.sh:72-80`), so nothing else resolves, and
`--ignore-scripts` loses nothing. An install npm refuses fails the gate with npm's own error, as in
the agent compatibility gate. Each directory also gets a file `agent-api` holding the version its
tag states, or `none`, which the suite reads.

In the probe, both installs verified one registry signature and one attestation each.

## Certificates and data directories

The suite makes one certificate for the run with the bridge harness's own: `certificate`,
`testCertificate()` for `localhost` and 127.0.0.1, valid for an hour
(`apps/bridge/src/test-harness.ts:34`, `apps/server/src/http/test-certificate.ts:52-82`). It writes
the certificate and key as PEM into a directory of its own, the key with mode 0600; each release
reads both with `readFileSync` (`apps/server/src/cli.ts` at `v0.2.1`, line 229; at `v0.4.0`, line
287). The bridge trusts it through `NODE_EXTRA_CA_CERTS`, as `BridgeHarness.process` makes a bridge
trust it (`test-harness.ts:208-219`).

Each release gets a data directory of its own, `realpathSync(mkdtempSync(path.join(tmpdir(), ...)))`
as the harness makes its home (`test-harness.ts:112`), mode 0700, and each bridge a home the same
way, since its key file obeys the same private-file rule. The rule refuses a data directory with an
ancestor that another user owns (`foreign_ancestor`) or that its group or others can write, unless
it is sticky (`writable_ancestor`; `checkAncestor` in `packages/private-files/src/private-files.ts`
at `v0.2.1` and `v0.4.0`, lines 134-153). So:

- **In CI** `tmpdir()` is `/tmp`, root's and sticky, which both releases accept, as the Build gate's
  server already shows (`scripts/check.sh:122-126`, under `mktemp -d`).
- **Locally** the same holds wherever `TMPDIR` is unset or private. A directory inside an Agentworks
  workspace is not: on this host `/opt/agentworks/workspaces` is root's with mode 0771 and the
  workspace another user's with mode 2770, so a release refuses a data directory there. The gate
  therefore keeps its state under the system temporary directory, as the Build gate and the bridge
  harness do, and removes it when done. A `TMPDIR` the rule refuses fails the suite with the
  release's own refusal, which names the directory and the fix.

## Starting each release

Both releases take the same command line and print the same start-up line (`apps/server/src/cli.ts`
at `v0.2.1`, usage lines 28-44 and the line at 283-286; at `v0.4.0`, lines 31-55 and 342-345):

```bash
<dir>/node_modules/.bin/agention serve --data <data> --origin https://localhost \
  --listen 127.0.0.1:0 --tls-cert <cert> --tls-key <key>
```

The suite starts it as a child process and reads the port from
`agention: serving <origin> on https://127.0.0.1:<port>`, as the Build gate reads its server's
(`scripts/check.sh:128-132`); only the port is read. A start that prints no such line within ten
seconds, or exits, fails the test with the release's output, and one that cannot start, such as for
a missing command, fails at once naming it. The suite stops it with SIGTERM, which every release
handles by closing its database (`apps/server/src/main.ts` at both tags, lines 4-9), and kills it if
it has not exited 5 seconds later; it waits for the exit before reading the database. Cleanup closes
the bridge, stops the server and removes the scratch directory, each even if one before it fails,
within the compatibility config's hook timeout, and a bridge process whose MCP connection fails is
closed, which ends it.

The origin names no port, so the release can be started before its port is known, and the bridge
reaches it through `AGENTION_CONNECT=127.0.0.1:<port>`, the setting an operator uses for a tunnel
(`apps/bridge/src/agent-api.ts:108-138`). The bridge then gives TLS and `Host` the origin's host
(`docs/architecture.md`, "Agent bridge", Connections), which each release's host check requires
(`apps/server/src/http/app.ts` at `v0.2.1`, lines 78-85; at `v0.4.0`, lines 110-117). An origin with
the port in it would need a port picked before the start and freed for it, which can race.

In the probe each release served in about 100 ms, and with `--listen 127.0.0.1:0`.

## Driving the bridge at HEAD

The suite starts the bridge at HEAD as an agent host starts one: a process of its own from the
source entry, speaking MCP on standard input and output, with `HOME`, `AGENTION_URL`,
`AGENTION_CONNECT`, `AGENTWORKS_AGENT`, `AGENTWORKS_SESSION` and `NODE_EXTRA_CA_CERTS`. That is what
`BridgeHarness.process` does for its in-process server (`test-harness.ts:202-230`), apart from the
server's clock and sign-in, so its transport and client setup moves into a function of
`test-harness.ts` that both use. The source entry, not the build: the build gate runs later in
`scripts/check.sh` (`check.sh:226-235`), and the bundle's parity with the source is that gate's.

**The calls.** `register` first: it creates the session's key (`session.ts:100-103`), without which
every other tool fails in the bridge, never reaching the server (`session.ts:141-145`). Then every
tool the bridge lists, each with valid arguments from a table in the suite, which must name exactly
the tools listed, as the agent compatibility suite checks it called every tool
(`apps/bridge/src/released-bridges.compat.ts:326`), so a new tool joins it. `message_wait` waits 0
seconds, so its failure's pause costs nothing (`apps/bridge/src/tools.ts:428-433`), and
`file_upload` names a file in the bridge's home, which it opens before the server is asked
(`apps/bridge/src/file-tools.ts:131-135`).

**What each answer must be.** The refusal is a `BridgeError`, answered as plain text with `isError`
(`tools.ts:163-170`, `tools.ts:488-490`); it has no code, since the API has none for a bridge's own
problems (`apps/bridge/src/errors.ts:4-9`). So each answer must be:

- an error; and
- the refusal the bridge gives that release's statement, which is plain text, not Agention's JSON:
  `#requireVersion`'s refusal moves into an exported function, `olderServerRefusal(origin, stated)`,
  which `#requireVersion` throws (`agent-api.ts:395-415`), and the suite compares each answer's text
  with `olderServerRefusal("https://localhost", stated).message`, `stated` being the `agent-api`
  file's version, or none.

The comparison is generation parity, one source and its output, never a sentence the test holds: a
change to the refusal's words changes both sides, and the gate does not depend on C3's wording. The
first check alone would not prove C3: a bridge that cannot reach the server, or does not trust its
certificate, also fails every call in plain text, the same for each, and 0.4.0's database would then
show nothing recorded too. The second fails for every failure but the older-server refusal of that
release's own statement, so it also proves the bridge read what the release stated: none from 0.2.1,
version 2 from 0.4.0.

In the probe, against both releases, every tool failed in plain text with one and the same refusal,
naming the statement each release made.

**Approved sessions.** The gate drives unapproved sessions only. Passkeys are not what stops it: a
software authenticator exists (`apps/server/src/auth/test-authenticator.ts`), and with each
release's `agention passkey-link` and web API it could approve the key there. The reason is that
approval changes nothing a session that starts against an older server sends or is told (the finding
above): every call is the same registration check, refused alike. From 0.3.0 the release refuses the
version before authenticating anything (`requireServedAgentApiVersion` in
`apps/server/src/http/agent-api-version.ts` at `v0.4.0`, lines 17-44, mounted first at
`apps/server/src/http/agent-api.ts` line 64), so approval changes nothing there either. Driving
approval would tie the suite to each release's passkey and approval routes for no answer it does not
already check.

The carried-out case needs a bridge that accepted its grant from a server serving it, then meets a
release before 0.3.0 at the same origin: a front of the suite's own switching from one to the other
under a running bridge, with the key approved on both. That proves only that an answer stating none
is refused after the call, which `tools.test.ts:263-290` already proves at the bridge's boundary for
answers and failures alike. Not recommended.

## The database (C4)

The suite reads each release's database with `node:sqlite`, read-only, twice: once the release says
it is serving, before the bridge starts, and once it has exited. Each read takes every table in
`sqlite_schema` and its rows, so it needs no knowledge of a release's schema. In the probe a
read-only connection opened beside the running 0.4.0, and after it stopped, without changing the
database.

- **Every release's** first read must hold the `instance` table's one row, so a database the release
  never wrote, or the wrong file, cannot pass as unchanged.
- **From 0.3.0** the two reads are equal: the release recorded nothing (C4).
- **Before 0.3.0** `registrations` holds exactly one row afterwards, `status` `pending`, with
  `expires_at` after `created_at` by at most an hour (C4), and the reads are equal once
  `registrations` and `sqlite_sequence`, SQLite's own counter for it, are left out of both. The
  columns read are those of `registrations` at `v0.2.1` (`apps/server/src/database/migrations.ts`,
  lines 54-68), and releases before 0.3.0 are fixed history.

The release decides which rule applies by what it states: `none` takes the second, any version the
first. In the probe, 0.2.1 held one pending registration with a lifetime of 3,600,000 ms and 0.4.0
none, and neither held an agent or a session.

## Where it lives

- `scripts/check-server-compatibility.sh`, beside `scripts/check-agent-compatibility.sh` and shaped
  like it: the selection, the installs, then
  `AGENTION_RELEASED_SERVERS="$scratch/servers" npm run --silent --workspace apps/bridge test:server-compat`.
  `--list` prints the selection, one `<version> <agent API version or none>` per line, and stops
  before installing, for the fixture test and for a contributor asking what it would check.
- `apps/bridge/src/released-servers.compat.ts`, a `describe.each` over the installed releases, one
  test each, failing at once without `AGENTION_RELEASED_SERVERS` as its sibling does
  (`released-bridges.compat.ts:14-24`).
- `apps/bridge/package.json` names each suite in its own script, since the one compatibility config
  takes every `*.compat.ts` (`apps/bridge/vitest.compat.config.ts:6`) and each suite fails without
  its own variable: `test:compat` (`package.json:28`) becomes `test:agent-compat`, naming
  `src/released-bridges.compat.ts`, beside `test:server-compat`, so each name says which gate runs
  it. `scripts/check-agent-compatibility.sh:52` follows.
- `scripts/check-server-compatibility.test.sh`, a fixture test in the shape of
  `scripts/check-release-order.test.sh`, runs `--list` in throwaway repositories, and keeps to the
  decisions that can regress (the effort lead's ruling): the newest release of each older version,
  one stating none among them and HEAD's version skipped; a prerelease skipped; version order over
  name order, 0.10.0 above 0.9.0 at one version; and failures for no older release reachable and for
  a contract line written another way.
- `scripts/check.sh`: a "Server compatibility tests" step after "Release order tests", which needs
  neither the network nor the tags, and a "Server compatibility" step after "Agent compatibility",
  in the block `--fast` skips (`check.sh:214-224`), so `--fast` skips the gate.

`ci-success` needs the `check` job (`ci.yml:85-96`), which runs both steps, so the gate is required
with no change to the workflow but its comment.

## Run time

The `check` job has 15 minutes (`.github/workflows/ci.yml:24`). Its recent runs took from 4 min 20 s
to 7 min 8 s (CI runs 45150759719, 45149282127 and 45148920601 on 2026-11-23). In the second, the
agent compatibility gate installed and verified seven bridges in 4.3 s and its suite ran in 10.2 s.

The server gate's share, from the probe and those figures: two installs and signature checks at
about 0.6 s each in CI (0.5 s locally, cached); and per release in the suite, a start of about 0.1
s, a bridge process, eleven calls in 0.35 s, a stop and two reads. With Vitest's own start, about 5
s in all. It grows by one release per agent API version, a few times a year at most, so it stays
seconds against minutes of headroom. Built, the gate ran locally in 12 s end to end, its suite in
1.0 s to 3.8 s.

## Proving it can fail

A verification step of the implementation, recorded in its pull request and not committed: with the
seed tags fetched, the gate passes against 0.2.1 and 0.4.0, then fails with each of these probes,
and passes again once it is reverted.

1. `#requireVersion` accepts any version: against 0.2.1, `register` answers pending, not an error;
   against 0.4.0, the release's `unsupported_version` comes through as Agention's JSON.
2. A missing version is refused as if it were version 1: against 0.2.1, the refusal is not the one
   for a release stating none.
3. `AGENTION_CONNECT` left out, so the bridge cannot reach the release: every answer is plain text
   alike, but not the older-server refusal, and 0.2.1's database has no registration.

## Permanent docs

The plan box's, and two the change outdates, with what each gains:

- **CONTRIBUTING "Checks"**: the two steps in the gates table, `--fast`'s list in the commands
  block, and the network and tags paragraph, which then names this gate too.
- **CONTRIBUTING "The agent API"**: a paragraph on the gate: the releases it takes and why one per
  version suffices, the install as the agent compatibility gate's, the refusal of every tool and the
  database rules for releases from 0.3.0 and before, and that a new tool joins its table; its name
  for the agent compatibility suite's script.
- **CONTRIBUTING "Dependencies"**: the install with the release-age wait off is both compatibility
  gates' exception, for the same reason: each checks a release as soon as it is published, and
  installs a bundle that declares no dependencies.
- **`docs/live-testing.md` "Surfaces"**: the bridge at the head against earlier servers is covered
  on every change by this gate, as the agent compatibility gate covers the other direction.
- **`docs/architecture.md` "Agent bridge"**: its paragraph on the bridge's tests
  (`docs/architecture.md:1136-1142`) gains the server compatibility gate, which runs the bridge at
  HEAD against released servers over TLS with the test certificate, through `AGENTION_CONNECT`.
- **`docs/development-context.md`**: "Security and dependency checks" (`npm audit signatures` for
  each server release the gate installs, line 81-83), "Maintained test harnesses" (the fixture test,
  lines 136-137), "Integration test selection" (the suite runs only in its gate, which `--fast`
  skips, lines 142-146), and "Test environment setup" (the release tags, lines 140-141).

And, since the change outdates them: the header comment of `scripts/check.sh` (lines 7-15), the
`fetch-depth` comment in `.github/workflows/ci.yml` (lines 29-31), the comments of
`apps/bridge/vitest.compat.config.ts` and of `apps/bridge/src/test-harness.ts`, whose bridge process
start moves into `startBridgeProcess`, and the agent compatibility gate's call of the renamed
`test:agent-compat`. The agent compatibility gate's header stays true. The finding above changed no
docs of this delivery's: delivery 3 carries it.
