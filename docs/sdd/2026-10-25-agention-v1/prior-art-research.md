# Agention v1: Prior Art and Host Research

- Date: 2026-10-25
- Method: web research against primary sources where available; unverified points are marked.

## Executive summary

Among the systems reviewed, none separates what is asked of a human from how it affects the work.
JMAP comes closest to pairing per-user read state with state-checked writes, but not on a shared,
attributed log. The pieces exist separately:
A2A and MCP Tasks model task state, MCP elicitation models structured responses, GitHub and Linear
separate action from awareness, Matrix separates read receipts from "caught up", and JMAP and event
stores provide state-checked writes. Agention combines them under an honor-system trust model. Host
research settles tool naming and constrains how agents state their session.

## Findings and design consequences

### Host configuration

| Finding | Source | Consequence |
| --- | --- | --- |
| Claude Code remote MCP entries accept a `headers` map and expand `${VAR}` and `${VAR:-default}` in `url` and `headers`. An unset variable without a default stays as the literal text, with a warning. Claude Code stores OAuth sign-ins per endpoint. | S1 | Distinct per-session URLs keep tokens separate for sessions under one OS user, so the session is stated as a URL path segment. Headers remain a fallback. |
| A configured `Authorization` header disables Claude Code's native OAuth for that server. Coexistence of other custom headers with OAuth is not stated. | S1 | Another reason to prefer the URL path over a header. |
| Plugin MCP configuration documents only plugin variables (`CLAUDE_PLUGIN_ROOT`, `user_config`), not arbitrary environment expansion. | S2 | Unverified for arbitrary environment variables. The MCP entry is per installation anyway (the origin differs per operator), so `agention setup` prints it rather than the plugin shipping it. |
| Codex supports streamable HTTP with OAuth (`codex mcp login`), static `http_headers` and `env_http_headers` (header name to environment variable). It does not document expansion in `url`. Tool calls time out after 60 seconds by default. | S3 | A static per-session URL needs no expansion. Long-poll waits stay well under 60 seconds. |
| MCP tool names SHOULD use `A-Za-z0-9_-.`, 1 to 128 characters. The Anthropic API tool-name pattern excludes dots, and hosts rewrite unsupported characters (Codex rewriting is reported by secondary sources only). | S5, S6, S8, S4 | Tool names use lowercase letters, digits and underscores (`item_create`). |

### Attention and task models

| Finding | Source | Consequence |
| --- | --- | --- |
| A2A tasks move through submitted, working, input-required and auth-required, ending in completed, failed, canceled or rejected. Status is separate from the message history. Terminal tasks are immutable; follow-ups are new tasks linked by context. | S9, S10 | Supports separating item state from entries. A2A merges "blocked" into "needs input"; Agention keeps request and impact separate. Agention allows reopen (operator ruling 11) instead of terminal immutability. |
| MCP elicitation requests a flat schema of primitives and enums; the human may accept, decline or cancel. | S11 | Response forms stay flat (text, one option, confirm or object, outside). Proposed: let the human explicitly decline an act request, which satisfies it with a refusal. |
| MCP Tasks (now an extension) are poll-based with time-to-live and immutable terminal states; host support varies. | S12, S13 | Not adopted. Agention's long-poll tool works on hosts without Tasks support. |
| HumanLayer's `require_approval` blocks until approve or reject and returns the rejection comment to the model. Timeout behavior could not be verified. | S14, S15, S16 | Agention covers the blocking case (impact blocking, confirm form) and adds the non-blocking one (impact assuming with an advisory deadline). |
| LangGraph resumes an interrupted graph with a single resume value matched to the interrupt. | S17 | A human response must bind to the request it answers. The stale-write rule provides that binding: a response always answers the request current at its `seen_through`. |
| GitHub notifications and the Linear inbox use one read and done state per recipient, with a reason or priority filter separating action from awareness. The recipient controls done, snooze and mute. | S18, S19 | Supports the needs-you and updates views over one ack cursor. Snooze and mute are candidates after v1. |
| Matrix distinguishes public read receipts from a private "fully read" marker. Monotonicity rules were not verified. | S20, S21 | Agention uses one visible cursor per identity in v1. A separate private marker is not needed for one human. |
| JMAP `ifInState` rejects writes on state mismatch and `/changes` returns what changed. Event stores append with an expected revision and treat identical retries as idempotent. | S22, S23 | Matches the `seen_through` rule, returning missed entries on mismatch, and the client request id for retries. |

## Pitfalls considered

- **Stale-write starvation.** A frequently posting agent could repeatedly fail a typing human. With one
  human and occasional agent writes this is unlikely. The stale response carries the missed entries
  and the UI keeps the draft. The operator's rule (every write is stale-checked) is kept; exempting
  plain comments was considered and rejected because it reintroduces racing updates.
- **Wake-up.** MCP gives no reliable push to command-line agents. Agents long-poll, bounded below host
  tool timeouts.
- **Session handles are names, not capabilities.** Every call checks the stated session against the
  credential's grants.

## Refuted or do-not-rely-on

- Dots in tool names are safe because the MCP specification allows them: hosts and the Anthropic API
  do not accept them uniformly.
- A plugin can ship the MCP server entry with environment-derived session headers: not documented.
- Custom headers coexist with Claude Code native OAuth: plausible but not documented.
- Hosts store OAuth tokens per server entry name: Claude Code documents per-endpoint storage instead.

## Open questions

1. Whether per-endpoint OAuth storage keeps distinct tokens for per-session URLs under one OS user on
   both hosts (documented for Claude Code, unverified for Codex).
2. Whether Claude Code keeps native OAuth when a non-`Authorization` custom header is configured
   (relevant only to the header fallback).
3. Whether Codex rewrites or truncates tool names (only secondary sources).

## Sources

| ID | URL | Supports | Quality |
| --- | --- | --- | --- |
| S1 | https://code.claude.com/docs/en/mcp | Claude Code headers, expansion, OAuth interaction, tool-name form | primary |
| S2 | https://code.claude.com/docs/en/plugins-reference | Plugin MCP configuration and variables | primary |
| S3 | https://learn.chatgpt.com/docs/extend/mcp?surface=cli | Codex streamable HTTP, headers, OAuth, timeouts | primary |
| S4 | https://codex-sdk.hexdocs.pm/Codex.MCP.Client.html | Codex tool-name sanitization | secondary, unverified |
| S5 | https://modelcontextprotocol.io/specification/2025-11-25/server/tools | Tool-name rules | primary |
| S6 | https://modelcontextprotocol.io/specification/2026-07-28/server/tools | Tool-name rules in the latest revision | primary |
| S8 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools | Anthropic API tool-name pattern | primary |
| S9 | https://a2a-protocol.org/latest/topics/life-of-a-task/ | A2A task lifecycle | primary |
| S10 | https://a2a-protocol.org/latest/specification/ | A2A task states | primary |
| S11 | https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation | Elicitation schema and outcomes | primary |
| S12 | https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks | MCP Tasks (experimental core) | primary |
| S13 | https://modelcontextprotocol.io/extensions/tasks/overview | MCP Tasks extension | primary |
| S14 | https://github.com/humanlayer/humanlayer | HumanLayer project | primary |
| S15 | https://raw.githubusercontent.com/humanlayer/humanlayer/v0.7.9/docs/core/require-approval.mdx | `require_approval` | primary |
| S16 | https://humanlayer.dev/docs/channels/introduction | Contact channels | primary, search summary only |
| S17 | https://docs.langchain.com/oss/python/langgraph/interrupts | Interrupt and resume | primary |
| S18 | https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications | GitHub notifications | primary |
| S19 | https://linear.app/docs/inbox | Linear inbox | primary |
| S20 | https://spec.matrix.org/latest/client-server-api/ | Matrix receipts and markers | primary, partly read |
| S21 | https://git.sudo.is/matrix/matrix-doc/src/branch/old_master/content/client-server-api/modules/read_markers.md | Fully-read marker | secondary |
| S22 | https://www.rfc-editor.org/rfc/rfc8620.html | JMAP state-checked writes | primary |
| S23 | https://docs.kurrent.io/clients/dotnet/legacy/v23.3/appending-events | Expected revision appends | primary, snippet only |
