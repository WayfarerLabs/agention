# Agention v1: Functional Requirements

- Status: Draft for operator review
- Date: 2026-10-25
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim or as close transcription.
- Predecessor: the unmerged initial build on branch `build/initial-agention` (head `d66d827`). It
  is reference material only. Parts of it carry forward as described in the HLA; its item model,
  documentation and developer framework do not.

## Why this exists

One person runs many largely autonomous agent sessions. Each session occasionally needs that person:
a question answered, a decision noticed, something done in another system, a result reviewed. Today
those needs are scattered across terminals and chats, and the person has to go looking.

Agention is one self-hosted, phone-friendly place where sessions say what they need and the person
responds. It never grants permissions, injects into a chat, or controls a harness. Agents read the
responses through the same interface they report through.

The predecessor build proved the infrastructure (agent OAuth, human passkeys, isolated storage) but
crossed several independent dimensions of an item into a set of kinds, each with its own lifecycle.
This effort rebuilds the product around those dimensions kept separate.

## Who this is for

- **The operator**: the one human in v1. Reviews and responds from a phone or desktop browser.
- **Agents**: the principals that run workloads. In Agentworks, an agent is a user on a VM.
- **Sessions**: workloads belonging to exactly one agent. In Agentworks, a named session such as
  `agention-claude`. Many harness conversations may run in one session over time.

## Terms

Accepted by the operator on 2026-10-25.

| Term | Meaning |
| --- | --- |
| Item | One thing a session wants the human to know about or act on. |
| Entry | One append-only record in an item's log: a message, a field change, a close or a reopen. |
| Request | What the agent is asking of the human: act, see, dismiss or none. |
| Impact | How the item affects the session's work: blocking, assuming or none. |
| Response form | How the human is asked to respond when the request is act. |
| Ack cursor | The latest entry an identity has acknowledged in an item or session log. |
| Envelope | Optional session state carried on any agent call. |
| Requester | The party asking for attention on an item. In v1, always the item's session. |
| Responder | The party asked to give attention. In v1, always the human. |
| Session log | Append-only record of a session's state, goal and progress. |

## Trust model

Agention is an honor system by nature. A rogue agent can fail to report or can report falsely, and
the product cannot detect or prevent that. Requirements therefore separate what is enforced from what
is made easy and visible.

**Enforced**, because the honor system cannot provide it:

- Identity and provenance: who made each entry.
- Isolation: a session sees and changes only what its credential authorizes. Credentials stored by
  sessions under the same OS user are not protected from each other; separate OS users or VMs are.
- Append-only, attributed history: nothing is erased or rewritten. A false report remains on the
  record, attributed to its author. The check on a rogue agent is accountability, not prevention.
- The human's own voice: only a human can give a human response.
- Inert content: item text and references are never executed or fetched.

**Honor system, made easy to follow and visible when broken**: whether and what to report, the
accuracy of impact, progress, session state and external facts, and when to close an item. The
product steers behavior through defaults, the agent skill and visible signals, not through
enforcement ladders. In many cases agents warrant more authority because they are trusted.

## Functional requirements

### Identity and authorization

**R1. Agents are principals, sessions are workloads, items belong to sessions.** Every session
belongs to exactly one agent. Every item belongs to exactly one session. For attribution and
cursors, an agent-side actor is the authenticated session (with the credential recorded); the
human-side actor is the human.

**R2. Requests state their target; credentials only authorize.** A request names the session or item
it acts on. The server checks that the presented credential authorizes that target and never infers
a target from the credential. The actor is always taken from authentication, never from request
content.

**R3. The default grant is one session.** In v1 a credential authorizes exactly one session. Later
grants across sessions (a supervisor agent, sessions of one agent seeing each other) need no API
change.

**R4. External issuers can supply identity later.** v1 identity comes from operator-approved
registration. The design keeps a seam for a configured issuer's verified token, with configurable
claim mapping, to supply agent and session.

**R5. Registration and credential lifecycle.** An agent submits a registration naming an agent and a
session. The operator approves it, choosing whether it attaches to an existing agent and an existing
or new session, or rejects it. Unapproved registrations expire. The operator can revoke a credential
without deleting its session or items. Approving a new registration for an existing session is how a
lost credential is replaced, and it grants that session's full history, so the approval screen says
so. A session without an active credential and its items stay visible to the human, who can still
reply, close and reopen; the session shows that no credential is active.

**R6. Unknown and unauthorized look the same.** A target the caller may not access produces the same
response as one that does not exist. This applies to every operation, including acknowledgement.

**R7. Human and agent authority stay separate.** The human authenticates with passkeys. Agents
authenticate with OAuth credentials. Neither credential type works on the other's surface.

### Items

**R8. An item is an append-only log.** Messages, field changes, close and reopen are entries with an
increasing sequence. The item's current state derives from its log. No entry is edited or removed.

**R9. Roles follow the direction of attention.** Each item has a requester and a responder.
Permissions attach to those roles on the item, not to whether an identity is a human or an agent: the
requester states and changes what is asked, the responder gives the response, and either may reply,
acknowledge, close and reopen. In v1 the requester is always the item's session and the responder is
always the human. The model admits later attention requests between agents without changing these
rules.

**R10. The request is explicit and mutable.** The requester states what it asks of the responder:

- act: the responder needs to do something, in Agention or elsewhere; satisfied by a response
  after the entry that last set the request, form or options;
- see: the responder should see this at some point; satisfied when the responder has acknowledged
  that entry;
- dismiss: the requester considers the item done, but closing it is the responder's; satisfied when
  the responder closes the item;
- none: nothing is asked; ordinary unread state still informs the responder.

The requester may raise or lower the request at any time. Only the requester sets the request.

**R11. Impact is explicit and mutable.** The requester states blocking, assuming (proceeding on a stated
assumption) or none, and updates it as the work changes. Only the requester sets impact. A
response does not change it.

**R12. Response forms.** An act request carries a form: free text, choose one of listed options,
confirm or object, or outside (the action happens elsewhere; the item text and references say where,
and the responder may mark it done). Responses must fit the current form. Response values, including
a text message marked as the response, can only come from the responder. The responder may always add
a plain note that does not count as a response, and may decline any act request, which satisfies it
with a refusal.

**R13. Deadlines are advisory.** An item may carry a respond-by time and display-only text describing
what the agent intends if there is no response. The server never acts on a deadline. What a missed
deadline means is entirely the agent's choice: proceed on an assumption, stop and report stalled,
ask someone else, or anything else.

**R14. External references are inert.** An item may reference external things (pull requests, work
items, SDD decision IDs, CI runs) with a label plus an identifier, an HTTPS URL, or both. References
are displayed, never fetched or followed by the server.

**R15. Relationships are minimal.** An item may name one related item when created and one item to
see instead when closed (superseded, or settled by another item). In v1 both must be in the same
session.

**R16. Items carry topics.** An item may carry free-form topic tags (for example `auth`) so related
items can be found together. The agent sets them and the human may add or remove them.
Each change is an attributed entry. The human's views group and filter by topic across all sessions.

**R17. Either party closes and reopens.** The agent or the human may close an item with an outcome of
complete or withdrawn plus detail text, and either may reopen it. Every close and reopen is
attributed. Either party may reply on a closed item; a reply does not reopen it.

**R18. Agents can find their items.** An agent can list its session's items, paged, filtered by open
or closed, request and topic, so a new harness conversation in the same session can pick up where
the last one left off.

### Awareness and concurrency

**R19. Every identity has an ack cursor.** For each item it can see, each identity has acknowledged
through some entry. Unread means entries beyond the cursor. Acknowledging never changes the item or
conflicts with any write. Each party sees the other's cursor on what it can see. Marking items read
in bulk is an acknowledgement like any other, so it satisfies see requests.

**R20. Item writes cannot race.** Every item write states the latest entry sequence the writer has
seen. If another entry landed first, the write fails as stale and returns the missed entries. A
successful write advances the writer's cursor to the new entry. Every write carries a client request
identifier: a retry with the same identifier and the same content returns the original result, and
the same identifier with different content is rejected.

**R21. Derived signals are computed, never stored.** At minimum:

- blocked on you: open, request act and unsatisfied, impact blocking;
- overdue: open, past respond-by, request unsatisfied;
- closed while waiting on you: closed by the agent with an act, see or dismiss request unsatisfied;
- quiet: the session has not been seen within a configurable threshold;
- stranded: open items with entries the session has not acknowledged while the session is stopped,
  quiet or without an active credential.

### Sessions

**R22. Sessions have state and progress.** A session is working, waiting (on something outside) or
stopped with an outcome of completed, withdrawn or stalled. A stopped session may resume. A session
may carry a title, an explicitly set goal and a rough percent estimate. A new goal replaces the
previous goal and its progress. Goals are never inferred.

**R23. Session updates ride normal traffic.** Any agent call may carry an optional session envelope
(state, outcome, goal, percent, note). Omitting it means unchanged; a call carrying only the
envelope serves quiet stretches. The envelope is applied once the call is authenticated and
authorized, whether or not the rest of the call succeeds. Changes are appended to a session log
shown to the human with an ack cursor. Session updates are exempt from the stale rule
because only the session writes its own state; the latest update wins.

**R24. Presence is observed.** Every authenticated agent call records when its session was last seen.

### Human experience

**R25. Two views of attention.** A needs-you view lists open items with an unsatisfied act or dismiss
request and unacknowledged see requests, with blocked-on-you first. An updates view lists everything
unread, including agent closures (with closed-while-waiting-on-you flagged) and session state
changes. Consecutive progress-only session updates collapse.

**R26. Human operations are explicit.** The human, as responder, can respond, add notes, acknowledge, close and
reopen items, edit topics, manage session groups, and approve,
reject and revoke registrations. The human does not create items or set request, impact or form in
v1.

**R27. The UI stays current.** Views refresh without manual action while visible, and an expired
human session leads to sign-in rather than a dead error.

**R28. The human groups sessions.** The human can create, rename and remove private session groups
(for example "work project X", "personal project A"), each session in at most one group. Groups organize the human's views only: agents never see them and they grant nothing. The
human can browse by group or by agent, then session, then items, with attention counts rolling up.

**R29. Stale writes keep the draft.** When a human write fails as stale, the UI shows the missed
entries and keeps the draft so one action acknowledges and resubmits.

### Operation

**R30. Listen address, TLS mode and public origin are independent settings.** Agention either
terminates TLS with a provided certificate or serves plain HTTP behind a TLS-terminating proxy. The
public origin is always HTTPS. Plain HTTP on a non-loopback address (anything other than
`127.0.0.0/8` or `::1`) is refused unless explicitly enabled. Proxy mode trusts no forwarded or
identity headers.

**R31. Transport is path-agnostic.** Any TCP path that delivers bytes to the one origin works. No
authentication decision or rate limit is keyed on source address or network identity. Each class of
unauthenticated endpoint has its own budget, so exhausting registration cannot block passkey sign-in
or token refresh.

**R32. Tailscale is the documented path, not a dependency.** Documentation shows running Agention on
loopback behind `tailscale serve`. Nothing requires Tailscale.

**R33. Bounded inputs and typed errors.** Every text field, list and page has a documented bound.
Errors are typed (at least invalid input, not found, stale, request-id conflict, rate limited,
unauthenticated) and consistent across the agent and human surfaces.

**R34. Consistent backup.** The operator can take a consistent backup of a running instance and
restore it, following documented steps. History is retained indefinitely.

### Product guidance and distribution

**R35. One concise agent skill.** A single canonical usage skill, distributed as Claude Code and
Codex plugins generated from one canonical plugin definition and installable from the repository, leads with the normal loop and a concrete example,
states a small set of hard rules, and relies on tool schemas for payload shapes.

**R36. Agentworks is optional.** Setup may default agent and session names from `AGENTWORKS_AGENT`
and `AGENTWORKS_SESSION` when present. Nothing else depends on Agentworks.

### Engineering

**R37. Self-hosted and open source.** Go server, React web UI, one SQLite database, MIT license, no
paid services.

**R38. Reproducible and consistent with sibling projects.** Exact dependency and action pins with
integrity checks, one versioned release stream with a changelog, automated dependency update
proposals, and repository conventions aligned with agentworks and nerftools where the stack allows.

## Operator rulings, 2026-10-25

Recorded from the design conversation.

1. Rebuild on a fresh branch rather than modifying the predecessor PR.
2. Hosting is the operator's personal Tailnet. Tailscale is not the authentication solution:
   Agention keeps its own authentication and authorization. "Run behind a proxy that terminates TLS"
   and "address to listen on" are orthogonal settings. Tailscale is not tightly coupled; make its path
   easy and documented. An embedded Tailscale startup mode is open for later discussion.
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
6. Adopt the Agentworks session model: the agent is the user, the session is the workload and belongs
   strictly to one agent, and items belong to sessions. Do not assume Agentworks; agents identify
   their sessions, optionally defaulting from the Agentworks environment variable.
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

## Out of scope for v1

- Item type labels (ruling 12): a known next step.
- Human-originated items, multiple humans and delegated human roles.
- An external identity issuer integration; only the mapping seam (R4) is in scope.
- Embedded Tailscale mode, Tailscale ACL lockdown, and reachability from machines shared in from
  another tailnet. These are deployment follow-ups.
- Push notifications, email, or any delivery channel beyond the web UI.
- Executing, fetching or acting on item content; granting permissions; controlling harnesses.

## Open questions

1. How the agent states its session. The HLA proposes a per-session MCP URL path, pending
   real-install verification on both hosts.
2. Where the shared Wayfarer developer artifact set lives and how repositories consume it (ruling
   19). Its curation is a cross-repository effort of its own; this effort consumes it.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- An agent on a separate VM registers, reports items across every request and response form, and
  reads human responses through the real MCP endpoint behind `tailscale serve`.
- The operator completes the passkey and inbox flows on a real phone.
- Releases are versioned and the repository passes its documented checks in CI.
