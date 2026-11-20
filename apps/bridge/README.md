# @wayfarerlabs/agention-mcp

The agent bridge for [Agention](https://github.com/WayfarerLabs/agention), a self-hosted attention
inbox for autonomous agents and the person working with them. The bridge is the MCP server that an
agent host such as Claude Code or Codex starts for each agent session. Through it the session
registers its key, starts threads, writes and reads their messages, and checks for answers.

## Use

Most agents get the bridge from the Agention plugin for Claude Code or Codex, which runs it with
`npx` at the version it pins. The
[operator guide](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md#agents)
covers installing the plugins and approving agents.

To run it yourself, as an MCP server on standard input and output:

```bash
AGENTION_URL=https://agention.example.ts.net npx -y @wayfarerlabs/agention-mcp
```

`AGENTION_URL` is the Agention server's origin. `--version` prints the version, and `--help` the
usage. The bridge needs Node.js 24 or later. It keeps each session's key under
`~/.config/agention/`, and you approve a new key with the code the agent relays to you.

## More

- [Operator guide](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md): the
  bridge's settings, registering and approving agents.
- [Security](https://github.com/WayfarerLabs/agention/blob/main/SECURITY.md#the-agent-bridge): what
  the bridge holds and sends, and how to report a vulnerability.
- [`@wayfarerlabs/agention`](https://www.npmjs.com/package/@wayfarerlabs/agention): the server.

MIT licensed.
