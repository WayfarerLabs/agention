# Review checklist

Agention's project checks: what a reviewer holds a change to, in code, docs or a design document,
beyond the common bar. Reviewers apply them on top of the shared project-review method (the
`project-review` skill), whose shared checks, conditional checks and report format all apply. Every
conditional check applies to Agention, since it has long-lived sessions and threads, persisted
state, optional integrations, CLI, MCP and JSON interfaces, and a declared server, browser and host
matrix ([development context](development-context.md)); the checks below add what only Agention has,
and refine those where noted. Cite a check by its number, such as A3.

The docs named here are the reference for what each check protects. Where they disagree with each
other or with the code, report the conflict rather than choosing.

Agention is a standalone, self-hosted attention inbox on an honor system. It enforces only what the
honor system cannot provide (identity and provenance, isolation, append-only attributed history,
role checks, inert content) and makes everything else easy and visible (`SECURITY.md` "Security
model"; ADR 0001 "Trust model: enforce provenance, not behavior"). Hold changes to both halves:
enforcement must not be missing where the trust model requires it (A2 to A9), and must not be built
where the trust model says it does not belong (A6).

Some checks state rules for features not built yet: session state that any call from a session may
carry, with its session log; the operator's session groups and tags; diagrams drawn from message
text; and `agention backup`, which `docs/operator-guide.md` "Commands" lists as planned. Their rules
bind the change that builds them, and that change documents them in the permanent docs.

## A1. Standalone and runtime-neutral

Agention never grants permissions, injects into a chat, controls a harness, or acts on message
content (ADR 0001 "Not doing"). Tailscale is one documented way to host, not a dependency (ADR 0001
"Transport independence"); Agentworks only supplies the session's default names, and nothing else
depends on it; the MCP surface and usage skill work on every supported agent host (ADR 0001
"Distribution: generated agent plugins"); and Agention uses no paid services (ADR 0001 "Repository
and supply chain"). Look for core paths that import, require, or default to one host, network, or
harness, new paid services, and optionality or dependencies nothing in the docs calls for.

## A2. Actor from authentication, target from the request

The actor is always the authenticated session or the person, never request content; the target is
always named by the request, and the credential only authorizes it (the **Identity and provenance**
invariant in `SECURITY.md` "Security model"). The default grant is one session; a later grant across
sessions, or identity from an external issuer, needs no change to the API (ADR 0001 "Agents,
sessions and threads"), and that seam stays a seam: no code depends on it. Look for a target
inferred from a credential, an actor or session taken from a payload, grants widened by anything a
client controls, and any way to write as the person other than the operator's own sign-in, a second
person included: agents take the person's messages as the operator's direction (`SECURITY.md`
"Security model").

## A3. Isolation, and unknown equals unauthorized

A target the caller may not access gets the same response as one that does not exist, for every
operation, including reading, archiving, list filters, references to threads, and long-poll wakes
(the **Isolation** invariant in `SECURITY.md` "Security model"; `docs/architecture.md` "Store").
Agents set and filter topics on their own session's threads, and topics never span sessions; a
thread reference names a thread of the same session. Quiet and stranded reach only the operator, and
the operator's session groups and tags are operator-only and grant nothing. Look for distinguishable
errors, counts, timing paths, identifiers, or list positions that reveal another session's threads;
references or topics that cross sessions; an archive mark visible to the other party; authorization
not rechecked on each `message_wait` wake; and presence signals, groups, or tags reachable from the
agent surface.

## A4. People and agents authenticate separately

Passkey sessions work only on the web mount and agent tokens only on the agent mount: the agent
mount refuses any request carrying a cookie, and the web mount any carrying an `Authorization`
header (`docs/architecture.md` "HTTP API"). An agent token is verified against its registration's
stored public key, bound to the origin and short-lived; approval and revocation are checked inside
each operation's transaction and during long polls, and only the registration route accepts a key
the operator has not approved (`docs/architecture.md` "Authentication"). Web mutations require the
CSRF token and the exact origin, and `Host` must equal the origin's host. Adding or removing a
passkey needs a recent sign-in; the last passkey is never removed; removing one ends the browser
sessions it signed in (the **Separate authentication** invariant in `SECURITY.md` "Security model").
Look for identity-header bypasses, an insecure TLS fallback, a first-user-wins bootstrap instead of
the one-time `passkey-link`, recovery paths that skip ceremony checks, and a bridge that sends
tokens or message text anywhere but its configured HTTPS origin, a followed redirect included
(`SECURITY.md` "The agent bridge").

## A5. Roles follow the direction of attention

Permissions attach to the requester and audience roles stored on the thread, never to whether the
actor is a person or an agent or how it authenticated (ADR 0001 "Roles follow the direction of
attention"). Asks, withdrawals and topics are the requester's, answers the audience's, and a
replacement its author's (the **Roles** invariant in `SECURITY.md` "Security model"). What makes an
ask, an answer, a withdrawal or a replacement valid, and what derives from them, is the thread
semantics in `docs/architecture.md` "Database" and "Store" and ADR 0001 "Threads are append-only
logs of messages, with asks": check the code against them rather than against a copy here. Sessions
are always requesters and the operator is always the audience, so these checks also keep an agent
from speaking as the operator, and the operator starts no threads. Look for role checks keyed on
anything but the roles stored on the thread, an ask or answer mutated in place, a withdrawal undone,
a derived state that counts a replaced message, and a derived next action, a per-kind lifecycle, or
items that open and close creeping back in (ADR 0001 "Not doing" and "Alternatives considered").

## A6. Nothing built beyond the trust model

As material as A5: the server never acts on a deadline, whose consequence is entirely the
requester's choice; goals are set explicitly and never inferred (ADR 0001 "Not doing"); derived
signals, such as overdue, quiet and stranded, inform and never trigger actions or block writes; and
accuracy of impact, priority, effort, progress, and session state is the honor system's, not
something to police with enforcement ladders. Look for timers or jobs that change threads, inferred
goals or progress, automatic withdrawals, archives, or escalations, and validation that
second-guesses what the agent reports.

## A7. Stale writes, request ids, and read cursors

Refines the shared **Lifecycle, idempotency, and convergence** and **Ordering and enforcement
ownership** checks. Every message states the latest sequence its writer has seen (`seen_through`),
and a stale write fails and returns the missed messages. A retried request id with the same content
returns the original result, and with different content is rejected (ADR 0001 "Read and archive
marks, and optimistic concurrency"). Marks move only the caller's own cursors, never change the
thread or conflict with a write, and never answer an ask; how they move, and what counts as unread
and as archived, is in `docs/architecture.md` "Store". A session's presence is stamped in a
transaction of its own before the call's work, so a call refused later still counts. Session state a
call carries is likewise applied once the call is authorized, whatever the call's outcome, with
every return path committing it, and session updates are last-writer-wins and exempt from the stale
rule, since only the session writes its own state. The UI keeps the draft on a stale write
(`docs/operator-guide.md` "Using the web UI"). Look for marks or derived counts that depart from
those definitions, check-then-write races outside one immediate transaction, writes that skip the
sequence check, and request-id handling that replays a different payload.

## A8. Append-only, attributed history

Thread logs, and the session log of session state, are append-only, protected by triggers on every
log table (`docs/architecture.md` "Database"); a thread's state derives from its live messages, and
anything stored beside the log equals a replay of it. Corrections are replacements that append;
actor and credential provenance is immutable; every topic change is an attributed message. Derived
signals are computed in queries, never stored (`docs/architecture.md` "Store"). Look for updates or
deletes on log rows, projections that can diverge from the log, and stored copies of derived
signals.

## A9. Inert content

Message text, details, references, and topics are displayed, never executed, fetched, or followed
(the **Inert content** invariant in `SECURITY.md` "Security model"; ADR 0001 "Text is Markdown,
rendered inert"). A message's text and its detail are Markdown rendered inert, every other text
field is plain, and text is stored and returned exactly as written. A reference is a label plus at
least one of an identifier, an HTTPS URL, and a thread of the same session
(`packages/api/src/references.ts`), and `isLinkableUrl` is the one rule for what shows as a link
(`docs/architecture.md` "API contract"). No image loads: an image shows as a link. A diagram drawn
from message text is drawn in isolation, so drawing it can neither run anything in the app's page
nor fetch anything, and shows as an image, with the content security policy kept strict. Look for
content-driven fetches or previews, raw HTML or images other than such a diagram reaching the DOM, a
diagram drawn outside its isolation, classes or styles taken from text, live non-HTTPS links, links
to URLs that `isLinkableUrl` refuses, search text read as query syntax, and message content treated
as the operator's direction anywhere, the usage skill included, unless the operator wrote it (its
author is the person).

## A10. Listener, TLS, proxy, and transport

Listen address, TLS mode, and public origin are independent settings; the origin is always HTTPS;
plain HTTP on a non-loopback address (anything but `127.0.0.0/8` or `::1`) is refused unless
explicitly enabled; proxy mode trusts no forwarded or identity headers (ADR 0001 "Transport
independence"; `docs/architecture.md` "Serving"). No authentication decision or rate limit keys on
source address, and each unauthenticated endpoint class has its own budget, so registration cannot
starve passkey sign-in, and failed agent authentication never slows an approved agent (the **No
network identity** invariant in `SECURITY.md` "Security model"; `docs/architecture.md` "Rate
budgets"). Every field, list, and page has a documented bound: the `packages/api` schemas are the
bounds (`docs/architecture.md` "API contract"), with the body limits in `docs/architecture.md` "HTTP
API".

## A11. Registration and credential lifecycle

Registrations move through pending, approved, rejected, expired, and revoked. Approval chooses the
agent and an existing or new session; approving a new registration for an existing session grants
its full history, and the approval screen says so. Unapproved registrations expire. Revocation
leaves the session and its threads visible and workable for the operator, marked as having no active
credential, and takes effect during long polls (`docs/operator-guide.md` "Agents" and "Approving
agents"; `docs/architecture.md` "Authentication"). Look for lifecycle transitions without tests,
re-grants that hide their consequence, and revocation that deletes or orphans data.

## A12. Adapters and the agent tool surface

Refines the shared **Service-layer authority and typed errors** and **Consistent interfaces**
checks. The store owns thread, session, and registration rules for every adapter: the CLI, the HTTP
API's agent and web mounts, and, through the agent mount, the bridge's tools (`docs/architecture.md`
"Store" and "HTTP API"). Request and response shapes come from one shared schema package,
`packages/api`. Once a bridge is released, agent routes only grow: each release's agent routes
accept what earlier released bridges send and answer what they read, because agents run whatever
bridge version their plugin pins. The typed error set (at least invalid input, not found, stale,
request-id conflict, rate limited, unauthenticated; `packages/api/src/errors.ts`) is the same on
both mounts and in the bridge's tool errors. Tool names use lowercase letters, digits, and
underscores; tool annotations are true of the tools; `message_wait` stays well below the 60-second
Codex tool timeout, worst case included; tool schemas are the payload reference
(`docs/architecture.md` "Agent bridge").

## A13. SQLite persistence and backup

Refines the shared **Recorded state and migrations** check. One SQLite database through
`node:sqlite`, one serialized writer (immediate transactions that are synchronous functions and
never span an `await`), pragmas applied on open, and private file permissions verified independent
of umask (`docs/architecture.md` "Database"; `SECURITY.md` "Private files"). Migrations are keyed on
`user_version` and append-only: a migration that has shipped is never edited
(`apps/server/src/database/migrations.ts`). A backup is consistent: the documented backup stops the
server before copying the data directory, and restore is stop, replace, start
(`docs/operator-guide.md` "Backing up"); a backup from a running instance uses SQLite's online
backup, and a raw copy of a running instance's files is no proof of a valid live backup. History is
retained indefinitely (ADR 0001 "Consequences").

## A14. Reproducibility and contract tests

Exact dependency and action pins with integrity checks, each the newest stable release at least
seven days old when chosen unless a recorded security fix cannot wait, installs with lifecycle
scripts disabled (no dependency may need one), `npm audit` and `npm audit signatures`, SHA-pinned
actions, published bundles that declare no runtime dependencies and ship the license and notices,
the generated-plugin drift check, and the SDD records check (`CONTRIBUTING.md` "Dependencies" and
"Checks"; ADR 0001 "Repository and supply chain"). These are genuine contract tests, not prose
policing; weakening one to get green is Blocking.

## A15. Public readiness and distribution boundaries

Agention is public: a contributor understands its code, decisions, expectations, and contribution
process from the repository alone (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/`). The
repository carries its own development contract (`docs/development-context.md`), its design
documents (`docs/sdd/`), this checklist and `docs/live-testing.md`, and no Rulesync sources,
generated agent guidance, private host names, tailnet names, private paths, private account names or
email addresses, or private test inventory. Material SDD decisions reach ADRs or permanent docs
before the SDD locks (`CONTRIBUTING.md` "Design documents"). Product plugins are generated from one
canonical definition with committed outputs (`CONTRIBUTING.md` "Generated plugins"); the usage skill
stays concise and teaches use, never development.

## A16. Evidence for Agention's matrix

Refines the shared **Declared environment matrix** check and the evidence-kind rule in **Tests
police behavior, never our own prose**. Agention's evidence kinds are store and HTTP tests,
component tests, a browser drive with a virtual WebAuthn authenticator, real-phone passkey
acceptance, installed plugin metadata, an authenticated Claude Code or Codex install, and a live run
behind `tailscale serve` from another machine. None stands in for another; report uncovered
dimensions explicitly, and do not re-report the known acceptance gaps in the development context's
"Testing" as new findings.
