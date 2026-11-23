# Agent push: Prior art and host research

- Date: 2026-11-22, from the hosts' documentation and source as published then
- Status: a desk survey. A hands-on spike on each host confirms what wakes an idle session before
  the HLA chooses a mechanism.

## Summary

Neither host offers a plugin a documented, setup-free way to wake an idle session from an MCP
server. Claude Code comes closest twice over: channels push events into a session, but a custom
channel needs a development flag each session during their research preview; and a plugin's hook can
run in the background and wake Claude when it exits. Codex shows MCP notifications to no one, its
background hooks start no turn, and the one outside wake is `codex queue`, which arrives as if the
operator typed it. MCP's own answer, the events extension, is final as a specification, and how a
host turns an event into a turn is left to the host. The one third-party design described in detail
sends a short, content-free notice and lets the agent read the messages through its tools, which is
P2.

## Claude Code

- **Channels.** A server declares `experimental['claude/channel']` and sends
  `notifications/claude/channel` with `content` and string `meta`; the event reaches the model
  wrapped in a `<channel>` tag. "Channels are in research preview." Custom channels "aren't on the
  approved allowlist", so a session loads one with `--dangerously-load-development-channels`, after
  a warning it must accept; plugin channels need allowlisting. The flag is ignored under `-p` and
  the Agent SDK. Events arrive only while the session is open; "if several notifications arrive
  while Claude is busy, they're delivered together on the next turn." The docs never say in so many
  words that an event wakes an idle session, though their webhook walkthrough shows Claude starting
  to respond to one. Teams and Enterprise admins must enable channels. Bears on H1, H2 and P4.
  [channels](https://code.claude.com/docs/en/channels.md),
  [channels reference](https://code.claude.com/docs/en/channels-reference.md)
- **A background hook that wakes.** A command hook with `asyncRewake` "runs in the background and
  wakes Claude on exit code 2", showing its output as a system reminder, and a plugin's
  `hooks/hooks.json` applies when the plugin is enabled. A hook started with the session that waits
  on the server and exits 2 when the operator writes would meet H2 without a flag, if it can be
  attached to such an event and restarted after each wake; neither is established. Admins can limit
  hooks to managed ones, and `--bare` runs none. Bears on H1 and H2.
  [hooks](https://code.claude.com/docs/en/hooks.md)
- **Not a wake.** A `Stop` hook can only continue the turn that is ending; the `Notification` hook's
  output is ignored; `/loop` and scheduled wake-ups are polling the agent starts; MCP
  `notifications/message` and `resources/updated` are not documented as reaching the model.
  `tools/list_changed` refreshes the tool list and starts no turn.

## Codex

- **MCP notifications are logged, not shown.** The client writes `notifications/message`,
  `resources/updated` and the list-changed notifications to its trace log
  (`codex-rs/rmcp-client/src/logging_client_handler.rs`). Elicitation works only inside a tool call.
  [openai/codex](https://github.com/openai/codex), as of 2026-11-22
- **Hooks reach the model only within a turn.** Plugins ship hooks; `Stop` with `decision: "block"`
  continues with its reason as a new prompt, and `SessionStart`, `UserPromptSubmit` and
  `PostToolUse` add context. "Finishing a background hook doesn't start a new turn." Bears on H1 and
  H4. [hooks](https://learn.chatgpt.com/docs/hooks)
- **`codex queue`.** A stable command that queues "a text message for an existing session by UUID or
  exact name", with `--resume` to load the session if it is not; resuming needs a local daemon or a
  remote server. The message arrives with the user's role, so the model reads it as the operator's
  own words, which P2's content-free notice keeps harmless. Whether it wakes an idle terminal
  session is reported by users, not documented. Bears on H1.
  [CLI reference](https://learn.chatgpt.com/docs/cli/reference.md)
- **Work in progress.** Unreleased, undocumented event plumbing matching MCP's events extension is
  in the client, and open issues ask for MCP notifications to reach the session (openai/codex#15299,
  #17543, #18056, #20312). Neither is something to build on yet.

## MCP

- **Core protocol.** As of the 2026-07-28 revision, list-changed and subscription notifications
  update a client's state, and every other server-to-client message rides inside a client's request.
  Nothing in the core asks a host to act on its own.
  [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- **The events extension** (SEP-3415, `io.modelcontextprotocol/events`, Final) delivers events by
  poll, push or webhook; over stdio, push is "notifications on stdout". "The client SDK chooses the
  mode and runs the loop", and whether an event invokes the model is the client's choice. It is the
  standard path to watch: a bridge serving it would push to any host that adopts it.
  [SEP-3415](https://modelcontextprotocol.io/seps/3415-events-extension)

## Other prior art

- **Agent Client Protocol v2** lets a client send a prompt to an agent in any state and the agent
  decide when to take it up: push into a session is a first-class idea there.
  [prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)
- **Third-party Codex wakers** (codex-wake, ATalk) combine hooks with `codex queue --resume`.
  ATalk's wake is a fixed note saying how many messages arrived and from whom, and the agent reads
  them from its inbox, so no peer's text is injected as a prompt: the same shape as P2.

## Open questions

- Does a Claude Code channel event wake an idle interactive session, and does an `asyncRewake` hook
  run for a session's lifetime, wake it, and start again after a wake? The spike answers both.
- Does `codex queue` wake an idle interactive Codex session, and can the bridge find its session's
  id or name to address it?
- Can the bridge tell whether push is live in its host session (a hook that is running, a channel
  loaded with its flag, and neither under `--bare` or admin-managed hooks)? H3 and H4 depend on it.
- Will either host adopt MCP's events extension, and when?

## Sources

| Source                                      | Quality                          | Angle                                   |
| ------------------------------------------- | -------------------------------- | --------------------------------------- |
| Claude Code channels and channels reference | Official docs                    | Push into a session, its gating         |
| Claude Code hooks                           | Official docs                    | Background hooks that wake              |
| Codex hooks and CLI reference               | Official docs                    | Hooks, `codex queue`                    |
| openai/codex source and issues              | Primary source, unreleased parts | What the client does with notifications |
| MCP 2026-07-28 changelog, SEP-3415          | Specification                    | Standard push                           |
| Agent Client Protocol v2                    | Specification                    | Push as a protocol idea                 |
| codex-wake, ATalk                           | Third-party projects, unaudited  | Working wake designs                    |
