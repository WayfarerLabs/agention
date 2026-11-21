# Live testing

What a live test of Agention drives, what it checks the product against, the failures it hunts, and
the rails that keep a run off real homes and real sessions. A tester applies it on top of the shared
tester method (the `integration-testing` skill's `tester-method.md`), whose inputs, method, safety
rails and report format all apply. The test beds the operator has authorized, and their bounds, are
in the [development context](development-context.md) under "Testing".

Intended behavior comes from `README.md`, `docs/operator-guide.md`, `SECURITY.md`,
`docs/architecture.md`, the ADRs in `docs/adrs/` and the commands' own help. Where they disagree
with each other or with what the product does, the disagreement is the finding.

## Surfaces

- **CLI**, run from the packed server package, never the source tree: installed from a tarball
  `npm pack` wrote for the head under test, such as those `scripts/check.sh --packages DIR` keeps.
  `agention serve`, including its plain-HTTP guard; `agention passkey-link`; `agention backup`,
  taken while agents and the operator write and while the server is stopped, the copy's mode and its
  refusals of an existing file and of a directory others can read, a database it leaves unmigrated,
  and a restore from the copy by the operator guide's steps, after which the server serves the
  threads the copy holds and nothing written after it; `agention version`; and `agention --help`
  (`docs/operator-guide.md` "Commands" and "Backing up").
- **HTTP API** through the real listener: the agent mount (key-signed tokens) and the web mount
  (passkey session and CSRF). The token cases: no token, a signature by another key than the one it
  names, an unknown key, another audience (refused naming the expected origin), an expiry past or
  more than 300 seconds ahead, an algorithm other than EdDSA, and a pending, expired, rejected or
  revoked registration, each `unauthenticated`, and a revocation ending a long poll
  (`docs/architecture.md` "Authentication"; the in-process tests in
  `apps/server/src/http/agent-api.test.ts`). Each credential on the other mount, a `Host` other than
  the origin's host, an oversized body (413), and a body without a declared length (411)
  (`docs/architecture.md` "HTTP API"). The agent API version on every agent answer, those refusals
  included: a request without the `Agention-Agent-API` header served as version 1, one stating a
  version above the server's, however many digits it has, refused as `unsupported_version` before
  authentication, and a header that is not a positive integer written without leading zeros refused
  as `invalid_input`.
- **Agent bridge**, started the way the plugin declares it: for the head under test, the plugins
  rendered against its packed bridge (`CONTRIBUTING.md` "Generated plugins"), whose entry is
  `npx -y --package=<tarball> agention-mcp`; the published bridge from npm only when the charter
  names a release. `register` through every registration state (pending, approved, rejected,
  expired, revoked), each of the thread tools: `thread_create`, `message_send`, `thread_get`,
  `thread_list`, `thread_read`, `thread_archive` and `message_wait`, and `session_update` through a
  session's life: working once registered, idle, stopped with each outcome, working again on
  resuming, a goal changed without a percent, and a note alone (`docs/architecture.md` "Agent
  bridge" and "Store"). The bridge at the head against a server of an earlier release, which it
  refuses with what the operator upgrades, and a bridge an earlier release published against the
  server at the head, which it still serves, where the charter names those releases; the agent
  compatibility gate covers the latter on every change (`CONTRIBUTING.md` "The agent API").
- **Generated plugins** on Claude Code and Codex, and the usage skill as an agent actually follows
  it. Codex runs only basic plugin-integration prompts, an operator bound.
- **Web UI** in a real browser with a virtual WebAuthn authenticator: passkey link and sign-in; the
  operator's passkeys (adding one on this device, renaming, removing, the recent sign-in both need,
  the last passkey kept, and removal ending the browser sessions it signed in); the thread list's
  filters with their counts, the session group and tag filters among them, with a removed group's
  and an unused tag's chips, its search reaching what live messages say and not what a replaced one
  said, its sorts and their direction, and grouping with roll-ups, by session group, by session and
  by agent; the thread page's numbered asks answered several at once, a message's details,
  replacements, mark unread from a message, archive through a message and archive all; stranded's
  reasons; the sessions view, its agent folds and folded rows with what each session reports and
  what waits on the operator, a row unfolded to its log and marking it read, and the folds kept, on
  a phone's width too; the operator's session groups and tags: a session's group and an agent's and
  a session's tags set from their options, the chips that show them, and the Groups and tags sheet's
  rename, its refusal of a name another group or tag has, and its removal, asked first; a thread the
  operator starts there, with the warning for a session not there to see it, and the agent's reply
  in it; registration approval, rejection, and revocation from past requests and a session's
  options; and diagrams, drawn in light and dark, with their Source toggle, their fallback, and the
  viewer's gestures, buttons and keys, on a phone's width too (`docs/operator-guide.md` "Signing
  in", "Using the web UI" and "Approving agents"). Real-phone passkeys, and diagrams and their
  viewer in iOS Safari, are the operator's acceptance, not the tester's.

## Layers to cross-check

Compare what a surface reports with:

- the database, opened read-only beside the running server: what each thread's messages derive (live
  messages, open asks, status, topic) against the log, each session's latest entry in its log
  against the status `session_update` answered and the sessions view shows, registration rows and
  states, browser sessions, used challenges (`docs/architecture.md` "Database");
- files and permissions: the data directory and database stay private whatever the umask, and the
  bridge's key directories under `~/.config/agention/<server>/<agent>/<session>/` are `0700` with a
  `0600` `key.pem`, where `<server>` is the origin's host, with its port when not 443 (`SECURITY.md`
  "Private files" and "The agent bridge");
- processes and sockets: the listener's address and TLS, bridge processes the hosts start and stop,
  and the shutdown `docs/operator-guide.md` "Running the server" and `docs/architecture.md`
  "Serving" describe, with long polls open;
- the other side: what an agent wrote must appear in the web UI, and what the operator answered must
  reach the agent through the bridge;
- host state: the plugin's files and MCP entry as each host loaded them, and the environment each
  host really passes the bridge (`docs/architecture.md` "Generated plugins");
- logs: host MCP logs, bridge stderr, and `agention serve` output hold no token, key bytes, or link
  token.

## Agention's hunts

On top of the method's failure classes, look for:

- **False success**: `register` reporting approval while calls fail, a tool reporting a write the
  thread's log lacks, a passkey ceremony that "succeeds" without a session.
- **Divergence**: the code the bridge relays against the code the sessions view shows, signals,
  roll-ups and a row's unread and total counts in a view against the thread's messages, a stopped
  session whose threads holding an unread message of the operator's are not stranded, or stay
  stranded once it reports working, a session's unread updates against its log and the operator's
  mark, a filter value's count against the list that value produces, a group's roll-up against the
  threads it holds, a tag on an agent against the threads of each of its sessions, an archived
  thread that another party's later message failed to bring back to the list, and one the caller's
  own message brought back.
- **Residue**: a refused key still on disk after the `register` that replaced it, temporary key
  files beside `key.pem`, an expired pending registration that survives the next write to the
  registrations table, browser sessions that outlive a passkey link or the passkey that signed them
  in.
- **Non-idempotency**: a retried request id (same content replays, different content conflicts), a
  repeated `register` that creates anything, a reissued link that leaves earlier ones usable, a
  restart over the same data directory.
- **Concurrency**: a write from the bridge racing one from the web UI, where the loser gets `stale`
  with the missed messages and a losing UI keeps its draft; bridges for one session starting
  together, which share the first key written.
- **Isolation**: one session's threads, positions, or wake-ups reachable with another session's key,
  probed with keys from different homes, since sessions under one home are not isolated by design
  (`SECURITY.md` "The agent bridge"); the operator's groups and tags, or a thread's group, reachable
  from the agent mount or the bridge, or an agent's search finding what a message says rather than
  its title; message text rendered live. The Markdown inputs: a message whose text or details hold a
  code block, a table, a task list, strikethrough, an `https` link, an `http` link, a raw `<b>` tag,
  an image and a `mermaid` block, in a thread whose title holds Markdown syntax. The first five
  render as formatting with a working link, the `http` link is plain text, the tag shows literally,
  the image shows as a link and the browser never requests it, the `mermaid` block shows as a
  diagram image drawn in the sandboxed frame, the title shows its syntax literally, and the agent
  reads the message back unchanged (`SECURITY.md` "Security model"; `docs/operator-guide.md` "Using
  the web UI"). Diagrams are drawn in isolation: a hostile `mermaid` source, with script, event
  handlers, links, `click` directives and directives that try to lower the security level, runs
  nothing in the page, requests nothing beyond the server, and leaves the frame where it was; a
  diagram image's `blob:` URL, once the image shows, no longer opens on its own; and
  `/diagram-frame` opened on its own does nothing.
- **Environment masking**: the Agentworks variables present or absent, a different umask, clock skew
  between bridge and server, `NODE_TLS_REJECT_UNAUTHORIZED=0` in the bridge's environment.
- **User hostility**: errors that do not say how to recover (an expired registration, a wrong
  origin, a skewed clock), a long poll that outlives its ceiling, a code that is hard to read aloud.

## Bed rails

On top of the method's safety rails:

- Servers a tester starts listen on the loopback only. Probe the plain-HTTP guard with non-loopback
  addresses and expect refusal; if a server starts anyway, stop it at once, and that start is the
  finding. Floods, budget draining, `passkey-link`, and the virtual-authenticator drive belong on
  the tester's own loopback instance, never on one where the operator has enrolled a passkey.
- Never run a `tailscale` command: on the live instance behind `tailscale serve`, the operator runs
  every one.
- Start every host and bridge with `AGENTION_URL`, `AGENTION_CONNECT`, `NODE_EXTRA_CA_CERTS`,
  `AGENTWORKS_AGENT`, and `AGENTWORKS_SESSION` set for the run (the Agentworks pair from the
  tester's namespace, or unset; `AGENTION_CONNECT` empty unless the run tests it), never inherited,
  so nothing registers, signs, or stores a key as the operator's real session, or connects through
  the operator's tunnel.
- Write nothing to shared `/tmp`: set `TMPDIR` to the run's scratch directory for every process the
  run starts, and put tarballs, renders, and certificates there too.
- The bridge's key path is fixed under the home directory, so use a separate `HOME` wherever the run
  allows it, including for checking a plugin's installed files. Load the plugin into an
  authenticated Claude Code session with `claude --plugin-dir <path>` (that session only). Install
  into a real home only when the charter names it, one tester at a time, never where an `agention`
  plugin or marketplace already exists. On Claude Code, add the marketplace with
  `claude plugin marketplace add <path> --scope local` and install with
  `claude plugin install agention@agention --scope local`, both in the run's scratch project; a
  Codex install changes the whole home. Allow only the plugin's tools for the run
  (`--allowedTools`); never use a permission-bypass mode or save an allow rule.
- Run Codex in its default approval and sandbox mode, with no override flag, and never change its
  trust settings: that mode is what host verification proves.
- Never publish a package; an npm release cannot be undone.
- Cleanup verification covers the layers above, plus the local marketplace, plugin caches, the npx
  cache entry for the run's tarball, host session records the run created, browser profiles,
  rendered plugins and tarballs, and any parent key directory the baseline shows the run created.
