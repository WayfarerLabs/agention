# Agent presence and nudge: Functional Requirements

- Status: Draft, for the operator's acceptance
- Date: 2026-11-23
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim.
- Research: [prior art and host research](prior-art-research.md)
- Origin: agention#63, its scope changed at the operator's direction (ruling 1) after agention#67,
  push by a Claude Code hook, was closed unmerged. Agention as released in 0.6.0 is the baseline.

## Why this exists

An agent learns of what the operator writes only when it checks. Once its turn ends and it sits at
its host's prompt, nothing reaches it, and the operator's thread waits until they go to its
terminal. Agention exists so the operator can answer from wherever they are, so the gap matters.

Two things close it. The operator needs to see what a session is really doing: today they see when
it last called the server and what it last reported, which cannot tell an agent working without
checking from one sitting at its prompt, or one stuck at a permission dialog nobody is watching. And
an agent at its prompt needs waking. No host offers a plugin a way to wake an open session on every
host, but a terminal does: under Agentworks every session runs in a tmux pane of its own, and the
bridge, running inside it, can type into it.

Typing into a terminal reaches whatever has the keyboard, so the nudge is one fixed message and
nothing more, sent only after checks that it lands where it should. ADR 0001 holds that Agention
never injects text into an agent's conversation; this effort makes that one message the only
exception.

## Who this is for

- **The operator**, who writes to an agent from Agention, often on a phone, and wants to know
  whether it will see it, and have it see it without going to its terminal.
- **Agents**, which should be woken to check in rather than keep a waiter running.
- **Agentworks**, which runs every session in a tmux server it owns and can tell the bridge where.
- **Maintainers**, who ship one bridge for hosts that differ in what a plugin can do.

## Terms

- **At its prompt**: an agent whose turn has ended and whose host session is open, waiting for
  input. This is the host's condition, not the session's reported state.
- **The pane**: the terminal pane the agent's host runs in, as the bridge's configuration names it.
- **Nudge**: the bridge submitting one fixed message at the agent's prompt, as if typed, so the
  agent takes a turn and checks in with Agention.
- **Checking in**: the agent calling an Agention tool.

## Functional requirements

### Presence

**PR1. Connected.** While a session's bridge runs with an approved registration, the server knows it
is connected, whatever the agent is doing, and stops showing it connected within about a minute of
the bridge ending. This holds on every host, with or without a pane.

**PR2. Agent activity, apart from the bridge's.** The server knows when the agent last checked in,
apart from when its bridge last called, so the operator sees, for example, "connected, no activity
for 3 hours", or a session that reported `working` and has not checked in for 2 hours.

**PR3. What the pane shows.** Where the bridge is given the pane (CF2), the operator also sees what
it shows, and since when: a turn running, the agent at its prompt, a dialog waiting for someone at
the terminal (such as a permission prompt), or unknown. A dialog is recognized on the hosts the
bridge knows; on others the pane is running or at rest.

**PR4. Stranded tells the truth.** A thread is stranded when nothing will bring what the operator
wrote to the agent: its bridge is not connected, or it is connected with no nudge and the agent has
not checked in within the quiet time, or its session stopped or has no active credential. A thread
whose session can be nudged is not stranded while the nudge can work.

**PR5. Nudge state.** Where the nudge is on, the operator sees when the session was last nudged, and
when a nudge stopped after a failed check (N6), with why.

**PR6. Only the derived state leaves the machine.** No text from the pane reaches the server, the
operator or the agent: presence carries the states and times above and nothing else.

### Nudge

**N1. When.** When a message the operator wrote lands in one of a session's threads and the agent
has not checked in since, the bridge nudges the agent, whatever state its session reported, since
the operator writing to a stopped session is how they start it again. A bridge whose registration is
not approved, or whose nudge is off, nudges nothing.

**N2. One canned message.** A nudge submits one fixed message, the same every time, telling the
agent to check in with Agention: read its unread threads and bring its session's status up to date.
It names no thread and carries nothing from the server, so nothing the operator, an agent or anyone
else wrote reaches the agent's prompt through it. The message's text, the messages' authors and what
was read reach the agent only through Agention's tools, as today.

**N3. Once until the agent checks in.** A session is nudged at most once for what arrived before it
next checks in, and nudges are spaced so a session that does not respond is not nudged repeatedly.

**N4. Only when it is safe to type.** The bridge nudges only when the pane has shown no change for a
while, no one has typed into it recently, it is not in a mode where keys do not reach the host (such
as tmux's copy mode), and it shows no dialog the bridge recognizes. Otherwise it waits and tries
again.

**N5. A warning first, and the operator can stop it.** Before the message, the bridge puts a visible
warning at the prompt, saying a nudge is coming and that typing anything stops it, and leaves it for
a few seconds. If the warning is then not exactly as written, alone on its line, the bridge clears
nothing it did not type and abandons the nudge. Otherwise it removes the warning, checks the line is
empty, puts the message there, checks it, and submits it. Text reaches the pane as pasted text,
never as keystrokes that a dialog could take as shortcuts; only the keys that remove the warning and
submit the message are keystrokes.

**N6. Watched, and stopped on anything odd.** After submitting, the bridge checks the host took the
message: the line is clear and a turn starts. When any check after the first keystroke fails, the
bridge stops nudging that session until the agent next registers, says so in presence (PR5), and
leaves the pane as it is.

### Configuration

**CF1. Off unless asked for.** The nudge is off unless the bridge is started with a nudge type, as a
command-line option or an environment variable, the option winning. `tmux` is the one type; others
may follow.

**CF2. The pane is named, never guessed.** The bridge reads the pane only where its configuration
gives the tmux socket and the target pane, as options or environment variables. It never infers them
from an inherited `TMUX` or from a known socket location. The configuration leaves room for other
tmux setups, such as another tmux program or a named socket. Presence's pane state (PR3) needs only
this; the nudge needs this and CF1.

**CF3. Agentworks supplies it.** Agentworks passes the socket path and target, and the nudge type,
through its templating, so every Agentworks session gets presence and the nudge without setup. That
change is Agentworks's; this effort states what it needs and tests against it.

**CF4. Misconfiguration is visible, never fatal.** A pane the bridge cannot reach, or a nudge type
it does not know, shows in presence and in the bridge's log, and Agention's tools work as without
it.

### Telling the agent

**T1. The register answer says how answers arrive.** `register` says the agent will be nudged when
the nudge is on and the pane is reachable, and otherwise that answers reach it when it checks, as
today. The usage skill says what each means: when nudged, an agent with nothing else to do reports
`idle` and ends its turn, with no waiter of its own; on a nudge, it checks in and updates its
status; otherwise it keeps checking as today.

### Compatibility and cost

**C1. Within the release lines.** Presence changes the agent API and the server, so it ships by the
release lines' rules (`docs/sdd/2026-11-22-separate-releases/frd.md` R2 and C2). A bridge with
presence against a server without it fails as that FRD's C3 requires; the nudge needs nothing new of
the server.

**C2. Bounded cost.** While nothing changes, a session costs no model turns, holds at most one
waiting request on the server, and sends presence only when it changes. Reading the pane costs a few
tmux calls at a time, at intervals the HLA bounds.

### Engineering

**E1. Collateral.** A new ADR records presence and the nudge, superseding ADR 0001's "No push" for
agents and amending its "No permissions, no harness control" for the one canned message. README,
`SECURITY.md` (the agent bridge), `docs/review-checklist.md`, the architecture document, the
operator guide (presence, the nudge, its configuration, stranded threads), the usage skill and the
tools' descriptions, `docs/live-testing.md` and the development contract describe them.

**E2. Tested at its boundary.** Presence, the nudge and every guard are tested against the bridge
driving a real tmux server, and the compatibility cases of C1 as the release lines require.

## Out of scope

- A Claude Code hook as a nudge type, as agention#67 built; it may come later as another type.
- Terminals other than tmux, and harnesses outside one.
- Nudging a session whose host has ended, or starting one.
- Notifying the operator (agention#30); this is the agent's side.
- The thin-proxy bridge and a direct MCP endpoint on the server (agention#16).

## Operator rulings, 2026-11-23 onward

1. (2026-11-23) After the effort lead found that the bridge can type into its session's tmux pane
   and proposed it only for hosts without a wake hook, the operator answered at the terminal: "So
   honestly, I disagree with limiting this. My thinking is that we should descope "push" to "nudge".
   The sole purpose is to wake the session and tell them to check in with Agention including making
   sure their status is up to date. I think we very specifically avoid anything other than a single
   canned message to steer clear of any prompt injection stuff." They proposed sampling the pane,
   refusing at a permission prompt, a warning the operator can abort, and observing the result;
   asked "if the bridge stays up even when the session is idle, should we be able to report on that
   condition (bridge connected but idle for ...)?"; proposed "something like a --nudge-type option
   passed as part of the mcp server command (standard cli arg plus env var). That ensures that
   Agentworks can set it when it should apply."; and said "I think we just build this and solve the
   problem once for all Agentworks installs. Then we can consider other nudge types." They then said
   "it seems like we should be able to leverage this same mechanism for much better presence
   reporting even before the nudge", and of agention#67, "Merging that as-is is just inviting
   confusion, right?". Offered closing agention#67 and carrying its bridge wait forward, or
   rewriting it in place, and one SDD with presence first or two efforts, they answered: "Also, I'm
   open to having agentworks provide the path to the tmux socket. That's not supported today but
   would be an easy add to our templating feature. That's probably way better than assuming a
   particular location. Likewise we should leave room for args/vars that allow for other tmux
   configurations. Beyond that, this all looks great!" Taken: agention#67 closed with its branch
   kept, agention#63 given this scope, this SDD with presence first, N2, N4 to N6, CF1 to CF3, and
   PR1 and PR2.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- Live under Agentworks, on Claude Code and on Codex: the operator sees a session connected, its
  activity and its pane's state, including a permission dialog; an agent at its prompt is nudged
  when the operator starts a thread with it from the web UI, checks in and updates its status; a
  nudge is refused at a permission dialog and while someone types, and stops when the operator types
  over the warning.
- The repository passes its documented checks in CI.
