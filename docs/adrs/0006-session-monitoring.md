# 6. Session monitoring from the harness's terminal

Date: 2026-11-24

## Status

Accepted. Refines how presence is observed in [ADR 0001](0001-agention-v1-architecture.md) "Sessions
report what they are doing; presence is observed": a session's bridge keeps a background connection
of its own, which never counts as the agent checking in, and may report what its harness's terminal
shows. It supersedes nothing; the nudge, which acts on the terminal, is
[ADR 0007](0007-the-nudge.md).

## Context

The operator learned whether a session was there only from its agent's calls: a session not seen for
a while was quiet, and a thread waiting on a quiet session was stranded. That cannot tell an agent
waiting at its prompt from one whose host has ended, or from one stopped at a permission dialog only
the person at its terminal can answer, which is the session the operator most needs to find. Every
call the bridge made counted as the agent's, so anything the bridge did on its own would have read
as the agent checking in.

The agent hosts Agention supports run in a terminal, and the setups that run several agents, such as
Agentworks, run each session's host in a tmux server of its own. The bridge is a child of the host,
on the same machine, as the same user who owns that tmux server, so it can read the host's screen
without any access it lacks.

## Decision

- **Connection apart from activity.** Once its registration is approved, a session's bridge holds a
  background long poll to the server, and its reads of a pending registration are marked as
  background requests, so approval reaches it with no tool call. A background request stamps the
  session connected; every other call is the agent checking in, as before. Connected, quiet and
  stranded are derived when read, never stored: a session is connected while its bridge made a
  background request within the last minute, and a thread is stranded, too, while its session is
  not. A bridge from before the background connection cannot be connected, so a session whose agent
  last checked in through one follows the earlier rule and is never shown disconnected.
- **The bridge reads its harness's terminal and reports only derived conditions.** Given the socket
  of the session's tmux server in the session's own environment, never inferred from the tmux it
  runs in, the bridge reads that server's one pane once a second and reports the session's
  condition: unknown, at a permission prompt, at another prompt, running, at its prompt, or waiting,
  with since when and, where the harness's profile can tell, what stopped it. A report holds only
  enumerations, booleans, times and the profile's name. The screen's text stays in the bridge's
  memory and never reaches the server, the operator, the agent or the bridge's log.
- **Reading a terminal stands on its own.** `packages/harness-observer` turns a pane into an
  observation in its own terms (whether the harness is running and, at rest, what its screen holds
  and why it stopped), which the bridge spells as the agent API's condition and stopped-by reason;
  it knows nothing of Agention, so it can become a package of its own. A profile per harness says
  what that harness's screens mean, from screens captured from it and checked into the repository;
  supporting another harness, or a version whose screens changed, is a change to the profiles alone.
  A harness without a profile gets a generic one that names no prompt.
- **One bridge acts for a session.** A host may run several bridges for one session, as Codex starts
  new ones without ending the old. The latest to claim the session acts for it, and the others stand
  down until their bridge next handles a tool call. The server keeps which bridge acts in memory, a
  claim deletes the report of the one before, and a report numbered no higher than the last accepted
  from its bridge is ignored, so a late report never stands as current.
- **What it needs.** Monitoring needs Linux, for `/proc`, and tmux 3.3 or later on the agent's
  machine, and is optional: without a socket the bridge monitors nothing and says so. The bridge
  reads a pane only while the pane's first process is an ancestor of the bridge, so a socket that
  names another session's pane reads as unknown, and only while that process holds the terminal, so
  a host started by a wrapper that does not exec it reads as unknown too. Whatever goes wrong, the
  condition is unknown, the bridge logs why once, and the tools work as without monitoring.
- **Advisory, on the honor system.** A report is the bridge's observation, trusted as the agent's
  host is under ADR 0001's trust model. Whatever runs in the pane draws the screen, so a screen can
  imitate a dialog, and any holder of the session's key, its agent included, can send a report or
  keep the session connected, as it can report its status. So monitoring reaches only the operator,
  through the web UI and the operator API's session and thread reads, never an agent, and informs
  without authorizing or triggering anything. The one exception is [ADR 0007](0007-the-nudge.md)'s
  nudge: the server offers one only where a report says the session can be nudged, and only the
  observer's own checks let it press a key.

## Consequences

- The operator can tell a session that is there and idle from one that is gone, and find the
  sessions waiting at a prompt for the person at their terminal.
- A stranded thread also means its session's bridge is not connected, so a thread waiting on a
  session whose host ended shows as stranded within a minute, not only once it turns quiet.
- Monitoring never changes what an agent sees or can do, and a bridge that cannot monitor still
  serves every tool, so a host Agention has no profile for, or a machine without tmux, loses only
  the condition.
- The condition is only as good as its profile's captures, and a harness update that changes its
  screens can read as waiting until its profile is updated from new captures.
- A report can be wrong, by a screen that imitates another or by an agent that reports for itself;
  the operator treats it as a pointer to the session to look at, never as proof of what it does.
