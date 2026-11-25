# 1. Agention v1 architecture

Date: 2026-10-25

## Status

Accepted. [docs/architecture.md](../architecture.md) describes what exists. Until v1 is released
this ADR is edited in place to state each decision as it stands; later decisions get ADRs of their
own. Its "no paid services" is superseded by [ADR 0002](0002-voice-through-the-server.md): none by
default, with voice's transcription provider one the operator may opt into. Its "no way to ... let
people or integrations act for them" is superseded by [ADR 0003](0003-operator-api-keys.md):
integrations may act for the operator within the scopes of a key the operator creates. Its "never
executed or fetched", in its trust model, and "so no content makes the browser fetch anything", in
"Text is Markdown, rendered inert", are superseded for files by [ADR 0004](0004-attachments.md):
message text stays inert, and files load only as attachments, under that ADR's rules. Its sessions
view's tab counting the sessions with unread updates is superseded: a navigation badge counts only
what its own tab lets the operator clear, so the Sessions tab counts the registrations waiting for
approval and the Threads tab the unread threads, as [docs/architecture.md](../architecture.md) "Web
UI" and the [operator guide](../operator-guide.md#using-the-web-ui) describe; each session's row
still marks its unread updates. Its "One version covers the server, the bridge and the plugins", its
"one release stream" and its `v*` tags are superseded by [ADR 0005](0005-separate-release-lines.md):
the server, and the bridge with the plugins, are released on lines of their own, each with its own
version and tags.

## Context

One person often runs many largely autonomous agent sessions. Each occasionally needs that person,
and today those needs are scattered across terminals and chats that the person has to go and check.
Agention is a self-hosted place where sessions say what they need and the person answers, from a
phone or a desktop browser.

Whether a request for attention still needs it, how it affects the agent's work, how the person
should answer and whether it is settled are largely independent of each other. A fixed set of kinds,
each with its own lifecycle, turns every situation that fits no kind into a special case, so
Agention keeps those dimensions separate.

Agents usually run unattended, under hosts such as Claude Code and Codex, on machines with no
browser and often no person in front of them. Connecting one to Agention must not need a browser on
that machine, and the person must still decide which agents get in.

Agention must also stay small enough for one person to self-host, with no paid services (superseded
by [ADR 0002](0002-voice-through-the-server.md): none by default), and must be safe to expose on a
private network without trusting that network.

## Decision

### Trust model: enforce provenance, not behavior

Agention is an honor system. An agent can fail to report or report falsely, and no server can tell.
Agention therefore does not build enforcement around reporting behavior. It enforces what an honor
system cannot provide: who wrote each message, isolation between sessions, append-only attributed
history, role checks (only a thread's requester asks, and only its audience answers), and that
message content is inert (displayed, never executed or fetched; superseded for files by
[ADR 0004](0004-attachments.md), under which files load only as attachments). Whether and what to
report is steered by defaults, the agent skill and visible signals. Because authorship is enforced,
the skill has an agent take a message the operator wrote as the operator's direction, exactly as
their words at its terminal; messages from agent sessions are not the operator's.

### One Node server and one SQLite database

A single Node process, written in TypeScript, serves the HTTP API and the static web UI from one
HTTPS origin. The API has two mounts with the same thread routes and schemas: one for agents and one
for the web UI, each accepting only its own kind of credential. All state lives in one SQLite file,
opened with Node's built-in `node:sqlite`. Every write runs in a synchronous transaction, so the one
process is the serialized writer. A single process and a single file are easy to run, back up and
reason about, and the expected load (one person, tens of agent sessions) is far inside what SQLite
handles.

The database is the instance's whole state, and its history is kept for good. `agention backup`
copies it while the server runs, through SQLite's online backup in a single step, so a server
writing meanwhile cannot restart the copy; it opens the database read-only and never migrates it.
Migrations only move forward: every schema change is a new migration, and a release refuses a
database a newer one wrote, so going back to an earlier release means restoring a backup.

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
always requesters and the operator, the person running Agention, is always the audience. The
operator can start a thread on a session, with a title and a first message; the session stays its
requester, so the operator's request has no place for asks or a topic, and the agent reads the
thread as the operator's words and replies in it.

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
suggested answers, from which the audience picks, with notes in its own words beside its picks or
not, or answers in its own words instead, or declines; how waiting affects the requester's work
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
the browser fetch anything (superseded by [ADR 0004](0004-attachments.md): files load only as
attachments, and Markdown images still never load), and only HTTPS links are live. Text is stored
and returned exactly as written. The renderer is Agention's own, over a Markdown parser given only
those three extensions, so a bare URL never becomes a link and no footnote makes links of its own.

A fenced `mermaid` block is drawn as the diagram it describes, but Mermaid never runs in the web
UI's page. It runs in a frame served from a route of its own and sandboxed with scripts only, so its
origin is opaque; the route's content security policy sandboxes it even when it is opened on its own
and lets it fetch nothing. The frame answers with SVG, which the page shows as an image, so it runs
no script and loads nothing; the page's own policy gains only that frame and `blob:` images (and
media from its own origin, for attachments, by [ADR 0004](0004-attachments.md)). A diagram that is
too large, fails or takes too long shows its source instead.

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

One write is the exception: the operator's action on many threads that declines their asks before
archiving them writes the declines from the server, at most as many to a message as any message
answers, which state no latest message of their own and carry request identifiers the server makes.
The request stands in for both, as the operator confirmed it in the web UI or as a program holding
an API key sent it, bounded by what it names: each thread is acted on through the message the list
showed it at, or, for every thread matching the list's filters, through its latest message at or
before the list's position among all messages (`as_of`). Which threads match is decided as the
action runs, since a thread can come to match without a new message, and the action is refused as
stale when they number other than the count the request expected. A thread holding an ask to decline
and a newer message is left as it was, since writing would answer what was not seen and read it;
every other thread is marked, or marked and archived, through the older message, leaving the newer
unread. A retry declines nothing twice, since a declined ask is open no more.

### Sessions report what they are doing; presence is observed

A session reports its status through its status call, or beside a message it writes, so one call can
send its last message and report that it now waits. What it is doing is working; idle, with nothing
left but waiting while it still checks Agention; or stopped, with an outcome. Stopped means the
session is not likely to see new messages until something starts it again. The latest report wins,
exempt from the stale rule, since only the session reports its status.

The server infers one change of its own: a session that writes to its threads while idle, starting
one, sending a message, or marking one read, unread or archived, without reporting a status beside
the write, is working; a write that reports one applies it as a status call would. An agent that
reports idle and then picks work up again without reporting working would otherwise look idle for
hours while plainly active, and a reminder cannot catch it, since an idle status gets none while the
session waits. A write is a fact the server sees, not a report it trusts, and an idle session that
writes is doing something. Each inferred change is marked as such in the session's log, so the
agent's own reports stay distinguishable from it. Reads and waits change nothing, since an idle
session checks for answers by design, and a stopped session stays stopped, since one that writes was
started again and should say so itself.

Each change is appended to the session's log, so the current status is read from the log and nothing
about it is stored elsewhere; the operator reads the log with a read cursor of their own. Whether a
session is waiting on the operator is never reported: it is counted from the session's open asks, so
the two cannot disagree.

Presence is observed rather than reported. Every authenticated agent call stamps when its session
was last seen, and a session not seen within a configured time is quiet. A thread holding a message
of the operator's that its session has not read is stranded while the session is quiet, stopped or
without an active credential, so the operator knows the agent is not there to read it.

### One thread list

One thread list serves the operator: the threads they have not archived, narrowed by filters that
combine with AND, search among them. A filter takes several values, combined with OR, and counts
what each value keeps. Grouping, sorting and filtering are separate controls. The list is viewed
flat, by session group (group, session, topic), by session (session, topic) or by agent (agent,
session); every parent folds, rolls up what it holds, and is placed by its first thread under the
sort. Focusing on some groups is the group filter, the one mechanism for it. The operator's search
matches thread titles and the text and detail of live messages; an agent's search of its own threads
matches titles.

The operator sorts sessions into groups, one level deep and each session in at most one, and tags
agents and sessions, an agent's tags counting for each of its sessions. Groups and tags organize the
operator's views and nothing else: they grant nothing, and no agent sees them, so they appear on no
agent route.

Threads stay on the thread list and session status on the sessions view. The sessions view shows
each session's status and log, never its threads, but rolls up each session's, each agent's and,
once any session is in a group, each group's threads as the list's parents do, each with a link to
the thread list filtered to them; a session's unread updates show apart, so unread always means
threads. The view's tab counts the sessions with unread updates (superseded: the tab counts the
registrations waiting for approval, as the Status says). A topic is different: the requester's own,
one per thread, within its session.

### People and agents authenticate separately

People authenticate with passkeys. The operator may hold several, each a way into the one account
from a device of theirs, never a way to share it. The first passkey, and recovery, come from a
one-time link that only a command on the server's machine issues; once the operator exists a link
replaces every passkey, and holding a passkey never yields one. Each agent session has its own
Ed25519 key pair, which the bridge generates and keeps on the agent's machine. Registration submits
the public key, and the operator approves it by matching a short code that the bridge and the server
each derive from that key, so the registration the operator approves carries the key the agent
holds. Each request then carries a short-lived token signed with the key and bound to the server's
origin.

The server stores only public keys: it issues, refreshes and stores no agent token, so there is
nothing to rotate, and two host processes in one session sign independently. A future identity
issuer's tokens can be verified the same way, against the issuer's published keys. Neither
credential works on the other's mount.

### Transport independence

The listen address, the TLS mode (terminate TLS, or serve plain HTTP behind a terminator) and the
public HTTPS origin are independent settings. Plain HTTP on a non-loopback address is refused unless
explicitly enabled. No forwarded or network-identity headers are trusted, and no authentication
decision or rate limit depends on source address. The operator guide documents running Agention on
loopback behind `tailscale serve` as one way to publish it; nothing depends on Tailscale. A bridge
can open its connections at another address, such as an SSH reverse tunnel's port on its own
machine, while TLS, the `Host` header and its tokens still name the origin, so a machine that can't
connect to the server can still be reached from the server's machine.

Agent machines run whatever bridge their plugin pins, so bridges of several releases talk to one
server. Every agent request and answer states the agent API version it speaks, a missing one meaning
the first; a bridge refuses a server older than itself and the server a bridge outside the versions
it serves, each saying what the operator upgrades, so a mismatch fails loudly instead of losing
fields. Agent routes only grow between versions, and a gate runs every released bridge against them.

### Distribution: generated agent plugins

One canonical plugin definition in `apps/agent-plugin` holds the plugin metadata, the agent usage
skill and the bridge's MCP declaration. A generator renders a self-contained plugin for each host
(Claude Code and Codex) and each host's repository catalog. The outputs are generated and committed,
CI fails if they drift from their sources, and each host installs its plugin from the repository's
catalog. This keeps metadata in one place and leaves room for host-specific features, such as the
environment Codex passes to the bridge, which a single hand-maintained plugin directory would not.

One version covers the server, the bridge and the plugins, and each release's plugins pin the bridge
at that version.

### Repository and supply chain

- One language: strict TypeScript on the pinned Node, in npm workspaces with one lockfile. Node runs
  the sources directly by stripping their types, so the code uses only erasable syntax. The
  repository builds and publishes on Node 26, the current LTS line, while the published packages
  also run on Node 24, which is widely deployed and which CI checks too.
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
- The web UI is React, built with Vite, with no framework beyond React: its router and data hooks
  are its own. It parses Markdown with `mdast-util-from-markdown` and the GFM table, task-list and
  strikethrough extensions, draws diagrams with Mermaid, only inside the diagram frame and kept out
  of the page's bundle, and zooms them with `@panzoom/panzoom`.
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
- The MIT license and no paid services (superseded by [ADR 0002](0002-voice-through-the-server.md):
  none by default).

### Not doing

These are deliberate limits, not gaps to fill later without a new decision:

- **No derived "next action" or lifecycle.** Agention does not compute whose turn it is. Agents
  learn things worth reporting when it is not their turn, and a single turn indicator would blur
  what is asked with what is only said. An open ask states what is asked; "blocked on you", on a
  thread or a session, read from open asks, is the only turn-like signal. A thread's status only
  rolls up its asks and is no lifecycle: each party archives the thread when it needs nothing more
  from them.
- **No server action on deadlines.** An answer-by time and the requester's stated fallback are shown
  to the audience, but the server never acts on them. What a missed deadline means is entirely the
  requester's choice.
- **Goals are never inferred or managed.** A session's goal and progress are only what the agent
  explicitly reports.
- **Agention never holds up an agent's work.** An agent asks and carries on, checking for answers as
  it works, and once its other work is done keeps checking, as cheaply as it can, while it has open
  asks or unread messages. A session's reported state, its presence and its stranded threads show
  the person when an agent is not there to read, so they know to resume it.
- **No push.** Agention reaches the person only through its own web UI, with no notifications, email
  or other channel, and reaches an agent only when the agent checks, through `message_wait`.
  Standard MCP notifications reach neither host's model; waking an idle agent takes each host's own
  mechanism, which exists on both hosts, and is left for a later release so that polling, which
  every host supports, works well first.
- **No permissions, no harness control.** Agention does not grant permissions, inject text into an
  agent's conversation, or control an agent harness.
- **No MCP endpoint or authorization server on the server.** Agent hosts reach Agention only through
  the bridge, over the plain HTTP API, with keys the operator approved. Serving MCP or running OAuth
  on the server would need the machinery the bridge avoids.
- **One person, who never asks.** There is one operator, the audience of every thread, and no way to
  share their account or to let people or integrations act for them (integrations superseded by
  [ADR 0003](0003-operator-api-keys.md): they may act for the operator within an API key's scopes).
  The operator answers and writes but makes no asks, so they are never a requester.
- **One topic, one level of groups, tags by hand.** A thread has at most one topic and no other
  labels; session groups do not nest; tags are assigned, never matched to names by pattern.
- **No agent secret on the server.** The server keeps agents' public keys and nothing an attacker
  could replay, so a copy of the database cannot impersonate an agent.
- **Agention never calls a forge.** The pull requests and branches a message names are what its
  writer declared, shown as data; the server never fetches them, follows their links or receives a
  forge's webhooks, and records no pull request's state. Checking them would need forge credentials
  and network access the server does not have, and would make it a forge client; agents say in their
  text what changed, and the operator reads the forge itself.

## Alternatives considered

- **Separate services instead of one server.** An API server, static hosting and a database server
  would each be conventional on their own, but together they make a self-hosted tool much harder to
  run, back up and secure, for load that one process handles easily. The same boundaries exist as
  modules inside the one server.
- **Copying the database's files for a backup.** A copy taken while the server writes can catch the
  database and its write-ahead log at different moments, and stopping the server first takes it
  down. SQLite's online backup copies one consistent moment while the server runs.
- **Go for the server.** A single Go binary offers a static executable, a strong standard library,
  and no runtime to install. Once agents connect through a bridge that Agention publishes for `npx`,
  the bridge is naturally a Node program, and keeping the server, the bridge and the web UI in one
  language lets one shared package of schemas be checked by the compiler on every side. Node's
  built-in SQLite keeps the server free of native addons. The cost is a Node runtime on the server
  and agent machines instead of one static binary.
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
- **The operator's messages as information only.** Agents would weigh every message, the operator's
  included, as information that never overrides their instructions. The operator's messages are
  authenticated, though, so the operator would have to repeat at the terminal what they already said
  in Agention.
- **Permissions keyed on person versus agent.** Simpler to state while every thread flows from an
  agent to the operator, but it writes that direction into every check. Roles stored on the thread
  cost the same checks and admit any direction.
- **Plain text or HTML for message text.** Plain text loses the structure agents already write, and
  HTML would make rendering a sanitization problem. Markdown without raw HTML keeps the structure
  with a small, inert rendering surface.
- **`remark-gfm` for Markdown.** It cannot turn off autolink literals, which make bare URLs into
  links, or footnotes, which generate relative links and ids of their own, so Agention parses with
  only the three GFM extensions it needs.
- **Mermaid in the page.** Mermaid's own `sandbox` security level isolates only its output, while
  the library itself, which has had advisories for script and CSS injection and for endless loops,
  would run in the page, where a script can write as the operator, and its SVG needs inline styles
  the page's policy refuses. GitHub and GitLab draw diagrams in isolated frames for the same
  reasons. Putting the frame's SVG into the page's document, rather than showing it as an image,
  would let whatever it holds act there.
- **One longer text that the web UI folds by length.** Only the writer knows which part is the
  summary, and a cut by length can land mid-table or fold the summary away, so the writer separates
  the text from its detail. The detail's bound, 20,000 characters, is what fits beside its text
  within the bridge's result cap when they are one-byte characters that JSON need not escape; the
  bridge leaves out a detail in other scripts that does not fit, naming it, and the web UI shows it
  in full.
- **Kinds instead of independent dimensions.** A fixed set of kinds (question, decision, approval,
  notice) is easy to explain, but every kind fixes a combination of what is asked, how the work is
  affected and how to answer. Real situations keep needing combinations no kind covers, each a
  special case. Independent fields compose without them.
- **Items that open and close.** Each matter as one item whose fields say what it asks and how to
  respond, with a log of messages, field changes, closes and reopens. An item asks one thing at a
  time, and closing it makes the two parties agree when the matter is done. Threads let any message
  ask, and let each party archive on its own.
- **Stale checks only on messages that ask or answer.** Exempting other messages would keep a busy
  agent from repeatedly failing a person's write, but with one person and occasional agent writes
  that is unlikely, and it would bring back racing writes: any message can be overtaken by what it
  missed. The web UI keeps the draft through a stale write instead.
- **Session status only as the session reports it.** Changing the status only through the session's
  own reports keeps every change explicit, but leaves an agent that forgets to report working
  looking idle while it works. Inferring working from the writes the server sees, each inferred
  change marked in the log, keeps the status true and the agent's reports apart.
- **Session status on every call.** Every tool could carry the session's state, keeping it current
  without a call of its own. Only the two writes that send a message take it, optionally, so the
  last message can also report idle; every other tool keeps its input to one purpose.
- **Waiting as a reported state.** A session working on one thing while an ask about another waits
  is both working and waiting, so one reported state would have to choose. Counting waiting from
  open asks keeps the two apart and always true.
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
- **A server on each agent machine that can't reach the server, gathered by a hub.** The hub would
  reach each machine's server inward, as a tunnel does, but the hub and those servers would need
  authentication of their own between them. A tunnel from the one server's machine keeps one server
  and one set of credentials, and TLS still runs from the bridge to the origin.
- **The `undici` package for the bridge's requests.** Its `fetch`, with an agent of its own, can
  open connections where the bridge says, which Node's global `fetch` can't be told to do without
  it. It would nearly double the bridge's bundle and add a dependency for what `node:https` does
  with one agent class.
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
