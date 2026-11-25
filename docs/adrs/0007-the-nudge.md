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
  anyone but its agent that the agent has not read, written after the agent's last check-in; and no
  nudge was claimed since that check-in. Working that out writes nothing. The bridge's background
  poll says whether one is due, and nothing more: no thread, message or presence reaches it. The
  poll is level-triggered: the bridge says whether it already knows one is due, and the server
  answers at once only when that differs, so a bridge told one is due holds its poll while it still
  is. The poll is woken by what can make one due: a report that leaves the session ready for one,
  and a message. What ends one being due wakes nothing, since the claim checks again. Before it puts
  anything in the pane, the bridge claims the nudge: in one transaction the server checks that the
  bridge acts for the session and that one is due, and records the claim, by its own clock, as the
  session's latest nudge. The rule and the claim read only the session's rows, so a session is
  nudged at most once until its agent checks in, whether the nudge was sent or not, across a server
  restart, a bridge restart and the takeover of ADR 0006's one acting bridge, even one in the middle
  of a nudge.
- **The texts are the bridge's own.** A nudge puts two texts in the pane: a warning that a nudge is
  coming and that typing anything stops it, ending with a token drawn from a cryptographic random
  source for that nudge alone, and then one fixed message telling the agent to check in with
  Agention: read its unread threads and bring its status up to date. Both are constants in the
  bridge, one line of printable ASCII each. Nothing from the server, the operator, an agent or the
  screen reaches either, so a nudge cannot carry an instruction; what the operator wrote reaches the
  agent only through Agention's tools, as before.
- **Only at a still prompt, and the person at the terminal can stop it.** The harness observer's
  nudge starts only when its latest observation finds the harness at its prompt, not stopped by a
  usage limit yet to reset, holding the terminal, with keys reaching it, no key typed by any client
  for ten seconds, and an empty input line with the cursor at its end and room for the longer text.
  It nudges only through a profile that knows its harness's prompt marker: a generic profile reads
  the cursor's whole row as the input line, so it cannot tell a draft the operator left at the
  prompt from an empty prompt, and a nudge there would submit the draft with the message appended,
  so the bridge reports a session read with one as one it cannot nudge. Once ready, the observer has
  the bridge claim the nudge, and reads the pane again to find the same screen. It pastes the
  warning through a buffer of its own, waits five seconds and abandons the nudge if the line is not
  exactly as it left it; otherwise it removes the warning, checks the line is empty, pastes the
  message, checks it, and submits it, then watches the harness take it. Its only keys are Backspace,
  to remove its own text, and Enter, to submit its own message, each straight after a reading
  confirmed the line holds exactly what it expects; text reaches the pane only as a paste, which
  refuses control characters. Where reading or writing the pane fails, it stops as a failed check at
  that step does: the warning stays, and the message is removed where the line still holds exactly
  it; a bridge another has taken over from sends no key more.
- **Watched, and the outcome reported.** Once a nudge it claimed ends, the bridge sends whether it
  was sent, again until it reaches the server, and logs the step a nudge stopped at, never a text.
  The server fills it in only where the latest claim has none yet, and stamps the agent's next
  check-in after a claim at once, so the operator sees a session **not responding to the nudge**
  only while a nudge has had no check-in since; one whose outcome never arrived counts as sent. A
  nudge can be claimed and then find the pane changed during the claim, which reports it not sent
  with nothing typed, and no other nudge comes until a check-in. A nudge the observer finds the
  session not ready for puts nothing in the pane, is not claimed and is no nudge: the bridge tries
  again about a second later while one is due, reading only the pane.
- **Off unless asked for.** The nudge needs a nudge type, `--nudge tmux` or `AGENTION_NUDGE`, and
  the socket monitoring reads. A type the bridge does not know, or one without a socket, is logged
  once and leaves the nudge off; the tools work as without it. Once its registration is approved,
  `register` tells the agent whether answers arrive by a nudge or as it checks, and the usage skill
  tells a nudged agent with nothing else to do to report `idle` and end its turn.
- **Stranded follows the nudge.** A thread on a session that can be nudged is not stranded for its
  session waiting at its prompt, quiet or stopped, since the nudge will bring it; it is stranded
  once the latest nudge since the operator's message was not sent, or was sent, or its outcome never
  arrived, and went the quiet time with no check-in, or none was claimed within the quiet time. Its
  other causes, no active credential and no connection, stand as before.

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
  looks like its prompt, where Backspace moves rather than deletes, so the clear step fails and the
  warning stays in the input, never submitted.
- A harness with no profile of its own is monitored but never nudged; nudging it waits on a profile
  captured from its screens.
- Check-ins are stamped to the minute, so a check-in up to a minute after the operator writes can
  leave a nudge due for a message the agent already saw; the agent reading the thread ends it.
- Other nudge types, such as a host's SDK, can join behind the same server rule, claim and outcome;
  each needs its own decision on what it may send.
