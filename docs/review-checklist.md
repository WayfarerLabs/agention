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
enforcement must not be missing where the trust model requires it (A2 to A9, A17, A18), and must not
be built where the trust model says it does not belong (A6).

## A1. Standalone and runtime-neutral

Agention never grants permissions, injects into a chat, controls a harness, or acts on message
content (ADR 0001 "Not doing"). Tailscale is one documented way to host, not a dependency (ADR 0001
"Transport independence"); Agentworks only supplies the session's default names, and nothing else
depends on it; the MCP surface and usage skill work on every supported agent host (ADR 0001
"Distribution: generated agent plugins"); and Agention uses no paid service by default: voice's
transcription provider is the one optional paid service, which the operator opts into and which is
off until they do (ADR 0002). Look for core paths that import, require, or default to one host,
network, or harness, a paid service on by default or without a decision of its own, and optionality
or dependencies nothing in the docs calls for.

## A2. Actor from authentication, target from the request

The actor is always the authenticated session or the person, never request content; the target is
always named by the request, and the credential only authorizes it (the **Identity and provenance**
invariant in `SECURITY.md` "Security model"). The default grant is one session; a later grant across
sessions, or identity from an external issuer, needs no change to the API (ADR 0001 "Agents,
sessions and threads"), and that seam stays a seam: no code depends on it. Look for a target
inferred from a credential, an actor or session taken from a payload, grants widened by anything a
client controls, and any way to write as the person other than the operator's own sign-in and the
API keys they create, a second person included: agents take the person's messages as the operator's
direction (`SECURITY.md` "Security model" and "API keys").

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

Passkey sessions work only on the web mount, agent tokens only on the agent mount and API keys only
on the operator mount: the agent mount and the operator mount refuse any request carrying a cookie,
and the web mount any carrying an `Authorization` header (`docs/architecture.md` "HTTP API"). An
agent token is verified against its registration's stored public key, bound to the origin and
short-lived; approval and revocation are checked inside each operation's transaction and during long
polls, and only the registration route accepts a key the operator has not approved
(`docs/architecture.md` "Authentication"). Web mutations require the CSRF token and the exact
origin, and `Host` must equal the origin's host. Adding or removing a passkey, and every voice
change, needs a recent sign-in; the last passkey is never removed; removing one ends the browser
sessions it signed in (the **Separate authentication** invariant in `SECURITY.md` "Security model").
The transcription provider's key is never logged, no answer carries more of it than its last four
characters, and it goes only to the base URL it was entered for (`SECURITY.md` "Voice"). An API key
is stored only as its hash, never logged or answered after its creation; creating and revoking one
needs a recent sign-in; its revocation and expiry are checked inside each operation's transaction,
and again on every chunk of a file it uploads or reads, and end the waits it holds; and every
refusal of a key is the same (`SECURITY.md` "API keys"). Look for identity-header bypasses, an
insecure TLS fallback, a first-user-wins bootstrap instead of the one-time `passkey-link`, recovery
paths that skip ceremony checks, a credential's end that leaves a wait it holds running to its
bound, and a bridge that sends tokens or message text anywhere but its configured HTTPS origin, a
followed redirect included (`SECURITY.md` "The agent bridge").

## A5. Roles follow the direction of attention

Permissions attach to the requester and audience roles stored on the thread, never to whether the
actor is a person or an agent or how it authenticated (ADR 0001 "Roles follow the direction of
attention"). Asks, withdrawals and topics are the requester's, answers the audience's, and a
replacement its author's (the **Roles** invariant in `SECURITY.md` "Security model"). What makes an
ask, an answer, a withdrawal or a replacement valid, and what derives from them, is the thread
semantics in `docs/architecture.md` "Database" and "Store" and ADR 0001 "Threads are append-only
logs of messages, with asks": check the code against them rather than against a copy here. Sessions
are always requesters and the operator is always the audience, so these checks also keep an agent
from speaking as the operator, and a thread the operator starts on a session keeps the session its
requester, so it carries no asks or topic from them. Look for role checks keyed on anything but the
roles stored on the thread, an ask or answer mutated in place, a withdrawal undone, a derived state
that counts a replaced message, and a derived next action, a per-kind lifecycle, or items that open
and close creeping back in (ADR 0001 "Not doing" and "Alternatives considered").

## A6. Nothing built beyond the trust model

As material as A5: the server never acts on a deadline, whose consequence is entirely the
requester's choice; goals are set explicitly and never inferred (ADR 0001 "Not doing"); derived
signals, such as overdue, quiet and stranded, inform and never trigger actions or block writes; and
accuracy of impact, priority, effort, progress, and session state is the honor system's, not
something to police with enforcement ladders. The server infers one thing a session did not report:
its own write to a thread while idle, reporting no status, makes it working, logged as inferred, and
a stopped session stays stopped (ADR 0001 "Sessions report what they are doing"). Look for timers or
jobs that change threads or a session's status, inferred goals, progress or any other state,
automatic withdrawals, archives, or escalations, and validation that second-guesses what the agent
reports.

## A7. Stale writes, request ids, and read cursors

Refines the shared **Lifecycle, idempotency, and convergence** and **Ordering and enforcement
ownership** checks. Every message states the latest sequence its writer has seen (`seen_through`),
and a stale write fails and returns the missed messages; the server's declines in the operator's
action on many threads are the one exception, which ADR 0001 "Read and archive marks, and optimistic
concurrency" records with its bounds. A retried request id with the same content returns the
original result, and with different content is rejected (ADR 0001 "Read and archive marks, and
optimistic concurrency"). Marks move only the caller's own cursors, never change the thread or
conflict with a write, and never answer an ask; how they move, and what counts as unread and as
archived, is in `docs/architecture.md` "Store". A session's presence is stamped in a transaction of
its own before the call's work, so a call refused later still counts. A session's status changes
only through its own reports, with its status tool or beside a thread it starts or a message it
sends, and the one inference A6 names: an update merges into the current status and appends the
result to the session log, appending nothing when it changes nothing and carries no note, so it
needs no request id; updates are last-writer-wins and exempt from the stale rule, since only the
session writes its own status. A report beside a write, and the inference from a write, apply in the
write's transaction once its checks pass, so a write that fails changes no status, and the report is
part of the write's digest, so a replay applies nothing again. The UI keeps the draft on a stale
write (`docs/web-ui.md` "A thread"). Look for marks or derived counts that depart from those
definitions, check-then-write races outside one immediate transaction, writes that skip the sequence
check, a status a write changes outside its transaction, and request-id handling that replays a
different payload.

## A8. Append-only, attributed history

Thread logs, and the session log of session state, are append-only, protected by triggers on every
log table (`docs/architecture.md` "Database"); a thread's state derives from its live messages, and
anything stored beside the log equals a replay of it. Corrections are replacements that append;
actor and credential provenance is immutable; every topic change is an attributed message. Derived
signals are computed in queries, never stored (`docs/architecture.md` "Store"). Look for updates or
deletes on log rows, projections that can diverge from the log, and stored copies of derived
signals.

## A9. Inert content

Message text, details, references, pull requests and branches, and topics are displayed, never
executed, fetched, or followed (the **Inert content** invariant in `SECURITY.md` "Security model";
ADR 0001 "Text is Markdown, rendered inert" and "Not doing"). A message's text and its detail are
Markdown rendered inert, every other text field is plain, and text is stored and returned exactly as
written. A reference is a label plus at least one of an identifier, an HTTPS URL, and a thread of
the same session (`packages/api/src/references.ts`); a pull request or branch is a GitHub repository
with a number or a branch name under git's rules, and an optional HTTPS URL
(`packages/api/src/code-links.ts`), shown by its short form; and `isLinkableUrl` is the one rule for
what shows as a link (`docs/architecture.md` "API contract"). No image written in message text
loads: it shows as a link. Files attached to messages are not message text, and load only as A17
holds them (ADR 0004); message text reaches a file only through a link to one of its own message's
files. A diagram drawn from message text is drawn in isolation, so drawing it can neither run
anything in the app's page nor fetch anything, and shows as an image, with the content security
policy kept strict: it gains only the diagram frame's route as a frame source, `blob:` images, and
media from its own origin for attachments, and the frame's own policy sandboxes it. Look for
content-driven fetches or previews, any call to GitHub or another forge about a pull request or
branch, raw HTML or images other than such a diagram or an attached file reaching the DOM, a link
from text to a file another message carries, a diagram drawn outside its isolation, classes or
styles taken from text, live non-HTTPS links, links to URLs that `isLinkableUrl` refuses, search
text read as query syntax, and message content treated as the operator's direction anywhere, the
usage skill included, unless the operator wrote it (its author is the person).

## A10. Listener, TLS, proxy, and transport

Listen address, TLS mode, and public origin are independent settings; the origin is always HTTPS;
plain HTTP on a non-loopback address (anything but `127.0.0.0/8` or `::1`) is refused unless
explicitly enabled; proxy mode trusts no forwarded or identity headers (ADR 0001 "Transport
independence"; `docs/architecture.md` "Serving"). No authentication decision or rate limit keys on
source address, and each unauthenticated endpoint class has its own budget, so registration cannot
starve passkey sign-in, and failed agent authentication never slows an approved agent (the **No
network identity** invariant in `SECURITY.md` "Security model"; `docs/architecture.md` "Rate
budgets"). Every field, list, and page has a documented bound: the API contract's schemas, in
`packages/api` and `packages/server-api`, are the bounds (`docs/architecture.md` "API contract"),
with the body limits in `docs/architecture.md` "HTTP API".

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
API's agent, web and operator mounts, and, through the agent mount, the bridge's tools
(`docs/architecture.md` "Store" and "HTTP API"). Request and response shapes come from the API
contract: `packages/api` for what the bridge shares, and `packages/server-api` for what only the
server and the web UI ship, which the bridge's bundle never includes
(`apps/bridge/src/bundle.test.ts`; `docs/architecture.md` "Source and packages"). Once a bridge is
released, agent routes only grow: each release's agent routes accept what earlier released bridges
send and answer what they read, leaving out of an answer to an older bridge the fields added after
its version, because agents run whatever bridge version their plugin pins; the agent compatibility
gate holds this, and every agent contract change bumps the agent API version (`CONTRIBUTING.md` "The
agent API"). The typed error set (at least invalid input, not found, stale, request-id conflict,
rate limited, unauthenticated; `packages/api/src/errors.ts`) is the same on every mount and in the
bridge's tool errors. Tool names use lowercase letters, digits, and underscores; tool annotations
are true of the tools; `message_wait` stays well below the 60-second Codex tool timeout, worst case
included; tool schemas are the payload reference (`docs/architecture.md` "Agent bridge").

## A13. SQLite persistence and backup

Refines the shared **Recorded state and migrations** check. One SQLite database through
`node:sqlite`, one serialized writer (immediate transactions that are synchronous functions and
never span an `await`), pragmas applied on open, and private file permissions verified independent
of umask (`docs/architecture.md` "Database"; `SECURITY.md` "Private files"). Migrations are keyed on
`user_version` and append-only: a migration that has shipped is never edited. CI checks each
migration against its hash in `apps/server/src/database/migrations.test.ts`, so a change to an
existing hash there is legitimate only for a migration no release tag contains: confirm it is absent
from `git show <latest release tag>:apps/server/src/database/migrations.ts`, or that
`git tag --contains` on the commit that added it prints nothing. A backup is consistent and changes
nothing: `agention backup` opens the database read-only without migrating it and copies it with
SQLite's online backup in one step, into a new private file that it checks and removes on failure
(`docs/architecture.md` "Database"); a raw copy of a running instance's files is no proof of a valid
live backup. Restore is stop, replace the database and its `-wal` and `-shm` files, start
(`docs/operator-guide.md` "Backing up"). History is retained indefinitely (ADR 0001 "Consequences").

## A14. Reproducibility and contract tests

Exact dependency and action pins with integrity checks, each the newest stable release at least
seven days old when chosen unless a recorded security fix cannot wait, installs with lifecycle
scripts disabled (no dependency may need one), `npm audit` and `npm audit signatures`, SHA-pinned
actions, published bundles that declare no runtime dependencies and ship the license and notices,
the generated-plugin drift check, the OpenAPI document's parity test, and the SDD records check
(`CONTRIBUTING.md` "Dependencies" and "Checks"; ADR 0001 "Repository and supply chain"). These are
genuine contract tests, not prose policing; weakening one to get green is Blocking.

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
component tests, a browser drive with a virtual WebAuthn authenticator and Chromium's fake
microphone against a stub transcription provider, hostile files served to Chromium, PDFs opened in
the operator's own browsers, real-phone passkey and dictation acceptance with a real provider,
installed plugin metadata, an authenticated Claude Code or Codex install, and a live run behind
`tailscale serve` from another machine. None stands in for another; report uncovered dimensions
explicitly, and do not re-report the known acceptance gaps in the development context's "Testing" as
new findings.

## A17. Attachments

Files are kept in the database in chunks and served without the app's authority (ADR 0004;
`SECURITY.md` "Attachments"; `docs/architecture.md` "Database", "Store" and "HTTP API"). A file
loads only through the file routes, with their headers: a type from the allowlist, else
`application/octet-stream`; `nosniff`; the `sandbox` policy that allows nothing; same-origin
resource policy; and an attachment disposition for SVG and everything off the allowlist. The web UI
shows a file only as an `<img>`, `<video>` or `<audio>` of its own page, as text it fetched, or as a
PDF in a tab of its own: never in a frame, and never as a `blob:` or `data:` URL. Nothing detects a
type from a file's bytes, parses one, or processes an image. Who can read a file is who can read its
thread, under `threads:read` on every mount, uploading needs `threads:write`, and every chunk read
or written checks the credential again; a message names only its writer's own pending uploads in its
session, and every other reference is refused alike. Attached files and their bytes are never
changed or removed, a replacement carries a file only by keeping it, and attachments are inside the
write's digest, after its replay. Uploads keep their limits: the file and message bounds, the
pending limits counting uploads still arriving, the free-space floor, the sweep, and the listener's
deadlines, under which only an upload has no total deadline and every body is cut off when idle. The
bridge's `file_upload` refuses anything but a regular file, its key directory and an oversized file,
and `file_get` writes only into its own directory, under names it makes from a reference. Look for a
served type a file's declaration or bytes can steer outside the allowlist, a route answering a file
that does not declare its own policy and caching with `ownHeaders`, a file shown in a frame or
through a `blob:` or `data:` URL, content sniffing or parsing, a reference that crosses writers or
sessions, a chunk read or written without the credential and scope check, a file route outside the
declared thread operations, a file held whole in memory, a route other than the upload given the
larger body bound or no total deadline, a refused upload whose body is read beyond the adapter's
bounded drain, a fetched file named from the sender's name or written outside its directory, and a
file's contents treated as the operator's direction.

## A18. Operator operations and their scopes

Every operation an API key may call is declared once, with the one scope it requires, in the
operator operations list (`apps/server/src/http/operator-operations.ts`). Being in that list is what
puts an operation on the operator mount, so one left out stays off it and nothing fails open, and
the web mount serves the same list, so no operation has a second handler (`docs/architecture.md`
"HTTP API"). What no key may call, such as managing keys, passkeys or Settings, and transcription,
stays a web-only route. Each operation requires the narrowest scope that covers it: an operation a
read scope grants is a `GET` without a body whose store work writes nothing, which the test over the
list in `apps/server/src/http/operations.test.ts` holds, and approving, rejecting or revoking a
registration needs `sessions:approve`, which no other scope includes. One operation needs a second
scope for some of its fields: approving a registration that also sets the session's group or tags
needs `sessions:write` beside `sessions:approve`, which the store checks inside the approval's
transaction, answering a key without it `not_found` on the field and applying nothing, as
`apps/server/src/http/groups-and-tags.test.ts` holds. Files are their threads': uploading and
removing a pending upload need `threads:write`, and a thread's files and reading one `threads:read`.
The mount refuses a missing scope before reading input, and the store operation confirms the same
scope inside its transaction, which a test over every operation in the same file holds; a file's
chunk reads and writes are store calls too, and confirm it as every other does. Each chunk also
re-checks the credential, in its own transaction, so a transfer stops within one chunk once its
credential is revoked or expires (one check for both), which the store's
`apps/server/src/store/files.test.ts` ("stops within a chunk once its credential is revoked") and
the HTTP tests in `apps/server/src/http/files.test.ts` (the same, for a read) and
`apps/server/src/http/operator-files.test.ts` (an API key's upload and read) hold. A later resource
adds scopes of the form `<resource>:<access>` to `packages/server-api/src/scopes.ts` and never
changes what an existing scope grants (`SECURITY.md` "API keys"). Look for an operator route added
outside the list, an operation with a scope wider or narrower than what it does, a read-scoped
operation that writes or takes a body, a store operation or a file's chunk read or write that leaves
its scope to the mount, an operation whose body or answer is bytes but not declared so, a
key-reachable route that manages credentials or Settings, and a scope whose meaning changes.

## A19. The operator API contract and its document

The operator API's version is in its path, and a version changes only additively: a new operation, a
new optional request field, a new response field. A change that would break a client, such as a
field removed, renamed, narrowed or made required, is a new version beside the old, by a
maintainer's decision (`docs/architecture.md` "HTTP API"). Until 1.0, a change in what an existing
field or value means may land in place (`docs/architecture.md` "HTTP API"); look for one without a
maintainer's decision or a `BREAKING CHANGE:` footer. The OpenAPI document, `docs/api/openapi.json`,
is generated from the declarations and never edited by hand: a change to an operator or agent
operation, or to a schema one uses, regenerates it with `scripts/generate-api-docs.sh` in the same
change, and its diff is reviewed as the contract change it is; the server's suite fails while the
committed document differs from the code's (`CONTRIBUTING.md` "Generated API document";
`docs/architecture.md` "API documentation"). Look for a contract change whose document was not
regenerated, a regenerated document whose diff removes or narrows anything a served version or the
agent API (A12) carries, a document that describes more than the server checks (it may describe
less: a rule enforced only in code answers `invalid_input`, naming the field when the rule concerns
one), and documentation served with anything beyond the contract or without `--api-docs`.
