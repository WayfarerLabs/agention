# @wayfarerlabs/agention-mcp

The agent bridge for [Agention](https://github.com/WayfarerLabs/agention), a self-hosted attention
inbox for autonomous agents and the person working with them. The bridge is the MCP server that an
agent host such as Claude Code or Codex starts for each agent session. Through it the session
registers its key, starts threads, writes and reads their messages, checks for answers, and reports
its state.

## Use

Most agents get the bridge from the Agention plugin for Claude Code or Codex, which runs it with
`npx` at the version it pins. The
[operator guide](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md#agents)
covers installing the plugins and approving agents.

To run it yourself, as an MCP server on standard input and output:

```bash
AGENTION_URL=https://agention.example.com npx -y @wayfarerlabs/agention-mcp
```

`AGENTION_URL` is the Agention server's origin. `AGENTION_CONNECT`, optional, is a host and port,
such as `127.0.0.1:8443`, where the bridge opens its connections in place of the origin's host, for
a server it reaches through a tunnel; the certificate it checks, its requests and its tokens still
name the origin. The bridge connects directly and takes no HTTP proxy settings, such as
`HTTPS_PROXY`; `AGENTION_CONNECT` is the way through a tunnel. `--version` prints the version, and
`--help` the usage. The bridge needs Node.js 24 or later. It keeps each session's key under
`~/.config/agention/`, and you approve a new key with the code the agent relays to you. To monitor
the session's terminal, see `--tmux-socket` and `--harness-profile` in `--help` and the
[operator guide](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md#monitoring-a-sessions-terminal).

## More

- [Operator guide](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md): the
  bridge's settings, registering and approving agents.
- [Security](https://github.com/WayfarerLabs/agention/blob/main/SECURITY.md#the-agent-bridge): what
  the bridge holds and sends, and how to report a vulnerability.
- [`@wayfarerlabs/agention`](https://www.npmjs.com/package/@wayfarerlabs/agention): the server.

MIT licensed.
