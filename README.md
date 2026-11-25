# Agention

A self-hosted attention inbox for autonomous agents and the people working with them.

One person can run many largely autonomous agent sessions. Each session occasionally needs that
person: a question answered, a decision noticed, something done in another system, a result
reviewed. Agention gives those sessions threads in which to say what they need and ask what they
want answered, and gives the person one phone-friendly list of threads in which to read and answer
them. Agents read the answers through the same interface they write through.

Agention never grants permissions, injects text into an agent's conversation, or controls an agent
harness, with one exception the person turns on: the bridge may nudge an agent at its prompt with
one fixed message telling it to check in. It records and shows; the agent decides what to do with an
answer.

## Status

Agention v1 is complete, and has been usable since its first release, 0.1.0. Each release is
published to npm: the server and operator CLI as `@wayfarerlabs/agention`, and the agent bridge as
`@wayfarerlabs/agention-mcp`. The Claude Code and Codex plugins install from this repository's
plugin marketplace, and the [operator guide](docs/operator-guide.md) takes you from installing the
server to agents asking and you answering. The repository contains:

- the `agention` command, the server and operator CLI: `agention serve` runs the HTTP API, with
  passkey sign-in for the person, key authentication for agents and API keys for the person's own
  programs, over the server's database and store, and `agention passkey-link` issues the link that
  registers the person's passkeys;
- the web UI, which the server serves: the person signs in with a passkey, works through one thread
  list, filtered, grouped and searched down to what messages say, reads and answers threads, opens
  the files agents attach and attaches their own, archives threads, follows every session's status
  and updates in one view, where they approve agents' registrations, start threads on a session, and
  sort sessions into groups and tag agents and sessions, and in Settings, in sections, manages their
  passkeys, their API keys and voice, which dictates replies through a transcription provider they
  choose and reads messages aloud on their device, and sees the space files take;
- the operator API, a versioned API through which a program the person runs, such as a tool that
  already shows their agents, reads and answers Agention as them, files included, with an API key
  they created in Settings and within the scopes they gave it, and its OpenAPI document, which the
  server serves with its documentation when asked;
- the `agention-mcp` agent bridge, the MCP server through which an agent session registers its key,
  starts threads, writes and reads their messages, uploads files for them to carry and fetches those
  they carry, withdraws the asks it no longer needs answered, checks for new messages, and reports
  its state, such as working or stopped, and which, where the person turns it on, nudges an agent
  waiting at its prompt when the person writes to it;
- the API contract, which the server, the bridge and the web UI share, and the OpenAPI document
  generated from it;
- the Claude Code and Codex plugins and their generator. The plugins carry the agent usage skill and
  run the bridge at the version they pin.

[docs/architecture.md](docs/architecture.md) describes what exists.

## Design

Agention is TypeScript on Node. One server process serves an HTTP API and a web UI for the person
from one HTTPS origin, with all state in one SQLite file. Agents do not call the API directly: each
agent host runs the agent bridge, a small MCP server that the Agention plugin starts with a pinned
`npx` command, and the bridge turns each tool call into one API request. Beside the tools, the
bridge holds a background connection that tells the server the session is connected and, where it is
given the tmux server the session runs in, what condition its terminal shows; with the nudge on, it
also wakes an agent at its prompt when the person writes to it. Each agent session authenticates
with its own key, which the person approves by matching a short code; the person signs in with
passkeys. The server terminates TLS itself or runs on loopback behind a TLS terminator, such as a
reverse proxy or `tailscale serve`, as the operator guide describes.
[ADR 0001](docs/adrs/0001-agention-v1-architecture.md) records the design and the alternatives
considered. Voice is optional and off until the person chooses a transcription provider: the server
relays their recordings to it with a key it holds, and keeps none of them, as
[ADR 0002](docs/adrs/0002-voice-through-the-server.md) records. Integrations act for the person only
through API keys they create, each limited to its scopes and revocable at once, as
[ADR 0003](docs/adrs/0003-operator-api-keys.md) records. Files attached to messages live in the same
database, and are served under rules that keep them from acting as the person, as
[ADR 0004](docs/adrs/0004-attachments.md) records. Monitoring reads a session's terminal on its own
machine and reports only the condition it derives, an advisory observation for the person, as
[ADR 0006](docs/adrs/0006-session-monitoring.md) records. The nudge, off unless the person turns it
on, submits one fixed message at an agent's prompt, never any text of anyone's, behind checks that
let the person at the terminal stop it, as [ADR 0007](docs/adrs/0007-the-nudge.md) records.

Agention works on the honor system: it cannot stop an agent from misreporting, so it enforces
provenance, isolation and append-only history instead, as [SECURITY.md](SECURITY.md) describes.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers building from source, the checks CI runs, the contribution
process and releasing. The [operator guide](docs/operator-guide.md) lists the commands.

## Repository layout

Each component is an npm workspace, and one lockfile covers them all.

| Path                                          | Contents                                                                                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api/`                               | The API contract shared by the server, the bridge and the web UI                                                                                                                             |
| `packages/build/`                             | The bundle build for the published packages, with their license notices                                                                                                                      |
| `packages/private-files/`                     | The private-file rule the server and the bridge share                                                                                                                                        |
| `packages/harness-observer/`                  | What an agent harness's terminal pane shows, read for the agent bridge, and the nudge at its prompt                                                                                          |
| `apps/server/`                                | The server and operator CLI, npm package `@wayfarerlabs/agention`                                                                                                                            |
| `apps/bridge/`                                | The agent bridge, npm package `@wayfarerlabs/agention-mcp`                                                                                                                                   |
| `apps/web/`                                   | The React web UI                                                                                                                                                                             |
| `apps/agent-plugin/`                          | The canonical agent plugin definition and its generator                                                                                                                                      |
| `out/`, `.claude-plugin/`, `.agents/plugins/` | Generated Claude Code and Codex plugins and catalogs (committed)                                                                                                                             |
| `scripts/`                                    | Check, lint, plugin generation and API document generation scripts                                                                                                                           |
| `docs/`                                       | Architecture, operator guide, decision records (`docs/adrs/`), the generated OpenAPI document (`docs/api/`), the development contract and its checklists, and design documents (`docs/sdd/`) |

## License

[MIT](LICENSE)
