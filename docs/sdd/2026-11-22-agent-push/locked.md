# Agent push: Locked

- Locked: 2026-11-23
- Shipped in: agention#67, which closes agention#63

## What shipped

- Push on Claude Code: when the operator writes to a session, an agent at its prompt is woken within
  a second or two by a notice of fixed words and thread numbers, the one text Agention puts into an
  agent's conversation (ruling 2), and reads the messages with its tools. Each message is pushed
  once, read or not, and push starts once the operator approves a registration, even after the
  agent's turn has ended.
- The bridge holds the wait in the background, only for an interactive Claude Code client whose
  plugin hook has marked its host directory, `~/.config/agention/_hosts/claude/<host name>/<pid>/`.
  A shell watcher, run by the plugin's hook on `SessionStart`, `UserPromptSubmit`, `Stop` and
  `StopFailure` with `asyncRewake`, takes the bridge's wake file and wakes Claude Code. No server or
  agent API change: push shipped on the agent line alone.
- The `register` answer says whether answers are pushed, and a tool answer says once when push has
  lapsed; the usage skill and the tools' descriptions teach both. A watcher lasts a day from the
  latest prompt or turn, a limit the operator guide states (ruling 3).
- Codex has no push: nothing a plugin can reach wakes an open Codex session (the spike), so its
  agents check as before.
- ADR 0005, which supersedes ADR 0001's "No push" for agents and amends its rule against injecting
  text into an agent's conversation.

The live run passed at 399cb24 on Claude Code 2.1.330 and Codex 0.171.0, with a loopback server from
the packed head and the operator driving the web UI: nine messages woke nine turns, each within
about a second, none twice; push started after an approval given at the prompt, and survived a
server restart, `/clear`, a turn of over two minutes, an interrupt and an API error; a revocation
gave the lapse line; `claude -p` and Codex were told they check, and Codex held no background wait.
A shorter run at the final head confirmed waking, re-arming, the lapse and `/exit`.

## Where it lives now

The permanent record is in `docs/adrs/0005-push-to-agents.md`,
`docs/adrs/0001-agention-v1-architecture.md`, `docs/architecture.md`, `docs/operator-guide.md` "Push
on Claude Code", `SECURITY.md`, `docs/review-checklist.md`, `docs/live-testing.md`,
`docs/development-context.md`, `CONTRIBUTING.md`, the README, and the usage skill. Nothing here is
needed to understand or work on the system.

## What follows

Push on Codex, when Codex offers a plugin a way to wake an open session or adopts MCP's events
extension, is its own effort. A notice naming its session, for two Agention bridges under one Claude
Code, is not planned; the operator guide says to run one. A bridge long-poll test that times out
under load is agention#91.
