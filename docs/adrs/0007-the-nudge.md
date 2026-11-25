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

- **The server decides when, from what it stores.** A nudge is due when the session's bridge last
  reported that it can be nudged, one of its threads holds a message from the operator that the
  agent has not read, written after the agent's last check-in, and no nudge was tried since that
  check-in. The bridge's background poll answers `nudge: true` while one is due, and nothing more:
  no thread, message or presence reaches it. The rule reads only the session's rows, so it holds
  across a server restart, a bridge restart and the takeover of ADR 0006's one acting bridge. A
  session is nudged at most once until its agent checks in, whether the nudge was sent or not.
- **The texts are the bridge's own.** A nudge puts two texts in the pane: a warning that a nudge is
  coming and that typing anything stops it, ending with a token drawn from a cryptographic random
  source for that nudge alone, and then one fixed message telling the agent to check in with
  Agention: read its unread threads and bring its status up to date. Both are constants in the
  bridge, one line of printable ASCII each. Nothing from the server, the operator, an agent or the
  screen reaches either, so a nudge cannot carry an instruction; what the operator wrote reaches the
  agent only through Agention's tools, as before.
- **Only at a still prompt, and the person at the terminal can stop it.** The harness observer's
  nudge sends keys only when its latest observation finds the harness at its prompt, not stopped by
  a usage limit yet to reset, holding the terminal, with keys reaching it, no key typed by any
  client for ten seconds, and an input line with the cursor at its end and room for the longer text,
  empty where the harness's own profile can tell. It pastes the warning through a buffer of its own,
  waits five seconds and abandons the nudge if the line is not exactly as it left it; otherwise it
  removes the warning, checks the line is as it was, pastes the message, checks it, and submits it,
  then watches the harness take it. Its only keys are Backspace, to remove its own text, and Enter,
  to submit its own message, each straight after a reading confirmed the line holds exactly what it
  expects; text reaches the pane only as a paste, which refuses control characters.
- **Watched, and the outcome reported.** The bridge reports the latest nudge's outcome, sent or not
  sent, and logs the step a nudge stopped at, never a text. The server records it at the poll answer
  that led to it, by its own clock, and stamps the agent's next check-in at once, so the operator
  sees a session **not responding to the nudge** only while a sent nudge has had no check-in since.
  A nudge the observer finds the session not ready for puts nothing in the pane and is no nudge: the
  bridge asks again a second later while one is due.
- **Off unless asked for.** The nudge needs a nudge type, `--nudge tmux` or `AGENTION_NUDGE`, and
  the socket monitoring reads. A type the bridge does not know, or one without a socket, is logged
  once and leaves the nudge off; the tools work as without it. Once its registration is approved,
  `register` tells the agent whether answers arrive by a nudge or as it checks, and the usage skill
  tells a nudged agent with nothing else to do to report `idle` and end its turn.
- **Stranded follows the nudge.** A thread on a session that can be nudged is not stranded for its
  session waiting at its prompt, quiet or stopped, since the nudge will bring it; it is stranded
  once the latest nudge since the operator's message was not sent, or was sent and went the quiet
  time with no check-in, or none was sent within the quiet time. Its other causes, no active
  credential and no connection, stand as before.

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
  warning stays in the input, never submitted. A generic profile cannot see a prompt marker, so it
  confirms each text by comparing the cursor's row before and after the paste.
- Other nudge types, such as a host's SDK, can join behind the same server rule and outcome; each
  needs its own decision on what it may send.
