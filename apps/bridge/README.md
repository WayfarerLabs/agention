# @wayfarerlabs/agention-mcp

The agent bridge for [Agention](https://github.com/WayfarerLabs/agention), the self-hosted inbox for
everything your agents need from you: agents post what they need as threads and keep working, and
you answer from one list.

The bridge is a standard MCP server on standard input and output, so any harness that speaks MCP can
use Agention: Claude Code, Codex or your own. The harness starts one for each agent session. Through
it the session registers its key, starts threads, writes and reads their messages, attaches and
fetches files, checks for answers, and reports its state.

## Use

On Claude Code and Codex you rarely install this package yourself: the Agention plugin runs it with
`npx` at the version it pins, and the
[operator guide](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md#agents)
covers installing the plugins and approving agents.

On any other harness, add it as an MCP server with this command, and give your agent the
[usage skill](https://github.com/WayfarerLabs/agention/blob/main/apps/agent-plugin/skills/agention/SKILL.md)
that the plugins carry. The operator guide's
[Other harnesses](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md#other-harnesses)
says what the harness must do, and pins both to a release:

```bash
AGENTION_URL=https://agention.example.com npx -y @wayfarerlabs/agention-mcp
```

| Setting                                           | Meaning                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `AGENTION_URL`                                    | The Agention server's origin; required                                                                          |
| `AGENTION_CONNECT`                                | A host and port, such as `127.0.0.1:8443`, to connect to in place of the origin's; optional                     |
| `AGENTION_TMUX_SOCKET` or `--tmux-socket`         | The socket of the tmux server the session's agent host runs in, to [monitor its terminal][monitoring]; optional |
| `AGENTION_HARNESS_PROFILE` or `--harness-profile` | How to read that terminal, `auto` by default                                                                    |
| `--version`                                       | Prints the version                                                                                              |
| `--help`                                          | Prints the usage                                                                                                |

`AGENTION_CONNECT` is the way to a server reached through a tunnel: the certificate the bridge
checks, its requests and its tokens still name the origin. The bridge connects directly and takes no
HTTP proxy settings, such as `HTTPS_PROXY`.

The bridge needs Node.js 24 or later. It keeps each session's key under `~/.config/agention/`, and
you approve a new key with the code the agent relays to you. To have the bridge nudge the agent at
its prompt when you write to it, on a host with a profile of its own, see `--nudge` and
[the nudge](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md#the-nudge).

[monitoring]:
  https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md#monitoring-a-sessions-terminal

## More

- [Operator guide](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md): the
  bridge's settings, registering and approving agents.
- [Security](https://github.com/WayfarerLabs/agention/blob/main/SECURITY.md#the-agent-bridge): what
  the bridge holds and sends, and how to report a vulnerability.
- [`@wayfarerlabs/agention`](https://www.npmjs.com/package/@wayfarerlabs/agention): the server.

MIT licensed.
