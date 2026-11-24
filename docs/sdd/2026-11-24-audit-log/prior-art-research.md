# Audit log research: schemas, pluggable sinks, integrity

Prior-art research for the Agention audit log design. Researched 2026-11-24.

Scope: an audit log for a single-operator Node.js server with one SQLite database, run in a homelab
or on a cloud platform, recording what each credential did: writes through a browser session, an API
key or an agent's registration, API key lifecycle, registration decisions and sign-ins. The
operator's direction: pluggable, writes to disk, ships to something sensible on PaaS and in a
homelab, query-friendly, "think SIEM data".

**Method.** Primary documentation was fetched where reachable (schema.ocsf.io, the RFC Editor,
vendors' docs); a search summary stands in where a page refused fetching, and the sources table says
so. Source numbers like [S12] refer to that table. **(analysis)** marks reasoning rather than a
source's claim.

**Grading** (sources table): **P** primary (a spec, standard, or a vendor's own docs for its own
product); **S** secondary (a vendor writing about others, news, an aggregator, or a search summary
of a page that could not be fetched); **C** community (forums, Q&A).

Each finding ends with the **design decision** it supports, by its number in the HLA's
[decision record](hla.md#decision-record).

## Executive summary

- **Schema: OCSF JSON, one object per line.** It is the only open schema that is a security event
  taxonomy rather than an envelope, that the named SIEMs accept natively or translate, and that a
  small app can write without an SDK [S1-S5, S12-S16]. Pin one released version: 1.9.0 (2026-08-03);
  1.10.0 (2026-11-20) is inside the seven-day hold-back [S4]. Consumers lag by several minor
  versions [S12, S14], so use long-lived classes and attributes. _Decisions 1 and 2._
- **The database table is the system of record and every sink's outbox.** Teleport (database
  backends plus export), authentik (database events plus log forwarding), GitHub (a seven-day buffer
  per stream) and Vector (disk buffers) all keep a durable local copy that delivery catches up from
  [S20, S24, S28, S29]. _Decision 3._
- **File and standard output first, OTLP if the operator takes it.** File and standard output as
  JSON Lines reach the PaaS log pipelines and every homelab collector; OTLP/HTTP logs reach the
  major vendors and collectors directly, and HTTP with a Splunk HEC mode reaches HEC-compatible
  SIEMs; syslog, GELF, Loki push and cloud APIs are reached through a collector [S9, S17-S19, S25,
  S29-S47]. _Decisions 5 and 6._
- **Integrity: the copy off the box.** A chain alone is tamper-evident only for values committed
  elsewhere; truncation and full recomputation go unseen otherwise [S48, S49]. Delivered events are
  such values already, so no chain is kept. _Decision 4._
- **Metadata, never secrets or content.** Kubernetes' `Metadata` level, Grafana's bodies off by
  default, GitHub's hashed token ids and OWASP's never-log list all point the same way [S21, S23,
  S26, S27, S70]. _Decision 8._
- **Delivery failure is visible, never silent, and never blocks the request.** The local write is
  mandatory, as Vault refuses a request no audit device can record [S21]; network sinks retry with
  backoff honoring `Retry-After` and never retry an OTLP partial success [S9], and report lag
  (Kubernetes' `apiserver_audit_error_total`; Fly's shipper stalling silently) [S23, S38].
  _Decision 5._

## 1. Event schemas

### 1.1 OCSF

- **Versioning.** Semantic Versioning; v1.8.0 (March 2026), v1.9.0 (2026-08-03), v1.10.0
  (2026-11-20). The breaking-change sections of 1.9 and 1.10 are empty; 1.9.0 made `superseded_by`
  mandatory on deprecations [S4]. _Decision 1: pin 1.9.0, revisit at implementation._
- **Shape.** Every event carries `class_uid`, `category_uid`, `activity_id`, `type_uid`
  (`class_uid * 100 + activity_id`), `severity_id`, `time` (epoch milliseconds) and `metadata`
  (required `version` and `product`; optional `uid`, `sequence`, `correlation_uid`, `logged_time`)
  [S1-S3, S5]. Profiles such as Cloud are optional overlays [S1]. _Decision 2: `metadata.sequence`
  carries the table's sequence, `metadata.uid` a unique id, `correlation_uid` ties a cascade to its
  cause._
- **API Activity 6003** (category 6). Activities 1 Create, 2 Read, 3 Update, 4 Delete, 5 List (new
  in 1.10.0), 99 Other. Required: `actor`, `api` (only `api.operation` required within it),
  `src_endpoint`. Recommended: `http_request`, `http_response`, `resources`, `status_id` [S1, S10b].
  `actor` needs at least one of `user`, `session`, `process`, `application` and a few others;
  `app_name` and `app_uid` are deprecated since 1.9.0 for `application` [S10c]. _Decision 2: every
  write._
- **Authentication 3002** (category 3). Activities 1 Logon, 2 Logoff, 99 Other among others.
  Required: `user`, and one of `dst_endpoint` or `service`. Recommended: `auth_protocol_id`,
  `status_id` (1 Success, 2 Failure), `status_detail`, `src_endpoint`, `session` [S2]. _Decision 2:
  sign-in, sign-out, passkey link use._
- **Entity Management 3004.** Activities 1 Create, 3 Update, 4 Delete, 6 Enroll, 7 Unenroll, 8
  Enable, 9 Disable, 10 Activate and others; required `entity`; not deprecated [S8b]. _Decision 2:
  API keys, passkeys and registrations._
- **User Management 3007** has 18 Add and 19 Remove Programmatic Credentials, and supersedes Account
  Change 3001, deprecated since 1.9.0 [S7, S8]. _Decision 2, alternative recorded._
- **User object:** at least one of `account`, `name`, `uid`; `type_id` 1 User, 2 Admin, 3 System, 4
  Service; `credential_uid` deprecated since 1.6.0 [S8c]. _Decision 2._
- **Tooling.** schema.ocsf.io serves each class as JSON Schema under `/schema/<ver>/classes/<name>`;
  no official npm package [S11]. _Plan P1: events validated against the pinned schema in tests._
- **Same space.** NVIDIA OpenShell, an agent sandbox supervisor, emits OCSF 1.8.0 (3002 and 6003
  among its classes) as daily-rotated JSON Lines, to stderr, or over OTLP; its console delivery
  drops when its queue is full [S53]. _Decisions 1 and 5._

#### SIEM adoption

| SIEM               | OCSF status                                                                        | Source |
| ------------------ | ---------------------------------------------------------------------------------- | ------ |
| AWS Security Lake  | Required for custom sources: Parquet, one class per source, OCSF 1.3 and earlier   | [S12]  |
| Splunk             | Edge Processor `ocsf` and `to_ocsf` commands; an OCSF-CIM add-on                   | [S13]  |
| Google SecOps      | Google-maintained parser, log type `OCSF`; changelog cites 1.1.0 categories        | [S14]  |
| Datadog Cloud SIEM | OCSF processor in log pipelines                                                    | [S15]  |
| Elastic            | No native OCSF; ECS is native; a Security Lake integration exists                  | [S16]  |
| Microsoft Sentinel | No first-party OCSF connector found; ASIM normalizes                               | [S16b] |
| Wazuh, Graylog     | OCSF only through Security Lake integrations or specific AWS telemetry (secondary) | [S16c] |

_Decision 1: OCSF reaches the most SIEMs; Security Lake's Parquet and version limit is out of scope
and reachable through a collector's transform._

### 1.2 Alternatives

- **ECS** (9.5.0): `event.category` (`authentication`, `iam`, `configuration`, `session`, `api`)
  with allowed `event.type`, plus `event.action` and `event.outcome` [S50, S55]. Native to Elastic,
  plain JSON elsewhere. Donated to OpenTelemetry in 2023; Elastic now says convergence is partial
  [S51, S54]. _Decision 1, alternative: better only if Elastic is the sole target._
- **CEF and LEEF**: a syslog prefix, a pipe-delimited header and `key=value` extensions with
  backslash escaping (CEF) [S56]; IBM's LEEF, whose full spec goes to partners [S57]. Broad legacy
  support, but flat key-value pairs cannot carry nested actor and resource objects without lossy
  flattening and fragile escaping **(analysis)**. _Decision 1, alternative._
- **RFC 5424 syslog with structured data** is a transport, not a schema: SD parameters are strings
  needing an enterprise number, and receivers must accept only 480 octets (2048 over TLS) [S17,
  S18]. _Decision 6: deferred as a sink._
- **OpenTelemetry logs** are a stable data model and protocol (`/v1/logs`, port 4318, JSON with
  lowerCamelCase keys and int64 as strings; retry only on 429, 502, 503, 504; honor `Retry-After`;
  never retry a partial success) [S9, S10]. The JavaScript logs SDK is still "Development" [S58],
  and no audit or security semantic convention exists [S59]. So OTLP is an envelope: the OCSF object
  as the record's body, a few attributes promoted **(analysis)**. _Decision 6: the OTLP sink writes
  OTLP/HTTP JSON itself, without the SDK._
- **CloudEvents** is a routing envelope, not a security taxonomy; its rule that `source` and `id`
  identify an event uniquely is worth borrowing under at-least-once delivery [S60, S61].
  _Decision 11._
- **A bespoke flat schema** would be smallest to write and the hardest for every SIEM to read
  **(analysis)**. _Decision 1, alternative._

## 2. How comparable products build pluggable audit sinks

| Product    | Sinks                                                          | Guarantee                         | When a sink is down                 | Source      |
| ---------- | -------------------------------------------------------------- | --------------------------------- | ----------------------------------- | ----------- |
| Vault      | `file` (path may be `stdout`), `syslog`, `socket`              | at least one device must succeed  | the request is refused              | [S21, S22b] |
| Kubernetes | `log` (JSON Lines, size and age rotation), `webhook` (batched) | batch best effort; blocking modes | buffer overflow drops, counted      | [S23]       |
| GitHub     | managed streams: S3, Azure, GCS, Datadog, Splunk HEC           | at least once, duplicates         | 7-day server-side buffer, then loss | [S24]       |
| Tailscale  | Splunk HEC and HEC-compatible SIEMs, Elasticsearch, S3, Vector | not documented                    | not documented                      | [S25]       |
| Teleport   | `dir` JSON lines, DynamoDB, Firestore, Athena; several at once | durable in the backend            | not documented                      | [S20]       |
| Grafana    | `file` (size and day rotation), `loki`, `logger` (console)     | best effort                       | not documented                      | [S27]       |
| authentik  | database events, 365-day default; forward the container's logs | in-app                            | n/a                                 | [S28]       |
| OpenShell  | JSONL files, stderr, OTLP                                      | best effort                       | bounded queue drops                 | [S53]       |

Further notes:

- Vault logs sensitive strings as HMAC-SHA256 and recommends two devices [S21]; its file device does
  not rotate and reopens on `SIGHUP` [S22b]. Enterprise filters without a fallback leave gaps
  [S21b].
- Kubernetes logs secrets at `Metadata` so contents never appear [S23].
- GitHub identifies tokens by `hashed_token` (SHA-256, base64) [S26]; Grafana records API key ids,
  and request bodies only when verbose [S27]. Keycloak exposes an event listener interface; webhooks
  come from third-party extensions [S64]. Gitea's audit log was Enterprise-only until 28.0 [S62,
  S63].

The shared shape **(analysis)**: a few built-in sinks, a durable local copy, one or two generic
network protocols, and loss that is metered rather than silent. Tailscale shows Splunk HEC is the de
facto generic SIEM protocol: one HEC sink reaches many products. _Decisions 3, 5 and 6._

## 3. Sinks per environment

### 3.1 Cloud platforms

- **Standard output JSON Lines** is the baseline everywhere. Cloud Run turns a line of JSON into
  `jsonPayload` [S36]; Azure Container Apps routes stdout to Log Analytics, storage, Event Hubs or
  partner SIEMs with minutes of delay [S37]; Fly ships stdout through its Log Shipper (Vector),
  which "can occasionally stop shipping logs without exiting" [S38]; Render streams logs over syslog
  TLS or HTTPS [S39]; Railway has no native log drain and documents a Vector forwarder [S40].
- **Node's stdout is asynchronous on pipes**, which is how containers capture it, and
  `process.exit()` can lose what is pending [S65]. _Decision 6: the stdout sink acknowledges only
  once a write has drained, and the server flushes it on shutdown._
- **OTLP/HTTP logs** reach the Datadog Agent (logs off by default) [S42], Elastic Cloud's managed
  OTLP [S43], Google's Telemetry API with IAM authentication [S44], and Loki 3.x at `/otlp/v1/logs`
  [S30].
- **Splunk HEC**: `POST /services/collector/event`, `Authorization: Splunk <token>`, objects with
  `time`, `host`, `source`, `sourcetype`, `index`, `fields` and `event`, batched by concatenation
  [S45]. Indexer acknowledgment needs a channel and, on Splunk Cloud, only Firehose may use it
  [S46]. _Decision 6: a HEC mode, if taken, without acknowledgment._
- **Cloud vendors' log APIs** each need their own auth: Sentinel needs an Entra app, a data
  collection rule and an endpoint [S47]. A collector owns retries, buffers and cloud auth, and each
  direct integration would be auth code, a test matrix and a stored secret **(analysis)** [S29-S31].
  _Decision 6: deferred._

### 3.2 Homelab

- **Files with rotation**: Kubernetes and Grafana rotate in process by size, day and count [S23,
  S27]; tailers include Wazuh (`log_format json`, one-line JSON) [S32], Fluent Bit `tail` [S33] and
  Vector `file` [S31]. In-process rotation needs no signal handling and works in containers
  **(analysis)**. _Decision 6._
- **Syslog over TLS** has universal receivers, with the size limits above [S17-S19].
- **Loki** takes its own push and native OTLP; labels must stay low-cardinality, never user, key or
  request ids [S30, S66].
- **Graylog** takes GELF over UDP, TCP or HTTP [S67], but its OpenTelemetry input is gRPC only, with
  no OTLP/HTTP [S68], so an OTLP/HTTP sink reaches Graylog only through a collector. _HLA, "Which
  sink fits which setting"._
- **Vector and Fluent Bit** serve as hubs, taking OTLP, HEC, HTTP, syslog and files [S31, S33].

## 4. Integrity and operations

- **Hash chains** detect edits and insertions, but whoever can write the log can truncate its tail
  or recompute the whole chain unless a value has been committed elsewhere [S49]. Merkle history
  trees give logarithmic proofs [S69], which a single operator's volume does not need
  **(analysis)**. _Decision 4._
- **Signed, chained digests**: CloudTrail delivers an hourly digest of its log files, signed, each
  carrying the previous digest's signature, so a verifier can prove deletion, modification, or that
  nothing was delivered for a period [S48]. _Decision 4, alternative._
- **Retention** defaults seen: authentik 365 days [S28], Teleport HA one year and `dir` forever
  [S20], GitHub 180 days [S25b]. Never delete what a sink has not received without recording the gap
  **(analysis)**. _Decision 9._
- **Backpressure.** Block only the local write (Vault, Kubernetes `blocking-strict`); spool for
  network sinks (Vector's disk buffer, GitHub's buffer) [S21, S23, S24, S29]. Retry with exponential
  backoff, honor `Retry-After`, do not retry non-retryable 4xx, treat an OTLP partial success as
  final [S9]. Give each event a stable id for deduplication [S24, S61]. _Decisions 5 and 11._
- **Redaction.** OWASP: never log session identifiers, tokens or keys; prefer structured formats;
  bound field sizes [S70]. A plain SHA-256 suits high-entropy tokens [S26]; an HMAC suits
  low-entropy values [S21]. _Decision 8: no secret or anything derived from one is logged;
  credentials are named by non-secret ids._
- **Ordering.** OCSF `time` is epoch milliseconds, with `metadata.sequence` for order [S2, S5]; one
  SQLite writer gives a total order **(analysis)**. _Decision 11._
- **Content.** Prior art defaults to metadata [S23, S27]. _Decision 8._

## Refuted / do-not-rely-on

1. **"Account Change 3001 is the class for credential changes."** Deprecated since 1.9.0 in favor of
   User Management 3007; Entity Management 3004 also fits [S7, S8, S8b].
2. **"API Activity requires a `cloud` object."** Only with the optional Cloud profile applied. The
   JSON Schema export at schema.ocsf.io applies profiles by default, so its 1.9.0 `api_activity`
   lists `cloud` and `osint` as required; the test fixtures are the classes without profiles [S1].
3. **"Security Lake ingests any OCSF JSON."** Custom sources need Parquet, one class per source,
   specific partitioning, and OCSF 1.3 or earlier [S12].
4. **"Graylog accepts OTLP."** Only over gRPC, logs only [S68].
5. **"Use the OpenTelemetry Collector's Loki exporter."** Deprecated for logs in 2024 and removed;
   Loki 3.x ingests OTLP natively [S71].
6. **"Railway has log drains."** Railway's staff say no; use a Vector forwarder [S40].
7. **"OpenTelemetry's JavaScript logs are stable."** The SDK's logs signal is "Development"; only
   the protocol and data model are stable [S9, S10, S58].
8. **"ECS has merged into OpenTelemetry's semantic conventions."** Partial and directional [S51]; no
   audit convention exists [S59].
9. **"A hash chain makes the log tamper-proof."** Tamper-evident only after a value is committed off
   the box [S48, S49].
10. **"stdout is synchronous, so nothing is lost."** Asynchronous on pipes; exit can drop output
    [S65].
11. **"Syslog can carry any JSON event."** Receivers need accept only 480 or 2048 octets; truncation
    corrupts JSON [S17, S18].
12. **"HEC acknowledgment gives exactly-once."** It narrows loss and adds duplicates; Splunk Cloud
    reserves it for Firehose [S46].
13. **"Buffered streams survive any outage."** GitHub keeps 7 days; Datadog refuses logs older than
    18 hours [S24].
14. **"Platform shippers are reliable."** Fly's can stall silently; Azure's ingestion lags minutes
    [S37, S38].
15. **Approaches that commonly fail** **(analysis, with support)**: high-cardinality Loki labels
    [S66]; console exporters in production [S27]; filtered sinks with no fallback [S21b]; unbounded
    in-memory queues; per-cloud integrations each needing their own auth [S47]; logging request
    bodies "temporarily".

## Open questions

Each with where the design stands; the operator's open choices are in the [FRD](frd.md).

1. **Record every read?** OCSF 6003 has Read and List, at a volume and privacy cost. _Not recorded
   (FRD R1), read marks included (decision 18)._
2. **3007 or 3004 for API keys?** 3007 is newer and older parsers may not know it. _3004 (decision
   2); 3007 recorded as the alternative. When 3007 entered the schema was not checked._
3. **A registration as a 3004 `entity`, or the agent as an OCSF `user` of type Service?** _Both: the
   registration is the entity of its lifecycle events, and the agent's session is the actor's user,
   type Service, in its writes (HLA mapping)._
4. **A failed sign-in has no user, yet 3002 requires one.** _An unknown user, `type_id` 0, with no
   uid (HLA mapping); checked against the pinned schema in P1._
5. **OTLP: the OCSF object as a map body or a JSON string, and which attributes to promote?** _A map
   body, with class, activity and sequence promoted (decision 6)._
6. **Signed checkpoints: where the key lives, how it rotates, how a verifier gets it.** _Not built
   (decision 4): the key would live on the box it guards against._
7. **Retention when undelivered events reach the limit.** _Never removed until every sink has them
   (FRD R8); the table grows while a sink is down, and its lag shows._
8. **Is the operator's address personal data worth an HMAC?** _Recorded as seen; one operator, and
   behind a proxy it is the proxy's until a later option trusts a configured proxy (FRD R4, decision
   12)._
9. **Should reading the log, or changing sinks, be audited (OWASP says access to logs should be)?**
   _Reads of the log are not recorded (FRD R14, decision 17), and SECURITY.md says so; sinks change
   only at start, and forgetting one records its event (decision 19)._
10. **Which OCSF version at implementation?** _1.9.0 pinned; 1.10.0 leaves the hold-back on
    2026-11-27, so P1 re-checks (plan)._
11. **Does Splunk accept OTLP natively?** _Not verified; Splunk is reached through HEC or a
    collector._

## Sources

| ID   | Source                                                                             | Grade | Angle                           |
| ---- | ---------------------------------------------------------------------------------- | ----- | ------------------------------- |
| S1   | schema.ocsf.io/1.10.0/classes/api_activity (and the 1.6.0 page)                    | P     | OCSF 6003 fields, activities    |
| S2   | schema.ocsf.io/1.10.0/classes/authentication                                       | P     | OCSF 3002                       |
| S3   | schema.ocsf.io/1.6.0/classes/account_change                                        | P     | OCSF 3001 before deprecation    |
| S4   | github.com/ocsf/ocsf-schema CHANGELOG.md                                           | P     | Versions, dates, semver policy  |
| S5   | schema.ocsf.io/1.10.0/objects/metadata                                             | P     | sequence, uid, version          |
| S7   | schema.ocsf.io/1.10.0/classes/account_change                                       | P     | Deprecation since 1.9.0         |
| S8   | schema.ocsf.io/1.10.0/classes/user_management                                      | P     | OCSF 3007                       |
| S8b  | schema.ocsf.io/1.10.0/classes/entity_management                                    | P     | OCSF 3004                       |
| S8c  | schema.ocsf.io/1.10.0/objects/user                                                 | P     | User object                     |
| S9   | opentelemetry.io/docs/specs/otlp                                                   | P     | OTLP HTTP, JSON, retry          |
| S10  | opentelemetry.io/docs/specs/otel/logs/data-model                                   | P     | Log record fields, events       |
| S10b | schema.ocsf.io/1.10.0/objects/api                                                  | P     | API object                      |
| S10c | schema.ocsf.io/1.10.0/objects/actor                                                | P     | Actor object                    |
| S11  | github.com/ocsf/ocsf-server issue 73; pypi ocsf-json-schema                        | P/C   | JSON Schema export              |
| S12  | docs.aws.amazon.com Security Lake custom sources                                   | P     | Security Lake OCSF requirements |
| S13  | help.splunk.com Edge Processor OCSF pages; splunk.com blog                         | P     | Splunk OCSF translation         |
| S14  | docs.cloud.google.com Chronicle parsing overview, OCSF changelog                   | P     | Google SecOps OCSF parser       |
| S15  | docs.datadoghq.com Cloud SIEM OCSF processor; Datadog blog                         | P     | Datadog OCSF                    |
| S16  | elastic.co integrations amazon_security_lake                                       | P     | Elastic and OCSF                |
| S16b | techcommunity.microsoft.com Security Lake to Sentinel blog; Microsoft ASIM docs    | C/P   | Sentinel and OCSF               |
| S16c | wazuh.com Security Lake blog; cioinfluence.com Graylog news                        | P/S   | Wazuh, Graylog OCSF             |
| S17  | RFC 5424                                                                           | P     | Syslog format, SD, sizes        |
| S18  | RFC 5425                                                                           | P     | Syslog over TLS, framing        |
| S19  | RFC 9662                                                                           | P     | Syslog TLS cipher update        |
| S20  | goteleport.com docs, audit and backends                                            | P     | Teleport audit backends         |
| S21  | developer.hashicorp.com/vault/docs/audit                                           | P     | Vault devices, HMAC, blocking   |
| S21b | developer.hashicorp.com/vault/docs/enterprise/audit/filtering (search summary)     | S     | Filter, fallback                |
| S22b | developer.hashicorp.com/vault/docs/audit/file                                      | P     | File device, SIGHUP             |
| S23  | kubernetes.io/docs/tasks/debug/debug-cluster/audit                                 | P     | Policy, backends, batching      |
| S24  | docs.github.com streaming-the-audit-log-for-your-enterprise                        | P     | GitHub streaming                |
| S25  | tailscale.com/kb/1255/log-streaming                                                | P     | Tailscale destinations          |
| S25b | docs.github.com about-the-audit-log-for-your-enterprise                            | P     | GitHub retention                |
| S26  | docs.github.com identifying-audit-log-events-performed-by-an-access-token          | P     | hashed_token                    |
| S27  | grafana.com/docs/grafana/latest/setup-grafana/configure-security/audit-grafana     | P     | Grafana exporters, bodies       |
| S28  | docs.goauthentik.io/docs/sys-mgmt/events                                           | P     | authentik retention, forwarding |
| S29  | vector.dev/docs/architecture/buffering-model                                       | P     | Buffers, when_full              |
| S30  | grafana.com/docs/loki/latest/reference/loki-http-api                               | P     | Loki push, OTLP                 |
| S31  | vector.dev/docs/reference/configuration/sources                                    | P     | Vector sources                  |
| S32  | documentation.wazuh.com localfile and JSON decoder (search summary)                | S     | Wazuh JSON ingest               |
| S33  | docs.fluentbit.io inputs, OpenTelemetry input (search summary)                     | S     | Fluent Bit inputs               |
| S36  | docs.cloud.google.com/run/docs/logging                                             | P     | Cloud Run structured logs       |
| S37  | learn.microsoft.com azure/container-apps/log-options                               | P     | Container Apps log destinations |
| S38  | docs.fly.io/monitoring/exporting-logs                                              | P     | Fly log shipper                 |
| S39  | render.com/docs/log-streams                                                        | P     | Render log streams              |
| S40  | docs.railway.com/guides/ship-logs-third-party; station.railway.com thread          | P/C   | Railway, no drains              |
| S42  | docs.datadoghq.com OTLP ingest in the Agent (search summary)                       | S     | Datadog OTLP logs               |
| S43  | elastic.co/docs/reference/opentelemetry/motlp (search summary)                     | S     | Elastic managed OTLP            |
| S44  | docs.cloud.google.com/stackdriver/docs/otlp-logs (search summary)                  | S     | Google Telemetry API logs       |
| S45  | help.splunk.com format-events-for-http-event-collector (search summary)            | S     | HEC format                      |
| S46  | help.splunk.com about-http-event-collector-indexer-acknowledgment (search summary) | S     | HEC acknowledgment              |
| S47  | learn.microsoft.com Azure Monitor custom logs (search summary)                     | S     | Sentinel DCR and DCE            |
| S48  | docs.aws.amazon.com cloudtrail-log-file-validation-intro                           | P     | Signed chained digests          |
| S49  | Schneier and Kelsey 1999 (ACM TISSEC); Ma and Tsudik's critique via DBSec 2008     | P/S   | Hash chains, truncation         |
| S50  | elastic.co/docs/reference/ecs                                                      | P     | ECS 9.5.0                       |
| S51  | elastic.co/docs/reference/ecs/ecs-opentelemetry                                    | P     | ECS and OTel convergence        |
| S52  | aws.amazon.com/blogs/opensource OCSF ITU support                                   | S     | OCSF standardization            |
| S53  | docs.nvidia.com/openshell observability/ocsf-json-export                           | P     | OCSF in an agent product        |
| S54  | opentelemetry.io/blog/2023/ecs-otel-semconv-convergence                            | P     | ECS donation                    |
| S55  | elastic.co/docs/reference/ecs/ecs-allowed-values-event-category                    | P     | ECS categories                  |
| S56  | microfocus.com CEF implementation standard                                         | P/S   | CEF                             |
| S57  | ibm.com/docs LEEF event components                                                 | P     | LEEF                            |
| S58  | opentelemetry.io/docs/languages/js                                                 | P     | JS signal status                |
| S59  | opentelemetry.io semantic conventions registry, enduser and user                   | P     | No audit convention             |
| S60  | cncf.io announcement 2024-01-25                                                    | P     | CloudEvents graduation          |
| S61  | github.com/cloudevents/spec spec.md                                                | P     | CloudEvents attributes          |
| S62  | docs.gitea.com/enterprise/23/features/audit-log                                    | P     | Gitea Enterprise audit          |
| S63  | linuxiac.com, alternativeto.net Gitea 28.0 news                                    | S     | Gitea open-source audit log     |
| S64  | docs.redhat.com Keycloak 26.2 auditing (search summary); keycloak.org javadoc      | S/P   | Keycloak listeners              |
| S65  | nodejs.org/api/process.html, "A note on process I/O"                               | P     | stdout sync and async           |
| S66  | grafana.com/docs/loki/latest/get-started/labels/bp-labels                          | P     | Label cardinality               |
| S67  | go2docs.graylog.org/current/getting_in_log_data/gelf                               | P     | GELF transports                 |
| S68  | go2docs.graylog.org OpenTelemetry gRPC input (search summary)                      | S     | Graylog OTLP gRPC only          |
| S69  | Crosby and Wallach, USENIX Security 2009                                           | P     | History tree                    |
| S70  | cheatsheetseries.owasp.org Logging Cheat Sheet                                     | P     | What not to log, integrity      |
| S71  | pkg.go.dev lokiexporter; grafana.com native OTLP versus the Loki exporter          | P     | Loki exporter deprecation       |
