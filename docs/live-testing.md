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
  `agention serve`, including its plain-HTTP guard and `--api-docs`; `agention passkey-link`;
  `agention backup`, taken while agents and the operator write and while the server is stopped, the
  copy's mode and its refusals of an existing file and of a directory others can read, a database it
  leaves unmigrated, and a restore from the copy by the operator guide's steps, after which the
  server serves the threads the copy holds and nothing written after it; `agention version`;
  `agention --help` (`docs/operator-guide.md` "Commands" and "Backing up"); and the voice
  environment variables, each value that breaks its rules, and a key without a base URL, refusing
  the start by naming the variable and never printing the value (`docs/operator-guide.md` "Voice
  from the environment").
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
  as `invalid_input`. The settings and transcription routes on the web mount only, each unknown on
  the agent mount; every voice change refused without a recent sign-in; a base URL the rule refuses
  in any spelling of a refused address; a changed base URL clearing the key; no answer or log
  carrying a key or a provider's body; and each provider failure, against a local stub provider
  (`docs/architecture.md` "Voice"). The operator mount (`/api/operator/v1`) with keys created in
  Settings, driven with `curl` from the served documentation alone: a key of each scope reading and
  writing what its scope grants, a write or an approval refused to a read key as `not_found`, a
  cookie on the operator mount and a key on the web mount refused, a mistyped, revoked or expired
  key refused with one and the same answer, the key, passkey, settings and transcription routes
  unknown there, `GET /api/operator` listing the versions and an unknown version `not_found`, and
  the API key budget; the operator's wait across sessions, answering at once, woken by a message in
  another session, never woken twice for one message when its `since` is passed back, continuing a
  full page, and ending at once with its refusal when its key is revoked or expires and when the
  browser session holding it on the web mount signs out or loses its passkey; and `--api-docs`: the
  page at `/docs/api/` and `/docs/api/openapi.json` without sign-in, `/docs/api` leading to the
  page, the page running no script, the document equal to `docs/api/openapi.json` at the head, and
  without the flag every path under `/docs/api` the JSON `not_found` (`docs/architecture.md` "HTTP
  API", "API documentation" and "Authentication"; `docs/operator-guide.md` "Using the operator
  API").
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
  replacements, mark unread from a message, archive through a message and archive all; Send and what
  answers it kept on a short screen while writing, and the way back under the composer; stranded's
  reasons, in the warning's color in both tabs; the sessions view, its group and agent folds and
  folded rows with what each session reports, when it was last seen and whether it is quiet, its
  open asks in the thread list's words and its threads' roll-up, the links from a row, an agent and
  a group to the thread list filtered to them, and from a row's and an agent's stranded flag to
  their stranded threads, a row unfolded to its log and marking it read, the Sessions tab's count of
  sessions with unread updates falling as logs are read, and the folds kept, on a phone's width too;
  the operator's session groups and tags: a session's group and an agent's and a session's tags set
  from their options, the chips that show them, and the Groups and tags sheet's rename, its refusal
  of a name another group or tag has, and its removal, asked first; a thread the operator starts
  there, with the warning for a session not there to see it, and the agent's reply in it;
  registration approval, rejection, and revocation from past requests and a session's options;
  diagrams, drawn in light and dark, with their Source toggle, their fallback, and the viewer's
  gestures, buttons and keys, on a phone's width too; Settings in sections, listed beside the open
  one on a wide screen and listed first on a phone with each section's way back, with `/passkeys`
  leading to Passkeys; API keys: one created with each expiry choice, the no-expiry warning and the
  list's flag, a scope that a chosen one includes shown chosen with it, the secret shown once with
  Copy and gone once dismissed, nowhere in storage or the address, the list's last use, Revoke asked
  first, creating and revoking held back without a recent sign-in, and Create held back at 20 live
  keys, at a phone's width too; and voice set up, with the write-only key, what the environment
  supplies shown read-only, Turn off and Try it; dictation through Chromium's fake microphone and a
  stub provider, its text at the caret with nothing sent, the microphone and what it says beside
  Send on a short screen, its failures keeping the recording for a retry, and a recording stopped
  when the page is hidden; and Read aloud and Stop, in WebKit too where it installs
  (`docs/operator-guide.md` "Signing in", "Using the web UI", "Voice" and "Approving agents").
  Real-phone passkeys, Send above a phone's keyboard while writing, dictation with a real provider,
  and diagrams and their viewer in iOS Safari, are the operator's acceptance, not the tester's.

## Layers to cross-check

Compare what a surface reports with:

- the database, opened read-only beside the running server: what each thread's messages derive (live
  messages, open asks, status, topic) against the log, each session's latest entry in its log
  against the status `session_update` answered and the sessions view shows, registration rows and
  states, browser sessions, used challenges, API keys holding only their secret's hash, and each
  message's position (`docs/architecture.md` "Database");
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
- logs: host MCP logs, bridge stderr, and `agention serve` output hold no token, key bytes, link
  token, API key, transcription key, recording or transcript;
- the provider's side: what the stub provider received (the recording, the model, the prompt, the
  key) against the settings in effect, and nothing sent to it after its base URL changed.

## Agention's hunts

On top of the method's failure classes, look for:

- **False success**: `register` reporting approval while calls fail, a tool reporting a write the
  thread's log lacks, a passkey ceremony that "succeeds" without a session.
- **Divergence**: the code the bridge relays against the code the sessions view shows, signals,
  roll-ups and a row's unread and total counts in a view against the thread's messages, a stopped
  session whose threads holding an unread message of the operator's are not stranded, or stay
  stranded once it reports working, a session's unread updates against its log and the operator's
  mark, a session's open asks and whether they block against its threads' asks and their Blocked on
  you marks, the Sessions tab's count against the sessions with unread updates, a filter value's
  count against the list that value produces, a group's roll-up against the threads it holds and the
  list its link opens, a stranded count in the sessions view against the list its link opens, a tag
  on an agent against the threads of each of its sessions, an archived thread that another party's
  later message failed to bring back to the list, and one the caller's own message brought back.
- **Residue**: a refused key still on disk after the `register` that replaced it, temporary key
  files beside `key.pem`, an expired pending registration that survives the next write to the
  registrations table, browser sessions that outlive a passkey link or the passkey that signed them
  in, a wait that outlives the key or the browser session holding it, a key's secret left on the
  page once dismissed.
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
- Transcribe only against a local stub provider, with a made-up key; a real provider and a real key
  are the operator's own check.
- Never publish a package; an npm release cannot be undone.
- Cleanup verification covers the layers above, plus the local marketplace, plugin caches, the npx
  cache entry for the run's tarball, host session records the run created, browser profiles,
  rendered plugins and tarballs, and any parent key directory the baseline shows the run created.
