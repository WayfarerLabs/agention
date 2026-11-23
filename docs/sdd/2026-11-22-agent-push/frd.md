# Agent push: Functional Requirements

- Status: Accepted by the operator, 2026-11-22 (ruling 2)
- Date: 2026-11-22
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim.
- Research: [prior art and host research](prior-art-research.md)
- Origin: agention#63, split out of agention#16 at the operator's direction (ruling 1). Agention as
  released in 0.6.0 is the baseline.

## Why this exists

An agent learns of what the operator writes only when it checks, with `message_wait` or the thread
tools. While it works, it checks between steps. Once its turn ends and it sits at its host's prompt,
nothing reaches it unless it keeps a background waiter of its own running, as the usage skill tells
it to, and a host that cannot run one, or an agent that forgets, leaves the operator's thread
stranded until they go to its terminal.

Agention exists so the operator can answer from wherever they are, often a phone, and have the work
carry on. That holds only as far as the answer reaches the agent. Push closes the gap.

ADR 0001 left push for a later release, and holds that Agention never injects text into an agent's
conversation. Every means a host offers to reach an agent at its prompt puts text in front of it, so
this effort supersedes that limit for one notice only, which P2 bounds.

## Who this is for

- **The operator**, who writes to an agent in Agention and expects the agent to act on it without
  going to its terminal.
- **Agents**, which should hear of what the operator wrote without keeping a waiter running, and
  know reliably whether they still have to.
- **Maintainers**, who ship the bridge and the plugins for two hosts that differ in what a plugin
  can do to a running session.

## Terms

- **At its prompt**: an agent whose turn has ended and whose host session is open, waiting for
  input. This is the host's condition, not the session's reported state: an agent at its prompt may
  have reported `working`, `idle` or `stopped`.
- **Push**: bringing what the operator wrote to an agent at its prompt, so that it takes a turn,
  without the agent, the operator or anyone at the terminal acting.

## Functional requirements

### What is pushed

**P1. The operator's messages are pushed.** When a message the operator wrote lands in one of a
session's threads, whether it starts the thread, answers an ask or tells the agent something, every
host session serving that session with push live is pushed. Nothing else is pushed.

**P2. A notice, never the message.** A push says only which threads have unread messages from the
operator, and how many, and tells the agent to read them with the thread tools. The message's text,
its detail and its files reach the agent only through those tools, which carry its author and mark
what was read, so a push never stands in for the operator's words. This notice, written by the
plugin, is the only text Agention puts into an agent's conversation; Agention still grants no
permission and acts on no message's content.

**P3. Once per message.** Each message is pushed to a host session at most once, whether or not the
agent then reads it, and a push names what is unread when it is sent.

**P4. Whatever the session reported.** An agent at its prompt is pushed whether its session reported
`working`, `idle` or `stopped`, since the operator writing to a stopped session is how they start it
again. A bridge whose registration is not approved is pushed nothing; push starts once one for its
key is approved.

**P5. What the operator sees stays as it is.** The sessions view does not show whether a session has
push, and a thread is stranded as it is today. The operator guide says that a session with push may
still pick up what they write to a stranded thread, and that resuming it at its terminal is the sure
way.

### Hosts

**H1. Each host as far as it allows.** On Claude Code and on Codex, push works by a means the host
offers a plugin, where one exists. A host that offers none has no push and works as today. The
operator guide says, per host, whether push works there and what it needs.

**H2. No setup.** Installing or updating the plugin is all push needs. On Claude Code, a means that
needs the operator to opt in at every launch, such as a development flag, is not used (ruling 2);
where a host offers only such a means, that host has no push.

**H3. The register answer tells the truth.** `register`'s answer says answers are pushed only when
the bridge can tell push is live for its host session, and otherwise that answers reach the agent
when it checks, as today. The usage skill tells the agent what each means: with push, an agent with
nothing else to do ends its turn and waits, with no waiter of its own; without it, it keeps checking
as today.

**H4. Push does not lapse silently.** Push told to an agent stays live for the host session's life:
it recovers on its own from a server restart, a lost connection or a pending re-registration. Where
it cannot recover, the agent's next tool answer says answers now reach it only when it checks.

### Compatibility and cost

**C1. Within the release lines.** A bridge with push works against every server that serves its
agent API version. If push needs a change to the agent contract, it ships by the release lines'
rules (`docs/sdd/2026-11-22-separate-releases/frd.md` R2 and C2), and against an older server the
bridge fails as that FRD's C3 requires. A bridge without push is unaffected by a server with it.

**C2. Bounded cost.** While nothing arrives, push costs no model turns and holds at most one waiting
request per host session on the server, putting no more load on it than an agent's long poll does
today.

### Engineering

**E1. Collateral.** A new ADR records how push is delivered on each host and supersedes ADR 0001's
"No push", and amends its "No permissions, no harness control" and "Never holds up" for P2's notice.
README, `docs/review-checklist.md` A1, `SECURITY.md` (the agent bridge), the architecture document,
the operator guide (push per host, any opt-in, stranded threads), the usage skill and its "how
answers reach you" guidance, `docs/live-testing.md` and the development contract describe push.

**E2. Tested at its boundary.** Push, its absence, its recovery and the compatibility cases of C1
are tested against the bridge and plugin as each host runs them.

## Out of scope

- Notifying the operator (agention#30); this is the agent's side.
- The thin-proxy bridge, a direct MCP endpoint on the server, and a bridge that falls back to an
  older server's agent API version (agention#16).
- Pushing to a host session that is closed, or starting one.
- Telling a working agent of unread messages in its tool answers; it checks between steps as today.
- Changing how a host installs or updates plugins, or asking a host's maker to allowlist the plugin.
- Claude Code's channels, while a custom channel needs a flag at every launch (ruling 2).

## Operator rulings, 2026-11-22 onward

1. (2026-11-22) After the effort lead assessed agention#16 against 0.6.0 and recommended splitting
   push out as its own effort, keeping the current agent identity, and leaving the thin proxy parked
   until the server serves MCP directly, the operator chose "Split, then FRD for push": comment on
   agention#16 that versioning has shipped, open a push issue, and draft a push FRD with a host
   spike first. They added: "Please note the release split PR #61, too." Taken: agention#63, this
   SDD, and C1.

2. (2026-11-22) Asked whether to accept these requirements, including P2's notice as the one
   exception to ADR 0001's rule against injecting text into an agent's conversation, the operator
   chose "Accept". Asked whether the operator guide may teach Claude Code's channels opt-in, a flag
   passed at every launch that shows a warning, as a fallback if the plugin-hook path does not work,
   they chose "Hook only". Asked whether the bridge may wake a Codex session with `codex queue`,
   whose message arrives as if the operator typed it, and whether to widen the development
   contract's Codex bound to a live check of it, they chose "Yes, and test it live". Asked when the
   hands-on spike should run, and whether it may launch separate interactive Claude Code and Codex
   sessions on this VM with a development build of the plugin, they chose "After acceptance, yes".
   Taken: this FRD as accepted, H2, the Codex line of the definition of done, the widened Codex
   bound, and the spike.

3. (2026-11-22) After the spike showed a hook's watcher ends at its timeout, set to a day, the
   operator was asked whether it is OK that a Claude Code session sitting at its prompt for over a
   day stops being pushed until its next turn, with the operator guide stating the limit; they chose
   "Yes, state the limit". Taken: H4 holds within that limit, which the operator guide states.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- Live on Claude Code: an agent at its prompt is pushed when the operator starts a thread with it
  from the web UI, reads the thread and acts on it, and its `register` answer said answers are
  pushed.
- Live on Codex: where `codex queue` wakes a session, an agent at its prompt is pushed when the
  operator starts a thread with it, and otherwise the operator guide and the `register` answer say
  Codex has no push.
- The repository passes its documented checks in CI.
