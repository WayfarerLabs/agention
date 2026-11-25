# Session monitoring and nudge: Prior art and host research

- Date: 2026-11-23, from the hosts' documentation and source as published on 2026-11-22, hands-on
  spikes on 2026-11-22 and 2026-11-23, and observations on the development VM, an Agentworks guest,
  on 2026-11-23
- Status: research for the FRD, with the results of the spike the operator approved (ruling 2)

## Summary

Neither host gives a plugin a setup-free way to wake an open session on both hosts: Claude Code has
one (a plugin's background hook, which agention#67 built and the operator closed unmerged), and
Codex has none. A terminal multiplexer gives one that works for any harness running in it: the
bridge, a child of the harness, can type into the harness's own pane. Under Agentworks every session
runs in a tmux server of its own, owned by the agent's account, so the bridge already has the rights
to do so. Typing reaches whatever has the keyboard, so the research below bears mostly on the
nudge's guards, and on monitoring, which reads the same pane without typing.

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
  `capture-pane` and `paste-buffer` from a client work.
- **The environment differs by host.** Claude Code passes its MCP servers its own environment, so
  the bridge inherits `TMUX` and `TMUX_PANE`. Codex passes them only an allowed list plus the
  variables its config names: on the VM its bridges had the variables the plugin forwards
  (`AGENTION_URL`, `AGENTION_CONNECT`, `AGENTWORKS_AGENT`, `AGENTWORKS_SESSION`) and neither `TMUX`
  variable, though the Codex process had both. Either way, inferring the pane from the environment
  would also find a tmux the operator runs Claude Code in by hand, which is why the FRD has the
  location passed explicitly.
- **The bridge lives as long as the harness.** It is a child of the harness, not of a turn: this
  session's bridge had run for 33 hours, through many turns and long waits at the prompt. It ends
  when the harness exits, which ends the session's tmux server under Agentworks, and freezes with a
  suspended VM.
- **Codex keeps old bridges.** One Codex session on the VM had six bridges under its process, from
  plugin versions 0.4.0 and 0.6.0, started over 15 hours; Codex started new ones without ending the
  old. All of them read the same key and share one registration, so approval cannot tell them apart:
  without a rule that one acts (FRD M7), each would hold a wait and nudge the same pane.

## What tmux offers the guards

From tmux 3.3a, the VM's version (`tmux(1)`):

- **Reading.** `capture-pane -p` prints the pane's visible text; the formats `pane_in_mode` (copy or
  another mode, where keys never reach the harness), `cursor_x` and `cursor_y` (where the input line
  is), `window_activity` (when the pane last printed) and `client_activity` (when an attached client
  last sent a key, so whether someone is typing) cost one client call each. `window_activity` is per
  window, to the second; `client_activity` is empty with no client attached, and with several
  attached `list-clients` gives each one.
- **Typing text.** `send-keys` sends keys: in a dialog, a letter or a digit may be a shortcut, and
  Enter accepts the highlighted choice. `paste-buffer -p` instead wraps the text in bracketed-paste
  marks when the application asked for them, so a terminal app receives it as one paste event, which
  an input line inserts and a dialog usually ignores. Whether each host asks for bracketed paste,
  and what it does with a paste in a dialog, is for the spike.
- **Targets.** A pane is named by id (`%0`), which stays fixed while the pane lives, or by
  `session:window.pane`.

## Spike results

On 2026-11-23, Claude Code 2.1.331 and Codex 0.171.0 ran in a tmux server of the spike's own, 160 by
45, each in a scratch folder with a clean environment and Agention off. Claude Code ran in default
permission mode with the operator's vim editor mode, and again with the normal editor; Codex ran
with `-a on-request -s read-only`. Cursor positions are column and row from 0, with whether the
cursor shows.

- **Both take pastes as pastes.** Each turns on bracketed paste at start. A two-line paste at the
  prompt was inserted, both lines, with nothing submitted. A paste of 1,200 characters became a
  placeholder (`[Pasted text #1]`, `[Pasted Content 1200 chars]`) that one Backspace removes, so the
  nudge's texts must stay short and on one line.
- **Dialogs drop a paste, but single keys and Enter answer them.** A paste into Claude Code's trust
  and permission dialogs and its rewind menu, and into Codex's trust and approval dialogs, changed
  nothing and was not delivered afterwards, even with digits and dialog letters in the text. But one
  typed key answers at once (Claude Code `4`; Codex `3`, `n` or Escape), and Enter confirms the
  highlighted choice, which is "Yes" in both hosts' tool approvals. So the bridge never types
  ordinary characters, and it presses Enter only once the pane shows its own text in the input.
- **The cursor tells input from dialogs, on both hosts.** At the prompt and with text in it, the
  cursor shows, on the input row, right after the text: `❯` or `›` and a space, then the text, with
  the cursor at column 2 plus its length. In every dialog, menu and browse mode seen, the cursor was
  hidden. The prompt glyph alone does not tell them apart: both hosts also mark a dialog's choice
  with it.
- **Two Claude Code states look like its prompt.** In vim's normal mode the input looks the same but
  the footer lacks `-- INSERT --`, Backspace only moves the cursor, and a paste still inserts. In
  shell mode, entered by typing `!` at the start, the glyph becomes `!` and Enter runs the line in a
  shell. The later captures for the profiles refined both: Claude Code's marker is `❯` and a
  no-break space, and its vim normal mode shows no footer at all, so its profile reads none.
- **Clearing.** Backspace, as many times as the pasted text is long, cleared the line on both hosts,
  wrapped lines included, and extra Backspaces at an empty prompt did nothing. Ctrl-U clears only to
  the start of a screen row on Claude Code. Escape must never be sent: on Claude Code it leaves vim
  insert mode, and twice clears the input or opens the rewind menu; on Codex twice opens a
  transcript browse where Enter rewinds the conversation.
- **Stillness tells a turn from rest.** At rest, neither pane changed in 6 seconds, and tmux's
  `window_activity` stayed put. During a turn, Claude Code's pane changed every quarter second and
  Codex's every half, and `window_activity` advanced each second. Claude Code's permission dialog
  blinks its bullet about every 0.6 seconds; Codex's approval dialog is still.
- **During a turn the input stays live.** Both hosts keep the input and the cursor during a turn,
  and text submitted then is queued and delivered after the running tool call, in the same turn
  (Claude Code: "Queued"; Codex: "Messages to be submitted after next tool call"). Stillness, not
  the cursor, keeps a nudge out of a running turn.
- **The host keeps the terminal.** The pane's command was the host throughout, and the terminal's
  foreground process group was the host's at rest and while its tools ran: both run commands in
  sessions of their own with no terminal, including Claude Code's `!` commands.
- **A nudge at rest works.** A pasted line then Enter changed the pane within 15 ms on Claude Code
  and 5 ms on Codex, cleared the input and started a turn that answered in about 2 seconds.
- **Not tested:** the letter keys that approve (`y` and `p`), Escape during a turn, panes narrower
  than 160 columns, and tmux's `extended-keys`.

## Sources

| Source                                       | Quality                         | Angle                                     |
| -------------------------------------------- | ------------------------------- | ----------------------------------------- |
| Claude Code channels and hooks               | Official docs                   | What a plugin can wake                    |
| Codex hooks and CLI reference                | Official docs                   | What a plugin can wake                    |
| Spike on Claude Code 2.1.330 and Codex 0.171 | Hands-on, 2026-11-22            | Hook wake works; `codex queue` does not   |
| Spike on Claude Code 2.1.331 and Codex 0.171 | Hands-on, 2026-11-23            | Paste, dialogs, cursor, clearing, turns   |
| MCP SEP-3415                                 | Specification                   | A standard path neither host takes yet    |
| codex-wake, ATalk                            | Third-party projects, unaudited | A fixed note, read through tools          |
| Agentworks repository                        | Primary source                  | Per-session tmux servers and their owners |
| The development VM                           | Observed, 2026-11-23            | Bridge lifetime, environment, old bridges |
| `tmux(1)`, 3.3a                              | Official manual                 | What a client can read and type           |
