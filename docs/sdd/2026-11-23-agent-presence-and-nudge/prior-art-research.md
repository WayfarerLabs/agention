# Agent presence and nudge: Prior art and host research

- Date: 2026-11-23, from the hosts' documentation and source as published on 2026-11-22, a hands-on
  spike on Claude Code 2.1.330 and Codex 0.171.0 that day, and observations on the development VM,
  an Agentworks guest, on 2026-11-23
- Status: research for the FRD; the spike its open questions call for follows the FRD's acceptance
  and is recorded here

## Summary

Neither host gives a plugin a setup-free way to wake an open session on both hosts: Claude Code has
one (a plugin's background hook, which agention#67 built and the operator closed unmerged), and
Codex has none. A terminal multiplexer gives one that works for any harness running in it: the
bridge, a child of the harness, can type into the harness's own pane. Under Agentworks every session
runs in a tmux server of its own, owned by the agent's account, so the bridge already has the rights
to do so. Typing reaches whatever has the keyboard, so the research below bears mostly on the
nudge's guards, and on presence, which reads the same pane without typing.

## Hosts as a plugin sees them

- **Claude Code.** Channels push events into a session but need a development flag at every launch
  during their research preview. A plugin hook with `asyncRewake` wakes a session at its prompt when
  it exits 2, and re-arms from `Stop`; the spike proved it on 2.1.330, and agention#67 built push on
  it before the operator chose the terminal nudge instead (ruling 1).
  [channels](https://code.claude.com/docs/en/channels.md),
  [hooks](https://code.claude.com/docs/en/hooks.md)
- **Codex.** MCP notifications go to the trace log only; finishing a background hook starts no turn;
  `codex queue` stored a message for an open session but neither woke it nor delivered it on its
  next turn (the spike, 0.171.0). Nothing a plugin can reach wakes an open Codex session.
  [hooks](https://learn.chatgpt.com/docs/hooks),
  [CLI reference](https://learn.chatgpt.com/docs/cli/reference.md)
- **MCP.** The events extension (SEP-3415, Final) lets a server deliver events, but whether one
  starts a turn is the host's choice, and neither host has adopted it.
  [SEP-3415](https://modelcontextprotocol.io/seps/3415-events-extension)
- **Third-party Codex wakers** (codex-wake, ATalk) send a fixed note saying how many messages
  arrived and let the agent read them through its tools, the same shape as the FRD's one canned
  message.

## Agentworks and tmux

From the Agentworks repository (`WayfarerLabs/agentworks`, public, read 2026-11-23:
`docs/sdd/2026-04-10-agent-tmux-sockets/hla.md`, `cli/agentworks/sessions/tmux.py`,
`docs/guides/session-status.md`) and the development VM:

- **One tmux server per session.** Agentworks starts each agent session in a tmux server of its own
  at `/run/agentworks/agent-tmux-sockets/<linux user>/<session>.sock`, owned by the agent's Linux
  account in a directory only that account and root can enter. The harness is the first pane's
  process, and the bridge, its MCP server, its child, so the bridge runs as the server's owner and a
  tmux client it starts needs no new rights. The socket path is derived, not configured, and
  Agentworks does not yet pass it to anything it launches (ruling 1 asks it to, through its
  templating).
- **A locked-down config** (`/opt/agentworks/tmux-session.conf`) unbinds the keys that make windows,
  panes and sessions, and `command-prompt`, but restricts no tmux client: `send-keys`,
  `capture-pane` and `paste-buffer` from a client work. Agentworks itself drives sessions with
  `send-keys`.
- **The environment differs by host.** Claude Code passes its MCP servers its own environment, so
  the bridge inherits `TMUX` and `TMUX_PANE`. Codex passes them only an allowed list plus the
  variables its config names: on the VM its bridges had `AGENTION_URL` and `AGENTWORKS_SESSION`,
  which Agentworks set, and neither `TMUX` variable, though the Codex process had both. Either way,
  inferring the pane from the environment would also find a tmux the operator runs Claude Code in by
  hand, which is why the FRD has the location passed explicitly.
- **The bridge lives as long as the harness.** It is a child of the harness, not of a turn: this
  session's bridge had run for 33 hours, through many turns and long waits at the prompt. It ends
  when the harness exits, which ends the session's tmux server under Agentworks, and freezes with a
  suspended VM.
- **Codex keeps old bridges.** One Codex session on the VM had six bridges under its process, from
  plugin versions 0.4.0 and 0.6.0, started over 15 hours; Codex started new ones without ending the
  old. Only a bridge whose registration is approved and current may report presence or nudge, or the
  same pane gets nudged more than once.

## What tmux offers the guards

From tmux 3.3a, the VM's version (`tmux(1)`):

- **Reading.** `capture-pane -p` prints the pane's visible text; the formats `pane_in_mode` (copy or
  another mode, where keys never reach the harness), `cursor_x` and `cursor_y` (where the input line
  is), `window_activity` (when the pane last printed) and `client_activity` (when an attached client
  last sent a key, so whether someone is typing) cost one client call each.
- **Typing text.** `send-keys` sends keys: in a dialog, a letter or a digit may be a shortcut, and
  Enter accepts the highlighted choice. `paste-buffer -p` instead wraps the text in bracketed-paste
  marks when the application asked for them, so a terminal app receives it as one paste event, which
  an input line inserts and a dialog usually ignores. Whether each host asks for bracketed paste,
  and what it does with a paste in a dialog, is for the spike.
- **Targets.** A pane is named by id (`%0`), which stays fixed while the pane lives, or by
  `session:window.pane`.

## Open questions for the spike

- Does a bracketed paste into a permission dialog leave the dialog untouched, on each host?
- What does each host do with a prompt submitted during a turn: queue it, steer the turn, or drop
  it?
- Which screen text marks each host's permission and other dialogs, and its input line, reliably
  enough to refuse a nudge on?
- How many Backspaces clear a pasted line on each host, and does a wrapped line change that?
- Does each host's spinner or timer change the pane at least once a second while a turn runs?

## Sources

| Source                                       | Quality                         | Angle                                     |
| -------------------------------------------- | ------------------------------- | ----------------------------------------- |
| Claude Code channels and hooks               | Official docs                   | What a plugin can wake                    |
| Codex hooks and CLI reference                | Official docs                   | What a plugin can wake                    |
| Spike on Claude Code 2.1.330 and Codex 0.171 | Hands-on, 2026-11-22            | Hook wake works; `codex queue` does not   |
| MCP SEP-3415                                 | Specification                   | A standard path neither host takes yet    |
| codex-wake, ATalk                            | Third-party projects, unaudited | A fixed note, read through tools          |
| Agentworks repository                        | Primary source                  | Per-session tmux servers and their owners |
| The development VM                           | Observed, 2026-11-23            | Bridge lifetime, environment, old bridges |
| `tmux(1)`, 3.3a                              | Official manual                 | What a client can read and type           |
