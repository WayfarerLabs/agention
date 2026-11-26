# Audit log: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md); research:
  [prior art](prior-art-research.md)
- The operator accepted the FRD on 2026-11-25; building starts with P1.
- Vehicle: one pull request per phase, each merged and released before the next starts, not stacked;
  each phase is usable alone. The development contract lists no `sdd:` label, so the pull requests
  cite this directory by path instead.
- Not in these phases: the forwarded-address option FRD R4 mentions, a later change of its own.

## Design

- [x] Requirements, prior-art research, HLA and plan drafted, with the operator's direction quoted
      and four open choices (#123).
- [x] Requirements, HLA and plan reviewed (project review and complexity pass), findings disposed
      (#123).
- [x] The operator accepts the FRD; rulings recorded verbatim in it, and the HLA and plan updated
      for any choice answered otherwise (#123).
- [x] On acceptance, the development contract names this effort as active alongside pull request and
      branch links (#123).

## P1: the log, stdout and files

Design:

- [ ] `audit-lld.md`: each action's event with its exact OCSF 1.9.0 attributes, checked against the
      class schemas without profiles (including where the credential sits in `actor.session`, the
      unknown user of a failed sign-in, and required objects such as 6003's `src_endpoint` when the
      peer is unknown); the fixed `status_detail` codes; coalescing; the table, its indexes and
      triggers; how the store records inside its transactions; the options; whether packaged Vector
      and Grafana Alloy run as their own users.
- [ ] The OCSF version confirmed at implementation under the seven-day hold-back: 1.10.0 becomes
      eligible on 2026-11-27; the lead rules between 1.9.0, for consumers' lag, and the newer one,
      and the choice is recorded in the LLD.

Server:

- [ ] Migration: `audit_events` (`seq` `AUTOINCREMENT`, `uid` unique, the filter columns, `event`,
      `open_until`), its triggers (no update but an open failure's count; delete only the oldest
      row, and only once every sink has passed it), `audit_sinks`, and `browser_sessions.id` with
      existing sessions given one; its frozen hash.
- [ ] `Credential` carries a browser session's id and passkey id; `Identity` carries the request's
      origin (peer address, user agent cut to 256 characters), set where each mount authenticates;
      the writes with no identity take an origin of their own.
- [ ] The event builder: typed inputs only, keys in a fixed order, a random uid, the sequence, the
      correlation uid in a cascade; the OCSF class schemas kept as test fixtures and `ajv` added to
      the server's development dependencies at its locked version.
- [ ] `recordAudit` in every mutating store function, in its transaction; every `POST` operation
      declaration names its action or declares none (the read marks); the web-only routes record
      theirs.
- [ ] Sign-in, sign-out and passkey link use; failures recorded in their own transaction once they
      have spent their rate budget, coalesced per kind per minute with a count.
- [ ] API keys: create, revoke, revocation by a passkey link (correlated), and first use, recorded
      in one transaction with the `last_used_at` update `authenticateApiKey` makes.
- [ ] Registrations: submit, approve, reject and revoke.
- [ ] Passkeys added, renamed and removed, and replaced by a passkey link, as Entity Management 3004
      like API keys; voice settings set and cleared, never with the key.
- [ ] Failures after authentication (FRD R1): a live key refused for scope, and a revoked or expired
      key found by its hash, each recorded once its budget is spent and coalesced per key, with the
      caller's answer unchanged; an unknown key records nothing.
- [ ] `agention passkey-link` records the link it issues in the same transaction.
- [ ] The dispatcher: a loop per sink from its cursor, woken when a transaction that recorded events
      commits and by a 30-second poll; an open coalesced failure held until its minute ends; a new
      sink from the oldest retained event; a short fixed retry; 5 seconds at shutdown.
- [ ] Each sink's state in `audit_sinks`, and stderr lines when a sink starts failing, every 15
      minutes while it fails, and when it recovers, naming the sink by kind; the cursor of a sink no
      longer configured kept, and named on stderr at start and every 15 minutes.
- [ ] `agention audit forget-sink --data DIR KIND`: removes a cursor and records its event.
- [ ] The stdout sink (`--audit-stdout`), acknowledging once a write has drained.
- [ ] The file sink (`--audit-dir`): `audit.jsonl` rotated daily, `--audit-keep-days` (30), the
      directory 0700 and files 0600 through `packages/private-files`, or 0750 and 0640 with
      `--audit-group` (the package learning a group-readable mode), `fsync` before acknowledging.
- [ ] `--audit-retention-days` (365, 0 for forever); pruning at start and with the upload sweep, in
      bounded batches; the usage text in `apps/server/src/cli.ts`.

Tests:

- [ ] Coverage: every declared `POST` on the web, operator and agent mounts, and every web-only
      route, produces exactly its one primary event with the right credential, or none when
      declared.
- [ ] Every action's event validates against the pinned class schemas.
- [ ] Failures before and after authentication recorded only within their budgets, a minute of them
      one event with its count, and an unknown key never.
- [ ] Atomicity: a failed write leaves no event; a failed audit insert fails the write.
- [ ] Triggers: they refuse an update other than an open count, a delete out of order, and a delete
      a sink has not passed.
- [ ] A marker planted in every secret and content field (session cookie and its hash, CSRF token,
      key secret, link token, passkey material, the instance's challenge key, an agent's
      `Authorization` token, the transcription key and audio, message and answer text, title, file
      name and bytes) appears in no event, stderr line or `audit_sinks` error.
- [ ] Dispatcher and sinks: resume from the cursor after a restart; the cursor of a sink no longer
      configured kept and `forget-sink` removing it; stdout under backpressure; file rotation,
      permissions, the group option and keep; options refused when malformed.

Collateral:

- [ ] A new ADR: the audit log, OCSF 1.9.0, the table as system of record and outbox, off-box
      delivery as the tamper evidence and its limit, pluggable sinks, and what it records and never
      records. It reconciles two existing statements of ADR 0001: pruning the log is the first
      deletion of append-only history ("history is retained"), and delivering to sinks is the
      server's first outbound channel of its own ("No push"), each scoped to the audit log.
- [ ] SECURITY.md: what is recorded and never recorded, credentials by non-secret ids, the files'
      modes and the group option, addresses behind a proxy, the delivered copy as the evidence and
      what it does not cover, reads of the log not recorded, and that a restore rolls the log back.
- [ ] Operator guide: an "Audit log" section (what is recorded, the format, stdout and files,
      retention, which sink fits which setting), the options table, the `agention audit forget-sink`
      command under "Commands", and "Backing up" on restoring the log.
- [ ] Architecture document: recording, the table, the dispatcher and sinks.
- [ ] Review checklist: the audit check (each write records its event in its own transaction;
      nothing secret or content-bearing reaches the builder).
- [ ] Live testing guide: checking delivery to stdout and a file on a live instance.

**Done when:** the coverage test lists every write; on a live instance, an API key's writes appear
in an audit file, read by a local collector tailing it, and on standard output, with the key's id
and name; gates and CI pass, and P1 ships in a release.

## P2: reading the log in Agention

- [ ] `audit:read` in `packages/api/src/scopes.ts`, with its description.
- [ ] `listAuditEvents` on the web and operator mounts under `audit:read`, a `GET` that writes
      nothing: filters by credential, action, outcome and time, paged by sequence, with the sinks'
      state for the web UI.
- [ ] Settings, Audit log: the list, its filters, each event's detail, and each sink's state.
- [ ] An API key's detail in Settings lists its recent events.
- [ ] Tests: the scope refused as `not_found` without it; filters and paging; browser tests of the
      page and a key's activity.
- [ ] Collateral: the regenerated `docs/api/openapi.json`; the web UI page's "Reading the audit log"
      and the operator guide's "API keys"; the ADR's scope list; the architecture document; the
      review checklist's operations and scopes (A18).

**Done when:** the operator filters the log by an API key in Settings and sees its writes, and a
script with `audit:read` reads them while one without it is refused; gates and CI pass, and P2 ships
in a release.

## P3: shipping over OTLP

- [ ] `Delivery` as accepted, retry, or paused; backoff from 1 second to 5 minutes, jittered, for a
      retry; `Retry-After` honored; a paused sink sending nothing more, keeping its cursor and
      events, recorded as its last error in `audit_sinks`, of class `refused` with the status, and
      on stderr every 15 minutes with what to correct, and resumed by the next start, whose first
      result overwrites that error; a 413 halving the batch, and pausing for a single event.
- [ ] Settings and the sinks' state in `listAuditEvents` showing a sink whose last error is
      `refused` as paused, with its status and what to correct; `refused` among the sinks' last
      error classes in that answer, and the regenerated `docs/api/openapi.json`.
- [ ] The OTLP sink (`--audit-otlp`): OTLP/HTTP JSON, the event as a map body with promoted
      attributes, headers from `AGENTION_AUDIT_OTLP_HEADERS`, retries on a 429, 502, 503, or 504, a
      timeout, or a network error only, every other 4xx or 5xx and a redirect pausing, a partial
      success final and counted; the transcription provider's URL rule, no redirect followed, a
      10-second timeout.
- [ ] Tests: the answer sort as a pure function over a table (429, 502, 503, 504, a timeout, and a
      network error retry; 400, 401, 500, and 3xx pause; 413 halves, and pauses for a single event);
      against a local receiver, shape and headers, a pausing answer sending one request and then
      nothing more, partial success, 413 halving, no redirect followed, refused URLs, and the
      headers in no event, stderr line, or `audit_sinks` error.
- [ ] Collateral: the operator guide's OTLP sink, saying plainly that any OTLP 4xx or 5xx other than
      429, 502, 503, and 504, a plain 500 included, pauses the export until the next start, and its
      collector recipes for syslog, GELF, and Loki; SECURITY.md's outbound rules; the architecture
      document; the development contract's optional integrations (a log collector or SIEM the
      operator runs); the live testing guide's collector check.

**Done when:** on a live instance, an API key's writes reach a local OpenTelemetry Collector; with
the collector stopped, the lag appears on stderr, and once it restarts every event arrives, none
lost; gates and CI pass, and P3 ships in a release.

## Closeout

- [ ] Permanent docs carry everything the codebase relies on; nothing points into this directory.
- [ ] `locked.md` records what shipped.
