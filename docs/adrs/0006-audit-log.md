# 6. An audit log, in OCSF, delivered off the box

Date: 2026-11-26

## Status

Accepted. Narrows two statements of [ADR 0001](0001-agention-v1-architecture.md), each for the audit
log alone: "history is retained" in its Consequences, since the log's oldest events are removed
after their retention, and "No push" in "Not doing", since the server delivers the log to the sinks
the operator configures.

## Context

Since the operator API ([ADR 0003](0003-operator-api-keys.md)), a program holding an API key can
write as the operator. A message records only its actor, so nothing recorded which credential did
what: a browser session or one of up to 20 keys. If a key leaked, or a script misbehaved, the
operator could not tell what it did, or rule out that it did anything. The operator also wanted the
record to leave the machine, to reach the log pipeline or security tooling they already run, on a
cloud platform or in a homelab, in a form that tooling can query.

## Decision

- **An event for every write, sign-in and credential change**, recorded in the same transaction as
  the change, so neither exists without the other and an event that cannot be saved fails the
  change. Read marks are the one kind of write a credential makes that is not recorded: they are the
  most frequent, and say nothing of what a credential did to the operator's work. Reads, the log's
  own included, are not recorded, so every read stays free of writes, and neither is the
  housekeeping the server does on its own, such as removing what has expired.
- **Refusals of a known API key, and failed sign-ins and links**, are recorded as failures, once
  they have spent their rate budget, coalesced to one event per kind, and per key, each minute with
  a count, since anyone who can reach the server can cause them. The answer stays the same.
- **OCSF 1.9.0 JSON.** Each event is one object of the Open Cybersecurity Schema Framework: API
  Activity for writes, Authentication for sign-ins and refused keys, and Entity Management for API
  keys, passkeys, registrations and links. It is the open security taxonomy most SIEMs read natively
  or translate, and any collector can query it as JSON. 1.9.0 was chosen over 1.10.0, which changes
  nothing these events use, for consumers' lag: those that read OCSF natively target older versions.
  Events use only long-lived classes and attributes, so a later version is a change of the version
  string and the test fixtures.
- **Metadata only.** An event names its credential by ids that are not secret, a browser session
  gaining a random id of its own for it, and what it acted on by id, with the names the operator and
  agents chose. No event holds message or answer text, a thread's title, a file's name or bytes, or
  a secret; the builder takes typed inputs that have no field for them.
- **The database is the system of record and every sink's outbox.** Events live in `audit_events`,
  append-only under triggers but for an open failure's count, in one sequence that never reuses a
  number. Each sink keeps a cursor there and receives every event at least once, in order, catching
  up after an outage; a failing sink falls behind and says so, and holds up no request.
- **Pluggable sinks, configured where the server starts.** A sink is a kind the server knows, behind
  one small interface, chosen by a `serve` option: standard output, for a platform's log pipeline,
  and files, rotated daily, for a collector to tail, optionally shared with one group for a
  collector that runs as its own user. Options take no secret, and no API key, agent or browser can
  change a sink. The operator supplies no sink of their own. An OTLP sink is to follow.
- **Off-box delivery is the tamper evidence.** Each event's random id and sequence let a destination
  see an event missing, delivered twice, or a rollback, and the copy that has left the machine holds
  against whoever controls it. There is no hash chain: whoever can write the database can compute
  one again.
- **Retention by age, after every sink has delivered.** Events older than the retention, 365 days by
  default, are removed oldest first, and only once every sink's cursor has passed them, which a
  trigger also holds. A sink no longer configured keeps its cursor, so one start without its option
  cannot prune what it never received, until `agention audit forget-sink` removes it.

## Consequences

- Within the audit log, history is not retained indefinitely: retention removes its oldest events.
  Every other append-only log keeps all its history, as ADR 0001 says.
- Delivering to its sinks is the server's first outbound channel of its own, carrying only the audit
  log, to destinations the operator configured, and reaching neither the operator nor an agent.
  Agention still reaches the person only through its web UI, as ADR 0001's "No push" says.
- Every write costs a second row, and the database grows by every event until retention removes it;
  a sink that fails for long grows it by every event recorded meanwhile, which its stderr lines say.
- A new write must record its event, which a test over every declared write and web route holds.
- A restore rolls the log back with the data; the destinations that already received the events
  after the backup keep them, and see the sequences that follow reused under new ids.
- Addresses recorded are the connection's peer, a proxy's behind one; trusting a forwarded header
  from a configured proxy would be a decision of its own.

## Alternatives considered

- **A flat object of Agention's own**, about half the size and read as plain JSON by every tool;
  **ECS**, native to Elastic only; **CEF or LEEF**, flat key-value with fragile escaping that cannot
  carry nested actors and resources.
- **Marking messages with their credential**, which answers "which key wrote this" for messages
  alone, and leaves sign-ins, credential changes and every other write unrecorded.
- **Log lines only**, which lose events in any outage and cannot back a viewer; **an in-memory
  queue**, unbounded or lossy; **a second database file**, which breaks the one transaction.
- **A hash chain over the stored events**, with or without signed checkpoints sent to the sinks:
  whoever can write the database can recompute it, so it catches only accidents and naive edits, and
  never the removal of the oldest events, which looks like retention.
- **A sink that refuses the operator's writes while it is down**, as some audit systems do, which
  would let a log destination block the product.
- **Pruning regardless of the sinks**, recording a gap event; or **a grace period** for a sink no
  longer configured, which still prunes after a long enough mistake.
