# 1. Agention v1 architecture

Date: 2026-10-25

## Status

Accepted. Implementation is in progress; [docs/architecture.md](../architecture.md) tracks what
exists. Later ADRs will record decisions made while building.

Until v1 is released, this ADR is amended in place rather than superseded, and each amendment is
listed here:

- 2026-10-27: the server moved from Go to TypeScript on Node; agents reach it through an agent
  bridge that Agention publishes, instead of an MCP endpoint on the server; and agents authenticate
  with keys the operator approves, instead of OAuth. The earlier choices are recorded under
  [Alternatives considered](#alternatives-considered).
- 2026-10-28: the server's HTTP framework and authentication libraries, and the agent bridge's MCP
  SDK, are recorded under [Repository and supply chain](#repository-and-supply-chain).
- 2026-10-30: agents and the operator work in threads of messages, where the party seeking attention
  may ask the other something; each party archives a thread it is done with; and one thread list
  serves the operator, holding the threads not archived and narrowed by filters that combine, title
  search among them.
- 2026-10-31: an ask states how long answering takes, when the requester can judge it; a message may
  carry several asks, each numbered within its thread, and several answers; an identity archives a
  thread through a message it chooses, all of it by default, its own writing keeps the thread
  archived, and an archived message is never unread; and the operator's list takes several values of
  a filter, combined with OR, counts what each value keeps, and is viewed flat or grouped by session
  or by agent.
- 2026-11-05: an ask is withdrawn by a later message naming it with a reason, which is never undone,
  instead of by replacing its message; a thread's status rolls up its asks; and agents never wait on
  Agention, which shows when a session has gone quiet and which threads it left stranded.
- 2026-11-06: releases publish to npm from their tag alone, through npm's trusted publishing with
  provenance, so CI holds no npm token.
- 2026-11-08: every message stands on its own: its text is a summary of at most 1,000 characters,
  and a Markdown detail beside it carries the rest, folded under the text in the web UI.
- 2026-11-18: every dependency is the newest stable release at least seven days old when it is
  chosen, unless a security fix cannot wait, and npm and Dependabot hold to that wait; see
  [Repository and supply chain](#repository-and-supply-chain).

## Context

One person often runs many largely autonomous agent sessions. Each occasionally needs that person,
and today those needs are scattered across terminals and chats that the person has to go and check.
Agention is a self-hosted place where sessions say what they need and the person answers, from a
phone or a desktop browser.

An earlier prototype proved the infrastructure (agent OAuth, human passkeys, isolated storage) but
modeled each request for attention as one of a fixed set of kinds, each with its own lifecycle.
Whether a request still needs attention, how it affects the agent's work, how the person should
answer and whether it is settled are largely independent of each other. Combining them into kinds
produced special cases wherever a real situation did not fit a kind. v1 rebuilds the product around
those dimensions kept separate.

Agents usually run unattended, under hosts such as Claude Code and Codex, on machines with no
browser and often no person in front of them. Connecting one to Agention must not need a browser on
that machine, and the person must still decide which agents get in.

Agention must also stay small enough for one person to self-host, with no paid services, and must be
safe to expose on a private network without trusting that network.

## Decision

### Trust model: enforce provenance, not behavior

Agention is an honor system. An agent can fail to report or report falsely, and no server can tell.
Agention therefore does not build enforcement around reporting behavior. It enforces what an honor
system cannot provide: who wrote each message, isolation between sessions, append-only attributed
history, role checks (only a thread's requester asks, and only its audience answers), and that
message content is inert (displayed, never executed or fetched). Whether and what to report is
steered by defaults, the agent skill and visible signals.

### One Node server and one SQLite database

A single Node process, written in TypeScript, serves the HTTP API and the static web UI from one
HTTPS origin. The API has two mounts with the same thread routes and schemas: one for agents and one
for the web UI, each accepting only its own kind of credential. All state lives in one SQLite file,
opened with Node's built-in `node:sqlite`. Every write runs in a synchronous transaction, so the one
process is the serialized writer. A single process and a single file are easy to run, back up and
reason about, and the expected load (one person, tens of agent sessions) is far inside what SQLite
handles.

### An agent bridge in front of a plain HTTP API

Agents never call the API directly. The Agention plugin declares the agent bridge, a small stdio MCP
server published as `@wayfarerlabs/agention-mcp`, as an `npx` command pinned to the release, so
installing the plugin is the whole agent setup. The bridge presents the agent tools to the host,
holds the session's key, and turns each tool call into one HTTP request. The server speaks no MCP;
the bridge and the web UI use the same plain HTTP API.

Because Agention writes both ends, registration can suit agents: the agent calls a `register` tool
when it chooses, and until the operator approves, the bridge answers with the code for the agent to
relay. The request and response schemas live in one shared package that the server, the bridge and
the web UI all compile against, so the bounds an agent's tools advertise are the bounds the server
enforces.

### Agents, sessions and threads

An agent is a principal; a session is one of its workloads; every thread belongs to exactly one
session. This matches how agents are actually run (a user on a machine running several named
workloads) and gives a natural unit of isolation: in v1 a credential authorizes exactly one session.

Requests always name their target (a session or a thread); the bridge names its session in the path
of every request. The credential only authorizes; the server never infers the target from it, and
the actor is always taken from authentication, never from the request. A target the caller may not
access looks the same as one that does not exist. Keeping the target in the request means later
grants (one credential across several sessions, or identity from an external issuer) need no change
to the API.

### Roles follow the direction of attention

Each thread has a requester, the party asking for attention, and an audience, the party whose
attention is asked. Thread permissions attach to those roles, stored on the thread, and never to
whether a party is a person or an agent or how it authenticated: the requester asks and sets the
topic, the audience answers, and either writes messages and replaces its own. In v1 sessions are
always requesters and the operator, the person running Agention, is always the audience.

### Threads are append-only logs of messages, with asks

A thread is a log of messages about one matter. A message may carry Markdown text, its detail,
references, a topic, asks for the audience, or answers to them, and may replace an earlier message
of its author's, which is ignored from then on. Every message stands on its own, so the operator can
decide on it or understand it from Agention alone, without going to the agent's terminal: its text,
at most 1,000 characters, says in a few sentences what the matter is and what is needed, and its
detail, which goes only beside text, carries everything else at length, folded under the text in the
web UI. Each ask is numbered within its thread as it is written; asks that belong together go in one
message and are answered together or apart, each answer naming its ask by number. Nothing is edited
or removed: revising an ask, or changing an answer, is replacing the message carrying it, and a
revised ask is asked again under a new number; withdrawing an ask the requester no longer needs
answered is a later message naming it with the reason, and is never undone, so no ask is dropped
without an explanation. A thread stores only what never changes and its latest sequence; which
messages are live, which asks are open, the thread's status, the topic and every signal are derived
from the messages in queries, never stored. The status rolls up the asks on live messages and those
a live message withdraws: open while any is open, otherwise withdrawn when every one was withdrawn,
answered when there are any, and none when there are none.

An ask carries independent fields rather than a kind, all set by the requester: a question and
suggested answers, from which the audience picks, or answers in its own words instead of a pick or
beside its picks where several are allowed, or declines; how waiting affects the requester's work
(blocking, proceeding on an assumption, or not at all); where it thinks the audience should focus
(urgent, high, normal or low, by what delay costs, independent of impact); how long answering takes,
when the requester can judge it (a glance, under 15 minutes, under an hour, or longer), and unknown
otherwise; and an optional answer-by time with what the requester will do without an answer.
Priority is the requester's stated judgement rather than something derived from impact or a
deadline, because only the requester knows what waiting costs its work. Signals such as "blocked on
you" or "overdue" are computed from open asks, never stored. A message without asks asks nothing and
is only read.

### Text is Markdown, rendered inert

A message's text and its detail are Markdown (CommonMark with GitHub's tables, task lists and
strikethrough), whoever writes them; every other text field is plain text. Rendering keeps content
inert: raw HTML is shown as text, images are shown as links rather than loaded, so no content makes
the browser fetch anything, and only HTTPS links are live. Text is stored and returned exactly as
written.

### Read and archive marks, and optimistic concurrency

Every identity has a read mark per thread, so each side knows what the other has read, and unread
state is always defined. Each also has an archive mark, which only it sees, through the message it
chose, all of the thread by default: an archived thread leaves the identity's list until the other
party writes to it again, its own writing keeps it archived, and a list can include archived threads
on request. An archived message is never unread, so archiving a thread unread settles it. Archiving
is refused while an ask open to the archiver sits in a message at or before the mark, so a thread
holding one is never archived for it. Every write states the latest message its author has seen; if
another landed first, the write fails as stale and returns the missed messages. Every write also
carries a client request identifier, so retries are safe and a reused identifier with different
content is rejected. Marking never conflicts with a write.

### People and agents authenticate separately

People authenticate with passkeys. Each agent session has its own Ed25519 key pair, which the bridge
generates and keeps on the agent's machine. Registration submits the public key, and the operator
approves it by matching a short code that the bridge and the server each derive from that key, so
the registration the operator approves carries the key the agent holds. Each request then carries a
short-lived token signed with the key and bound to the server's origin.

The server stores only public keys: it issues, refreshes and stores no agent token, so there is
nothing to rotate, and two host processes in one session sign independently. A future identity
issuer's tokens can be verified the same way, against the issuer's published keys. Neither
credential works on the other's mount.

### Transport independence

The listen address, the TLS mode (terminate TLS, or serve plain HTTP behind a terminator) and the
public HTTPS origin are independent settings. Plain HTTP on a non-loopback address is refused unless
explicitly enabled. No forwarded or network-identity headers are trusted, and no authentication
decision or rate limit depends on source address. The documented deployment runs Agention on
loopback behind `tailscale serve`, but nothing depends on Tailscale.

### Distribution: generated agent plugins

One canonical plugin definition in `apps/agent-plugin` holds the plugin metadata, the agent usage
skill and the bridge's MCP declaration. A generator renders a self-contained plugin for each host
(Claude Code and Codex) and each host's repository catalog. The outputs are generated and committed,
and CI fails if they drift from their sources; installing them from the repository on each host will
be verified once the plugin has real content. This keeps metadata in one place and leaves room for
host-specific features, such as the environment Codex passes to the bridge, which a single
hand-maintained plugin directory would not.

One version covers the server, the bridge and the plugins, and each release's plugins pin the bridge
at that version.

### Repository and supply chain

- One language: strict TypeScript on the pinned Node, in npm workspaces with one lockfile. Node runs
  the sources directly by stripping their types, so the code uses only erasable syntax.
- The server and the bridge are published to npm as esbuild bundles that declare no dependencies, so
  `npx` and `npm install` resolve nothing beyond what the lockfile built. Each package ships
  Agention's license and, beside its bundle, the license notices of the npm packages it includes.
- npm lifecycle scripts are disabled for every install, so no dependency may need an install script.
  That rules out native addons, which is why SQLite comes from Node itself.
- The server is built on a few small libraries, each pure JavaScript and bundled into its package:
  Hono on `@hono/node-server` for HTTP, a small router whose sub-applications let both API mounts
  share the thread routes; `jose` to verify agents' tokens; and `@simplewebauthn/server` for the
  passkey ceremonies, whose attestation and signature checks are not worth writing again. Rate
  budgets are a small module of Agention's own.
- The agent bridge is built on the official MCP TypeScript SDK, `@modelcontextprotocol/server`,
  whose protocol handling and revision negotiation with each host are not worth writing again, and
  on `jose` to sign its tokens. The SDK's own build includes a JSON Schema validator and its
  helpers; their license notices ship with the bridge too, and the bridge lists them at the inlined
  versions so the vulnerability check covers them.
- Bash scripts as the task runner, with `scripts/check.sh` as the single definition of the CI gates
  that contributors also run locally. The repository's build concerns (the server, the bridge, the
  web UI and plugin generation) share one toolchain and do not justify a build system.
- Exact pins everywhere: the Node version in `.node-version`, every package in `package-lock.json`,
  GitHub Actions by commit SHA. The checks verify registry signatures after each clean install.
- Each pin is the newest stable release at least seven days old when it is chosen, which gives a
  broken or compromised release time to be caught; a security fix that cannot wait is taken earlier
  and recorded. npm's `min-release-age` in `.npmrc` holds every install to the wait, and
  Dependabot's cooldown holds its proposals to it.
- One release stream with a changelog, produced by release-please from Conventional Commits.
  Dependabot proposes weekly updates.
- A release's tag publishes both packages through npm's trusted publishing, which signs their
  provenance and needs no token. Only a job that runs no repository code can publish: it publishes
  the tarballs a job without that right built and checked. Only a merged release pull request can
  start it: each package's trusted publisher names the workflow and a GitHub environment only `v*`
  tags may use, only the release-please App may create `v*` tags, and the App's key is usable only
  from `main`, which changes only through reviewed pull requests with the required check. A tag's
  own workflow cannot be trusted to check where its commit came from, since whoever pushes the tag
  supplies it.
- The MIT license and no paid services.

### Not doing

These are deliberate limits, not gaps to fill later without a new decision:

- **No derived "next action" or lifecycle.** Agention does not compute whose turn it is. Agents
  learn things worth reporting when it is not their turn, and a single turn indicator would blur
  what is asked with what is only said. An open ask states what is asked; "blocked on you" is the
  one turn-like signal. A thread's status only rolls up its asks and is no lifecycle: each party
  archives the thread when it needs nothing more from them.
- **No server action on deadlines.** An answer-by time and the requester's stated fallback are shown
  to the audience, but the server never acts on them. What a missed deadline means is entirely the
  requester's choice.
- **Goals are never inferred or managed.** A session's goal and progress are only what the agent
  explicitly reports, and Agention never decides whether a session continues.
- **Agents never wait on Agention.** An agent asks and carries on, checking for answers as it works,
  and one that has done what it can stops as it otherwise would; a waiter of its own may wait while
  it carries on. Agention shows when a session was last seen, whether it has gone quiet, and which
  threads hold messages it has not read while it is quiet or has no credential, so the person knows
  to resume it.
- **No permissions, no harness control.** Agention does not grant permissions, inject text into an
  agent's conversation, or control an agent harness.
- **No MCP endpoint or authorization server on the server.** Agent hosts reach Agention only through
  the bridge, over the plain HTTP API, with keys the operator approved. Serving MCP or running OAuth
  on the server would bring back the machinery the bridge removed.
- **No agent secret on the server.** The server keeps agents' public keys and nothing an attacker
  could replay, so a copy of the database cannot impersonate an agent.

## Alternatives considered

- **Separate services instead of one server.** An API server, static hosting and a database server
  would each be conventional on their own, but together they make a self-hosted tool much harder to
  run, back up and secure, for load that one process handles easily. The same boundaries exist as
  modules inside the one server.
- **Go for the server.** Agention's first foundation, in a repository before this one, was a single
  Go binary: a static executable, a strong standard library, and no runtime to install. Once agents
  connect through a bridge that Agention publishes for `npx`, the bridge is naturally a Node
  program, and keeping the server, the bridge and the web UI in one language lets one shared package
  of schemas be checked by the compiler on every side. Node's built-in SQLite keeps the server free
  of native addons. The cost is a Node runtime on the server and agent machines instead of one
  static binary.
- **OAuth through the hosts' MCP clients.** The server would be a remote MCP endpoint and an OAuth
  authorization server, and each host's MCP client would sign in. Neither host's client implements
  the OAuth device grant, so approving a sign-in needs a browser on the agent's machine, which
  unattended agents do not have. Hosts also store sign-ins per endpoint, which pushes the session
  into the endpoint URL, and a plugin's remote entry has no documented way to take the server's
  address from the environment. Agention would carry a complete authorization server (client
  registration, token issuance, refresh, revocation) to get less than approved keys provide.
- **Device-code sign-in through an existing bridge.** A generic stdio-to-remote bridge run with
  `npx`, such as `mcp-remote`, implements the device grant. It signs in before it answers the host,
  so the code reaches only its standard error and the host's log, where the agent cannot read it to
  relay, and the host's startup waits on the approval. It also still needs the OAuth server above.
  Agention's own bridge answers the host at once and hands the code to the agent through a tool.
- **Permissions keyed on person versus agent.** Simpler to state while every thread flows from an
  agent to the operator, but it writes that direction into every check. Roles stored on the thread
  cost the same checks and admit any direction.
- **Plain text or HTML for message text.** Plain text loses the structure agents already write, and
  HTML would make rendering a sanitization problem. Markdown without raw HTML keeps the structure
  with a small, inert rendering surface.
- **One longer text that the web UI folds by length.** Only the writer knows which part is the
  summary, and a cut by length can land mid-table or fold the summary away, so the writer separates
  the text from its detail. The detail's bound, 20,000 characters, is what fits beside its text
  within the bridge's result cap when they are one-byte characters that JSON need not escape; the
  bridge leaves out a detail in other scripts that does not fit, naming it, and the web UI shows it
  in full.
- **Kinds instead of independent dimensions.** A fixed set of kinds (question, decision, approval,
  notice) is easy to explain, but every kind fixes a combination of what is asked, how the work is
  affected and how to answer. Real situations keep needing combinations no kind covers, and the
  prototype that tried this accumulated special cases. Independent fields compose without them.
- **Items that open and close.** Each matter as one item whose fields say what it asks and how to
  respond, with a log of messages, field changes, closes and reopens. An item asks one thing at a
  time, and closing it makes the two parties agree when the matter is done. Threads let any message
  ask, and let each party archive on its own.
- **Nx or Make instead of Bash scripts.** Nx brings a large dependency tree and its own
  configuration for a few build concerns that share one toolchain. Make adds a second language and
  portability quirks for little gain over a few scripts. Bash scripts keep the gates readable in one
  place, and CI runs the same script contributors do.
- **Express, Fastify or bare `node:http` instead of Hono.** Express brings a deep dependency tree
  and Fastify a plugin system the server does not need, and bare `node:http` would mean writing
  routing, cookies and body limits by hand. Hono has no dependencies, is typed end to end, and runs
  the same application in process under test.
- **Hand-written token and passkey checks.** Verifying a compact JWS or a WebAuthn assertion with
  `node:crypto` alone is possible, but the encodings and rules around them (JWS headers and critical
  parameters; CBOR, COSE keys, attestation formats and authenticator data) are easy to get subtly
  wrong, and maintained libraries already get them right.
- **A hand-written MCP server for the bridge.** The bridge needs only stdio, tool listing and tool
  calls, which a few hundred lines of JSON-RPC could serve. Hosts already open with different
  protocol revisions, and the protocol keeps adding revisions and rules, so the SDK keeps the bridge
  current with the hosts for the cost of a larger bundle.
- **A lockfile per component.** Separate lockfiles would multiply the installs, audits and update
  proposals without isolating anything: the published packages are bundles that declare no
  dependencies, so every dependency is resolved at build time, from the one lockfile that npm
  workspaces share.

## Consequences

- Operating Agention means running one Node process and backing up one file. Scaling beyond one
  machine is not a goal, and the single writer bounds write throughput.
- Agent machines need Node to run the bridge. In exchange, installing the plugin is the whole agent
  setup, and each session's key never leaves its machine.
- Every dependency must work without an install script, which narrows the choice of libraries and
  excludes native addons.
- Because the server cannot verify what agents report, the product's value depends on the agent
  skill and on making the right behavior easy. Misreporting stays visible and attributed rather than
  prevented.
- Every operation, including marking read, must authorize its target explicitly. This is more code
  than scoping everything by credential, and it is what makes later cross-session grants possible
  without breaking the API.
- Append-only logs mean history grows without bound. That is intended: history is retained, and
  backups carry all of it.
- Agents and people both handle stale writes. The web UI keeps the draft, shows what was missed and
  resubmits in one step; agents re-read and retry.
- Committed generated plugins add a regeneration step to changes that touch the plugin sources. A
  release bumps the version in the canonical definition and in both generated manifests, so the
  outputs stay current without regeneration.
