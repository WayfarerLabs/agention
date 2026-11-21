# Agention v1: Functional Requirements

<!-- cspell:ignore stanard differnent Everytihng satisifes lineaar diffferent hthe -->
<!-- cspell:ignore levl seperate dismissable doind botton -->
<!-- cspell:ignore locatoin sesson hsould Pleae keepging consise agnet probaly Arhive autoinc thikn -->
<!-- cspell:ignore additiona somehing empahsize goint miconstrued Informaiton -->
<!-- cspell:ignore subscibe certianly especiallyas everytihng Fwiw haveto -->

- Status: Approved by the operator 2026-10-25; amended by rulings 23 to 28 on 2026-10-27, rulings 29
  to 31 on 2026-10-28, rulings 32 to 39 on 2026-10-30, rulings 40 to 44 on 2026-10-31, rulings 45 to
  47 on 2026-11-01, ruling 48 on 2026-11-05, rulings 49 to 52 on 2026-11-06, ruling 53 on
  2026-11-08, rulings 54 and 55 on 2026-11-09, rulings 56 and 57 on 2026-11-10, ruling 58 on
  2026-11-11, rulings 59 and 60 on 2026-11-18, ruling 61 on 2026-11-19, and rulings 62 to 71 on
  2026-11-20
- Date: 2026-10-25
- Repository: `WayfarerLabs/agention`, which holds this SDD (ruling 59); paths below are relative to
  its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim or as close transcription.
- Predecessor: the unmerged initial build on branch `build/initial-agention` (head `d66d827`). It is
  reference material only. Parts of it carry forward as described in the HLA; its item model,
  documentation and developer framework do not.

## Why this exists

One person runs many largely autonomous agent sessions. Each session occasionally needs that person:
a question answered, a decision noticed, something done in another system, a result reviewed. Today
those needs are scattered across terminals and chats, and the person has to go looking.

Agention is one self-hosted, phone-friendly place where sessions say what they need and the person
answers. It never grants permissions, injects into a chat, or controls a harness. Agents read the
answers through the same interface they report through.

The predecessor build proved the infrastructure (agent OAuth, human passkeys, isolated storage) but
crossed several independent dimensions of an item into a set of kinds, each with its own lifecycle.
This effort rebuilds the product around those dimensions kept separate.

## Who this is for

- **The operator**: the one human in v1. Reads and answers from a phone or desktop browser.
- **Agents**: the principals that run workloads. In Agentworks, an agent is a user on a VM.
- **Sessions**: workloads belonging to exactly one agent. In Agentworks, a named session such as
  `agention-claude`. Many harness conversations may run in one session over time.

## Terms

Accepted by the operator on 2026-10-25; Priority, Quick and Audience (replacing Responder) on
2026-10-27; Thread, Message, Ask, Answer, Replace, Topic, Archive and Read cursor on 2026-10-30
(rulings 32 to 34); Answer and Topic revised by ruling 37; Effort replaced Quick by ruling 40;
Message, Ask and Archive revised by ruling 41.

| Term        | Meaning                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Thread      | A conversation in which a requester seeks its audience's attention: a title, a topic, messages.          |
| Message     | One append-only record in a thread: text, its detail, references, asks, answers, a topic, a replacement. |
| Ask         | A numbered question on a requester's message, with suggested answers, open until answered.               |
| Answer      | The audience's reply, written on the ask: suggested answers picked, its own words, or a decline.         |
| Replace     | What a message does to one of its author's earlier messages, which is ignored from then on.              |
| Topic       | What a thread is about, set by the requester: one per thread, within its session.                        |
| Impact      | How an open ask affects the requester's work: blocking, assuming or none.                                |
| Priority    | Where the requester thinks the audience should focus: urgent, high, normal or low.                       |
| Effort      | How long answering takes the audience, as the requester estimates it.                                    |
| Read cursor | The latest message an identity has read in a thread or session log.                                      |
| Archive     | An identity's own mark that it is done with a thread's messages through a chosen one.                    |
| Requester   | The party seeking attention in a thread. In v1, always the thread's session.                             |
| Audience    | The party whose attention is sought. In v1, always the operator.                                         |
| Session log | Append-only record of a session's state, goal and progress.                                              |

## Trust model

Agention is an honor system by nature. A rogue agent can fail to report or can report falsely, and
the product cannot detect or prevent that. Requirements therefore separate what is enforced from
what is made easy and visible.

**Enforced**, because the honor system cannot provide it:

- Identity and provenance: who wrote each message.
- Isolation: a session sees and changes only what its credential authorizes. Credentials stored by
  sessions under the same OS user are not protected from each other; separate OS users or VMs are.
- Append-only, attributed history: nothing is erased or rewritten. A false report remains on the
  record, attributed to its author. The check on a rogue agent is accountability, not prevention.
- Roles: only the requester asks and sets the topic, only the audience answers, and a message
  replaces only its own author's messages (R9, R15).
- Inert content: message text, detail and references are never executed or fetched, and formatted
  text renders without raw HTML or remote content (R14).

**Honor system, made easy to follow and visible when broken**: whether and what to report, the
accuracy of impact, priority, progress, session state and external facts, and when to withdraw an
ask. The product steers behavior through defaults, the agent skill and visible signals, not through
enforcement ladders. In many cases agents warrant more authority because they are trusted.

## Functional requirements

### Identity and authorization

**R1. Agents are principals, sessions are workloads, threads belong to sessions.** Every session
belongs to exactly one agent. Every thread belongs to exactly one session. For attribution, cursors
and roles, an agent's actor is the authenticated session (with the credential recorded) and a
person's actor is that person.

**R2. Requests state their target; credentials only authorize.** A request names the session or
thread it acts on. The server checks that the presented credential authorizes that target and never
infers a target from the credential. The actor is always taken from authentication, never from
request content.

**R3. The default grant is one session.** In v1 a credential authorizes exactly one session. Later
grants across sessions (a supervisor agent, sessions of one agent seeing each other) need no API
change.

**R4. External issuers can supply identity later.** v1 identity comes from operator-approved
registration. The design keeps a seam for a configured issuer's verified token, with configurable
claim mapping, to supply agent and session.

**R5. Registration and credential lifecycle.** An agent submits a registration naming an agent and a
session. The operator approves it, choosing whether it attaches to an existing agent and an existing
or new session, or rejects it. Unapproved registrations expire. The operator can revoke a credential
without deleting its session or threads. Approving a new registration for an existing session is how
a lost credential is replaced, and it grants that session's full history, so the approval screen
says so. A session without an active credential and its threads stay visible to the operator, who
can still read, answer, write and archive; the session shows that no credential is active.

**R6. Unknown and unauthorized look the same.** A target the caller may not access produces the same
response as one that does not exist. This applies to every operation, including reading and
archiving.

**R7. People and agents authenticate separately.** People authenticate with passkeys. Agents
authenticate with keys they generate and the operator approves through registration (R5). Neither
credential type works on the other's surface. The operator may hold several passkeys, each a way
into the one operator account from a device of theirs and never a way to give anyone else access:
they add one on the device in hand, having signed it in with a passkey they hold, and name, rename
and remove them. Adding or removing a passkey needs a recent sign-in, the last passkey cannot be
removed, and removing one ends the browser sessions it signed in. A local command remains the
recovery path, replacing them all.

### Threads

**R8. A thread is an append-only log of messages.** Everything that happens in a thread is a message
with an increasing sequence, attributed to its author. A message may carry text and its detail,
references, asks, answers to earlier asks, withdrawals of its author's open asks and a topic, and
may replace one of its author's earlier messages (R15). The thread's current state derives from the
messages that have not been replaced. No message is edited or removed.

**R9. Roles follow the direction of attention.** Each thread has a requester and an audience.
Permissions in a thread attach to those roles, never to whether an identity is a person or an agent
or how it authenticated: the requester asks, withdraws its asks and sets the topic, the audience
answers, and either may write messages, replace its own, read and archive. In v1 the requester is
always the thread's session and the audience is always the operator. Attention sought in other
directions, such as agent to agent or person to agent, needs no change to these rules.

**R10. Asks live on messages.** A requester's message may carry one or more asks, each a question,
zero or more suggested answers, each a short label with an optional description, and whether the
audience may pick more than one. Each ask has a number, counting from 1 within its thread in the
order asks are written, shown on the ask and in every answer to it, which never changes; a
replacement's asks are new asks with new numbers. An ask is open until a message answers it,
declining included, its requester withdraws it, or its own message is replaced. A thread may hold
several open asks. A message without an ask seeks nothing beyond being read; a requester that wants
an answer asks.

**R11. Each ask states its demand on attention.** Impact, priority and effort belong to an ask, and
the requester sets them when it asks. An ask never changes: the requester revises one by replacing
its message, and withdraws one it no longer needs answered, saying why (resolved elsewhere, a
fallback taken, overtaken by events), in a later message. A replacement never drops an open ask
unexplained: it asks again or withdraws each one. A withdrawal is never undone.

- Impact: blocking (the work the ask is for stops until it is answered, while the requester carries
  on with other work), assuming (proceeding on a stated assumption) or none.
- Priority is defined by what delay costs, not by how important the ask feels, and is independent of
  impact. Urgent: something is breaking, costing money or about to miss a real deadline now. High:
  delay costs real work or time. Normal, the default: waiting costs little. Low: whenever
  convenient.
- Effort is optional: quick (a glance or a short check, about two minutes), under 15 minutes, under
  an hour, or longer. An ask without one states nothing about effort.

**R12. Answers.** The audience answers an open ask on the ask itself, with a message that names the
ask by its number; one message may answer several open asks. Where the ask suggests answers, the
audience picks one, or several where the ask allows, and may always answer "other" in its own words,
instead of a pick or, where several are allowed, beside its picks. An ask without suggested answers
is answered in the audience's own words. The audience may instead decline, which is offered apart
from the answers. An answer's own words belong to the answer, apart from the message's text, which
carries any additional information. Only the audience answers. The audience changes an answer by
replacing its message with one that answers the same asks again, and may always write a message that
answers nothing.

**R13. Deadlines are advisory.** An ask may carry an answer-by time and display-only text describing
what the requester intends if there is no answer. The server never acts on a deadline. What a missed
deadline means is entirely the requester's choice: proceed on an assumption, stop and report
stalled, ask someone else, or anything else.

**R14. Content is inert.** Agention displays content and never executes or fetches it.

- Text: a message's text and its detail are Markdown (CommonMark with GitHub's tables, task lists
  and strikethrough), whoever writes them. The text is a summary of at most 1,000 characters; the
  detail, which needs text beside it, carries at length everything else its reader needs, and the
  web UI shows it folded under the text (ruling 53). Every other text field, including the thread
  title, questions, suggested answers, an answer's own words, fallback text, topics and session
  text, is plain text. Raw HTML displays as text, images display as links instead of loading, and
  only HTTPS links are live. Text is stored and returned exactly as written.
- Diagrams: a fenced code block marked `mermaid` displays as the diagram it describes, sized to its
  content and fitted to the screen, and opens in a viewer to zoom and pan. It is drawn in isolation,
  so drawing it can neither run anything in the app nor fetch anything, and it displays as an image.
  A diagram that cannot be drawn shows its source, and the source is always available (ruling 39).
- References: a message may reference external things (pull requests, work items, SDD decision IDs,
  CI runs) with a label plus an identifier, an HTTPS URL, or both. References are displayed, never
  fetched or followed by the server.

**R15. Messages replace earlier messages and answer asks.** A message may replace one earlier
message by the same author, and a replacement may itself be replaced. A replaced message is ignored
from then on in everything derived from the thread, including open asks, answers, the topic and
unread counts, while the history still shows it, marked as replaced, with a link to its replacement.
An answer names the ask it answers by its number. A message may also reference another thread in the
same session, displayed as a link; threads have no other relationships.

**R16. Threads carry a topic.** A thread may carry one topic (for example `auth`) so related threads
in its session can be found together. The topic is shown with the thread's agent and session, not as
a label, and following it lists the session's threads on that topic. Only the requester sets or
changes it, in a message, and the latest such message stands; the audience may suggest a change in a
message. The operator's views filter a session's threads by topic; topics do not span sessions.

**R17. Each party archives for itself.** An identity archives a thread to clear it from its list, as
in email: archiving marks the thread's messages through a chosen one, all of them by default, as
archived for that identity alone. A thread is archived when all of its messages are. A later message
from another party arrives unarchived and returns the thread to the list. A message whose ask is
open to that identity cannot be archived, nor can any later one, and declining is always available.
Archiving works on one thread or several at once, writes no message, is not shown to the other party
and never conflicts with a write. Threads are never closed or deleted.

**R18. Sessions can find their threads.** A session can list its threads, paged, filtered by status,
unread messages, archive, title search and topic, so a new harness conversation in the same session
can pick up where the last one left off.

### Awareness and concurrency

**R19. Every identity has a read cursor.** For each thread it can see, each identity has read
through some message, and unread means messages beyond it. An identity marks a thread read through a
message, and the operator can mark many threads read at once. Marking a thread unread moves the
identity's own cursor back, never forward. Reading never changes the thread, never conflicts with a
write and never answers an ask. Each party sees the other's cursor on what it can see.

**R20. Thread writes cannot race.** Every message states the latest message its writer has seen. If
another message landed first, the write fails as stale and returns the missed messages. A successful
write advances the writer's cursor to its new message. Every write carries a client request
identifier: a retry with the same identifier and the same content returns the original result, and
the same identifier with different content is rejected.

**R21. Derived signals are computed, never stored.** An ask is open to the viewer when the viewer is
its thread's audience and it is open. A thread rolls up the messages that have not been replaced:
its unread count, and from its open asks the highest priority, the earliest answer-by and whether
any is blocking. Its status rolls up its live asks and those withdrawn: open while any is open;
otherwise withdrawn when every one was withdrawn, and answered when the audience answered or
declined any; and none when it holds none. At minimum:

- blocked on you: an ask open to you with impact blocking;
- overdue: an open ask past its answer-by;
- quiet: the session has not been seen within a configurable threshold;
- stranded: threads with messages the session has not read while the session is stopped, quiet or
  without an active credential.

### Sessions

**R22. Sessions have state and progress.** A session reports what it is doing: working, idle
(nothing to do until something arrives, while it still checks for messages) or stopped with an
outcome of completed, withdrawn or stalled. Stopped means the session is not likely to see new
messages until something starts it again (ruling 65). Whatever it is doing, a session is waiting on
the operator while it has open asks, which the operator's views count from the asks themselves
rather than from anything the session reports (ruling 68). A stopped session may resume. A session
may carry a title, an explicitly set goal and a rough percent estimate. A new goal replaces the
previous goal and its progress. Goals are never inferred.

**R23. Sessions report through one status call.** A session reports its state, outcome, title, goal,
percent and a note through one call made for it, and no other call carries them (ruling 65). A field
left out is unchanged. Changes are appended to a session log shown in the operator's views with a
read cursor. Session updates are exempt from the stale rule because only the session writes its own
state; the latest update wins.

**R24. Presence is observed.** Every authenticated agent call records when its session was last
seen.

### Operator experience

**R25. One thread list with filters and sorts.** The operator's views are one list of threads, which
shows every thread the operator has not archived. Every way of narrowing it is a filter, each one
dimension with concise labels and values: search; status, and of one open ask its priority at least
a chosen level, its impact, whether it is overdue, and its effort at most a chosen level; unread,
and unread by the agent or stranded; agents, sessions, topic, group and tag; and including archived
threads. Different filters always combine with AND; several values chosen within one filter, such as
two agents, combine with OR. Each value shows how many threads it keeps given every other filter,
which for a filter taking one value is what the list would hold if it were chosen; resetting the
filters shows how many the list holds with none. Search matches thread titles and the text and
detail of messages. The operator chooses what the list is ordered by and, apart from it, which way
it runs. It is ordered by priority unless the operator chooses otherwise: threads with asks open to
the operator first, ordered by priority with blocked-on-you first within each priority, then by
earliest answer-by, and every other thread by latest message. It can also be ordered by soonest
answer-by, by least effort, by latest message, or by when each thread was created, which within a
session is thread-number order. Any order can be reversed, which reverses the threads it ranks;
every thread it does not rank, such as one without an open ask, still follows them as before (ruling
54). Session state changes stay in the view of the sessions rather than the thread list, which links
to the threads of each session and agent (ruling 74); in that view, consecutive progress-only
session updates collapse.

**R26. Operator operations.** As a thread's audience, the operator answers asks, writes and replaces
messages, marks threads read, marks a thread unread from a chosen message on, and archives a thread
whole or through a chosen message. Opening a thread reads what it shows, as opening an email does.
Standard icons show what is read, unread and archived, on each message and in aggregate on threads
and groups: unread when any message within is, archived when all are. The thread page shows which
messages the operator had not read and which of the operator's messages the agent has not read.
Actions on a thread as a whole are presented apart from answering, which happens on the message that
asked; uncommon actions on a message sit in its options menu. The operator also manages their
passkeys (R7) and session groups and tags, and approves, rejects and revokes registrations, which
appear within one view of the sessions: each agent's sessions, each with its status and whether it
holds a working credential, and registrations waiting for approval beside them (ruling 56). The
operator starts a thread on a session with a title and a first message (ruling 64), and the session
stays its requester; the operator makes no asks in v1 (rulings 11 and 65), so they are never a
requester, and R9 keeps every requester-only action out of their hands.

**R27. The UI stays current.** Views refresh without manual action while visible, and an expired
browser sign-in leads back to sign-in rather than a dead error.

**R28. The operator groups and tags sessions.** The operator can create, rename and remove private
session groups (for example "work project X", "personal project A"), one level deep, each session in
at most one group, and can assign tags to agents and sessions, which cut across groups. Groups and
tags organize the operator's views only: agents never see them and they grant nothing. The operator
can view the list flat, by group (group, session, topic, thread), by session (session, topic,
thread) or by agent (agent, session, thread), and the view of the sessions by group (ruling 75),
collapse any parent, and see on every parent its roll-up of what it holds, aggregated generally as a
maximum: unread threads, whether any is blocked on the operator, the highest open priority, and
archived when all are. Grouping, sorting and filtering are separate controls.

**R29. Stale writes keep the draft.** When a write from the web UI fails as stale, the UI shows the
missed messages and keeps the draft so one action marks them read and resubmits.

### Operation

**R30. Listen address, TLS mode, public origin and name are independent settings.** Agention either
terminates TLS with a provided certificate or serves plain HTTP behind a TLS-terminating proxy. The
public origin is always HTTPS. Plain HTTP on a non-loopback address (anything other than
`127.0.0.0/8` or `::1`) is refused unless explicitly enabled. Proxy mode trusts no forwarded or
identity headers. Each server has a name, Agention unless the operator sets another on its first
start, after which it never changes; its web UI shows the name as its title and its passkeys carry
it, so that an operator running several servers can tell them apart (rulings 54 and 55). Several
servers can run on one host under different ports, sharing nothing: signing in to one never signs
the operator out of another (ruling 55).

**R31. Transport is path-agnostic.** Any TCP path that delivers bytes to the one origin works. A
bridge can open its connections at another address, such as a tunnel's, while TLS and its tokens
still name the origin (ruling 69). No authentication decision or rate limit is keyed on source
address or network identity. Each class of unauthenticated endpoint has its own budget, so
exhausting registration cannot block passkey sign-in.

**R32. Tailscale is the documented path, not a dependency.** Documentation shows running Agention on
loopback behind `tailscale serve`. Nothing requires Tailscale.

**R33. Bounded inputs and typed errors.** Every text field, list and page has a documented bound.
Errors are typed (at least invalid input, not found, stale, request-id conflict, rate limited,
unauthenticated) and consistent across the MCP and web surfaces. The bridge words the problems it
finds itself for the agent: what the agent does, or, for what only the operator can fix, to tell
them (ruling 62). A bridge and the server each state the agent API version they speak; a bridge
refuses a server older than itself, and the server a bridge outside the versions it supports, each
saying what the operator upgrades (ruling 67).

**R34. Consistent backup.** The operator can take a consistent backup of a running instance and
restore it, following documented steps. History is retained indefinitely.

### Product guidance and distribution

**R35. One concise agent skill.** A single canonical usage skill, distributed as Claude Code and
Codex plugins generated from one canonical plugin definition and installable from the repository,
leads with asking through Agention and never waiting at the terminal for an answer, then following
the bridge, the normal loop and a concrete example, states a small set of hard rules, and relies on
tool schemas for payload shapes. The agent bridge tells every agent host the same when it connects,
before the skill loads (ruling 60), and its answers say how answers reach the agent, which the skill
follows (ruling 61). Agention adds no waiting to an agent's work: the skill has it ask and carry on,
check for answers as it works and check for itself what it can see. Once its other work is done, the
agent keeps running while it has open asks or unread messages, checking in the way that costs least,
such as through a waiter of its own, and stops when none remain or the operator tells it to (ruling
61). A message without an ask is as normal as one with asks. The skill has every message stand on
its own: its text says what the matter is and what is needed, and its detail carries everything else
the operator needs to decide on it or understand it without looking elsewhere (ruling 53).

**R36. Agentworks is optional.** Setup may default agent and session names from `AGENTWORKS_AGENT`
and `AGENTWORKS_SESSION` when present. Nothing else depends on Agentworks.

### Engineering

**R37. Self-hosted and open source.** TypeScript throughout: the server and the agent bridge on
Node, and the React web UI. One SQLite database, MIT license, no paid services.

**R38. Reproducible and consistent with sibling projects.** Exact dependency and action pins with
integrity checks, one versioned release stream with a changelog, automated dependency update
proposals, and repository conventions aligned with agentworks and nerftools where the stack allows.

**R39. Public-ready from v1.** Agention is expected to become public. A contributor can understand
its code, major decisions, expectations and contribution process from the repository alone: README,
CONTRIBUTING, SECURITY, architecture documentation, and ADRs under `docs/adrs/` (the agentworks
convention). Material decisions from this SDD are promoted to ADRs or permanent docs before it
locks. The repository carries no Rulesync sources or generated agent guidance: Wayfarer's shared
process is installed into agent workspaces from outside it, and reads the repository's development
contract, `docs/development-context.md`; its SDDs live in `docs/sdd/` (ruling 59).

## Operator rulings, 2026-10-25 onward

Recorded from the design conversation.

1. Rebuild on a fresh branch rather than modifying the predecessor PR.
2. Hosting is the operator's personal Tailnet. Tailscale is not the authentication solution:
   Agention keeps its own authentication and authorization. "Run behind a proxy that terminates TLS"
   and "address to listen on" are orthogonal settings. Tailscale is not tightly coupled; make its
   path easy and documented. An embedded Tailscale startup mode is open for later discussion.
3. Item dimensions, from the operator's list: whether the item still needs attention; the agent's
   authority over that; impact on the work; who has the next action; where that action takes place;
   whether the session is still running; progress toward the current goal; relationships to other
   items; relationships to external things. These are almost entirely orthogonal, and combining them
   is what broke the predecessor. A made decision no longer impacts work but needs attention to
   convey what was decided; a merged PR needs no further attention.
4. Trust model: the tool is on the honor system. Build it so the right thing is easy and the wrong
   thing is hard; do not build enforcement beyond what the trust model supports, and agents may
   warrant more authority because they are trusted.
5. A derived "next action" is rejected: agents learn things that merit updates when it is not their
   turn, it does not scale to richer identity models, and it blurs "I need you to do something",
   "make sure you see this" and "I think we're done but this is yours to dismiss". Beyond flagging
   blocked-on-you, next action is not important.
6. Adopt the Agentworks session model: the agent is the user, the session is the workload and
   belongs strictly to one agent, and items belong to sessions. Do not assume Agentworks; agents
   identify their sessions, optionally defaulting from the Agentworks environment variable.
7. A future Agentworks IdP may issue session-scoped identity tokens. Support other issuers and less
   direct mappings too.
8. Pair the model with read cursors and acknowledgement for every identity so unexpected updates
   surface, and updates must not race: one lands, the other fails until its author reads and
   acknowledges.
9. Close outcome: complete or withdrawn, plus detail.
10. Session progress may ride the envelope of normal traffic; either that or a dedicated update is
    acceptable.
11. Reply and reopen after close: agreed. Human-originated items: not in v1.
12. Labels for item types will be wanted but are deferred.
13. The session is fixed at registration, or automatically from an IdP token, and the token only
    authorizes reporting on that session.
14. Presence: agreed.
15. Deadlines are softer than server behavior: the agent may use them however it wants, and the
    consequence of missing one is flexible.
16. Tokens are only for authorization and never for assuming anything. Even when the token
    determines the session, the agent states it and the token validates it. This allows a future
    where some actors are authorized across sessions.
17. Grouping items by subject ("these are all the items related to auth") is valuable. Grouping
    sessions in the UI (work project X, personal project A, other work) is important; agents do not
    see those groups.
18. Accepted: the human may decline an act request; the human may edit topics; session updates are
    exempt from the stale rule; each session belongs to at most one human group. The proposed terms
    are accepted.
19. Developer guidance: Rulesync generation is valued, and developer-facing artifacts stay distinct
    from the user-facing usage skill. Curate one shared common set of Wayfarer developer artifacts
    (rules, skills, subagents, and MCP configurations such as Agention) used by all Wayfarer
    repositories, each adding only its unique considerations.
20. Nx is optional: any approach that accommodates backend, frontend and plugin generation is fine.
    Keep generated plugins; a hand-maintained single directory duplicates metadata and prevents more
    exotic configurations such as hooks. Nerftools is a good example.
21. Restrictions may follow the direction of attention (an agent asking for it, the operator giving
    it). Done properly, this extends to attention requests to other agents.
22. The shared developer artifact repository is `wf-agentic-dev`; the operator creates it on GitHub.
    Product MCP configurations such as Agention's are per developer and stay out of it.
23. (2026-10-27) "Priority is the agent's chance to tell me where to focus. Do you really think they
    wouldn't use this honestly?" The operator then accepted the proposal as "exactly right": an
    agent-set priority (urgent, high, normal, low; normal by default), separate from impact, each
    level defined by what delay costs, with the needs-you view ordered by priority and then
    blocked-on-you. "Adding the effort hint is good, too. Let's do both": a quick flag, off by
    default, so quick items can be cleared in a batch.
24. (2026-10-27) "So again, to make this design robust against a more complicated future, the roles
    shouldn't be human v agent. Rather they should be the entity asking for attention and the
    audience. Restricting when each can do based on that makes sense. Baking in human v agent
    assumptions is likely to become problematic." The operator then named the second role the
    audience, replacing "responder" from the terms accepted in ruling 18.
25. (2026-10-27) "And then I'm thinking it would be good to provide markdown formatting for the main
    text. Does that make sense?" The operator accepted the proposal as given: the item body,
    messages, responses and close detail are CommonMark with GitHub's tables, task lists and
    strikethrough, for every party; titles, option labels, fallback text and reference labels stay
    plain; raw HTML shows as text; remote images are not loaded and show as links; links are live
    only for HTTPS; text is stored and returned to agents exactly as written.
26. (2026-10-27) On agent setup, the operator allowed a local tool: "In this case, I'd love for it
    to be a one liner in the mcp registration (like uvx/npx/...) vs having to download and install
    something first." Then: "So if we do our own typescript client, we should be able to wrap a
    standard mcp client and keep it super clean with something like a "register" tool call that the
    agent invokes on its schedule, yeah? Honestly, assuming so, I think that's the jam. And then
    we'd just have a stanard http api between the typescript mcp client and the server, right?" The
    operator approved the proposal as given. Agents run a small TypeScript stdio MCP server, the
    agent bridge, from a pinned one-line `npx` registration that the plugin declares. The agent
    calls a register tool when it chooses, and until the operator approves, the bridge answers with
    the code to relay. The bridge talks to the server over a plain HTTP API, the one the web UI also
    uses, and the server no longer serves MCP itself.
27. (2026-10-27) "Yeah, good point on Oauth not being needed anymore." The operator approved agent
    authentication by operator-approved keys instead of OAuth: the bridge generates a key pair for
    each session, registration submits the public key, the operator approves by matching a code
    derived from that key, and each request carries a short-lived token signed by it. A configured
    issuer's token (R4) is later verified the same way.
28. (2026-10-27) "And I'm personally not married to golang. If it means writing our own oauth
    implementation, I think we should consider other backend options." Then: "Let's go with
    Typescript for the BE, too. All these changes are approved. Make it happen!" The server, the
    agent bridge and the web UI are TypeScript, the first two on Node.
29. (2026-10-28, after the Delivery 2 live run) "It feels like we're missing the ability to just
    browse items. I totally agree with starting with Needs you but there should be a view of all
    items with filters including the ability to view closed items." Then: "And I'm fine with
    differing the browse until phase 3. As long as it gets done." The operator's views gain a view
    of all items, filterable and including closed items, in Delivery 3.
30. (2026-10-28) "And then we for sure need tags that can be assigned to agents and sessions and
    then used to filter activity. It might be nice to have "smart tags" that match patterns in the
    names but that can come after manual tags." Then: "So I think we want to keep topics as a
    different thing. That should group items within a session. I don't think it spans sessions. And
    then I'm thinking we have both groups and tags for sessions. Groups are strictly hierarchical,
    tags are cross-cutting. But I'm open to your thoughts on that." The operator answered "Awesome!"
    to the proposal that followed: topics stay on items within one session; each session sits in at
    most one group; the operator assigns tags to agents and sessions, an agent's tags applying to
    its sessions; and groups and tags filter the operator's views, including the view of all items
    (ruling 29). Asked whether groups nest and whether smart tags come in v1: "Just one level of
    group at first" and "Smart tags come later".
31. (2026-10-28, after the Delivery 2 live run) On the item page: "What is "add as a note" vs the
    normal actions? My thinking is that we just allow for additional optional text for any action.
    And then maybe a "message only" action that doesn't make a choice where there is one. I think
    this is basically the current setup. We just need to clean it up." And: "Back seems to work for
    closing the item view. But there needs to be a more obvious CTA for that." Then: "Yes, opening
    an item should mark it as read. I think the email metaphor really works here and we should lean
    into it. I would like to see a "mark unread" action like email." Asked whether to keep the
    request "none": "Keep none." "To me "add note" is confusing as it sounds like a potentially
    different action. I'd prefer something like "message only" that conveys both a) messages go with
    all actions, and b) the message only is strictly less than an action plus a message." "Close is
    an exceptional action. It should be presented as such. It's also an item-level action vs a
    response-level action. We need to present those differently."

32. (2026-10-30, after re-checking the item page) "So I was able to do everything except 8 (close
    and reopen). After going through all the items, there was no way for me to see the closed ones."
    "I feel like there's a simplification here around the differnent types of items and giving the
    user choices. Maybe this is all just one item type with suggested responses (yes/no,
    confirm/object, a multi-select, ...) and optional additional text? And then I still feel like we
    can do a better job of visually representing the item-level stuff vs the response-level stuff."
    "Fwiw, I do feel like the harnesses have all landed on a pretty good response model." "Also, I
    feel like there's an elegant solution where we just have a view of items and "needs you" and
    "updates" are really just canned filters across standard item dimensions." To the proposal that
    followed, asks shaped like the harnesses' question tools and one list with filters: "Yeah, this
    sounds much better." And: "I don't think we should complicate thing with a "got it" type
    response to updates. If the agent wants a response, they should ask. And the user can always
    send a new message regardless." Then: "What I described are not item types I don't think. Per my
    earlier ask, we need to cleanly differentiate between the item and the
    messages/responses/traffic within it. In this model, the item is kind of a thread. Maybe that's
    the model. Items (or threads?) operate much link threads in an email inbox. They're a grouping
    for the actual messages. Everytihng happens at that lower level (including read/unread tracking)
    with roll-ups to the thread level." "And maybe, just like email, this notion of "closing" and
    item goes away, replaced with read/unread and something like archived/dismissed (at the thread
    level). But that's just a local thing (not sync'd to the item) that is reset the moment new
    messages arrive on that thread (like email)." The operator answered "Yeah, this sounds right to
    me" to the proposal that followed: threads of messages; asks on messages, several open at once,
    each with its own priority, quick, impact and deadline; closing replaced by each party's own
    archive; and one thread list with filters, built in Delivery 2. With refinements: "Agreed on
    topic/thread/message"; "Let's really lean into our terminology (specifically threads and asks).
    So instead of "needs you", "open asks""; "Let's just move the archive action to the messages,
    exactly like email"; "Agreed that you can't archive an unanswered response (but asks can always
    be declined which satisifes this)".
33. (2026-10-30) On topics: "while this starts to work like a topic, I still think it's worth having
    agent-assigned topics." Then: "Topics as labels is a great metaphor. We might even consider
    allowing multiple although I feel like that could get abused." And: "I feel like the topic
    really belongs to the agent (requester). The user (responder) can always suggest to change it."

34. (2026-10-30) On the readings of ruling 32 (archived state kept per message as in Gmail; one
    topic per thread): "Agreed with your readings." Then: "Are we sticking to the idea of forcing
    lineaar messages per thread such that a new message will get rejected if it's not based on the
    latest message in the thread? This is a departure from email but I think it makes sense." "And
    then it seems like while asks are raised in a message, they kind of have their own lifecycle
    (with withdrawals, responses, and probably updates), right? That seems like a bit of a smell
    here, yeah?" After the proposal that asks never change: "Maybe we have a generic way for a
    message to replace an earlier one? Once a message has been replaced, it's just ignored. That's
    cleaner for withdrawal and update, right?" "And then I guess we don't have any choice but to use
    a later response to mark an ask as answered. But that operates as a diffferent level (ask vs
    message). Maybe we drop the notion of message replacement and just offer these ask-modifying
    parts of messages?" "And let's settle on answer/answered instead of response/responded. It
    better matches "ask"." The operator answered "Yep, this is awesome. Let's do it!" to the
    proposal that followed: strict ordering stays; an ask never changes; a message may replace one
    of its author's earlier messages, which is then ignored everywhere; an answer names the message
    whose ask it answers, so both relations are between messages; and withdrawing or revising an
    ask, changing an answer and correcting a message are all replacements.

35. (2026-10-30) "And can you allow for multiple operator passkeys and the ability to manage them?"

36. (2026-10-30) "Yeah, and I feel like we need to be really careful wit hthe identity model here.
    This app is entirely single user for now. Multiple passkeys are not a way of sharing access to
    other users, rather different ways to access _the_ account."

37. (2026-10-30, after re-checking the thread page) "Looking really good! A few things:" "1. Is "My
    own answer" special, or it just another choice? I do think we should offer a standard "other"
    response. My thinking is that the phrasing should be "Other (see message)" to guide the user and
    reader to the message field." "2. It may just be a later phase thing but presenting Inbox at the
    same visual levl as Open asks, Unread, and Archived, is confusing. Those are filters into the
    Inbox (if such a thing even exists)." "3. Showing "My own answer" and Decline on a freeform
    question is just awkward. This should be a type of ask and should result either a) telling the
    user to answer via the message, or b) some text entry mechanism in the ask itself (separate from
    message). I think I kind of like (b) but I think that would suggest that all "My own choice"
    entry should be in the ask seperate from the message. Lmk what you think." "4. I do wonder if
    presenting Decline as yet another option isn't a bit strange. Perhaps it should be visually
    different (like a smaller Decline link)?" "5. Similar to #2, "Back to Inbox" is just a little
    strange. I think a more standard back/close CTA would be more appropriate." "6. I love the
    multi-select but we for sure need to present them differently visually. Please study best
    practices on that. And this makes presenting Decline as a normal option even more problematic."
    "7. We seem to be calling both the container as well as the text box "message". My vote is that
    the text box becomes "Additional information" or something like that." "8. "Send message" should
    probably just be "Send" and it should be inactive when there's nothing to send (no answer and no
    additional info)" "9. And perhaps we have a (dismissable for all) confirmation if you send
    something without an answer? Dunno. I wouldn't make this change now but maybe record it as an
    open design item." "10. If our topic model is truly just 1, then presenting them as chips/labels
    is going to be confusing I think. Again, we can defer this, but keep it in mind. And the topic
    itself should be a CTA to go view everything in that topic (probably with additional filters
    just like jumping into the threads)." The operator answered "Yeah, this all sounds exactly
    right. Make it happen!" to the proposal that followed, built in Delivery 2: the answer is
    written on the ask, so an ask with suggested answers always ends with an "Other" choice that
    opens a text field there, and an ask without them shows only a text field; agents receive that
    text as part of the answer, apart from any additional information. One answer shows as radio
    buttons with "Choose one", several as checkboxes with "Choose any that apply", and declining is
    a smaller "Decline to answer" link below the choices. The message box is labelled "Additional
    information", and one Send stays disabled until there is an answer or some text. Where the list
    looks (Inbox, Archived, All) is a switch apart from the filters (Open asks, Unread, Quick),
    which are combinable toggles with counts. The thread page has a standard back control that
    returns to the list as it was left. The topic shows in an agent › session › topic path under the
    title, each part opening the list narrowed to it. Item 9 stays an open question.
38. (2026-10-30, after re-checking Delivery 2 on a phone) "Getting really close. Just a couple
    things:" "1. Maybe phase 2, but we need a folding model for the whole hierarchy: Session Group
    -> Session -> Topic -> Thread. And maybe we also offer Agent -> Session -> Thread with a "By
    session"/"By agent" toggle. It should be possible to collapse at any parent level and there
    should be rollup status (unread, any blocked, max priority) when a level is collapsed. Ofc the
    challenge is doind this efficiently on mobile. Again, please research best practices/prior art."
    "2. I'm not sure Inbox as a thing really earns it's keep. Do we really need that term/metaphor?
    I get that we have to do something for archival and viewing archived messages but in terms of
    visual priority, that is way, way below viewing active threads. And then "All" is completely
    useless. It's also really weird to keep the quick filters on Archived and All. My feeling is
    that we should have the absolute bare minimum to view and search through archived messages
    (perhaps an "include archived" option on the main view?)." "3. I also think we can get crisper
    and more intuitive on the filtering. In my mind, we should have a full set of filters (possibly
    including "include archived") that includes unread status, open ask, priority, agent, agent
    unread status, ..." and then the "Open asks", "Unread", ... are just shortcuts to configure
    those filters. And if we want to put the filters in a popover type thing, that's fine, but I
    think the intuitive model starts with filters and then layers in the shortcuts, not the other
    way around." "4. Small thing, the the back arrow is very faint/weak. Let's do something
    stronger." "5. The other choice is correctly labeled "Other" but when you do it, the recorded
    message say "Answered #N in your own words:...". That should just say that Other was selected
    and then show the other text." "6. Let's do a persistent checkbox next to send that says
    something like go back after sending. I think most people will want that but it should be a
    choice." The proposal that followed: one list of the threads the operator has not archived, with
    no Inbox, Archived or All; every narrowing a filter that combines (search, open asks, blocking,
    overdue, quick, priority at least a level, unread, unread by the agent, agent, session, topic,
    and including archived threads), behind a Filters button and its sheet, with Open asks, Unread
    and Quick as shortcuts that set the same filters and show their counts; `inbox_wait` renamed;
    the thread page's path opening everything in that part with no other filter; and, in Delivery 3
    with session groups, the list viewed flat, by session or by agent, each parent collapsible with
    its roll-up (unread, blocked on the operator, highest priority). Items 4 to 6 were built as
    asked. The operator answered: "1. Yep, approved. Nice job!" "2. Yeah, let's add search.
    Title-only is fine for now but I would plan on the same thing expanding to full text." "3.
    Agreed" "4. Yep, fold it in" "5. Honestly, I think "attention inbox" is still a decent way to
    describe the tool. I'd only drop it if we have something better." The numbers answer the
    proposal's questions: the filters approved, title search added, the path clearing other filters,
    folding in Delivery 3 with the flat list kept, and "attention inbox" kept as the tool's
    description.
39. (2026-10-30) "Oh, and we should be sure to support mermaid rendering. Ideally we render at the
    right size for the content and then fit it to the screen for mobile, with the ability to click
    into it with good zoom/pan controls to explore it in detail."
40. (2026-10-31, after re-checking Delivery 2 on a phone) "Ok. Definitely way better. Nice work!"
    "1. Let's use the standard funnel icon for filter. I could be wrong but I feel like the top
    right is kind of the standard locatoin, too. The filter shortcuts should be right justified to
    hte left of that." "2. I'm not seeing the group by agent, group by sesson choice. And I think
    you said you were doing to provide an option not to group, which I agree with. Is it in here?"
    "3. The filter model is way better but we're still mixing/complicating a couple dimensions: Read
    status (all read/some unread) is different from agent read status (also all read vs some
    unread). I don't think you need to be some/all on there, though. I think that's the standard
    email convention." "3 cont. And is "Needs you" truly a single dimension? And if so, is "Quick"
    truly part of that? Let's clean that up. And I think quick hsould just be part of an "Estimated
    effort" dimension that maybe also includes <15m, <1h, >1h? I'm open to your thoughts there." The
    proposal that followed: a funnel at the top right with the shortcuts to its left; grouping not
    built, offered for this round; the operator's read status and the agent's as separate
    dimensions; "Needs you" as one open ask with four properties (priority, impact, deadline and
    effort), each its own dimension, Impact gaining Assuming; and effort replacing quick: quick
    (about two minutes), under 15 minutes, under an hour, or longer, optional, filtered as at most a
    level. The operator answered: "1. Tbh, I'm tempted to put the filter shortcuts in the filter
    popup. But they are important. That said, we could use a sensible default and then put them
    there where they belong. Also, we haven't mentioned sorting, which provides additional control
    here. Maybe the default filter is really just all non-archived and the sort controls are what
    people will really want/use?" "2. Pleae wait one more round on grouping. But this metaphor of
    grouping + sorting + filtering is good I think. Let's make sure we don't lose that. And when we
    do get to grouping, aggregated status (generally "max") for hte groups is going to be critical
    to keepging it intuitive, consistent, and useful." "3. The new dimensions look great! Just
    please try to keep them consise (both labels and values). for example, the current user's read
    status should probably just be "Read status" (or even just "Read"). It's the agnet's one that's
    unusual and merits more characters." "Oh. And the "Mark unread" action should be on a message
    (mark unread from here). I'm not sure what mark unread on a thread means other than to mark it
    all unread. That's consistent but maybe a bit much." "And along those lines, we should show the
    users read status by message somehow." "And we probaly want to offer a way to archive a message,
    much like mark unread from here." "And for uncommon actions on a thing (like message archive and
    mark unread), let's lean into the standard options menu metaphor (3 dots, expands to options)."
    Built from that: no shortcuts, every filter in the sheet one row per dimension with concise
    labels, the default list everything not archived; a Sort control (priority by default, newest,
    due, effort) beside an icon-only funnel at the top right; mark unread from a message in each
    message's options menu, with Edit and Change answer moved there and no thread-level mark unread;
    each message showing whether the operator had read it and each of the operator's whether the
    agent has. Grouping comes in the next round. What archiving a message does was asked back and is
    open.
41. (2026-10-31, after re-checking Delivery 2 on a phone) "Ok. This continues to get better and
    better. Love it!" "1. I truly love the filter popup. The only thing I'd look to do is have the
    unselected options show a count (in parens) indicating the resulting total if you selected that
    option given the other currently-selected options. And I think Reset should move to this view
    and should carry a similar hint count." "2. Agent should be its own selector in the filter list.
    The session selector should just be sessions. Both should be popup multi-selects with a search
    box. The same preview counts should apply here." "3. To be clear, different filters are always
    ANDed. Multiple selections within a single filter are ORed to come up with that filter, then
    ANDed with everything else." "4. Let's make the current filter chips slightly smaller. And
    perhaps decrease the radius for a tighter fight around the text? That part of the UI get's
    really big if you have a lot of selections." "5. And for the agent and session multi-select, if
    only one is selected, show that in the chip (Agent: \<agent_name>). Otherwise "\<N> Agents".
    Same with sessions." "6. Let's always make the chip fit the text up to a pretty generous limit
    (20 total chars, including Agent:/Session: prefix). After that truncate with '...'" "7. The
    Archive action at the thread level should be "Arhive all". And did you decline a message-level
    archive? I'm open to that argument. Lmk what you're thinking. If we do have a message-level
    archive, it should be in the options menu (next to Mark unread from here) and should be greyed
    out if the message has an unanswered ask." "8. We need a stronger visual indication of read vs
    unread as well as archived. Please use standard icons for those, both at the message level but
    also in aggregate. Unread aggregates via ANY. Archived aggregates via ALL." "9. We should show
    the ask number in the ask itself as part of the card. This will help tie things together when
    there are multiple asks and answers." "10. Please double check that ask numbers are truly
    immutable, too. Replacing the message should just create new autoinc asks I think." "11. I
    understand why we only allow one answer per message but is that really necessary? It seems we
    could allow multiple asks and multiple answers in a single message, yeah? If there's a clear
    path to that, please do it. If you see problems, though, it's fine." Asked what archiving a
    message should mean (archiving through it, archiving only it, or no message-level archive), the
    operator chose "Archive through here": a message's options archive it and every earlier message,
    which fold away on the thread page, unavailable while an unanswered ask sits in it or before it,
    and Archive all archives through the latest message. Asked whether grouping joins this round or
    the next, the operator chose this round. On item 10: an ask's number had been its message's
    sequence, which never changes, since messages are append-only and a replacement is a new
    message. Designed from that: several asks and several answers in one message, each ask numbered
    from 1 within its thread and shown on its card; Agent and Session as multi-select popups with
    search; a count on every value not chosen, and Reset in the sheet with its own; compact chips,
    truncated past 20 characters; Archive all in the head and Archive through here in each message's
    options; envelope and archive icons on messages, threads and groups; and the list viewed flat,
    by session or by agent through a Group control beside Sort and Filters.
42. (2026-10-31) "1. Oh interesting. For those multi-selects, it seems that we'd want to have the
    count show the additiona for that choice (e.g. if that was the only choice). That should be
    easier as you just draw the counts when building the list (as if nothing is selected) and then
    you don't have to change/redraw them as boxes are checked. But if you disagree or feel that's
    too inconsistent, I'm ok with that." "2. Reset should indeed be "Reset filters". Perhaps we need
    to make that explicit." "Beyond that, everything sounds great!" Taken as asked: each option of a
    multi-select counts the threads it keeps on its own, given every other filter, and keeps its
    count as boxes are checked; for a filter taking one value that is the same number as the list it
    would show, so one rule serves every count. The sheet's button reads Reset filters.
43. (2026-10-31) Asked whether read items also carry an icon, an open envelope beside the closed
    envelope on unread ones, or only unread items do, the operator chose both states: the closed
    envelope on unread and the open envelope on read, on messages, threads and groups alike.
44. (2026-10-31, answering the questions the design review raised) Asked whether the requirement
    wording written beyond the verbatim rulings stands (R7's passkey management; R6, R8, R12, R17
    and R19 as tightened after review; R14's isolation of diagrams; the transcriptions of rulings 41
    to 43; and two consequences of this round: an archived message is never unread, and a changed
    answer drops its answers to asks since revised), the operator chose "Approve as written". Asked
    whether to cut adding a passkey through a link, so that a new device signs in through the
    browser's cross-device sign-in and adds its own, and a device that can do neither is added by
    `agention passkey-link`, which replaces every passkey, the operator chose "Cut it". Asked
    whether each group in the grouped list sits by its most pressing thread under the sort or by
    name, the operator answered: "Yeah, groups follow the sort based on their aggregated status".
45. (2026-11-01, after re-checking Delivery 2 on a phone) Asked whether the thread list keeps keyset
    paging or moves to offsets, as a complexity review of the code proposed, the operator answered:
    "1. Yeah, let's keep keyset paging". Then: "And then the app looks great! I only have a couple
    things:" "4. The word "Threads" is duplicated right next to each other between the top nav and
    the title within the threads tab. Furthermore, that title is super tight with the grouping,
    sort, and filter. I think we can get rid of the title, yeah? We probably do want to make the
    selected tab in the top nav more prevalent (or maybe all the tabs)." "5. I like the idea of the
    agent/session/topic breadcrumb but I think it's a bit weak visually for something that is
    actually pretty important. Also, it's not clear which is which. The problem is that the full
    "Agent:"/"Session:"/"Topic:" labels would make it quite crowded. I wonder if we don't introduce
    "A:"/"S:"/"T:" shorthand for those and really lean into that. Please give me your thoughts
    before implementing." "6. Also, given that topic is scoped to the session, I wonder if we should
    show it as "\<session>/\<topic>" wherever it's not fully obvious what session we're in (like the
    breadcrumb). That would replace the current behavior of adding both hte session and topic to the
    filter if the topic breadcrumb is selected. Again, thoughts?" "7. If we don't have them already,
    we should have rules for topics that prevent '/' and other patterns that wouldn't work." Taken:
    the list keeps its keyset cursors; a page with a tab in the navigation (Threads, Registrations
    and Passkeys) is named by its tab, its heading visually hidden; and the tabs fill their own row
    on a phone, the current one marked. Ruling 46 answers items 5 to 7.
46. (2026-11-01, answering the lead's proposal on items 5 to 7 of ruling 45) The lead proposed:
    letter badges, A, S and T, before a thread's agent, session and topic wherever they show, in
    place of the path's separators, on chips and beside the filter sheet's labels; a topic written
    `session/topic` wherever its session is not beside it; the topic filter taking
    `agent/session/topic` paths, several at once like agents and sessions, so following a topic sets
    that filter alone; topics following the agent and session name rule; and each answer as read
    carrying its ask's question, which a live read-back showed agents need. The operator answered:
    "This all sounds good including making topic multi-select for consistency." "Let's make all
    these changes and then get the skill ready to go. One thing the skill should mention is that
    when this is active, the agent should avoid blocking, especially on questions using the native
    question tool." "And please make every effort to keep hte skill complete and accurate but
    concise. That's probably worth some Fable-tier work." Taken as proposed. The skill sends a
    question to the operator as an ask, never through the host's own question tool or a question
    that ends the agent's turn, and carries on with work that does not need the answer.
47. (2026-11-01, after re-checking Delivery 2 on a phone) Asked whether an agent with nothing left
    but to wait for an answer keeps checking for it indefinitely or stops after a limit, the
    operator answered: "1. Yes. The agent should be explicitly instructed to keep checking for
    activity indefinitely." On the re-check: "2. This all looks good. I did respond to #9. But it
    seems it's still unread by the agent." Then: "When you say "block", do you mean blocking on the
    MCP or blocking in some other way. I don't know if it's possible to block on MCP but that would
    be fine. Anything else will break Agention, right?" And: "And a couple small things:" "1. We
    need to make the thread number visible in the thread list view." "2. We need to make the agent
    read status more visible when viewing a thread. Maybe we put the envelop icon and the word
    "agent" on the botton right of the card? It should be visually subtle but it's important to make
    available in a clear, intuitive manner." The lead answered that waiting blocks on the MCP call:
    `message_wait` is held open up to 25 seconds and called again, while what breaks Agention is an
    agent waiting on its terminal, through the host's question tool or a question that ends its
    turn. Taken: the skill tells an agent with nothing left but to wait to keep calling
    `message_wait` indefinitely, never ending its turn, and the bridge holds a failed wait for its
    full time; a thread's number leads its title on rows and on the thread page; and the agent's
    reading of each of the operator's messages shows at the card's foot as the envelope and the word
    "agent".
48. (2026-11-05, on asks resolved outside Agention) Asked "And then can an agent dismiss and thread
    that has been resolved externally? For example, a request to merge a PR. What is the UX there?",
    the lead answered that an agent can withdraw an ask by replacing its message and archive the
    thread for itself, while the operator's archive stays the operator's, and proposed that agents
    check what they can see between waits, that a replacement without asks read as a withdrawal, and
    that the operator's archive stay theirs. The operator answered: "Ok. Let's come back to the
    validation. But first, the withdrawn stuff." "1. I'd argue that this whole model is
    fundamentally non-blocking. I certainly don't want the agent blocking on the harness question
    tool, but I don't want it blocking on us either. My thinking is that we tell the agent
    specifically that the main agent shouldn't block on anything. If the main agent wants to use
    subagents that block either on our stuff or other stuff, that's fine provided that the main
    agent can continue, but we should fully support a polling mode, too." "2. I Do think we should
    support a specific withdrawn action with an explanation as you say. And then we should aggregate
    that status up to the thread with some good rules. Really think about that one." "3. For the PR
    case, though, would merging the PR be an ask? That's a little strange, right? What happens if
    the user says they merged it but they didn't." "Does that make sense?" The lead proposed a
    withdrawal with a required reason; a thread status of needs you, waiting, withdrawn, answered or
    none; the agent checking any claim it can check, such as a pull request's state, and withdrawing
    an ask the world has settled; and, for an agent with nothing left but answers to wait for, a
    background waiter where the host offers one and otherwise ending its turn. The operator
    answered: "Ok. So this gets into session status, which is something we haven't revisited in a
    while." "But I honestly think you're overcomplicating this. We just don't want the agent to
    block period, right? that whole "if the host cant, end the turn..." just seems wrong to me. But
    maybe I'm missing somehing." "Also, is "host" standard terminology here?" The lead agreed that
    the rule is only never to wait: an agent that has done what it can stops as it always would, and
    what it then misses is being woken by an answer, which the stranded signal (R21) shows the
    operator. It proposed bringing last seen, quiet and stranded into Delivery 2, and answered that
    "host" is the Model Context Protocol's term for the application that runs the model and connects
    to MCP servers. The operator answered: "Yep, that sounds perfect. And if "host" is well-defined,
    I'm all for it. I didn't know that." "And the posture here is really that goal management is out
    of scope for agention. When we get to session status, we'll report on the goal, but the harness
    is still the thing managing the goal and deciding whether the session should continue. We just
    want to avoid any additional blocking behavior due to Agention." Taken, overtaking ruling 47's
    indefinite `message_wait`: the skill has an agent ask and carry on, check for answers as it
    works, check what it can see for itself, and stop as it otherwise would, never waiting; the
    requester withdraws an open ask in a message, giving a reason, and a replacement never drops one
    unexplained; a thread's status rolls up its live asks, shown on rows, the thread page and the
    bridge and filtered by a Status filter that takes the place of Open asks; Delivery 2 carries
    last seen, quiet and stranded; and managing a session's goal stays out of scope. A request for
    an action stays an ask, whose answer the agent checks where it can.
49. (2026-11-06, answering the lead's reading of the reviews of ruling 48's change) Asked whether
    the operator approves ruling 48's drafted requirement wording (R8 to R11, R18, R21, R25, R35 and
    the out-of-scope list), checking two points: R21's status counts an ask a replacement withdraws,
    so a replacement that withdraws an ask and asks nothing leaves its thread withdrawn rather than
    none; and R35 gains that the agent checks for itself what it can see, the operator answered:
    "All approve all the changes per your recommendations. I'll get going on the recheck nw." Taken:
    ruling 48's requirement wording stands as drafted, R35 with that addition; ruling 48's record
    stays as first written; and the review findings the lead took apply, among them that a
    replacement takes its message's asks with it, answered or not.
50. (2026-11-06, during the phone re-check of ruling 48's change) The operator wrote: "And I'd like
    to get to a stopping point where I can start using the product for real. Please head in that
    direction." "And along those lines, if we don't yet have the npm publish process as well as the
    full instructions for running it, we need that." Asked what the first release includes beyond
    Delivery 2 as it stands, given that either way it adds the npm publish workflow, a full running
    guide and migrations that only move forward from 0.1.0, the operator chose "Release and guide
    only": backup stays in Delivery 3, and until then the guide says to stop the server and copy the
    database file. Asked how npm publishing starts, given that npm sets up a trusted publisher only
    on a package that exists and expires one that has not published within two days, the operator
    chose "Placeholder first": they publish a stub of each package once and deprecate it, then set
    up trusted publishing, and CI publishes 0.1.0 onward with provenance. Asked where the server
    runs for real use, the operator chose "Another machine", installed by following the guide. Asked
    who merges, the operator chose "You merge": the lead says when each pull request is ready. Then:
    "And please document how to run the server manually, outside of launchd/systemd." Taken:
    Delivery 2 ends with the first release, 0.1.0, carrying the release workflow, the placeholder
    start of trusted publishing, and the operator guide for real use; migration 1 is frozen at
    0.1.0.
51. (2026-11-06, as the release workflow was built) Asked what 0.1.0 does given that
    `WayfarerLabs/agention` is private, while npm attaches provenance only from a public repository
    and installing the plugins from a private one needs GitHub credentials on each machine, the
    operator chose "Make it public": they make the repository public before merging the release pull
    request. Asked how CI publishes, given that trusted publishers created after 2026-09-03 allow
    only staged publishing unless `npm publish` is allowed, the operator chose "CI publishes":
    merging the release pull request is the human approval, and each trusted publisher allows
    `npm publish`. Asked what `SECURITY.md` says of supported versions from 0.1.0, the operator
    chose "Latest only": "Agention is pre-1.0: fixes go into the next release, and only the latest
    release is supported." Asked how to go public, given that the repository's pull requests #1 and
    #2 and the branch `build/initial-agention` hold the predecessor's process documents and design
    drafts, which GitHub keeps viewable after a branch is deleted, while `main` and agention#7's
    history are clean, the operator chose "Fresh public repo": the current repository is renamed and
    kept private as an archive, a new public `WayfarerLabs/agention` receives `main` and the release
    branch, and agention#7 reopens there as a new pull request.
52. (2026-11-06, answering the review of the release change) Told by the review lanes that anyone
    able to push a `v*` tag, the fine-grained tokens agent sessions use included, could publish a
    branch's code with provenance, and that the lead takes the fix of a tag ruleset whose only
    bypass is the release-please App, with the App's key usable only from `main`, the operator was
    asked what system the server's machine runs, given that only Linux has been exercised, and chose
    "Not decided yet": the guide keeps both the systemd and the launchd service, the launchd one
    marked as not yet tested. Asked how the plugins are installed, given that the marketplaces read
    `main`, so a skill change merged before its release reaches agents ahead of the bridge and
    server that implement it, the operator answered: "We should support both pinned and unpinned
    usage. Pinned is safer for sure." Taken: the guide installs the plugins pinned to a release tag
    first, as the safer way, and tracking `main` second.
53. (2026-11-08, before the phone re-check of ruling 48's change) "Oh, and I really want to avoid
    having to constantly go to the console to get the details for an ask or other message." "Should
    we consider some sort of "detail" type field that is designed to carry truly long-form markdown?
    Depending on the UI, this could be folded by default or something like that. But it should be
    available and the skill should instruct the agent to include all relevant detail so that a
    decision can be made (or the message can be understood) without having to gather additional
    information." The lead proposed an optional Markdown detail on every message, folded in the web
    UI between the text and the asks, with the text bounded at about 4,000 characters so that it
    stays a summary, a skill rule that every message stands on its own, and landing it before 0.1.0.
    The operator answered: "Yep, this sounds good. But 4000 sounds quite long for a "summary". Let's
    make that maybe 500? 1k? And yeah, before 0.1.0. It really won't be useful without this." Taken:
    a message's text holds at most 1,000 characters.
54. (2026-11-09, during the phone re-check of the change for rulings 48 and 53) "Just a few tiny
    things:" "1. We should add a thread number sort" "2. Sort mechanism should seperate what we're
    ordering by vs ascending/descending" "3. We need a way to control the title. Can that be a
    setting? I'll likely have two of these running at once (one for work, one for personal) so
    different titles are important." Told that thread numbers restart in every session, the operator
    was asked to approve a Sort menu of Priority, Due, Effort, Latest message and Created, Created
    being thread-number order within a session, beside a separate button naming its direction (such
    as Newest first or Soonest first), with a thread the chosen order does not rank staying after
    the rest either way and Priority, most pressing first, staying the default, and chose "As
    described". Asked whether a server's name is set by a flag of `agention serve`, known before the
    first passkey is made, or by a setting in the web UI, the operator chose the flag. Asked whether
    two servers under one Tailscale name on two ports should both work, given that a browser shares
    sign-in cookies and passkeys across the ports of one host, the operator answered: "These will be
    entirely different servers/services. Any given session will only be pointed at one. Please do
    not try to make them share auth or any other data." Taken: a second server runs under its own
    host name, and servers share nothing.
55. (2026-11-09, on ruling 54's change) "Would it be a problem to run two server instances on the
    same host, just on different ports? If so, why?" Told that it would, because browsers keep one
    set of cookies for a host whatever its port, so signing in to one server would sign the operator
    out of the other, and because a passkey belongs to a host name, so each sign-in would offer both
    servers' passkeys alike, and that a cookie name of each server's own and the server's name on
    its passkeys would keep them apart without sharing anything, the operator answered: "Ah. Sorry
    about that. Yeah, let's do the "make both work" option." "Just a thought, but since the name is
    getting captured in passkeys, etc., would it perhaps be better to set it once at first start and
    then make it immutable? As it stands today, I could technically start with a new name every
    time, yeah?" The lead recommended storing the name with the server's data on its first start,
    later starts leaving it out or repeating it and a different one refused, with no rename, and
    said this needs a fresh database on the live server. Asked to choose, the operator chose "Set
    once, never changes". Taken: two servers may share a host name under different ports, and a
    server's name is set on its first start and never changes. The operator then added: "Please
    don't empahsize running two instances on the same machine. The likely setup is for sure
    different machines." Taken: the guide shows a second server on its own machine and mentions only
    in passing that servers can share a host.
56. (2026-11-10, during the phone re-check of rulings 54 and 55) "So while I do this, I think we're
    going to want a more efficient interface for viewing registrations. I'm ultimately going to have
    5-10 agents and dozens of sessions." Shown a page keeping registrations waiting for approval on
    top and, below them, one compact row per session grouped under foldable agent headers, each with
    whether it holds a working credential, when it was last seen and a menu with Revoke, past
    requests folded at the bottom, the operator noted: "Yeah, this is awesome. It should really just
    be pulled into the session status view. Love it!" Asked when it lands, the operator chose
    "Delivery 3 (Recommended)", after 0.1.0 and with session groups and tags. Taken: registrations
    and credentials move into one view of the sessions, designed with session groups and tags in
    Delivery 3.
57. (2026-11-10, during the phone re-check of rulings 54 and 55) "Ok. And then I think we should
    show an aggregate "earliest due" status on the thread card. It should be the earliest due data
    amongst the open questions. Does that make sense? Please just hold on to this one until I finish
    goint through everything." The lead answered that it does: the server already rolls up each
    thread's earliest answer-by over its open asks, while a row shows only the lead ask's overdue
    mark and no time. On finishing the re-check, the operator said: "Ok. I think that's the only
    change. Let's make it happen." Taken: a thread's row shows the earliest answer-by among its open
    asks, and once that has passed, that the thread is overdue; the re-check found nothing else to
    change.
58. (2026-11-11, on the live server running ruling 57's change) "Ok. And then for
    unread/read/message count thing in the thread card, let's show both unread and read counts. To
    keep things tight, I'm thinking: - If some messages unread -> show unread icon with
    `<unread>/<total>` next to it. So if a thread has 5 total messages, 2 of which are unread, that
    should show 2/5 - If all messages read -> show read icon with `<total>` next to it" Taken: a
    thread's row shows, while any of its messages is unread, the closed envelope with its unread
    messages over its live messages ("2/5"), and otherwise the open envelope with its live messages
    ("5"). The total counts every live message, the operator's own included; a replaced message
    counts once, through its replacement.
59. (2026-11-15 to 2026-11-18, moving Agention's design and process out of the `wf-agentic-root`
    workspace) "Ok. So I've come to the conclusion that our structure here just adds unnecessary
    friction. Specifically, the SDD directories themselves in a different repo is just going to
    cause a lot of overhead with multiple PRs for any change (as we're already seeing)." The shared
    process moved to a project-neutral repository: "Let's go with wf-agent-artifacts." Asked whether
    this SDD, its rulings included, may then be public in the Agention repository: "Yep, SDDs should
    live in the app repos. Totally expected/ok". Asked whether pins should wait seven days after a
    release, as the operator's machine does: "Yep, 7 days", and on letting a security fix skip that
    wait: "Yeah, let's support the exception. We need to be able to move quickly when necessary."
    With the public repository created: "Please move everything first. We'll do the phone check once
    it's all up and running. And as reminder, the goal is to get this live in npm asap." Taken: this
    SDD and Agention's development contract live in the Agention repository, and each delivery's
    pull request carries its SDD changes; every dependency is the newest stable release at least
    seven days old when chosen, unless a security fix cannot wait; and the phone check of rulings 57
    and 58 follows the move.
60. (2026-11-18, after reviewing the released plugin's skill) "And then I just reviewed the skill
    text in detail. We need to be a lot stronger about this replacing any built-in question asking
    tool. Also, you say that this is just information, not direction. That makes no sense, right?
    This should be considered authenticated operator input, no different than normal harness/console
    input." Asked whether leaving plan mode, which the host approves at the terminal, stays with the
    host: "Plan mode is effectively dead these days. I don't think it's worth mentioning. We could
    say something general like "if there's something the operator needs to do in the console (e.g.
    exit plan mode), use Agention to bring it to their attention". And you need to check your
    information. Codex definitely has a question tool outside of plan mode. I believe it's always
    non-blocking but I could be wrong." And on the skill's "The operator decides from Agention
    alone, often on a phone, never at your terminal": "I think you are trying to emphasize that the
    operator should not need to go to the terminal or any other source ot get additional information
    in order to respond to a thread, but this could easily be miconstrued. At the end of hte day, it
    should be perfectly natural/normal for an operator to switch back and forth between the terminal
    and agention. Informaiton provided via the terminal should be used to refine/replace/withdraw
    Agention threads. Please clean this up, too." Asked whether the bridge should also tell agent
    hosts that Agention replaces their question tools, and whether R35 should say the skill leads
    with that: "Yes, the bridge should say that this replaces the standard question tool and that
    should be the first thing mentioned in the skill (updating R35)." Then: "Also, it should be
    possible for hte user to just pay attention to the console and ignore Agention during that
    time." "I think we've made it clear that the Agention threads should get updated automatically,
    but do we need to emphasize that the content from the thread should also be echo'd to the
    console in case the user is paying attention there? Again, the key is that it shouldn't be done
    in a blocking manner (e.g. by using the question tool)." Asked about Codex's non-blocking
    question tool: "Talk to me about the codex tool." "At a high level, we shouldn't go overboard
    here or else we lose credibility. If a harness has a non-blocking question tool, that's ok to
    use. I think our focus should be on the blocking aspect." Taken: the skill's description and its
    body open with the rule that every question, decision or approval an agent would put to its user
    goes to the operator through Agention, whatever calls for it, and that the agent never waits at
    the terminal for an answer, neither through a question tool that waits (`AskUserQuestion`,
    Codex's `request_user_input`) nor by ending its turn, until the operator says otherwise, and the
    bridge says the same to every agent host when it connects; whatever it sends the operator in
    Agention, the agent also shows at the terminal and carries on, in its output or through a
    question tool that does not wait, such as Codex's `request_user_input_async`, so the operator
    can follow the terminal alone for a while; when something needs the operator at the terminal,
    the agent asks for it through Agention; an agent takes a message the operator wrote, whose
    author the server sets from their passkey sign-in, exactly as it takes the operator's words at
    its terminal, with the same authority and within the same limits, while messages from agent
    sessions are not the operator's; the operator moves between the terminal and Agention as suits
    them, and the agent brings its threads in line with what it is told at the terminal, replacing
    or withdrawing asks; and every message stands on its own, so the operator never needs the
    terminal or another source to answer it.

61. (2026-11-19, on how answers reach agents, and the operator's draft of the skill) The operator
    pushed a draft of the skill and asked: "So is all this non-blocking stuff misguided? Did we
    build the bridge in such a way that it takes advantage of native mcp subscibe/listen? I could be
    wrong, but I believe that's a key part of the answer, right?" The lead answered that the bridge
    has no push and that standard MCP notifications reach neither host's model, while Claude Code
    offers channels and Codex an app-server queue. The operator answered: "Yeah, so I feel like the
    right general path is to support both polling and push modes, likely through both flags to the
    bridge as well as different skills text (maybe via templating)?" "But we definitely want to test
    this first, certianly for Claude Code. And I further authorize you to scour the Codex repository
    if you haven't already and to test Codex if you need to." Then: "Check out `codex queue`". The
    lead reported that in Claude Code a channel event, and a background hook that exits with code 2,
    each wake an idle session, and that `codex queue` starts a turn in an idle Codex session or,
    with `--resume`, in a closed one. The operator answered: "Yeah, so I'm thinking we organize this
    as something like 'push methods', where the bridge would be started with an optional method (via
    env var or cli arg). Ultimately we probably also support an "auto detect push" mode that
    attempts to figure out works given its harness." "But the poll mode is the floor. It must work
    well as some harnesses will undoubtedly need it." "And then in terms of the skill, I think we
    have two options: 1. Use a templated skill so that sections can be swapped out for the different
    plugins 2. Make it more dynamic, likely with the bridge reporting whether push is currently
    supported, and then instructions that take that into account" "My head was initially on #1, but
    I think #2 is the obvious right answer, especiallyas we can only bake one version into a plugin
    and auto mode would clearly not work." "So the final decision: incorporate push now or leave it
    for a future release? I'm inclined to leave it for a future release. If nothing else, it will
    force us to get the poll mode working well." The lead agreed. The operator then: "Fwiw, I'm
    pretty sure you get some env vars from Claude. But we can save that for later." "And more or
    less agreed on the skill. That said, we can already start leaning into the "follow the bridge's
    instructions", right?" "Please take a fresh look at the skill and my rewrites. I'm perfectly
    happy to rewrite R35 or anything else if that's the right thing to do." "And in polling mode, we
    do indeed want the agent to keep running. This can be couched with "as long as there are open
    asks and/or unread messages". Likewise, we may want to suggest that they take steps to minimize
    token usage from polling. But we don't want them to stop." On the lead's review of the draft:
    "1. Something like "Load when using Agention", right?" "2. Yeah, understood. The initial text
    gave the impression that everytihng had to be an ask. I just want to make sure that agents
    understand that ask-less messages for informational purposes are totally normal and good." "3.
    Agreed. And tbh I really didn't want to use the word "channel" as it means something for Claude
    (and probably others). Please rewrite this as you see fit." "4. Agreed." "5. Agreed." "6. Yes
    please" (restoring the points the draft dropped, "never" over "please avoid", and the typo
    fixes) "Please take a crack and then pass it to a Fable-tier dev with a focus on conciseness and
    completeness." Then: "And then we really haven't released Agention in any real capacity. I don't
    like that we have all this noise in terms of adrs and decisions. I know it's against the normal
    rules but I'd like you to clean up a bit where it makes sense to do so." And on a test that held
    the bridge's instructions to a length: "And please, please do not test wording. A test that only
    pins wording offers no more protection than the wording alone." Taken, overtaking ruling 48's
    stopping: push methods wait for a later release, and polling, v1's only method, must work well
    on its own; the skill follows the bridge, whose answers say how answers reach the agent; with
    polling, an agent whose other work is done keeps running while it has open asks or unread
    messages, checking in the way that costs least, and stops when none remain or the operator tells
    it to; a message without an ask is normal; the skill's description says to load it whenever the
    agent uses Agention; until v1 is released, ADR 0001 states its decisions as they stand, without
    a log of amendments; and no test pins wording.
62. (2026-11-20, on what an agent learns when the bridge cannot work) The operator asked: "And does
    the bridge let the agent know if it can't find or connect to the server at startup?" The lead
    answered that the agent learns on its first call, normally `register`, since the bridge contacts
    the server only on a call, and that the bridge's messages about its settings read as if the
    agent could fix them, though only the operator can and a change takes effect only once the
    session restarts; it proposed wording those messages to have the agent tell the operator, and no
    probe of the server at startup. The operator answered: "Yeah, let's do the startup errors
    feature. That's going to be a big point of friction." Then: "I think ultimately this just comes
    down to good, agent oriented error messages." Taken: every problem the bridge finds itself is
    worded for the agent, saying what it does; one only the operator can fix, such as a setting or a
    server the bridge cannot reach, has the agent tell them at its terminal what to change, say for
    a setting that the session must then restart, and carry on; the skill's rule that a failed call
    says what to do covers it unchanged.
63. (2026-11-20, while testing 0.2.1) "Honestly, we shouldn't really assume Tailscale. It's ok to
    recommend it and to have it mentioned in the guide as an option, but people can host the server
    however they want, right?" The lead proposed a docs change making the guide's setup step "give
    the server an HTTPS origin", with `tailscale serve` among the ways to do it. The operator
    answered "Go ahead", and: "Again, we should talk about how to do this on Tailscale but it should
    be an optional path." Taken: the guide covers hosting behind any TLS terminator, such as a
    reverse proxy, or with the server terminating TLS itself, and documents `tailscale serve` as an
    optional way; nothing in the setup assumes Tailscale.
64. (2026-11-20, while testing 0.2.1) "Ok. And then what's next in terms of agention functionality?
    I don't want to bite off the push/thin client/auth rework stuff yet. Perhaps we park that in a
    new SDD?" "I could be wrong but I think session status is the next step, right?" "Also, is there
    any good reason why I shouldn't be able to initiate a thread from my side?" The operator also
    asked about an API for integrations that act for them. The lead proposed cutting Delivery 3 so
    that sessions come first; parking the rework in a new SDD; operator-started threads with the
    sessions view, since an agent sees a new thread only while it checks; and the integration API
    with the rework, since it needs the same credential decision. The operator chose "Sessions
    first" and "With the sessions view", and answered: "Actually, let's create a GitHub issue for
    this. That's cleaner than an SDD that might sit for a while." and, for the integration API,
    "Great a GitHub Issue for this, too." Taken: Delivery 3 splits, sessions first (the status tool,
    the session log, stopped sessions in stranded, the sessions view replacing the registrations
    page, and the check that agent routes only grow), groups, tags, message search, Mermaid and
    backup after; the operator starts threads on a session from the sessions view, overtaking ruling
    11 for threads; the rework and the integration API are GitHub issues, not an SDD.
65. (2026-11-20, on the sessions delivery's design) Asked four questions, the operator chose "One
    status tool" over an envelope on every call; answered on where unread session updates show:
    "Separate sessions view for now. We'll figure out that integrated view as a second step"; chose
    "You write, agent asks" for the threads they start; and answered on whether an agent reports
    itself stopped each time it finishes what it was asked: "The main function of stopped is an
    indication of whether the agent is likely to see additional messages. It should be set
    accordingly." Taken: one `session_update` tool carries state, outcome, title, goal, percent and
    a note, and no other call carries them; unread updates show in the sessions view, and the thread
    list takes them in a later step; the operator's thread has a title and a first message without
    asks, the session stays its requester, and the agent replies in it; stopped means the session is
    not likely to see new messages until something starts it again, so an agent reports stopped when
    it stops checking Agention and working when it resumes.
66. (2026-11-20, using 0.2.1) "For me, I really like the option to jump right to a new question on a
    thread where you've read some stuff. However, in thinking about this more:" "1. Unless I missed
    it, it only works for asks. New messages should get the same treatment. Basically a "Jump to
    unread" CTA." "2. That said, we should at least offer the option (probably default) for newest
    first sorting, which gets rid of that. I'm open to this being the only option." "Also, if I'm
    not mistaken, there's no way to unselect an ask option. Decline means something different,
    right? I just accidentally selected an option for an ask that I didn't want to answer right then
    and didn't see a way to then not answer it at that moment." The lead answered that picking only
    stages an answer, which the composer's Remove clears out of view, and that Decline records that
    the operator will not answer; it proposed a Clear on the ask card and newest first as the only
    order. The operator answered: "Totally agreed on "Clear". That's exactly right." "But then let's
    leave the order as-is for now and just turn the new ask jump to a general "Jump to unread"
    action. I do worry that newest first will cause me to miss things (you haveto scroll past stuff
    to then read in the right order). No order toggle for now." Taken: messages stay oldest first
    with no toggle; the thread's head jumps in turn to each unread message and each ask still open
    to the operator; an ask card with an answer staged offers Clear, which removes it as the
    composer's Remove does.
67. (2026-11-20, rolling Agention out across the operator's sessions) "Ok. And then I'm going to
    start rolling this out across my sessions. I feel like the mixed up api thing is going to hit us
    pretty soon if we don't get in front of it." "Is there a simple solution that we can put in
    place to fail loudly instead of getting strange errors for silently missed fields?" The lead
    proposed one integer agent API version, sent as a header both ways, absent meaning 1, with a
    bridge refusing a server older than itself and the server refusing a bridge outside the versions
    it supports, each saying what the operator upgrades, built into the first release that changes
    the agent contract. The operator answered: "Yes, please build the check into the sessions
    release." Taken: the sessions release carries the agent API version check; the rest of the
    versioning research stays with the parked rework.
68. (2026-11-20, on the sessions view's mockup) "Ok. So for the mock-up, I'm thinking that the
    details for each session would be folded by default such that many sessions would fit on the
    screen. The folder status should have all the key info. Unfolding would show the log." "And I
    also meant to say earlier that you should be careful with working and waiting statuses. They're
    not mutually exclusive, right? They're probably best represented as separate dimensions ."
    Taken: each session is a folded row carrying its key facts, which unfolds to its goal and log; a
    session reports what it is doing as working, idle or stopped, and whether it is waiting on the
    operator is counted from its open asks, never reported.
69. (2026-11-20, rolling Agention out across the operator's sessions) "Ok. So I have a challenge. I
    have Agentworks VMs on both my personal and my work Tailnet. My VMs on my work Tailnet are
    shared back to my personal Tailnet and my laptop and phone generally live on that. Since all
    traffic is inbound to the Agentworks VMs, everything is great. But the Agention server is now
    something that needs to be routable from other VMs. This alone is a challenge and will force me
    to poke holes in my ACLs. Is there an elegant approach here where a VM can run a localhost
    Agentworks server that can then be reached from another Agentworks server, thus keeping the
    "everything inbound to the VM" model? Obviously auth gets really tricky here." The lead proposed
    keeping one server, with the server's machine holding an SSH reverse tunnel into each VM and a
    bridge setting that opens the bridge's connections at the tunnel's loopback port while TLS and
    the tokens still name the real origin, and recommended against a server per VM with a hub. The
    operator asked: "I think this makes sense. Any security concerns?" The lead answered that
    authentication is unchanged and the certificate check stops a process squatting the port, that
    the new exposure is the server machine's SSH key into each VM, to be restricted to that one
    forward, and that work threads would be stored on the personal server. The operator answered
    "Sounds great!", choosing "Yes, add the setting" and "The 0.2.2 patch". Taken: the bridge gains
    `AGENTION_CONNECT` in the next release, and the operator guide documents the tunnel.
70. (2026-11-20, using 0.2.1) "One thing I've noticed is that there's isn't enough of a visual
    difference between read and unread messages." "I really like the way asks work, purple when
    open, blue when closed. I think we should do something like that more broadly for message read
    status. And the unread bold should be bolder if possible." The lead proposed giving unread
    threads and messages the open ask's shape in the accent blue (a thick bar at the start, a tint
    and a dot), unread titles at weight 800 instead of 700, and dropping the thread page's "New"
    divider since the card says it. The operator answered at the terminal: "Actually, can you knock
    out the unread contrast improvements real quick? Let's get those in 0.3.0." Taken: as proposed,
    with the sessions log's unread entries tinted to match, in the 0.3.0 release.
71. (2026-11-20, releasing 0.3.0) "Btw, shouldn't we be basing this on node 26? Is that a big
    change?" Before the lead answered, the operator added: "I mean, I suppose it's good to support
    v24 if we can. That's pretty widely deployed. But we should use v26 ourselves." Taken: the
    repository builds, checks and publishes on Node 26's LTS line through `.node-version`; the
    packages keep supporting Node 24 and later (their `engines`, the bundle's target and the
    bridge's startup check), which CI checks on Node 24 too, with `@types/node` held to the 24 line.
72. (2026-11-21, on the plain-HTTP tunnel hint) Asked whether the tunnel hint ships alone as 0.3.1
    once its pull request merges or rides with the next release, the operator chose "Ride with the
    next". Taken: no 0.3.1; the hint ships in the release that completes v1.
73. (2026-11-21, on Mermaid's bundled layout engine) Asked "I'm not familiar with ELK layouts. Are
    they a big improvement?", then told that ELK helps mainly on large, dense graphs, costs about
    1.6 MB of the diagram frame's script and is the bundle's only copyleft code (EPL-2.0 OR
    GPL-3.0-or-later), the operator answered: "Yeah, let's strip it. We can always add it later if
    needed." (Superseded by ruling 77.) Taken: the diagram frame's bundle leaves `elkjs` out, and a
    diagram that asks for an ELK layout draws with Mermaid's default layout.
74. (2026-11-21, on Delivery 4's design) "So one thought here. What if we limit viewing thread
    details to the threads tab only. The sessions tab would just provide the session status stuff
    (including activity log) and then thread summaries/counts. And then we just have obvious CTAs
    there to view threads that just take you to an appropriate filter in the threads tab?" Asked
    whether session updates then stay on the Sessions tab only, not in the thread list, with an
    unread badge on the tab and each session row showing its threads' roll-up and a link to them,
    the operator chose "Yes, split them" and wrote "Love it!". Taken, overtaking ruling 65's later
    step: unread session updates do not join the thread list; the Sessions tab carries a badge
    counting sessions with unread updates; each session row shows its threads' roll-up (threads and
    unread threads, with blocked on the operator in its existing open-asks mark) with unread updates
    marked apart, and links to the thread list narrowed to it, as an agent's header does to the
    agent.
75. (2026-11-21, on Delivery 4's design) Shown groups as fold levels in the thread list beside a
    Group filter, the operator wrote: "So I think this looks good but I worry about consistency,
    especially w.r.t. what we've already built. And the group filtering mechanism seems strange with
    the foldable top-level groups. How do we expect users to focus on a specific group or set of
    groups? I'd much rather have one really good mechanism vs two mediocre and overlapping ones."
    Offered a bar of group chips focusing both tabs instead, the operator answered: "So maybe I'm
    missing something, but I think we keep the group fold on the session tab and then it just
    becomes a standard filter (and maybe a grouping option?) on the thread tab. No need for a new
    shared bar paradigm. But lmk if you disagree." Taken, overtaking ruling 38's single hierarchy of
    session group, session, topic and thread: the Sessions tab folds group, agent, session, each
    group's head carrying its roll-up and a link to the thread list filtered to the group; the
    thread list focuses on groups through the Group filter, and Group becomes a grouping of its own
    (group, session, topic, thread) beside Flat, Session and Agent, the session grouping returning
    to session, topic, thread.
76. (2026-11-21, on Delivery 4's design) Asked whether the Sessions tab nests group, agent, session
    (an agent showing under each group that holds its sessions) or group, session with the agent
    named on each row, the operator chose "Group, agent, session".
77. (2026-11-21, on Mermaid's bundled layout engine) Told that ruling 73 rested on a mistake, since
    Mermaid 12 lays out most diagrams with ELK by default, so stripping it changes nearly every
    diagram's layout, the operator asked "So what exactly are the license implications of keeping
    it?" Told that elkjs is file-level copyleft under EPL-2.0, leaves Agention's MIT license
    untouched, and adds a statement wherever it ships that its source is available under the EPL and
    how to obtain it, the operator chose "Keep ELK" and wrote "Let's keep it. Thanks!". Taken:
    ruling 73 is superseded; the diagram frame keeps Mermaid's default ELK layout, and the shipped
    notices say where elkjs's source is available under the EPL, the frame's script pointing to
    them.
78. (2026-11-21, at the lead's terminal, on the phone check of Delivery 3 on 0.3.0) "So the only
    thing I noticed is that in the session tab, the option menu fo the last session in an agent
    group opens "under" the "Credentials and past requests" fold. Everything else looks good so far.
    And I know we have the updated design, so let's consider this complete." Taken: Delivery 3's
    phone check passed. The menu did not stack under that fold at Delivery 4's head, whose live run
    had already fixed menu stacking, and a browser test now guards that case.
79. (2026-11-21, on finishing v1) Asked whether to release v1 as 1.0.0 or as release-please's
    default 0.4.0, the operator chose "0.4.0"; asked whether the phone check comes before Delivery
    4's pull request merges or after the release, the operator chose "After the release". Taken: the
    release that completes v1 is 0.4.0; the operator checks the published release on a phone, and a
    small follow-up pull request records that check, the release and the lock.
80. (2026-11-21, on a preliminary check of Delivery 4 on the staging server) "The only issue that I
    noticed is that stranded should be a proper filter with the normal linking from the session
    view." Taken: a session row's and an agent header's stranded count link to the thread list
    filtered to their stranded threads, as their threads links do.
81. (2026-11-21, the same check) "I don't thikn "Quiet since..." should be a chip. Each session
    should have a "Last seen" tracker that is its own line (likely between the session name and the
    chips). And then "stranded" as a session chip should get the same visual treatment as the
    stranded agent chip. If you haven't already figured out, I'm big on consistency. That's how you
    build intuitive UIs." Taken: every session row shows when it was last seen on a line of its own
    between its head and its chips, warning while quiet, and no quiet chip; the row's stranded chip
    and every other chip share the agent header's look; and consistency across the UI is a standing
    principle for its design.

## Out of scope for v1

- Labels beyond one topic per thread (rulings 12 and 33).
- Nested session groups and smart tags that match patterns in agent and session names (ruling 30).
- Asks the operator makes (rulings 11 and 65), more than one person, and people acting for the
  operator.
- An external identity issuer integration; only the mapping seam (R4) is in scope.
- Embedded Tailscale mode and Tailscale ACL lockdown. These are deployment follow-ups.
- Push notifications, email, or any delivery channel beyond the web UI.
- Push methods, by which the bridge wakes an agent when a message lands, chosen at start or detected
  from the host; polling is v1's only method (ruling 61).
- Executing, fetching or acting on message content; granting permissions; controlling harnesses.
- Managing a session's goal or whether the session continues. The host does both; Agention reports
  what a session states (R22), adds no waiting to its work (ruling 48), and has the agent keep
  running only while it has open asks or unread messages (ruling 61).

## Open questions

- Whether sending a message without answering an ask open to the operator first asks the operator to
  confirm, with a choice to stop asking (ruling 37, item 9). Not built in v1 unless decided.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- An agent on a separate VM registers, raises threads with asks of every shape, and reads the
  operator's answers through the agent bridge, against the real server behind `tailscale serve`.
- The operator completes the passkey and inbox flows on a real phone.
- Releases are versioned and the repository passes its documented checks in CI.
