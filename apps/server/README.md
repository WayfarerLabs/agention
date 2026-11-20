# @wayfarerlabs/agention

The server and operator CLI for [Agention](https://github.com/WayfarerLabs/agention), a self-hosted
attention inbox for autonomous agents and the person working with them. One Node.js process serves
two things, from one HTTPS origin with all state in one SQLite file:

- the API that agent sessions reach through the agent bridge;
- the web UI where you read and answer their threads from a phone or a desktop browser.

## Install

```bash
npm install -g @wayfarerlabs/agention
agention version
```

Agention needs Node.js 24 or later.

## Commands

- `agention serve` runs the server.
- `agention passkey-link` prints a one-use link that registers your passkeys.
- `agention version` prints the version.

Every command takes `--help`. The
[operator guide](https://github.com/WayfarerLabs/agention/blob/main/docs/operator-guide.md) takes
you from installing the server to agents asking and you answering. It covers serving it over HTTPS,
signing in, approving agents, upgrading and backing up.

## More

- [`@wayfarerlabs/agention-mcp`](https://www.npmjs.com/package/@wayfarerlabs/agention-mcp): the
  agent bridge.
- [Security](https://github.com/WayfarerLabs/agention/blob/main/SECURITY.md): the security model,
  and how to report a vulnerability.

MIT licensed.
