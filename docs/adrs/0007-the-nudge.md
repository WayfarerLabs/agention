# 7. The nudge: one fixed message at the agent's prompt

Date: 2026-11-25

## Status

Accepted. Supersedes [ADR 0001](0001-agention-v1-architecture.md) "Not doing", "No push", for
agents: where the operator turns it on, the bridge wakes an agent at its prompt when the operator
writes to it. Amends ADR 0001's "No permissions, no harness control": the nudge's two texts, and the
keys that place and submit them, are the one exception. It builds on
[ADR 0006](0006-session-monitoring.md), whose observations it acts on.

## Context

An agent learns of what the operator writes only when it checks. One that has nothing left to do but
wait has to keep a waiter running, a `message_wait` loop or a subagent, which costs turns and ends
when the host ends the turn. No host offers a plugin one way to wake an open session on every host,
and the operator writing to a stopped session had no way to start it again from Agention.

ADR 0006 gave the bridge the session's tmux pane to read. The same pane takes input as if typed, so
the bridge can wake an agent sitting at its prompt by submitting a message there. That is the
injection ADR 0001 ruled out, and the risk is real: whatever reaches a prompt is an instruction to
the agent, and keys sent to a pane that is not what the bridge thinks it is can answer a permission
dialog, edit a draft, or reach a shell. The operator directed that the bridge do it anyway, and only
as a nudge: one canned message that sends the agent to Agention, never any text of anyone's, with
every check that can be made before each key.

## Decision

- **The server decides when, from what it stores, and the bridge claims it.** A nudge is due when
  the session's bridge last reported that it can be nudged and that it is at its prompt, not stopped
  by a usage limit whose reset is unknown or still to come; one of its threads holds a message by
  anyone but its agent that the agent has neither read nor archived, written after the agent's last
  check-in; and no nudge was claimed since that check-in. Working that out writes nothing. The
  bridge's background poll says whether one is due, and nothing more: no thread, message or presence
  reaches it. The poll is level-triggered: the bridge says whether it already knows one is due, and
  the server answers at once only when that differs, so a bridge told one is due holds its poll
  while it still is. The poll is woken by what can make one due: a report that leaves the session
  ready for one, and a message. What ends one being due wakes nothing, since the claim checks again.
  Before it puts anything in the pane, the bridge claims the nudge by its attempt's id: in one
  transaction the server checks that the bridge acts for the session and that one is due, and
  records the claim, by its own clock, apart from the session's latest nudge, which the claim
  becomes once its outcome settles it. The rule and the claim read only the session's rows, so a
  session is nudged at most once until its agent checks in, whatever the nudge's outcome, across a
  server restart, a bridge restart and the takeover of ADR 0006's one acting bridge, even one in the
  middle of a nudge. An attempt that left nothing of its own in the pane is no nudge: it releases
  its claim, and the nudge stays due.
- **The texts are the bridge's own, and marked.** A nudge puts two texts in the pane: a warning that
  a nudge is coming and that typing anything stops it, and then one fixed message telling the agent
  to check in with Agention: read its unread threads and bring its status up to date. Both start
  with the nudge marker, `Agention nudge`, and an id drawn from a cryptographic random source for
  that attempt alone, so the bridge knows nudge text wherever it sees it, an attempt takes only its
  own text as its own and never an earlier attempt's, and the id stays in the submitted message, so
  the harness's transcript records which attempt woke the agent, which the operator sees on the
  latest nudge. Beyond the marks both are constants in the bridge, one line of printable ASCII each.
  Nothing from the server, the operator, an agent or the screen reaches either, so a nudge cannot
  carry an instruction; what the operator wrote reaches the agent only through Agention's tools, as
  before.
- **Only at a still prompt, and the person at the terminal can stop it.** The harness observer's
  nudge starts only when its latest observation finds the harness at its prompt, not stopped by a
  usage limit yet to reset, holding the terminal, with keys reaching it, no key typed by any client
  for ten seconds, and an empty input line with the cursor at its end and room for the longer text.
  It nudges only through a profile that knows its harness's prompt marker: a generic profile reads
  the cursor's whole row as the input line, so it cannot tell a draft the operator left at the
  prompt from an empty prompt, and a nudge there would submit the draft with the message appended,
  so the bridge reports a session read with one as one it cannot nudge. Once ready, the observer has
  the bridge claim the nudge, and reads the pane again to find the same screen. Nudge text already
  on the line, left by an earlier attempt or anyone, is never pasted over or removed: it holds the
  nudge off. It pastes the warning through a buffer of its own, waits five seconds and confirms the
  line holds exactly it, and abandons the nudge if the line is not exactly as it left it; otherwise
  it removes the warning, checks the line is empty, pastes the message, checks it, and submits it,
  then watches the harness take it. The checks of the texts compare only the input line and the
  cursor: where the line holds exactly the nudge's text but the rest of the screen changed
  meanwhile, as when the harness starts a turn or redraws, the nudge takes its text back and tries
  again later, since a harness redraws often and treating that as a failure would raise false
  alarms. Its only keys are Backspace, to remove its own text, and Enter, to submit its own message,
  each straight after a reading confirmed the line holds exactly what it expects; text reaches the
  pane only as a paste, which refuses control characters. A bridge another has taken over from sends
  no key more.
- **Watched, and the outcome reported.** Each attempt ends in one of four outcomes, which the bridge
  sends by the attempt's id, again until it reaches the server, and logs with the step it ended at,
  never a text: **deferred**, nothing of it left in the pane, because nothing was pasted, it took
  its text back, or the harness cleared the line with no one typing; **stopped** by someone at the
  terminal typing into or over its text, which reads as their choice, not a failure; **failed**, a
  pane it could not read or write, a Backspace that did not remove one character, a message that did
  not show exactly, or a harness that did not take it; and **sent**. The server fills in only the
  claim the id names: a deferred attempt releases it, and the others settle it as the latest nudge.
  It stamps the agent's next check-in after a claim, or after a message someone else wrote to the
  session, at once, so the operator sees a session **not responding to the nudge** only while a
  nudge has had no check-in since. A claim whose outcome has not arrived is under way, never sent,
  and the operator sees nothing of it until it settles, since it may yet be deferred. The server
  records which bridge made it; when another bridge comes to act for the session while it is under
  way, as after a restart or a takeover, nothing proves its text reached the pane, so the server
  releases it as deferred, the first time since the agent last checked in, and settles it as failed
  the next, so a bridge that keeps stopping mid-nudge raises a problem rather than warning the agent
  again and again. A nudge that failed or was stopped strands the thread it was for at once; only a
  failed nudge, and nudge text left at the prompt, read as problems. A nudge the observer finds the
  session not ready for puts nothing in the pane, is not claimed and is no nudge: the bridge tries
  again about a second later while one is due, reading only the pane.
- **Why it cannot, on the session, for the operator alone.** The bridge's report says why the
  session cannot be monitored or nudged, where it cannot, as one reason from a fixed list with since
  when: no socket, a pane it cannot read or that is not the session's alone, a profile or nudge type
  it does not know, the nudge off, a generic profile, claims the server refused, or nudge text left
  at the prompt. It reports a reason whenever it arises, not only as it starts, since trouble can
  begin after `register`. The operator sees it on the session; the agent is not told, since the
  trouble is the operator's to deal with, and no tool's answer changes.
- **Off unless asked for.** The nudge needs a nudge type, `--nudge tmux` or `AGENTION_NUDGE`, and
  the socket monitoring reads. A type the bridge does not know, or one without a socket, is logged
  once and leaves the nudge off; the tools work as without it. Once its registration is approved,
  `register` tells the agent whether answers arrive by a nudge or as it checks, and the usage skill
  tells a nudged agent with nothing else to do to report `idle` and end its turn.
- **Stranded follows the nudge, and ignored stands apart.** A thread on a session that can be nudged
  is not stranded for waiting at its prompt, since the nudge will bring it. One the nudge did not
  bring, whose agent checked in at or after the operator's message and the latest nudge without
  reading it, is **ignored**: stranded is ordinary, a session stopped or gone, while ignored says
  the session is not doing what it should, different enough to be a status of its own. A nudge due
  comes first: a thread it would bring is stranded if it never comes, since that is the nudge
  failing, not the agent ignoring the operator. The full rule is in
  [Presence, quiet and stranded](../architecture.md#presence-quiet-and-stranded).

## Consequences

- An agent that can be nudged needs no waiter of its own, and the operator writing to a session that
  ended its turn, or stopped, starts it again from Agention.
- The operator can tell a session that is offline, one that is online but not checking in, and one
  that did not respond to a nudge.
- The monitoring reports of ADR 0006 now lead to keys, so their trust matters more: a screen can
  imitate a prompt, and only the observer's own checks at the moment of each key let one be pressed.
  A report is never what authorizes a key. The keys go to the one pane of the tmux server the bridge
  monitors, whose first process must be one of the bridge's own ancestors, and the bridge gains no
  access it lacked.
- A screen the profile reads wrong can still take the nudge's texts: Claude Code's vim normal mode
  looks like its prompt, where Backspace moves rather than deletes, so the clear step fails, the
  warning stays in the input, never submitted, and the nudge reads as failed. Its marked text then
  holds later nudges off until someone clears it, which the session shows.
- A harness with no profile of its own is monitored but never nudged; nudging it waits on a profile
  captured from its screens.
- `stranded` on the operator API's version 1 changes what it means in place, by the maintainer's
  decision under [ADR 0005](0005-operator-api-meaning-before-1-0.md), and is marked breaking: for a
  session that can be nudged it follows the nudge rather than the session being quiet or stopped,
  and a thread whose agent checked in without reading it is ignored, a status of its own, rather
  than stranded.
- Check-ins are stamped to the minute, so a check-in up to a minute after the operator writes can
  leave a nudge due for a message the agent already saw; the agent reading the thread ends it.
- Other nudge types, such as a host's SDK, can join behind the same server rule, claim and outcome;
  each needs its own decision on what it may send.
