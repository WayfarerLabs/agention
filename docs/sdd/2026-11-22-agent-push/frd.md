# Agent push: Functional Requirements

- Status: Draft, for the operator's acceptance
- Date: 2026-11-22
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim.
- Research: [prior art and host research](prior-art-research.md)
- Origin: agention#63, split out of agention#16 at the operator's direction (ruling 1). Agention as
  released in 0.6.0 is the baseline.

## Why this exists

An agent learns of what the operator writes only by calling `message_wait`. While it works, it
checks between steps. Once its turn ends and it sits at its host's prompt, nothing reaches it: a
thread the operator starts with it, or an answer to one of its asks, waits until the operator nudges
it at its terminal or it happens to run a background waiter of its own. Every agent has to be taught
to keep such a waiter running, and one that forgets goes deaf.

Agention exists so the operator can answer from wherever they are, often a phone, and have the work
carry on. That holds only as far as the answer reaches the agent. Push closes the gap: when the
operator writes to a session, the agent bridge puts it in front of the agent by whatever means its
host offers, waking an idle session where the host allows it.

## Who this is for

- **The operator**, who writes to an agent in Agention and expects the agent to act on it without
  going to its terminal.
- **Agents**, which should hear of what the operator wrote without polling, and know reliably
  whether they still have to check for themselves.
- **Maintainers**, who ship the bridge and the plugins for two hosts that differ in what an MCP
  server can do to a running session.

## Functional requirements

### What is pushed

**P1. What the operator writes reaches the agent.** When a message the operator wrote lands in one
of a session's threads, whether it starts a thread, answers an ask or tells the agent something,
every bridge serving that session with push brings it to the agent's attention without the agent
calling a tool. Nothing else is pushed: not the session's own messages, nor another session's.

**P2. A push says what to read, not the message itself.** A push names the threads with unread
messages from the operator and says what arrived in each (a new thread, an answer, a message), and
tells the agent to read them with the thread tools. The message's text, its detail and its files
reach the agent only through those tools, which carry its author and mark what was read, so a push
can never stand in for the operator's words.

**P3. A burst is one push.** Several messages landing close together, in one thread or several,
reach the agent as one push naming them all, and a message the agent has already read is never
pushed again.

**P4. A push never interrupts work in progress.** While the agent is in a turn, a push waits for the
turn to end, or arrives with its next tool answer, as the host allows; it never cuts a step short.

**P5. It reaches the session whatever its reported state.** A session reported `idle` or `stopped`
whose host session is still open receives pushes like a `working` one, since the operator writing to
a stopped session is how they start it again. A session whose credential the operator revoked
receives nothing.

### Hosts

**H1. Push on each host as far as it allows.** On Claude Code and on Codex, push works by the best
means the host offers a plugin: waking an idle session where it can, and otherwise reaching the
agent at its next turn or tool answer. The operator guide says, per host, what push does there and
what it does not.

**H2. No setup where the host needs none.** Where a host lets a plugin push without the operator's
configuration, installing or updating the plugin is all push needs. Where a host requires the
operator to opt in, for each session or once, the operator guide says how, and a session without the
opt-in works as it does today.

**H3. The agent knows how answers reach it.** `register`'s answer says, for this session as it is
running, whether answers are pushed to the agent or reach it only when it checks, and the usage
skill tells the agent what each means for its loop: with push, an idle agent ends its turn and
waits, with no waiter of its own; without it, it keeps checking as today. The answer never claims
push the session does not have.

**H4. Working agents hear of unread messages on any host.** When the session has messages from the
operator the agent has not read, a tool's answer says so, in a line after the answer as the status
reminder is, at most once per new message, so an agent that is working learns of them on every host
whether or not it can be woken.

### Compatibility

**C1. Within the release lines.** Push follows the release lines of agention#61: what it needs of
the server ships on the server line first, and the bridge that uses it on the agent line after, by
that effort's release order. Push that needs no server change ships on the agent line alone.

**C2. Across versions.** A bridge with push against a server without what push needs works as it
does today, its `register` answer saying answers reach it when it checks; a bridge without push
against a newer server works as it does today. Neither case needs the operator to act.

**C3. Bounded cost.** Holding a session ready for push costs the server no more than one waiting
request per bridge, which ends when the session's credential is revoked or the bridge exits, and
costs the host no model turns while nothing arrives.

### Engineering

**E1. Collateral.** The architecture document, the operator guide (push per host, any opt-in), the
usage skill and its "how answers reach you" guidance, README and the development contract describe
push, and an ADR records how it is delivered on each host.

**E2. Tested at its boundary.** Push, its absence, and the compatibility cases of C2 are tested
against the bridge as a host runs it, and live on Claude Code: an idle session wakes and reads a
thread the operator starts with it from the web UI.

## Out of scope

- Notifying the operator (agention#30); this is the agent's side.
- The thin-proxy bridge, a direct MCP endpoint on the server, and a bridge that falls back to an
  older server's agent API version (agention#16).
- Pushing to a host session that is closed, or starting one: push reaches only a session whose host
  is running it.
- Changing how a host installs or updates plugins, or asking a host's maker to allowlist the plugin
  for a capability.

## Operator rulings, 2026-11-22 onward

1. (2026-11-22) After the effort lead assessed agention#16 against 0.6.0 and recommended splitting
   push out as its own effort, keeping the current agent identity, and leaving the thin proxy parked
   until the server serves MCP directly, the operator chose "Split, then FRD for push": comment on
   agention#16 that versioning has shipped, open a push issue, and draft a push FRD with a host
   spike first. They added: "Please note the release split PR #61, too." Taken: agention#63, this
   SDD, and C1.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- Live on Claude Code: an idle session wakes and reads a thread the operator started with it from
  the web UI, and its `register` answer said answers are pushed.
- Live on Codex: the session gets what H1 says it can, and its `register` answer is accurate.
- The repository passes its documented checks in CI.
