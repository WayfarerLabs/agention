# Audit log: Functional Requirements

- Status: Draft for the operator's acceptance. The operator has answered its four open choices
  (rulings below); everything else is the lead's proposal, which the operator may change on
  accepting.
- Date: 2026-11-24
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim.
- Origin: agention#42, and the operator's direction on how the log is delivered, quoted under
  [The operator's direction](#the-operators-direction). The operator API and its keys
  (`docs/adrs/0003-operator-api-keys.md`) are the baseline.

## Why this exists

Until the operator API, only the web UI, signed in with a passkey, could act as the operator. API
keys changed that: a program the operator runs can now start threads, answer asks, archive, and
approve or revoke agents' registrations, with the same effect as the operator doing it in the
browser. Nothing records which credential did what. A message, a file or a mark the operator wrote
records only their actor (`messages.actor_id`, `files.actor_id`, `thread_marks.actor_id` in
`apps/server/src/database/migrations.ts`), though the server knows the credential at the time
(`apps/server/src/identity.ts:14-17`): whether it was a browser session, or which of up to 20 API
keys, is not kept anywhere. If a key leaks, or a script misbehaves, the operator cannot tell what it
did, or rule out that it did anything.

The operator chose an audit log over marking messages with their credential. An audit log answers
the question for every kind of write, not only messages, covers credential lifecycle and sign-ins
too, and leaves the thread views as they are.

Beyond answering "which key wrote this" in Agention, the operator wants the log to leave the box: to
reach the log pipeline or security tooling they already run, whether Agention is on a cloud platform
or in a homelab, in a form those tools can query.

## Who this is for

- **The operator**, the one human, who reads the log to learn what a credential did and to notice
  what they did not do.
- **The operator's log tooling**: a platform's log pipeline, an OpenTelemetry collector, a SIEM, or
  files a homelab collector tails. It receives the log; it never acts on Agention.
- **Programs using API keys** act as they do today; what they do is now recorded.
- **Agents** act as they do today; R15 states what stays unchanged for them.

## The operator's direction

Verbatim, on how the log is delivered:

> make sure the audit log is pluggable. It should support writing directly to disk as well as
> shipping to something that makes sense, both for cloud PaaS stuff as well as homelab setups. And
> the format should lend itself to querying. Think SIEM data.

## Functional requirements

### What is recorded

**R1. Every write, by the credential that made it.** Every state-changing action on the web API, the
operator API and the agent API is recorded, as each happens: starting threads, sending messages and
answers, archiving, uploading and removing files, groups and tags and their assignment, a session's
status updates, voice settings set and cleared, and the rest of the server's mutations. Reads are
not recorded (R14 holds the choice for reads of the audit log itself). Nor is the server's own
housekeeping (a browser session's idle expiry being extended, a key's hourly last-used time, a
session's last-seen time, which agents' calls stamp, the upload sweep), or `agention backup`, a
read-only command that runs without the server and writes nothing to the database.

**Failures after authentication.** Some refusals of a credential the server has identified matter
for security: an API key refused because it lacks the operation's scope, and an attempt with a
revoked or expired key whose id the server knows. They are recorded as failures naming the key,
bounded as failed sign-ins are (R2); the answer the caller sees stays the same.

**Read marks are not recorded.** Marking a thread read or unread, marking many read, and marking a
session's log read change state but say nothing about what a credential did to the operator's work,
and they are the most frequent writes there are, from the operator, from scripts and from agents.

**R2. Sign-ins.** Every passkey sign-in, sign-out and use of a passkey link is recorded. A failed
sign-in or a failed link is recorded as a failure, with no actor, since none was established. Anyone
who can reach the server can cause failures, so they are bounded in the log itself: failures of one
kind (and, for a key, of one key) within a minute are recorded as one event that counts them, with
the first one's origin. A day of continuous failures of every kind adds a few thousand events, not
the hundreds of thousands the rate budgets alone would let through.

**R3. Credential lifecycle.**

- **API keys:** creating and revoking a key, including the revocation of every live key that
  replacing the operator's passkeys causes. A key's first use is recorded; each later use is not,
  beyond the writes it makes (R1).
- **Passkeys:** adding, renaming and removing one, and the replacement of every passkey that a
  passkey link causes, recorded as credential changes like API keys', so a SIEM's credential-change
  rules catch them.
- **Agents' registrations:** an agent submitting one, and the operator approving, rejecting and
  revoking it.
- **Passkey links:** `agention passkey-link` issuing a link from the command line, recorded directly
  when the command runs.

A credential expiring is not an event: no timer runs when a key, a browser session or a pending
registration expires, and none is added (ADR 0001, "No server action on deadlines"). Each
credential's expiry is in the event that created it.

**R4. What each event says.** Every event names:

- **the actor:** the operator, an agent's session, or no one for a failure before authentication;
- **the exact credential:** a browser session, by the passkey that signed it in and the session's
  own identifier, never its cookie or anything derived from the cookie; an API key, by its id and
  name; or an agent's registration, by its id with its agent and session;
- **the action**, under one stable name per kind of action, and its **target**: the thread, session,
  group, tag, file, key, passkey or registration it acted on;
- **the outcome**, success or failure;
- **the request's origin:** the address the request came from, as the server sees it (the
  connection's peer), and the user agent, cut to a bounded length, where either is available;
- **when it happened**, and its place in the log's one order.

**Behind a proxy, the address is the proxy's.** Behind `tailscale serve` or a platform's router, the
peer is the proxy, and the server reads no forwarded header, so it cannot be fooled by one. A
`serve` option that trusts a forwarded header only from a configured proxy is a later change of its
own.

### What is never recorded

**R5. Metadata only.** No event ever holds a message's text, an answer's text, a file's bytes, a
transcription, or a secret: no session cookie, CSRF token, API key secret, passkey link token,
passkey material, the instance's own keys, the transcription key, or a request's `Authorization`,
`Cookie` or `X-CSRF-Token` header. Names the operator gave to keys, passkeys, groups and tags, and
the names of agents and sessions, are metadata and are recorded.

**Thread titles and file names are left out.** A thread's title is written by whoever starts the
thread, often an agent, and may carry the substance of the work; an event identifies its thread by
agent, session and number, which the operator can open, and an attached file by its id.

### Format

**R6. SIEM data.** Each event is one JSON object in a published security event schema, the Open
Cybersecurity Schema Framework (OCSF), at one pinned version, which Splunk, Datadog, Google SecOps
and AWS Security Lake normalize natively and every other SIEM and collector can query as JSON. The
same object reaches every destination: a line in a file or on standard output, or an OpenTelemetry
log record's body. Each event carries a unique identifier, so a destination that receives one twice
can tell.

### Storage and integrity

**R7. The database keeps the log.** Every event is kept in Agention's database, written in the same
transaction as the change it records: a change is never saved without its event, nor an event
without its change. The log is append-only: nothing in it is ever edited once delivered (a coalesced
failure's count rises only until its minute ends, R2), and only its oldest events are ever removed
(R8). It rides in backups with everything else. **Restoring a backup rolls the audit log back with
the data**, so events after the backup are gone from Agention, though not from any destination that
already received them; the operator guide says so where it describes restoring. A destination that
already holds later events can tell a restore's rollback for what it is: new events reusing sequence
numbers it has received, under new identifiers.

**R8. Retention.** Events older than the retention period are removed, oldest first, and only once
every destination has received them; with no destination configured, by age alone. The period is 365
days by default, set by a `serve` option, with a value that keeps events forever.

**R9. Tamper evidence.** The evidence that holds against someone who controls the server is the copy
that has already left it: an event delivered to a destination cannot be edited or removed from the
box. Each event's unique identifier and its place in the log's order let a destination see a gap or
a rollback. The operator guide states the limit: events not yet delivered can be removed or
rewritten unseen by whoever can write the database. There is no hash chain: anyone who can write the
database can recompute one after an edit, so it would catch only accidents and naive edits, and
never removal of the oldest events, which looks like retention.

### Delivery

**R10. Pluggable destinations.** The log is delivered to any number of destinations at once, each a
sink of a kind the server knows:

- **standard output**, a JSON line per event, for a cloud platform's log pipeline;
- **files**, a JSON line per event, rotated daily, for a homelab collector or SIEM agent to tail;
- **OpenTelemetry (OTLP over HTTP)**, in a later phase, which reaches an OpenTelemetry collector,
  Loki 3, Grafana Cloud, Datadog and Elastic directly, each event the body of a log record.

Other protocols (syslog over TLS, GELF, Loki's own push, cloud vendors' APIs, and any network sink
not built) are reached through a collector the operator runs, and the operator guide shows how for
common setups. Pluggable here means kinds of sink built into the server and chosen by configuration:
a kind is added in the server's code, behind one small interface, without changing how events are
recorded, and the operator cannot supply a sink of their own (a plugin, or a command the server
runs). With no sink configured, the log is kept in the database alone.

**R11. Delivery never holds anyone up.** Each destination receives every event at least once, in
order, catching up after an outage from the database, except events an OpenTelemetry destination
rejects as invalid in a partial success, which the protocol makes final: they are counted and
reported, not resent. A destination that is down or refusing never delays or fails the operator's or
an agent's request. How far behind each destination is, and why, is visible to the operator.

**R12. Configuration.** Sinks are configured by `serve` options, as the rest of the server is. Any
credential a network sink needs is taken from an environment variable only, never from an option, so
it never appears in a process listing.

### Viewing

**R13. Reading the log in Agention.** The phase after standard output and files adds:

- **Settings, Audit log:** a read-only list of events for the operator, filterable by credential and
  by action, with each event's detail, and each destination's delivery state;
- **each API key's detail** in Settings showing its recent activity;
- **an operator API scope, `audit:read`**, with which a program reads the log.

**R14. Who may read it.** Only the operator: through the web UI, and through the operator API with a
key holding `audit:read` (R13). Agents never read it. The destinations' own access controls govern
the copies delivered there.

Reads of the log are not recorded. Every read the server answers writes nothing, and the review
checklist keeps it so; reading threads, which hold the content, is not recorded either, and a key's
creation, with its scopes, and its first use are. OWASP's advice to record access to logs is not
followed, and SECURITY.md says so.

### Engineering

**R15. Agents unchanged.** No agent route, tool or answer changes, and the agent API version stays
as it is. Agents' writes and registrations are recorded on the server's side alone.

**R16. Security.**

- A sink's credentials come only from the environment, are never logged, and never appear in an
  event, an answer or the web UI.
- A network sink sends only to the target the operator configured, by the rule the transcription
  provider's address follows: HTTPS to any host but link-local and cloud metadata addresses, plain
  HTTP only to the operator's own network. It follows no redirect.
- Sinks are configured only where the server is started. No API key, agent or browser can add,
  change or remove one.
- Audit files are readable only by the server's user, in a directory no other user can enter, as the
  data directory is; or, where the operator names a group for a collector that tails them, also
  readable, never writable, by that group.
- Recording an event never weakens a write: if the event cannot be saved, the change is not saved
  either.

**R17. Collateral.** The operator guide, SECURITY.md, the architecture document, the API document,
the review checklist and a new ADR describe what is recorded and never recorded, the format, the
sinks and their configuration, retention, what tamper evidence there is and its limits, and
restoring; the live tests cover delivery to a file, standard output and a collector.

## Out of scope

- Recording reads (R14 holds the choice for reads of the audit log itself).
- Alerting on events. That is the SIEM's work.
- Syslog, GELF, Loki push and cloud vendors' log APIs as built-in sinks; a collector reaches them.
- Recording the server's own life (start, stop, migrations, configuration) as events.
- The forwarded-address option R4 mentions; it is a later change of its own.
- Exporting to AWS Security Lake's format (Parquet, OCSF 1.3); a collector can transform.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- Every write route on the three mounts produces its event, or is listed as one that does not.
- The operator sees, on a live instance, an API key's writes delivered to a file and read by a
  collector tailing it, with the key's id and name, and finds them in the web UI and in an
  OpenTelemetry collector.
- The repository passes its documented checks in CI, and each phase ships in a release.

## Operator rulings, 2026-11-24 onward

**2026-11-24, on the four open choices**, asked with the lead's recommendation first; the operator
picked:

- "Which event format: OCSF 1.9.0, or flat JSON with our own documented fields?" **OCSF**
- "Should the server ship events over the network itself, beyond standard output and files?" **OTLP,
  later phase**
- "Record refused API keys (missing scope; revoked or expired key presented) as failures naming the
  key?" **Yes**
- "Default retention for the audit log?" **365 days**

Asked before answering: "So can you do OCSF over OTLP?" Answered yes: each OCSF event is the body of
an OpenTelemetry log record, as R6 and R10 state.
