# 5. Push to agents through the bridge and a Claude Code hook

Date: 2026-11-23

## Status

Accepted. Supersedes, in [ADR 0001](0001-agention-v1-architecture.md), "No push" as far as agents
go: Agention still reaches the operator only through its own web UI. Amends its "No permissions, no
harness control" and "Agention never holds up an agent's work" for the one notice below.

## Context

An agent learns of what the operator writes only when it checks. While it works, it checks between
steps; once its turn ends and it sits at its host's prompt, nothing reaches it unless it keeps a
waiter of its own running, and a host that cannot run one, or an agent that forgets, leaves the
operator's thread stranded until they go to its terminal. Agention exists so the operator can answer
from wherever they are and have the work carry on, which holds only as far as the answer reaches the
agent.

Every means a host offers to reach an agent at its prompt puts text in front of it, which ADR 0001
ruled out. Neither host offers a plugin a documented, setup-free way to wake an idle session from an
MCP server. Claude Code's channels push events into a session, but a custom channel needs a
development flag at every launch, which the operator ruled out. A Claude Code plugin's command hook
with `asyncRewake` runs in the background and wakes the agent when it exits 2, and one started on
`SessionStart` and on every `Stop` re-arms itself after each wake. On Codex nothing a plugin can
reach wakes an open session: `codex queue` neither wakes one nor delivers to it. MCP's events
extension leaves to each host how an event becomes a turn, and neither host has adopted it.

## Decision

- **The bridge holds the wait.** The bridge, already running for the host session, approved, and
  holding the key and the connection, long-polls the session's existing wait in the background, so
  push needs no server or agent API change and works against every server that serves the bridge's
  agent API version. It runs only for an MCP client that is Claude Code, whose host process has the
  plugin's hook running, so a Codex session costs nothing.
- **A hook wakes the agent.** The Claude Code plugin carries a watcher, a POSIX shell script run on
  `SessionStart`, on `UserPromptSubmit` and at every turn's end, `Stop` or `StopFailure`, with
  `asyncRewake` and a day-long timeout. The bridge and the watcher meet in a host directory named
  for the machine and the Claude Code process, the bridge's nearest ancestor named `claude`, under
  the private-file rule: the bridge writes a session's wake file there when the operator writes, and
  the watcher takes it, prints its notice and exits 2. Nothing but a taken wake file makes it exit
  2, and nothing but a notice reaches its stderr, so a broken watcher cannot loop the session
  through turns or put text before it. The watcher touches no key and no server.
- **A notice, never the message.** The notice says which threads hold unread messages from the
  operator, and how many, and tells the agent to read them with the thread tools. The bridge
  composes it from fixed words and schema-checked integers; no title, message text or other content
  from the server reaches it. It is the one text Agention puts into an agent's conversation, and the
  messages themselves reach the agent only through the tools, which carry their author and mark what
  was read. Agention still grants no permission and acts on no message's content.
- **Once per message.** The wait's position is saved in the host directory, per session, before the
  wake file is written, so a message is pushed at most once to a host session, whether or not the
  agent reads it, and across a restart of the bridge. The notice itself comes from a fresh read of
  every thread with unread messages, so it names what is unread when it is sent.
- **The agent is told the truth.** `register` says answers are pushed only where the bridge can tell
  push works for its host session: Claude Code, with the watcher's mark in its host directory. When
  push gives up, on a server that does not serve its version, a host directory it cannot use or a
  registration that can never be approved, the next tool answer says answers now reach the agent
  only when it checks. Elsewhere the agent checks, as before.

## Consequences

- Interactive Claude Code sessions in the terminal, in a trusted folder, with plugin hooks allowed,
  are pushed; Codex sessions, `claude -p` and Agent SDK runs, a session under `--bare` and one where
  an administrator allows only managed hooks are not, and are told they check.
- The host directory's name comes from `CLAUDE_PID`, which Claude Code sets for hooks without
  documenting it, and from the bridge's nearest ancestor whose command is `claude`; and the watcher
  tells an interactive session from `claude -p` and SDK runs by `CLAUDE_CODE_ENTRYPOINT` being
  `cli`, also undocumented. If Claude Code stops setting either, or its process takes another name,
  no mark is found and sessions are told they check.
- A bridge started again resumes push at the agent's next call in the session, not before.
- A watcher ends at its day-long timeout, so a session left at its prompt longer is pushed only
  after its next turn.
- A watcher started during a turn, as `SessionStart`'s and `UserPromptSubmit`'s are, can take a wake
  file while the agent works, and the notice shows at the agent's next opportunity.
- An agent with push ends its turn when it has nothing else to do, with no waiter of its own; ADR
  0001's "never holds up" holds through the push instead of through polling.
- Codex gains push if it offers a plugin a way to wake an open session, or adopts MCP's events
  extension, which the bridge, already holding the wait, would serve.
