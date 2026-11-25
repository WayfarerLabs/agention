# Session monitoring and nudge: Functional Requirements

- Status: Draft, for the operator's acceptance
- Date: 2026-11-23, restructured with rulings 3 and 4
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim.
- Research: [prior art and host research](prior-art-research.md)
- Origin: agention#63, its scope changed at the operator's direction (rulings 1 and 3) after
  agention#67, push by a Claude Code hook, was closed unmerged. Agention as released in 0.6.0 is the
  baseline.

## Why this exists

The operator runs many agent sessions, under more than one account, and follows them from Agention,
often on a phone. Today Agention tells them only when a session last called the server and what its
agent last reported. It cannot tell an agent working without checking from one sitting at its
prompt, one stopped at a permission dialog nobody is watching, or one that hit its account's usage
limit, so the operator finds out by going to each terminal.

And an agent at its prompt learns of what the operator writes only when something wakes it. No host
offers a plugin a way to wake an open session on every host, but a terminal does.

Under Agentworks every session runs in a tmux pane of its own, and the bridge runs inside it. So the
bridge can **monitor** the session, reading its pane to say what condition it is in, and, where the
operator turns it on, **nudge** an agent sitting at its prompt by typing one fixed message.
Monitoring only reads, so it comes first and stands on its own; the nudge acts only on what
monitoring finds, behind checks of its own. ADR 0001 holds that Agention never injects text into an
agent's conversation or controls its harness; the nudge's one message, and the keys that place and
submit it, become the only exception.

## Who this is for

- **The operator**, who wants to see at a glance which sessions need them, and why, and have an
  agent see what they wrote without going to its terminal.
- **Agents**, which should be woken to check in rather than keep a waiter running.
- **Agentworks**, which runs every session in a tmux server it owns and can tell the bridge where.
- **Maintainers**, who ship one bridge for harnesses that differ in what their screens show and what
  a plugin can do, and change from version to version.

## Terms

- **The pane**: the terminal pane the agent's host runs in: the one pane of the tmux server the
  bridge's configuration names.
- **Condition**: where the session is now, as monitoring reads it from the pane (M3).
- **At its prompt**: the condition of a host whose turn has ended, waiting at its normal input line.
  It is the host's condition, not the session's reported state.
- **Stopped by**: why a session at rest stopped, where its profile can tell (M3).
- **Profile**: what the bridge knows about one harness: how to read each condition from the pane,
  and how to clear what the nudge puts there. A harness's own profile knows the most; the generic
  profiles, a strict and a lenient one, make what sense they can of a harness with none.
- **Can be nudged**: the nudge is on (CF1), the pane is reachable (CF2), and the profile in use can
  tell when the session is at its prompt.
- **Checking in**: the agent calling an Agention tool. The bridge's own background requests are not
  checking in.
- **Nudge**: the bridge submitting one fixed message at the agent's prompt, as if typed, so the
  agent takes a turn and checks in with Agention.

## Functional requirements

### Monitoring

**M1. Connected.** While a session's bridge runs with an approved registration, the server knows it
is connected, whatever the agent is doing, and stops showing it connected within about a minute of
the bridge ending. This holds on every host, with or without a pane. The bridge also says whether it
monitors a pane and whether the session can be nudged.

**M2. Agent activity, apart from the bridge's.** The server knows when the agent last checked in,
apart from when its bridge last called. What the operator sees today as a session's last seen
becomes its agent's last check-in, shown beside whether it is connected, so they see, for example,
"connected, no activity for 3 hours", or a session that reported `working` and has not checked in
for 2 hours. The operator guide's account of `idle` changes with T1: an idle agent that can be
nudged waits at its prompt rather than checking.

**M3. The session's condition.** Where the bridge is given the pane (CF2), the operator sees, with
since when:

- whether the host is **running** a turn (retries included), **at rest**, or **unknown** (the bridge
  cannot read the pane, or the pane no longer runs the host);
- at rest, what its screen holds: **its prompt**, a **permission prompt** (a permission or approval
  dialog), an **other prompt** (any other dialog or prompt for someone at the terminal, such as
  trusting a folder or signing in), or nothing the profile recognizes (**waiting**); and
- at rest, what **stopped** it, where the profile can tell: a **usage limit**, with when it resets
  where the host shows it; a **block**, the host refusing an action on a safety or permission rule;
  or an **error** from its model provider. It clears when the next turn starts.

A session stopped by one of those reasons stopped for it, and any prompt on its screen is beside it,
such as a menu the host shows at a usage limit; a session at rest with a permission or other prompt
and no such reason stopped on that prompt. Agention's report and the harness observer's interface
each define these, in their own terms (ruling 5). A profile reports only what it can tell reliably
and has captured screens for (M5).

**M4. What needs the operator, at a glance.** The sessions view flags each session at a permission
or other prompt, or stopped by something, as it flags stranded threads today, and lets the operator
list just those sessions. Conditions show per session: a session's account can change, so no account
label is kept (ruling 4).

**M5. Profiles by harness.** Each harness Agention supports has one profile, which records where the
harness's screens changed between versions, and applies to its later versions until one is found to
differ. The configuration chooses the profile: by default the one for the harness the bridge runs
under, and for a harness it has none for, the strict generic one; the lenient generic one only where
the configuration names it. A profile claims a condition, or a stopped-by reason, only once screens
of it have been captured from that harness, and its tests read those screens. Captures come from
clean scratch environments or are scrubbed of anything personal, and review checks them. Supporting
a new harness, or a version whose screens changed, is a change to the profiles alone.

**M10. The harness observer stands on its own.** Reading a harness's terminal (the profiles, and
what turns a pane into a condition) sits behind one well-defined interface that knows nothing of
Agention's server, sessions or threads, so it can be reused by other projects and moved into a
package of its own later. It ships inside the bridge for now; releasing it separately is a later
effort, after the server and the bridge and plugins are split (ruling 4).

**M6. Stranded tells the truth.** A thread is stranded when the agent has not read the operator's
latest message and nothing will bring it to the agent soon:

- its session has no active credential or its bridge is not connected (M1);
- its session cannot be nudged, and it has stopped or is quiet, where quiet now reads when the agent
  last checked in (M2), not when its bridge last called; or
- its session can be nudged, and the latest nudge since that message was not sent (N6), or was sent
  without the agent checking in within the quiet time, or none was sent within the quiet time.

A session that can be nudged is not stranded merely for waiting at its prompt, which is what T1
teaches it to do. A stranded thread says why, as today, with the session's condition (M3) where it
has one. These are worked out from what the bridge reports, never stored.

**M7. One bridge acts for a host session.** A host may run several bridges for one session, as Codex
does when it starts new ones without ending the old, and all of them share its key and its approved
registration, even when they come from different plugin versions. Only one of them reports to the
server in the background, monitors and nudges; the others do none of these. When a bridge that
predates monitoring runs beside one that reports it, the newer one's report applies and the older
one's calls count as check-ins.

**M8. Monitoring is the operator's, and holds no pane text.** What monitoring reports reaches the
operator, through the web UI and the operator API's session reads, and never an agent. No text from
the pane reaches the server, the operator, the agent or the bridge's log: monitoring carries
conditions, times, and fields of fixed types its profile defines, such as a reset time, never a
string copied from the pane.

**M9. Starts on approval.** When the operator approves a registration while the agent sits at its
prompt, monitoring and the nudge start without the agent calling a tool (ruling 2), through what a
pending key may already call and nothing more.

### Nudge

**N1. When.** When a message the operator wrote lands in one of a session's threads and the agent
has not checked in since, the bridge nudges the agent, whatever state its session reported, since
the operator writing to a stopped session is how they start it again. A bridge whose registration is
not approved, or whose session cannot be nudged, nudges nothing.

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
in, whether that nudge was sent or not (N6).

**N4. Only at its prompt, and only when still.** The bridge nudges only when monitoring finds the
session at its prompt, not stopped by a usage limit that has yet to reset, the host itself has the
terminal (not an editor, pager, shell or password prompt it started), the pane has shown no change
for a while, no one has typed into it recently, and it is not in a mode where keys do not reach the
host (such as tmux's copy mode). Anything else means it waits and tries again.

**N5. Warn, clear, send, and the operator can stop it.** The warning sits at the prompt for a few
seconds. If it is then not exactly as the bridge put it there, alone on the input line, the bridge
abandons the nudge and removes nothing. Otherwise it removes the warning, checks the line is empty,
puts the message there, checks it, and submits it; if that last check fails, it removes the message
when it can still see it exactly as it put it there, and otherwise leaves it. Text reaches the pane
only as pasted text. The only keys the bridge sends are the ones that remove its own text and the
one that submits the message, never an ordinary character or Escape, and only once the pane shows
the bridge's own text where the profile expects the input line.

**N6. Watched, and the outcome reported.** After submitting, the bridge checks the host took the
message: the line is clear and a turn starts. The bridge reports its latest nudge's time and whether
it was **sent** or **not sent** (abandoned at any step), and logs why, without pane text (M8). The
operator then sees a session **not responding to the nudge** when it was sent and the agent has not
checked in since, beside **connected** (M1) and its activity (M2), so they can tell a session that
is offline, one online but not checking in, and one that did not respond to a nudge (ruling 2).

### Configuration

**CF1. Nudge off unless asked for.** The nudge is off unless the bridge is started with a nudge
type, as a command-line option or an environment variable, the option winning. `tmux` is the one
type; others may follow, such as a nudge through a host's SDK.

**CF2. The pane is named, never guessed.** The bridge monitors a pane only where its configuration
gives the tmux socket, as an option or environment variable. It never infers it from an inherited
`TMUX` or from a known socket location. The socket is a path, named for tmux rather than for
Agentworks, so other tmux setups, a named socket among them, need nothing more. The tmux server
holds one pane, as Agentworks's sessions do (ruling 2); one with more is reported as unknown and
never nudged, and the configuration leaves room for naming a pane later. Monitoring needs only this;
the nudge needs this and CF1. The profile (M5) is one more setting, naming a harness's profile or a
generic one.

**CF3. Agentworks supplies it.** The plugins forward the environment variables of CF1 and CF2 to the
bridge, which is the route a host's plugin configuration allows, and Agentworks sets them through
its templating, so every Agentworks session is monitored, and nudged where turned on, without setup.
That change is Agentworks's; this effort states what it needs and tests against it.

**CF4. Misconfiguration is visible, never fatal.** A pane the bridge cannot reach, a profile or
nudge type it does not know, or a nudge type without a socket, shows in the bridge's log and in the
`register` answer (T1), and an unreachable pane also as unknown (M3); Agention's tools work as
without it.

### Telling the agent

**T1. The register answer says how answers arrive.** Once its registration is approved, `register`
says the agent will be nudged when its session can be nudged, and otherwise that answers reach it
when it checks, as today; a pending answer says nothing of the nudge. The usage skill says what each
means: when nudged, an agent with nothing else to do reports `idle` and ends its turn, with no
waiter of its own; on a nudge, it checks in and updates its status; otherwise it keeps checking as
today. Nothing tells the agent later that a nudge failed: the operator sees it (N6, M6).

### Compatibility and cost

**C1. Within the release lines.** Monitoring changes the agent API and the server, so it ships by
the release lines' rules (`docs/sdd/2026-11-22-separate-releases/frd.md` R2, C1 and C2). A bridge
with monitoring against a server without it fails as that FRD's C3 requires. A session whose bridge
predates monitoring keeps today's presence and stranded rule, every call it makes counting as a
check-in, so an older plugin's threads are not stranded for want of a connection it cannot report.

**C2. Bounded cost.** While nothing changes, what this effort adds costs no model turns, at most one
waiting request on the server for each host session, and conditions sent only when they change.
Reading the pane costs a few tmux calls at a time, at intervals the HLA bounds.

### Engineering

**E1. Collateral.** Two new ADRs, one with each delivery, record monitoring and then the nudge, the
second superseding ADR 0001's "No push" for agents, amending its "No permissions, no harness
control" for the nudge's texts and keys, and saying where monitoring's reports sit in its trust
model: observations the bridge makes, which the screen can imitate, so only a session found at its
prompt, behind N4 and N5, ever leads to a key. README, `SECURITY.md` (the agent bridge),
`docs/review-checklist.md` (A1, A6 on derived signals, and how a call marks a session seen), the
architecture document, the operator guide (monitoring and its conditions, quiet, `idle`, stranded
threads and the New thread sheet's word on them, the nudge, profiles and the configuration), the
usage skill and the tools' descriptions, the plugin definition and the bridge's usage text,
`docs/live-testing.md` and the development contract describe them.

**E2. Tested at its boundary.** Monitoring, the nudge and every guard are tested against the bridge
driving a real tmux server; each profile against its captured screens (M5); and the compatibility
cases of C1 as the release lines require.

## Out of scope

- Reading the pane with a language model to make sense of an unknown harness's screen: a roadmap
  item (ruling 3). Were it built, its answer could name a condition but never be what lets the
  bridge press a key, since the screen is untrusted input, and it would send pane text off the
  machine only where the operator opts in.
- Notifying the operator outside Agention's web UI and API (agention#30).
- Other nudge types, such as a Claude Code hook as agention#67 built or a host's SDK; CF1 leaves
  room for them.
- Terminals other than tmux, harnesses outside one, and tmux servers with more than one pane.
- Nudging a session whose host has ended, or starting one.
- The thin-proxy bridge and a direct MCP endpoint on the server (agention#16).

## Operator rulings, 2026-11-23 onward

Rulings 1 and 2 name requirements as they were numbered before ruling 3: P1 to P6 are now M1, M2,
M3, M6, M7 and M8; N1's start on approval is now M9; and N4's profiles are now M5. Ruling 3's CF3,
an account label, was dropped by ruling 4.

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

3. (2026-11-24) The operator wrote in Agention: "Dude, I just had an insane idea. I hit usage limits
   earlier. I use multiple accounts so knowing when this happens and to what sessions would be a
   _huge_ value add. So what if we split what we're doing here between session monitoring and the
   nudge? The monitoring could then detect not just the prompt state but also other exceptions like
   usage limit, security block, permission prompt, etc. And like what we've designed so far, we
   could add specific harness support that knows exactly what to look for (and probably supports a
   notion of harness version and changing behavior over versions) vs generic harness support that
   might not be able to reliably detect all conditions. And then a roadmap item, but we could
   consider allowing for an optional bridge-to-llm integration to "make sense" of the tmux screen
   for the generic harness support. Thoughts? This solves a ton of problems for me." The effort lead
   proposed monitoring as delivery 1 and the nudge as delivery 2 in this SDD, renamed; the
   conditions of M3; and an account label from Agentworks; and asked about each. Drafted on that
   proposal while the questions are open: this FRD's structure, M1 to M5, M8, N4, N6's nudge
   outcome, CF3, and the language model as out of scope.

4. (2026-11-25) Asked whether to restructure this SDD as monitoring then the nudge and rename it,
   the operator chose "Yes". Asked whether the conditions list was right, they answered: ""needs
   you: permission or other dialog" is a mouthful. I think those are just "permission prompt" and
   then a catch-all "other prompt"." Asked where a session's account should come from, they
   answered: "Per session for now. Sessions can change their accounts so an Agentworks label is
   insufficient." They added: "I'd also like to structure the harness-specific monitoring pieces to
   make them highly pluggable and possibly reusable across other projects. Don't break them out into
   separate releases yet but we probably will in a follow up effort after we split the server and
   bridge/plugin. So step 1 is a very good interface for the harness terminal observer." Taken: this
   SDD's structure and name, M3's prompt conditions, M4 without an account, CF3's account label
   dropped, and M10.

5. (2026-11-25) Asked whether usage limit, block and error should be a "stopped by" note on a
   session at rest rather than conditions of their own, the operator answered: "Yes, but let's just
   make sure that both Agention and the monitoring plugin API have this well defined. And it doesn't
   necessarily have to be the same. That said, this same concept of "whether it's running" vs "is
   some prompt present" is probably a better model across the board. We just need to be able to
   differentiate between "Stopped by a prompt" vs "Stopped for some other reason and there's an
   unrelated prompt"". Asked whether Claude Code usage-limit detection is part of monitoring's
   definition of done, from a scrubbed capture of one of their sessions the next time it hits a
   limit on its own, they chose "Yes, capture it". Asked whether to reword the development
   contract's Codex bound to "monitoring and the nudge", they answered: "Yes. But the work should
   include usage limit detection for Codex, too. I can provide that sample data." Taken: M3's
   running, screen and stopped-by model, the definition of done's usage limits on both hosts, and
   the reworded bound.

6. (2026-11-25) Asked whether they would tell the effort lead which Claude Code session hit a usage
   limit so its pane could be captured once, the operator chose "I'll capture it myself" and wrote:
   "I'll capture it myself. You won't have access to do it directly." Taken: the definition of
   done's Claude Code usage-limit screens come from the operator.

## Definition of done

Monitoring ships first and stands on its own; each delivery is done when its part holds.

- **Monitoring:**
  - M1 to M10, the configuration and C1 and C2 are implemented, tested at their boundary, and
    documented in permanent docs.
  - Live under Agentworks on Claude Code and on Codex, with the configuration set by Agentworks or,
    until Agentworks ships it, by hand: the operator sees a session connected, its agent's activity,
    and its condition, including running, at its prompt and a permission dialog; a session approved
    while at its prompt starts reporting; and on Codex, of several bridges for one session, only one
    reports.
  - A usage limit is detected on Claude Code and on Codex from screens of limits that happened on
    their own, never brought about for the purpose: Claude Code screens the operator captures from
    one of their sessions, and Codex samples the operator provides, both scrubbed (rulings 5 and 6).
- **Nudge:**
  - N1 to N6 and T1 are implemented, tested at their boundary, and documented in permanent docs.
  - Live the same way: an agent at its prompt is nudged when the operator starts a thread with it
    from the web UI, checks in and updates its status; a nudge is refused at a permission dialog and
    while someone types, and is abandoned when the operator types over its warning; and a session
    whose nudge was not answered shows as not responding.
- The repository passes its documented checks in CI.
