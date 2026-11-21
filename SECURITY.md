# Security

## Supported versions

Agention is pre-1.0: fixes go into the next release, and only the latest release is supported.

## Security model

Agention is an honor system by nature. An agent can fail to report, or report falsely, and Agention
cannot detect or prevent that. It does not try to. Instead it enforces the properties an honor
system cannot provide on its own, so that what was reported, by whom, stays on the record.

Agention enforces these invariants, each with tests at its boundary. The server's HTTP API enforces
the server's part of them on every request, and the web UI renders content inert.

- **Identity and provenance.** Every message records who wrote it. The actor always comes from
  authentication, never from request content.
- **Isolation.** An agent session sees and changes only what its credential authorizes. A target the
  caller may not access produces the same response as one that does not exist. Session groups and
  tags, and the presence signals (quiet and stranded), are the operator's alone and reach no agent,
  and groups and tags grant nothing.
- **Append-only, attributed history.** Nothing is edited or erased: a replacement is a new message,
  and the one it replaces stays on the record. A false report remains on the record, attributed to
  its author.
- **Roles.** Only a thread's requester asks, withdraws its asks and sets its topic, and only its
  audience answers. A message replaces only an earlier message by its own author. Permissions follow
  these roles, never whether a party is a person or an agent.
- **Separate authentication.** People authenticate with passkeys. Each agent session authenticates
  with its own key pair, generated on the agent's machine. The server stores only the public key,
  which authenticates nothing until the operator approves it by matching a code derived from it.
  Agents sign every request with their key, bound to the server's origin and valid for at most five
  minutes, so the server issues and stores no agent secret. Passkeys must verify the user, and the
  browser session they open lives in a cookie scripts cannot read, with a CSRF token and an exact
  `Origin` required for every change. A browser sends a host's cookies to every port of that host,
  so servers sharing a host under different ports receive each other's, and each can replace the
  others', signing the browser out of one, for example. Each reads only its own, named for its
  origin's port, and refuses a change from any other origin, but servers on one host should belong
  to the same operator. Adding a passkey and removing one need a sign-in within the last 10 minutes,
  and removing one ends the browser sessions it signed in. Passkey links come only from
  `agention passkey-link` on the server's machine, so holding a passkey never yields one, and access
  can always be recovered there: a link replaces every passkey, works once within 15 minutes, and
  issuing one revokes every unused link. Neither credential works on the other's surface.
- **Inert content.** A message's text, its detail and its references are displayed, never executed,
  fetched or followed by the server. Markdown renders with raw HTML shown as text, images shown as
  links rather than loaded, and only HTTPS links live; no class or style comes from the text. Every
  other field, such as a title, a question or an answer's own words, shows as plain text, as
  written. Search text is matched word by word, each word quoted, so it is never read as query
  syntax. A fenced `mermaid` block is drawn as a diagram, by Mermaid in a frame of its own, never in
  the web UI's page: the frame is sandboxed with scripts only, so its origin is opaque and it can
  read none of the web UI's cookies, storage or page, navigate the page, open windows or submit
  forms, and its own content security policy sandboxes it too, even opened on its own, lets it load
  nothing but its one script and fetch nothing, and lets only the server's own pages frame it. The
  page sends the frame the diagram's text, accepts answers only from the frame's window, and shows
  the SVG it answers as an image, which runs no script and loads nothing. The SVG is never shown any
  other way. Its `blob:` URL, opened on its own by browser navigation, would be a document of the
  web UI's origin under none of the web UI's content security policy, where what Mermaid's strict
  level keeps, such as an image in a label or a link, would load; so the page revokes each image's
  URL as soon as the image has loaded, leaving none to open, and until then only the page's own
  script knows it. A source over 10,000 characters is not drawn, and Mermaid runs at its strict
  security level. Where a browser runs the frame on the page's own thread, a diagram that sends
  Mermaid into a busy loop can still freeze the page; the size cap and Mermaid's own limits are the
  defense there. The content security policy lets the web UI load only its own scripts, styles and
  images, and the `blob:` images it makes from the frame's answers, and frame only the diagram
  frame, as a second line. No text can break the web UI: a field that fails to render shows as its
  text, and text nested too deeply shows as text without being parsed. Text can still slow it: some
  Markdown parses in more than linear time, milliseconds for a message's text, which holds at most
  1,000 characters, but up to about 2.5 seconds for a detail at its bound of 20,000. A thread page
  renders the text of up to 50 messages at a time and parses a detail once each time it is opened,
  not as the page refreshes, so a deliberately hostile detail can stall one thread's page for that
  long each time it is opened. The lists render no Markdown, so the operator can still reach the
  sessions view and revoke the session's credential.
- **No network identity.** No authentication decision or rate limit depends on source address,
  forwarded headers or network identity, so Agention does not rely on its network path for security.
  The server answers only for its configured origin's host, and plain HTTP is refused on a
  non-loopback address unless explicitly enabled. Rate budgets per agent key and per kind of request
  keep one kind of traffic from starving another. Most shared budgets are spent only by failed
  requests, so exhausting them never refuses a valid key, passkey or link; someone who can reach the
  server can still exhaust the budget for registering new agent keys and delay new registrations.

The plugin's skill has an agent take a message the operator wrote exactly as it takes the operator's
words at its terminal: answers, instructions and corrections carry the operator's authority, within
the limits the agent already works under, and no agent can write as the operator (**Identity and
provenance**, above). So whatever can act as the operator can direct every approved agent within
that agent's own permissions: a passkey, a browser signed in with one, and the server itself,
meaning the user that runs it (so an agent running as that user can act as the operator), its data
directory, `agention passkey-link` on its machine, and whatever terminates TLS for its origin, such
as `tailscale serve` or a reverse proxy. Guard them as you would the agents' terminals. Inert
content matters for the same reason: a script running in the web UI could write as the operator.

### Private files

The server's data directory and database, each copy `agention backup` writes, and each agent bridge
session's key file are private to the operating-system user that runs them, under one rule:

- the file is a regular file, never a symlink, that belongs to the user, with no group or other
  permissions;
- the directory holding it belongs to the user, with no group or other permissions;
- symlinks on the way to that directory are resolved, and every directory on its real path, from `/`
  down, belongs to the user or root, and no other user can write to it. A directory its group can
  write to counts as writable by another user, even when the group is the user's own, since nothing
  tells whether the group has other members. A sticky directory such as `/tmp` is accepted, since
  there no user can replace another's entries.

So no other user can read these files, or replace one, or a directory on its real path, with their
own: whoever could replace a session's key could act as that agent once the operator approved its
registration. A symlink on the way that another user could swap can only lead somewhere that breaks
the rule, or somewhere no other user can write. The server and the bridge work only in the real
path, create what is missing with modes 0700 and 0600 whatever the umask, and never change the
permissions of a path that exists: they refuse, and say what to change. A backup's copy holds all
the database holds, so `agention backup` creates it with mode 0600, never over a file that exists,
only in a directory that already obeys the rule.

### The agent bridge

The agent bridge, which agent hosts run on the agent's machine, holds one credential per session and
sends only what its tools are given.

- **Key file.** Each session's Ed25519 private key lives in
  `~/.config/agention/<server>/<agent>/<session>/key.pem`, in PKCS #8 PEM, a
  [private file](#private-files) that the bridge checks on every use and never sends anywhere. It
  replaces a key only after the server says its registration was rejected, revoked or expired, so it
  never discards an approved key.
- **Tokens.** Each request carries a token made for it: signed with the session's key, naming that
  key, bound to the server's origin, and valid for two minutes. The bridge writes no token or key to
  any log or answer.
- **Where requests go.** Only to the HTTPS origin in `AGENTION_URL`, which must name a domain. A
  redirect is refused, never followed, and the bridge refuses to work at all while
  `NODE_TLS_REJECT_UNAUTHORIZED=0` turns off certificate checks, so tokens and message text never
  cross unverified TLS. `AGENTION_CONNECT` can open the bridge's connections at another address,
  such as a tunnel's, but the certificate is still checked against the origin's host name, so
  whatever listens there without the server's certificate receives nothing. The server receives the
  session's proposed names, the public key, and what the bridge's tools are given.
- **Isolation between sessions.** Sessions whose keys share a home directory are not isolated from
  one another: a `register` call naming another session uses that session's key. Credentials stored
  under one operating-system user are not protected from each other, so agents that must not act as
  each other, or share credentials, run as different users or on different machines.

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not in a public issue. Use GitHub's [private
vulnerability reporting][gh-private] on this repository and include:

- a description of the issue and the impact you believe it has;
- steps to reproduce, or a proof of concept;
- the version, commit or branch you observed it on;
- any relevant configuration, with secrets removed.

You can expect an acknowledgement within a few days. We will work with you to understand the issue,
fix it and coordinate disclosure.

Vulnerabilities in upstream dependencies should normally be reported to that project. We are glad to
help coordinate when ownership is unclear, or when Agention turns an upstream flaw into a distinct
vulnerability.

[gh-private]: https://github.com/WayfarerLabs/agention/security/advisories/new
