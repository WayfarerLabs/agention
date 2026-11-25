# Audit log: High-Level Architecture

- Status: Draft, following the FRD's draft, with the operator's answers to its open choices
- Date: 2026-11-24
- Requirements: [FRD](frd.md), R1 to R17
- Research: [prior-art research](prior-art-research.md)
- Code facts cite `apps/server/src/` as `S/` and `packages/api/src/` as `A/`, at `main` e69bf39

This effort adds an audit log to the Agention server:

- an event for every write, sign-in and credential change, built in OCSF 1.9.0 JSON and saved in the
  same transaction as the change;
- an append-only `audit_events` table that is both the system of record and every sink's outbox;
- a dispatcher that delivers the table to pluggable sinks, at least once, from a cursor per sink:
  standard output and files;
- then a viewer in Settings with an `audit:read` scope;
- then an OTLP/HTTP logs sink (FRD R10).

No agent route, tool or answer changes.

## Decisions at a glance

- **The event is written with the change** (R7), inside the store's own transaction, so neither
  exists without the other. Sinks read the table afterwards and never touch a request.
- **OCSF 1.9.0** (FRD R6): Authentication 3002 for sign-ins, API Activity 6003 for writes, and
  Entity Management 3004 for API keys, passkeys and registrations. One object everywhere: the same
  bytes in a file or on standard output, the same fields in an OTLP body.
- **The exact credential, never a secret.** Browser sessions gain a random, non-secret id, since
  today a session is known only by its cookie's hash (`browser_sessions` in
  `S/database/migrations.ts:104-112`). API keys and registrations already have ids.
- **Tamper evidence is the copy that has left the box** (FRD R9): each event has a unique id and a
  sequence, and there is no hash chain.
- **A small Sink interface and a dispatcher with one cursor per sink**, in the database. A failing
  sink falls behind and says so; nothing waits for it.
- **Sinks are configured where the server starts**, by `serve` options, one per kind; a network
  sink's credentials come from the environment only.
- **Retention prunes the oldest events only**, and only those every sink has delivered, which a
  trigger enforces.
- **Beyond writes:** refusals of a known API key that matter for security (FRD R1). Reads, the log's
  own included, are not recorded.
- **Failures are coalesced**: one event per kind of failure, and per key, each minute, with a count,
  since anyone who can reach the server can cause them.

## Where it runs

```text
browser / API key / agent --request--> mount: authenticate -> Identity (+ credential, origin)
                                          |
                                          v
                            store function, in BEGIN IMMEDIATE:
                              change rows ... + INSERT audit_events (event JSON)
                                          |  COMMIT
                                          v
                              wake --> dispatcher (in agention serve)
                                          |  per sink: SELECT after cursor, deliver, advance cursor
                         +----------------+----------------+
                         v                v                v
                      stdout         file (rotated)   OTLP/HTTP logs (P3)
                   (PaaS logs)     (homelab tailer)    (collector, vendor)

agention passkey-link (CLI) --> same database, same INSERT, delivered by the server's next poll
agention audit forget-sink (CLI) --> removes a sink's cursor, with its own event
```

## Components

### Recording

**Identity carries what an event needs.** `Credential` (`S/identity.ts:14-17`) gains the browser
session's id and its passkey id beside the hash, which stays for the store's own lookups and never
reaches an event. `Identity` (`S/identity.ts:28-32`) gains the request's origin: the connection's
peer address and the `User-Agent` header, set where the mount authenticates. The few writes with no
identity (sign-in, link use, registration submit) take an origin of their own.

**The store writes the event.** Every mutating store function, already one transaction each
(`S/database/database.ts:75-93`), calls `recordAudit(db, identity, event)` inside that transaction,
after its change, with the action, its target and any details. The function builds the event and
inserts the row. A failed insert fails the transaction, and with it the write (R16).

**Every write is declared.** An operation declaration (`S/http/operations.ts`) that is a `POST`
names its audit action, or declares that it records none, the read marks; the type requires one or
the other, so a new mutation cannot be added silently. The web-only routes
(`S/http/web-api.ts:151-245`) call the store's recording functions directly. A test drives every
declared write and checks its event (see Testing).

**Failures with no actor.** A failed sign-in or link has rolled back, or never opened, its
transaction. Its event is recorded in a transaction of its own, after the failure spends its rate
budget (`failedSignIn`, `failedLink` in `S/http/rates.ts`); requests refused because the budget is
spent are not recorded. The budgets bound CPU, not storage: `failedSignIn` alone admits about 14,400
failures a day from anyone who can reach the server, and `failedKeyAuth` about 86,400. So failures
are coalesced: the first failure of a kind (and, after authentication, of a key) in a minute records
an event; later ones in that minute raise its count, in the same row, until the minute ends and the
event is final and deliverable. The worst case is then one event per kind and key per minute,
whatever the attacker's rate. The event keeps the first failure's origin.

**Failures after authentication** (FRD R1). Two refusals of a key the server has identified are
recorded as failures naming it, each in a transaction of its own after the refusal has spent its
rate budget and coalesced as above, and neither changes the answer, which stays the same for every
refusal (`S/auth/api-keys.ts:190-192`):

- a live key without the operation's scope, refused as `not_found` by the mount before it reads any
  input (`addOperations` in `S/http/operations.ts`), within the key's own `apiKey` budget;
- a revoked or expired key, which `authenticateApiKey` found by its hash but refuses, within the
  `failedKeyAuth` budget. An unknown key names no credential and is not recorded.

**Reads of the log** (FRD R14) record nothing: `listAuditEvents` (P2) is a `GET` whose store work
writes nothing, as review check A18 requires of every read-scope operation.

**Cascades.** One action that changes several credentials records an event for each, correlated by
the first event's `metadata.uid` in their `metadata.correlation_uid`: a passkey link replacing the
operator's passkeys records the sign-in, each passkey removed and added, and each live API key
revoked (ADR 0003, "Recovery revokes keys").

**First use of a key.** `authenticateApiKey` (`S/auth/api-keys.ts:194-226`) already writes
`last_used_at` when it is null or an hour old, in a statement of its own outside any transaction
(`S/auth/api-keys.ts:215-217`). When it is null, that update and the first-use event run together in
one transaction instead.

**The command line.** `agention passkey-link` opens the database itself (`S/cli.ts:385-428`) and
issues the link in a store transaction, so it records its event there, as the server would. Its
actor is the operating system user running the command; it has no request origin. The server's
dispatcher, which polls as well as waking on its own commits, delivers it.

**Request origin.** The server reads no forwarded header (`S/http/app.ts:127`;
`S/http/rates.ts:3-5`), so the address recorded is the connection's peer: behind `tailscale serve`
or a platform's router, the proxy's. A later `serve` option, off by default, may trust a forwarded
header only from a configured proxy's address (FRD R4); this effort does not build it. A request
answered in process (`app.request`, the test harness) has no peer address, and its `src_endpoint`
carries none.

### The table

`audit_events`, one row per event:

- `seq`: `INTEGER PRIMARY KEY AUTOINCREMENT`, so a sequence is never reused, even after pruning
  empties the table. One SQLite writer at a time means sequences commit in order with no gaps a
  reader can see.
- `uid`: a random UUID, the event's `metadata.uid`, unique. After a restore, new events reuse
  sequence numbers a destination has already seen; their uids are new, so deduplication by uid never
  drops them.
- `time`, `class_uid`, `action`, `outcome`, `credential_kind`, `credential_id`: copies of the
  event's fields for filtering, indexed for the viewer (P2).
- `event`: the event's JSON text, exactly as built, never re-serialized.
- `open_until`: for a coalesced failure, the end of its minute; the dispatcher delivers no event
  until it has passed, so a count is final when it leaves.

Triggers, like the other append-only tables' (`messages_no_update` and `messages_no_delete` at
`S/database/migrations.ts:206-213`):

- no `UPDATE`, except raising an open coalesced failure's count before its `open_until`;
- a `DELETE` only of the oldest row, and only of a row every sink's cursor has passed.

`audit_sinks`, one row per configured sink: its `name`, `delivered_seq`, when it last delivered,
since when it has been failing, and its last error as a class and status, never a response body or a
credential.

**Retention** (FRD R8): `--audit-retention-days`, 365 by default, 0 for forever. Pruning runs at
start and with the upload sweep every 10 minutes (`S/store/file-sweep.ts`), in bounded batches,
deleting events older than the period that every sink has delivered. While a sink is failing, the
table grows; its lag shows why.

**Backups and restore.** The table is in `agention.db`, so `agention backup` carries it and a
restore rolls it back, cursors included: sinks then receive again what they had after the backup's
cursor, which their uids deduplicate, and new events reuse the sequences that followed, under new
uids. A destination holding events past the restored sequence sees the numbers reused under new
uids, and knows the reuse for a rollback. The operator guide's "Backing up" says so.

### Events

Every event is an OCSF 1.9.0 object, built by one module from typed inputs only, with its keys in a
fixed order. No request body reaches it; the one string a client supplies, the user agent, is cut to
256 characters, and the path is one of the server's own routes.

- `class_uid`, `category_uid`, `activity_id`, `type_uid`, `class_name`, `activity_name`;
- `time` (epoch milliseconds), `severity_id` (1 Informational, 2 Low for a failure), `status_id` (1
  Success, 2 Failure) and, on failure, `status_detail` (a fixed reason code);
- `metadata`: `version` "1.9.0", `product` (name `Agention`, vendor `Wayfarer Labs`, the server's
  version), `uid`, `sequence`, `log_name` "audit", and `correlation_uid` in a cascade;
- on a coalesced failure, `count`, `start_time` and `end_time`;
- `actor`, and the class's own objects below;
- `src_endpoint` (`ip` when known), `http_request` (`http_method`, `url.path`, `user_agent`) for a
  request;
- `unmapped.credential`: the credential in Agention's own terms, so one field answers "which
  credential" across all three classes.

**Credentials.** The exact attribute placement, here and in the action table, is to be verified
against the pinned schema in P1's LLD. The schema the tests validate against is the classes without
profiles: schema.ocsf.io's export applies profiles by default, which makes `cloud` and `osint`
required. Fields a class requires are always present, so 6003's `src_endpoint` is sent even where
the peer is unknown, as in an in-process request.

| Credential           | `actor.user`                                                             | `actor.session`                                               | `unmapped.credential`                 |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------- |
| Browser session      | the operator: `uid` `person:<id>`, `name`, `type_id` 2 Admin             | `uid` `browser_session:<id>`, `credential_uid` `passkey:<id>` | kind, session id, passkey id and name |
| API key              | the operator, as above                                                   | `credential_uid` `api_key:<id>`                               | kind, key id and name                 |
| Agent's registration | the session: `uid` `session:<id>`, `name` `<agent>/<session>`, 4 Service | `credential_uid` `registration:<id>`                          | kind, registration id, agent, session |
| Command line         | the OS user, `type_id` 3 System; `actor.process` the command             | none                                                          | kind `cli`                            |
| None (a failure)     | no actor; 3002's required `user` is `name` `unknown`, `type_id` 0        | none                                                          | kind `none`                           |

**Actions.** Resource identifiers are stable ids (`thread:<id>`, with `name` the thread's
`<agent>/<session>/<number>`, never its title), plus names the operator chose for groups, tags, keys
and passkeys.

| Action (`api.operation` or entity)                         | Mount                | Class, activity         | Target and details                                    |
| ---------------------------------------------------------- | -------------------- | ----------------------- | ----------------------------------------------------- |
| `startThread`, agent `createThread`                        | web, operator; agent | 6003 Create 1           | session; the new thread and its first message         |
| `sendMessage`                                              | all three            | 6003 Create 1           | thread; the message, with its asks, answers, files    |
| `archiveThread`, `bulkArchive`                             | all three; web, op   | 6003 Update 3           | each thread                                           |
| `uploadFile`                                               | all three            | 6003 Create 1           | file id, size, media type (no name, FRD R5)           |
| `removeUpload`                                             | all three            | 6003 Delete 4           | file id                                               |
| `createGroup`, `createTag`                                 | web, operator        | 6003 Create 1           | group or tag: id, name, color                         |
| `renameGroup`, `recolorGroup`, `orderGroups`               | web, operator        | 6003 Update 3           | group(s): id, new name, color or position             |
| `renameTag`, `recolorTag`                                  | web, operator        | 6003 Update 3           | tag: id, new name or color                            |
| `removeGroup`, `removeTag`                                 | web, operator        | 6003 Delete 4           | group or tag id and name                              |
| `setSessionGroup`, `setSessionTags`                        | web, operator        | 6003 Update 3           | session; group or tags                                |
| `setAgentTags`                                             | web, operator        | 6003 Update 3           | agent; tags                                           |
| agent `updateSession` (status)                             | agent                | 6003 Create 1           | the session's new update                              |
| `markRead`, `markUnread`, `bulkRead`, `markSessionLogRead` | all                  | not recorded (FRD R1)   |                                                       |
| passkey register finish                                    | web                  | 3004 Create 1           | `entity` passkey: id, name                            |
| passkey rename                                             | web                  | 3004 Update 3           | `entity` passkey: id, new name                        |
| passkey remove (or replaced by a passkey link)             | web                  | 3004 Delete 4           | `entity` passkey; the browser sessions it ended       |
| voice settings set, clear                                  | web                  | 6003 Update 3, Delete 4 | `voice_settings`: which fields changed, never the key |
| sign-in finish                                             | web                  | 3002 Logon 1            | `user` the operator; `session` the new session        |
| passkey link use (begin refused, finish)                   | web                  | 3002 Logon 1            | as sign-in; first link: operator created; cascades    |
| sign-out                                                   | web                  | 3002 Logoff 2           | the session ended                                     |
| API key create                                             | web                  | 3004 Create 1           | `entity` key: id, name, scopes, expiry                |
| API key revoke (or by a passkey link)                      | web                  | 3004 Disable 9          | `entity` key: id, name                                |
| API key first use                                          | operator             | 3004 Activate 10        | `entity` key: id, name                                |
| agent `register` (a new registration)                      | agent                | 3004 Create 1           | `entity` registration: id, proposed agent and session |
| `approveRegistration`                                      | web, operator        | 3004 Enroll 6           | registration; the session, group and tags given       |
| `rejectRegistration`                                       | web, operator        | 3004 Other 99, "Reject" | registration                                          |
| `revokeRegistration`                                       | web, operator        | 3004 Disable 9          | registration                                          |
| `agention passkey-link`                                    | command line         | 3004 Create 1           | `entity` passkey link: expiry, first or replacing     |
| a live key refused for scope (FRD R1)                      | operator             | 6003, the operation's   | failure, `status_detail` `scope`; the operation       |
| a revoked or expired key presented (FRD R1)                | operator             | 3002 Logon 1            | failure, `key_revoked` or `key_expired`; the key      |
| `listAuditEvents` (P2)                                     | web, operator        | not recorded (FRD R14)  |                                                       |
| `agention audit forget-sink`                               | command line         | 6003 Delete 4           | the sink's name and the sequence it had delivered     |

Not recorded: reads, the audit log's included (FRD R14); transcriptions (no database write); the
idle-expiry extension of `GET /session`, hourly `last_used_at`, passkey counters and sessions'
`last_seen_at` (`S/store/presence.ts:22-26`), which agents' calls stamp, `GET`s included; the upload
sweep; credentials expiring; and `agention backup`, which opens the database read-only.

**Worked example.** API key 7, named `ci-deploy`, archives thread 118 (`claude/builder/42`) through
the operator API:

```json
{
  "class_uid": 6003,
  "category_uid": 6,
  "activity_id": 3,
  "type_uid": 600303,
  "class_name": "API Activity",
  "activity_name": "Update",
  "time": 1795564800123,
  "severity_id": 1,
  "status_id": 1,
  "metadata": {
    "version": "1.9.0",
    "product": { "name": "Agention", "vendor_name": "Wayfarer Labs", "version": "0.7.0" },
    "uid": "3f2b8c1e-5d4a-4e8f-9a61-0c7d2e9b4f15",
    "sequence": 4211,
    "log_name": "audit"
  },
  "actor": {
    "user": { "uid": "person:1", "name": "operator", "type_id": 2 },
    "session": { "credential_uid": "api_key:7" }
  },
  "api": { "operation": "archiveThread", "service": { "name": "operator/v1" } },
  "src_endpoint": { "ip": "127.0.0.1" },
  "http_request": {
    "http_method": "POST",
    "url": { "path": "/api/operator/v1/s/claude/builder/threads/42/archive" },
    "user_agent": "tmux-agents/0.3"
  },
  "http_response": { "code": 200 },
  "resources": [{ "type": "thread", "uid": "thread:118", "name": "claude/builder/42" }],
  "unmapped": { "credential": { "kind": "api_key", "id": 7, "name": "ci-deploy" } }
}
```

The address is the loopback because the server sits behind `tailscale serve`. On a file sink this is
one line, without the indentation.

### Dispatcher and sinks

```ts
interface Sink {
  readonly name: string;
  // Delivers events in sequence order. Resolves with the last sequence the
  // destination accepted, which may be short of the batch's end.
  deliver(batch: readonly AuditRecord[], signal: AbortSignal): Promise<Delivery>;
  close(): Promise<void>;
}
type Delivery =
  { ok: true; through: number } | { ok: false; retryAfterMs?: number; reason: string };
interface AuditRecord {
  seq: number;
  uid: string;
  time: number;
  json: string;
}
```

One loop per sink, in `agention serve` only:

```text
loop:
  batch <- events after the sink's cursor, at most 100 events or 1 MiB
  if empty: wait for a wake (a commit that recorded events) or 30 seconds
  result <- deliver(batch)
  ok:     cursor <- result.through, in a short transaction; backoff reset
  not ok: note the failure; wait max(retryAfter, backoff); backoff doubles, 1 s to 5 min, jittered
```

- **Never dropped.** A destination refusing for good (a 4xx other than 408, 413 and 429) is a
  configuration problem: the sink keeps retrying at the longest backoff and reports itself failing,
  rather than skipping events. A 413 halves the batch. An OTLP partial success is final, per the
  protocol: the sink advances, counts the rejected records, and logs the count.
- **Lag.** For each sink: events behind the head, the age of the oldest undelivered, the last error.
  `agention serve` writes a stderr line when a sink starts failing, every 15 minutes while it fails,
  and when it recovers (`S/cli.ts:224-227`), naming the sink by its kind, never its URL. Settings
  show it from P2.
- **Wake.** `recordAudit` marks its transaction, and `Database.transaction`
  (`S/database/database.ts:75-93`) wakes the dispatcher once that transaction commits, as store
  writes call `store.notifier.notify` for the long polls; the 30-second poll picks up what the
  command line wrote.
- **Start and stop.** A sink new to the database starts from the oldest retained event, or from the
  head with `start=now`. A sink no longer configured keeps its cursor, which holds back retention,
  and `agention serve` writes a stderr line at start and every 15 minutes naming it and how far
  behind it is: one start without a sink's option, such as a missing platform variable, must not let
  retention prune what that sink never received. `agention audit forget-sink` removes the cursor. A
  sink's cursor is keyed by its kind, since each kind is configured at most once. At shutdown each
  sink gets 5 seconds to finish its batch; whatever is undelivered waits in the table.

**stdout.** One JSON line per event. `agention serve` writes nothing else to standard output (its
own lines go to stderr). Node writes to a pipe asynchronously, so a batch is acknowledged only once
its write has drained, and backpressure holds the loop.

**file.** `--audit-dir DIR` writes `DIR/audit.jsonl`, rotated daily at UTC midnight, the rotated
file named for its UTC date, keeping the newest `--audit-keep-days` rotated files (30 by default).
The directory is created 0700, or refused if any other user has any access to it, and files are
0600, through `packages/private-files` as the data directory is. `--audit-group NAME` is for a
collector that runs as its own user, as packaged collectors commonly do (to confirm for Vector and
Grafana Alloy in the LLD): the directory is 0750 and files 0640, in that group, which the server's
user must belong to; other users still have no access. A batch is written and `fsync`ed before it is
acknowledged.

**otlp** (P3). `--audit-otlp URL` POSTs OTLP/HTTP JSON to the full logs URL (a collector's
`/v1/logs`, Loki's `/otlp/v1/logs`). Resource attributes `service.name` `agention` and
`service.version`; one log record per event with `timeUnixNano`, `severityNumber` 9 (13 for a
failure), `eventName` `ocsf.<class>`, the event as a map `body`, and `ocsf.class_uid`,
`ocsf.activity_id` and `agention.audit.sequence` as attributes. Retries only on 429, 502, 503, 504
and network errors, honoring `Retry-After`. Headers, such as a vendor's API key, come from
`AGENTION_AUDIT_OTLP_HEADERS` in the `OTEL_EXPORTER_OTLP_HEADERS` format. The URL is checked by the
transcription provider's rule (`S/transcription/base-url.ts`): HTTPS anywhere but link-local and
metadata addresses, plain HTTP only on the operator's own network, and no user information, query or
fragment. It follows no redirect and times out after 10 seconds. The retry policy above (backoff,
`Retry-After`, a lasting 4xx retried rather than skipped, 413 halving) arrives with it; until then
the two local sinks retry at a short fixed interval.

### Configuration

```text
--audit-stdout
--audit-dir /var/log/agention  [--audit-group alloy]  [--audit-keep-days 30]
--audit-otlp https://otel.lan:4318/v1/logs            (P3)
AGENTION_AUDIT_OTLP_HEADERS=api-key=...               (P3)
--audit-retention-days 365
```

Each kind is configured at most once, by options like every other `serve` setting
(`S/cli.ts:38-65`). Options take no secrets, and the URL rule keeps a credential out of the usual
places in a URL; a token embedded in a URL's path cannot be told apart, so no stderr line or
Settings page shows a sink's URL, only its kind. Sinks change only on restart. The usage text in
`S/cli.ts` and the operator guide's options table (`docs/operator-guide.md:110-120`) list the
options.

### Forgetting a sink

`agention audit forget-sink --data DIR KIND` removes a sink's cursor, so retention no longer waits
for it, and records an event naming the sink and the sequence it had delivered. It opens the
database as `agention passkey-link` does, so it works whether or not the server runs; a sink still
configured gets a new cursor at the next start.

### Viewer (P2)

- An operator operation, `listAuditEvents`, on the web and operator mounts under a new scope,
  `audit:read` (`A/scopes.ts:7-19`), filtering by credential, action, outcome and time, paged by
  sequence. A browser session holds every scope; no key holds `audit:read` unless the operator gives
  it.
- Settings, Audit log: the list with those filters, each event's detail as its fields and its JSON,
  and each sink's state and lag.
- An API key's detail in Settings lists its recent events, through the same operation.

## Which sink fits which setting

| Setting                               | Sink                          | Notes                                                                |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| Fly.io                                | stdout                        | Fly Log Shipper (Vector) forwards; watch it, it can stall silently   |
| Render                                | stdout                        | Render's log streams forward over syslog TLS or HTTPS                |
| Railway                               | stdout, or otlp               | No native drain; run a Vector forwarder, or send OTLP to a collector |
| Cloud Run                             | stdout                        | A JSON line becomes `jsonPayload` in Cloud Logging                   |
| Azure Container Apps                  | stdout                        | Lands in Log Analytics, from which Sentinel reads                    |
| Datadog, Elastic Cloud, Grafana Cloud | otlp, or file via an agent    | Directly, or through the vendor's agent or a collector               |
| Splunk, HEC-compatible SIEMs, Cribl   | file, via a forwarder         | Universal Forwarder, or a collector's HEC exporter                   |
| Homelab, systemd, Docker              | file, or stdout               | stdout lands in the journal or `docker logs`                         |
| Homelab with Wazuh                    | file                          | `localfile` with `log_format json`                                   |
| Homelab with Loki                     | otlp                          | Loki 3.x at `/otlp/v1/logs`; keep ids out of labels                  |
| Homelab with Graylog                  | file, or otlp to a collector  | Graylog takes OTLP over gRPC only; a collector forwards GELF         |
| Syslog receivers (rsyslog, syslog-ng) | file or otlp, via a collector | Vector, Fluent Bit or the OTel Collector forwards over syslog TLS    |

## Data model additions

| Where                       | Holds                                                                             |
| --------------------------- | --------------------------------------------------------------------------------- |
| `audit_events` (new)        | seq, uid, time, class, action, outcome, credential kind and id, event, open_until |
| `audit_sinks` (new)         | name, delivered_seq, last delivery, failing since, last error                     |
| `browser_sessions.id` (new) | a random, non-secret id, unique; existing sessions given one by the migration     |

One migration per phase that needs one, each with its frozen hash, rolling back as a whole.

## Security model additions

FRD R5 and R16 state the rules; the design adds:

- **Typed inputs only** reach the builder, and a test plants a marker in every secret and content
  field and finds it in no event, stderr line or `audit_sinks` error. Credentials are named by
  non-secret ids, never the cookie or its hash.
- **Bounded failures:** every failure event, before or after authentication, is recorded only within
  a rate budget it has already spent, and coalesced to one event per kind and key per minute; the
  user agent is cut to 256 characters.
- **Addresses** are the peer's, unverified; behind a proxy, the proxy's (FRD R4).
- **Destinations hold activity metadata**, never content; the operator guide says their access
  controls then apply. Readers in Agention are the operator alone.
- **Review checklist:** a new check: every write records its event in its own transaction; nothing
  secret or content-bearing reaches the builder; sink credentials only from the environment.

## Testing

- **Coverage:** the in-process harness (`S/http/test-harness.ts`) calls every declared `POST` on the
  web, operator and agent mounts, and the web-only routes, and finds exactly one primary event with
  the declared action and credential, or none for a declared exclusion.
- **Schema:** every action's event validates against the pinned OCSF 1.9.0 class schemas, kept as
  test fixtures, with `ajv`, already in the lockfile through the bridge, added to the server's
  development dependencies at its locked version.
- **Atomicity:** a write that fails after recording leaves neither change nor event; a failed audit
  insert fails the write.
- **Triggers:** they refuse an update other than an open failure's count, a delete that is not the
  oldest, and a delete a sink has not passed.
- **Secrets:** the marker test above, over every action, with markers in the session cookie and its
  hash, the CSRF token, an API key's secret, a passkey link token, passkey material, the instance's
  challenge key, an agent's `Authorization` token, the transcription key and audio, the OTLP
  headers, and message, answer, title and file content.
- **Beyond writes:** a key refused for scope and a revoked or expired key each record a failure
  naming the key, only within their budgets, with the caller's answer unchanged; an unknown key
  records nothing; a minute of failures of one kind is one event with their count, delivered only
  once its minute has ended; a `listAuditEvents` call records nothing.
- **Restore:** events recorded after restoring a copy reuse its later sequences under new uids.
- **Forgetting a sink:** the cursor of a sink no longer configured survives a start and holds back
  retention; `forget-sink` removes it and records its event.
- **Dispatcher:** a fake sink's partial acknowledgments and failures; a restart resuming from the
  cursor; a stalled sink not delaying a write; with OTLP (P3), `Retry-After` and backoff on a fake
  clock.
- **Sinks:** stdout backpressure with a slow stream; file rotation, permissions, the group option
  and `--audit-keep-days`; OTLP (P3) against a local receiver: shape, retry codes, partial success,
  413 halving, no redirect followed, refused URLs.
- **Configuration:** the options refused when malformed, such as a group the server's user is not
  in.
- **Live:** the operator's instance with a local Vector or OpenTelemetry Collector, per
  `docs/live-testing.md`.

## Decision record

1. **OCSF 1.9.0 JSON** (FRD R6, the operator's choice). The only open security taxonomy most SIEMs
   read or translate. Pinned 1.9.0, since 1.10.0 (2026-11-20) is inside the seven-day hold-back;
   only long-lived classes and attributes. _Alternatives:_ **a flat object of Agention's own**,
   about half the size, with no class or activity to choose per action, read as plain JSON by every
   tool, which is how all but Splunk, Datadog, Google SecOps and Security Lake read OCSF too;
   **ECS**, native to Elastic only; **CEF or LEEF**, flat key-value with fragile escaping that
   cannot carry nested actors and resources.
2. **Classes 3002, 6003 and 3004.** _Alternative:_ User Management 3007 (Add and Remove Programmatic
   Credentials) for API keys and passkeys, the class that superseded Account Change; 3004 is older
   and more generic, so older parsers know it, and registrations fit it too.
3. **The table is the system of record and the outbox**, written in the change's transaction.
   _Alternatives:_ log lines only, which lose events in any outage and cannot back a viewer; an
   in-memory queue, unbounded or lossy; a second database file, which breaks the one transaction.
4. **No hash chain; off-box delivery is the evidence** (FRD R9). Whoever can write the database can
   recompute a chain, so it catches only accidents and naive edits, never removal of the oldest
   events; a delivered copy holds against the box. _Alternatives:_ a SHA-256 chain over the stored
   bytes with a verify command; that chain with signed checkpoints sent to the sinks, whose key
   lives on the box they guard against.
5. **Sink interface, cursors in the database, at least once.** _Alternatives:_ Vault's
   refuse-if-no-device, which would let a sink block the operator; Kubernetes' bounded batch buffer,
   which drops.
6. **stdout and files; OTLP/HTTP later** (FRD R10, the operator's choice). _Alternatives:_ no
   network sink, a collector tailing the files; OTLP and an HTTP sink with a Splunk HEC mode.
   _Deferred either way:_ syslog over TLS, GELF, Loki push and cloud APIs, which a collector
   reaches; each direct integration is auth code, tests and a secret. OTLP is written as JSON by our
   own code, since the JavaScript logs SDK is not stable.
7. **`serve` options, one per kind; credentials from the environment** (FRD R12). _Alternatives:_ a
   repeatable sink spec with names, for several sinks of one kind, which no setting needs; a
   configuration file, the server's first.
8. **Metadata only; titles and file names out** (FRD R5).
9. **Retention by age, after every sink has delivered** (FRD R8; 365 days, the operator's choice).
   _Alternative:_ prune regardless, recording a gap event.
10. **The viewer before network shipping** (FRD R13): it answers which credential did what, the
    question the log exists for.
11. **A random uid per event; order by sequence.** Deduplication survives a restore, and reused
    sequences under new uids mark it. _Alternative:_ a start event naming the latest sequence, which
    adds a class and says nothing the reuse does not.
12. **The peer address, no forwarded headers**, as the rate budgets already decided (FRD R4); a
    `serve` option trusting a configured proxy is a later change of its own.
13. **A non-secret browser session id**, added by migration, since the hash is all a session has.
14. **Passkeys as Entity Management 3004**, like API keys, so a SIEM's credential-change rules catch
    them. _Alternative:_ API Activity 6003, as ordinary writes.
15. **Security failures after authentication** (FRD R1, the operator's choice), bounded by the
    existing budgets and coalesced.
16. **Failures coalesced per kind and key per minute**, because the rate budgets bound CPU, not
    storage. _Alternative:_ a fixed daily cap, which hides an attack's later failures entirely.
17. **Reads, the log's own included, not recorded** (FRD R14), keeping every read free of writes.
    _Alternative:_ recording reads of the log, as OWASP advises, with review check A18 gaining one
    exception.
18. **Read marks not recorded** (FRD R1): the most frequent writes, saying nothing about what a
    credential did to the work.
19. **Sinks no longer configured keep their cursors until `forget-sink`**, so one start without a
    sink's option cannot prune what it never received. _Alternative:_ a grace period, which still
    prunes after a long enough mistake.

## Delivery

One pull request per phase, each merged and released before the next starts; each is usable alone:

1. **P1:** the table, events for every write and the security failures, stdout and file sinks with
   their options, retention, `forget-sink`, and each sink's state and stderr lines.
2. **P2:** the viewer and `audit:read`.
3. **P3:** the OTLP sink, with backoff and `Retry-After`.

Each carries its collateral; see the [plan](plan.md).
