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
never injects text into an agent's conversation or controls its harness; this effort makes that one
message, and the one key that submits it, the only exception.

## Who this is for

- **The operator**, who writes to an agent from Agention, often on a phone, and wants to know
  whether it will see it, and have it see it without going to its terminal.
- **Agents**, which should be woken to check in rather than keep a waiter running.
- **Agentworks**, which runs every session in a tmux server it owns and can tell the bridge where.
- **Maintainers**, who ship one bridge for hosts that differ in what a plugin can do.

## Terms

- **At its prompt**: an agent whose turn has ended and whose host session is open, waiting for
  input. This is the host's condition, not the session's reported state.
- **The pane**: the terminal pane the agent's host runs in: the one pane of the tmux server the
  bridge's configuration names.
- **Profile**: what the bridge knows about one host, which decides whether the pane is at its prompt
  and how to clear what the bridge put there. A host's own profile knows the most; generic profiles,
  a strict and a lenient one, make what sense they can of a host with none.
- **Pane state**: what the pane shows, one of: **running**, a turn in progress; **at its prompt**,
  the host's input line at rest, as the profile decides; **waiting**, at rest but not at its prompt,
  such as a permission dialog, a pager or an editor; and **unknown**, when the bridge cannot read
  the pane.
- **Nudge**: the bridge submitting one fixed message at the agent's prompt, as if typed, so the
  agent takes a turn and checks in with Agention.
- **Checking in**: the agent calling an Agention tool. The bridge's own background requests are not
  checking in.

## Functional requirements

### Presence

**P1. Connected, and whether it can be nudged.** While a session's bridge runs with an approved
registration, the server knows it is connected, whatever the agent is doing, and stops showing it
connected within about a minute of the bridge ending. This holds on every host, with or without a
pane. The bridge also says whether its nudge is on and its pane reachable, so the operator can tell
a session that can be nudged from one that cannot.

**P2. Agent activity, apart from the bridge's.** The server knows when the agent last checked in,
apart from when its bridge last called. What the operator sees today as a session's last seen
becomes its agent's last check-in, shown beside whether it is connected, so they see, for example,
"connected, no activity for 3 hours", or a session that reported `working` and has not checked in
for 2 hours. The operator guide's account of `idle` changes with T1: an idle agent that is nudged
waits at its prompt rather than checking.

**P3. What the pane shows.** Where the bridge is given the pane (CF2), the operator also sees its
pane state and since when.

**P4. Stranded tells the truth.** A thread is stranded when the agent has not read the operator's
latest message and nothing will bring it to the agent soon:

- its session has no active credential or its bridge is not connected (P1);
- its bridge is connected without a nudge (P1), and its session has stopped or is quiet, where quiet
  now reads when the agent last checked in (P2), not when its bridge last called; or
- its bridge can be nudged, and that message has waited unread longer than the quiet time, so the
  nudge had its chance and did not work.

A session that can be nudged is not stranded merely for waiting at its prompt, which is what T1
teaches it to do.

**P5. One bridge acts for a host session.** A host may run several bridges for one session, as Codex
does when it starts new ones without ending the old, and all of them share its key and its approved
registration, even when they come from different plugin versions. Only one of them holds the wait,
reports presence and nudges; the others do neither. When a bridge that predates presence runs beside
one that reports it, the newer one's presence applies and the older one's calls count as check-ins.

**P6. Presence is the operator's, and holds no pane text.** Presence reaches the operator, through
the web UI and the operator API's session reads, and never an agent. No text from the pane reaches
the server, the operator, the agent or the bridge's log: presence carries the states and times above
and nothing else.

### Nudge

**N1. When.** When a message the operator wrote lands in one of a session's threads and the agent
has not checked in since, the bridge nudges the agent, whatever state its session reported, since
the operator writing to a stopped session is how they start it again. A bridge whose registration is
not approved, or whose nudge is off, nudges nothing. When the operator approves a registration while
the agent sits at its prompt, presence and the nudge start without the agent calling a tool (ruling
2).

**N2. A warning, then one canned message.** A nudge puts two texts in the pane, one after the other.
First a warning, saying a nudge is coming and that typing anything stops it, which the bridge
removes and never submits; it carries a token unique to that nudge, made by the bridge, so the
bridge can tell its own warning from anything else on the screen. Then the message, the same every
time, telling the agent to check in with Agention: read its unread threads and bring its session's
status up to date. Neither names a thread or carries anything from the server, so nothing the
operator, an agent or anyone else wrote reaches the agent's prompt through a nudge, and the bridge
submits only the message. The messages, their authors and what was read reach the agent only through
Agention's tools, as today.

**N3. Once until the agent checks in.** A session is nudged at most once until the agent next checks
in, whether that nudge was submitted, stopped by someone typing (N5) or failed its checks (N6).

**N4. Only at its prompt, and only when still.** The bridge nudges only when the host itself has the
terminal (not an editor, pager, shell or password prompt it started), the profile finds the pane at
its prompt, the pane has shown no change for a while, no one has typed into it recently, and it is
not in a mode where keys do not reach the host (such as tmux's copy mode). Anything else means it
waits and tries again. Which profile applies is configurable, defaulting to the host's own where the
bridge has one; adding a host's profile is a change to the profiles alone.

**N5. Warn, clear, send, and the operator can stop it.** The warning sits at the prompt for a few
seconds. If it is then not exactly as the bridge put it there, alone on its line, the bridge
abandons the nudge and removes nothing. Otherwise it removes the warning, checks the line is empty,
puts the message there, checks it, and submits it. Text reaches the pane as pasted text; only the
keys that remove the warning and submit the message are keystrokes, and they are sent only after the
pane has shown the bridge's own text where the profile expects the input line.

**N6. Watched.** After submitting, the bridge checks the host took the text: the line is clear and a
turn starts. When a check fails, it leaves the pane as it is and logs why, without pane text (P6).

### Configuration

**CF1. Off unless asked for.** The nudge is off unless the bridge is started with a nudge type, as a
command-line option or an environment variable, the option winning. `tmux` is the one type; others
may follow, such as a nudge through a host's SDK.

**CF2. The pane is named, never guessed.** The bridge reads the pane only where its configuration
gives the tmux socket, as an option or environment variable. It never infers it from an inherited
`TMUX` or from a known socket location. The socket is a path, named for tmux rather than for
Agentworks, so other tmux setups, a named socket among them, need nothing more. The tmux server
holds one pane, as Agentworks's sessions do (ruling 2); one with more is reported as unknown and
never nudged, and the configuration leaves room for naming a pane later. Presence's pane state (P3)
needs only this; the nudge needs this and CF1.

**CF3. Agentworks supplies it.** The plugins forward the environment variables of CF1, CF2 and the
profile (N4) to the bridge, which is the route a host's plugin configuration allows, and Agentworks
sets them through its templating, so every Agentworks session gets presence and the nudge without
setup. That change is Agentworks's; this effort states what it needs and tests against it.

**CF4. Misconfiguration is visible, never fatal.** A pane the bridge cannot reach, or a nudge type
it does not know, shows in the bridge's log and in the `register` answer (T1), and an unreachable
pane also as the unknown pane state (P3); Agention's tools work as without it.

### Telling the agent

**T1. The register answer says how answers arrive.** `register` says the agent will be nudged when
the nudge is on and the pane is reachable, and otherwise that answers reach it when it checks, as
today. The usage skill says what each means: when nudged, an agent with nothing else to do reports
`idle` and ends its turn, with no waiter of its own; on a nudge, it checks in and updates its
status; otherwise it keeps checking as today. Nothing tells the agent later that a nudge failed: a
nudge that does not work leaves its thread stranded (P4), which the operator sees.

### Compatibility and cost

**C1. Within the release lines.** Presence changes the agent API and the server, so it ships by the
release lines' rules (`docs/sdd/2026-11-22-separate-releases/frd.md` R2, C1 and C2). A bridge with
presence against a server without it fails as that FRD's C3 requires. A session whose bridge
predates presence keeps today's presence and stranded rule, every call it makes counting as a
check-in, so an older plugin's threads are not stranded for want of a connection it cannot report.

**C2. Bounded cost.** While nothing changes, what this effort adds costs no model turns, at most one
waiting request on the server for each host session, and presence sent only when it changes. Reading
the pane costs a few tmux calls at a time, at intervals the HLA bounds.

### Engineering

**E1. Collateral.** A new ADR records presence and the nudge, superseding ADR 0001's "No push" for
agents and amending its "No permissions, no harness control" for the one canned text and the key
that submits it. README, `SECURITY.md` (the agent bridge), `docs/review-checklist.md` (A1, the rule
that derived signals never trigger actions, and how a call marks a session seen), the architecture
document, the operator guide (presence, quiet, `idle`, stranded threads and the New thread sheet's
word on them, the nudge and its configuration), the usage skill and the tools' descriptions, the
plugin definition and the bridge's usage text, `docs/live-testing.md` and the development contract
describe them.

**E2. Tested at its boundary.** Presence, the nudge and every guard are tested against the bridge
driving a real tmux server, and the compatibility cases of C1 as the release lines require.

## Out of scope

- Other nudge types, such as a Claude Code hook as agention#67 built or a host's SDK; CF1 leaves
  room for them.
- Terminals other than tmux, harnesses outside one, and tmux servers with more than one pane.
- Nudging a session whose host has ended, or starting one.
- Notifying the operator (agention#30); this is the agent's side.
- The thin-proxy bridge and a direct MCP endpoint on the server (agention#16).

## Operator rulings, 2026-11-23 onward

1. (2026-11-23) After the effort lead found that the bridge can type into its session's tmux pane
   and proposed it only for hosts without a wake hook, the operator answered at the terminal: "So
   honestly, I disagree with limiting this. My thinking is that we should descope "push" to "nudge".
   The sole purpose is to wake the session and tell them to check in with Agention including making
   sure their status is up to date. I think we very specifically avoid anything other than a single
   canned message to steer clear of any prompt injection stuff. But then I think we take steps to
   make it as safe as we can. Some ideas: 1. Sample the tmux output several times leading up to it
   to make sure it's not changing 2. Attempt to detect a permission prompt and refuse the nudge 3.
   Before sending, maybe type out something like "Agention is about to nudge. Delete or type a
   character to abort..." and then wait, check again. If our string isn't there unchanged, abort.
   This should also help with sitting at weird prompts (although the keystrokes still go) 4. If all
   is good, clear our warning text and send the canned message. Then observe the result, looking for
   any weirdness." They asked "if the bridge stays up even when the session is idle, should we be
   able to report on that condition (bridge connected but idle for ...)?"; proposed "something like
   a --nudge-type option passed as part of the mcp server command (standard cli arg plus env var).
   That ensures that Agentworks can set it when it should apply."; and said "I think we just build
   this and solve the problem once for all Agentworks installs. Then we can consider other nudge
   types." They then said "it seems like we should be able to leverage this same mechanism for much
   better presence reporting even before the nudge", and of agention#67, "Merging that as-is is just
   inviting confusion, right?". Offered closing agention#67 and carrying its bridge wait forward, or
   rewriting it in place, and one SDD with presence first or two efforts, they answered: "Also, I'm
   open to having agentworks provide the path to the tmux socket. That's not supported today but
   would be an easy add to our templating feature. That's probably way better than assuming a
   particular location. Likewise we should leave room for args/vars that allow for other tmux
   configurations. Beyond that, this all looks great!" Taken: agention#67 closed with its branch
   kept, agention#63 given this scope, this SDD with presence first, N2 and N4 to N6, CF1 to CF3,
   and P1 and P2.

2. (2026-11-24) Asked in Agention, the operator answered: whether the spike may run now, "Yes, now";
   whether to widen the development contract's Codex bound to add "and live checks of presence and
   the nudge", "Yes"; whether to open an issue in the Agentworks repository for its templating,
   "Yes, open it. But note that the tmux sessions are single pane. The named consoles add the
   multiplexing and companion shells, etc. For now, we should start with that single pane
   assumption."; whether to accept this FRD, "Mostly right on but I feel like we now need to
   differentiate between "hasn't responded but online" vs "not online" vs "not responding to nudge".
   Let's take a moment to make sure we get those right."; whether to use one line or warn, clear and
   send, "Warn, clear, send. This keeps from polluting the agent context and allows us to put truly
   unique content in there for matching (which we probably should)."; whether presence and the nudge
   start when a registration is approved while the agent sits at its prompt, "Yes, start on
   approval"; and whether to nudge any harness behind general checks with optional per-host
   profiles, "Yeah, I think "profile" is a great way to think about this. The profile should own the
   "is this at the normal prompt" decision. The more we know about the harness, the better that
   decision can be. And then we can offer more generic profiles (perhaps a strict and lenient
   version?) that attempt to make sense of unknown harnesses. And we should leave room for SDK-based
   nudges, etc. Probably just other nudge types." Taken: the spike, the widened bound, the
   Agentworks issue, CF2's one pane, N1's start on approval, N2 and N5's warning, N4's profiles,
   CF1's room for other types; presence's states are being settled before acceptance.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- Live under Agentworks, on Claude Code and on Codex, with the configuration of CF1 and CF2 set by
  Agentworks or, until Agentworks ships it, by hand: the operator sees a session connected, its
  agent's activity and its pane state, including a permission dialog as waiting; an agent at its
  prompt is nudged when the operator starts a thread with it from the web UI, checks in and updates
  its status; a nudge is refused at a permission dialog and while someone types, and is abandoned
  when the operator types over its text.
- The repository passes its documented checks in CI.
