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
  to the same operator. Adding a passkey, removing one and every change to voice need a sign-in
  within the last 10 minutes, and removing a passkey ends the browser sessions it signed in. Passkey
  links come only from `agention passkey-link` on the server's machine, so holding a passkey never
  yields one, and access can always be recovered there: a link replaces every passkey, which signs
  out every browser and revokes every API key, works once within 15 minutes, and issuing one revokes
  every unused link. A program acting for the operator authenticates with an API key the operator
  created ([API keys](#api-keys)). No credential works on another's surface: a browser session only
  on the web mount, an agent's token only on the agent mount, and an API key only on the operator
  mount.
- **Inert content.** A message's text, its detail and its references are displayed, never executed,
  fetched or followed by the server. Markdown renders with raw HTML shown as text, images shown as
  links rather than loaded, and only HTTPS links live; no class or style comes from the text. A
  Markdown link to `attachment:` and a name is live only when the name is a file of the message's
  own, and then opens that file as the message's own list does. Files attached to messages are not
  message text: they load only as [Attachments](#attachments) describes, and nothing in a message's
  text loads one. Every other field, such as a title, a question or an answer's own words, shows as
  plain text, as written. Search text is matched word by word, each word quoted, so it is never read
  as query syntax. A fenced `mermaid` block is drawn as a diagram, by Mermaid in a frame of its own,
  never in the web UI's page: the frame is sandboxed with scripts only, so its origin is opaque and
  it can read none of the web UI's cookies, storage or page, navigate the page, open windows or
  submit forms, and its own content security policy sandboxes it too, even opened on its own, lets
  it load nothing but its one script and fetch nothing, and lets only the server's own pages frame
  it. The page sends the frame the diagram's text, accepts answers only from the frame's window, and
  shows the SVG it answers as an image, which runs no script and loads nothing. The SVG is never
  shown any other way. Its `blob:` URL, opened on its own by browser navigation, would be a document
  of the web UI's origin under none of the web UI's content security policy, where what Mermaid's
  strict level keeps, such as an image in a label or a link, would load; so the page revokes each
  image's URL as soon as the image has loaded, leaving none to open, and until then only the page's
  own script knows it. A source over 10,000 characters is not drawn, and Mermaid runs at its strict
  security level. Where a browser runs the frame on the page's own thread, a diagram that sends
  Mermaid into a busy loop can still freeze the page; the size cap and Mermaid's own limits are the
  defense there. The content security policy lets the web UI load only its own scripts, styles,
  images and media, and the `blob:` images it makes from the frame's answers, and frame only the
  diagram frame, as a second line. No text can break the web UI: a field that fails to render shows
  as its text, and text nested too deeply shows as text without being parsed. Text can still slow
  it: some Markdown parses in more than linear time, milliseconds for a message's text, which holds
  at most 1,000 characters, but up to about 2.5 seconds for a detail at its bound of 20,000. A
  thread page renders the text of up to 50 messages at a time and parses a detail once each time it
  is opened, not as the page refreshes, so a deliberately hostile detail can stall one thread's page
  for that long each time it is opened. The lists render no Markdown, so the operator can still
  reach the sessions view and revoke the session's credential.
- **No network identity.** No authentication decision or rate limit depends on source address,
  forwarded headers or network identity, so Agention does not rely on its network path for security.
  The server answers only for its configured origin's host, and plain HTTP is refused on a
  non-loopback address unless explicitly enabled. Rate budgets per agent key, per API key and per
  kind of request keep one kind of traffic from starving another. Most shared budgets are spent only
  by failed requests, so exhausting them never refuses a valid key, passkey or link; someone who can
  reach the server can still exhaust the budget for registering new agent keys and delay new
  registrations.

The plugin's skill has an agent take a message the operator wrote exactly as it takes the operator's
words at its terminal: answers, instructions and corrections carry the operator's authority, within
the limits the agent already works under, and no agent can write as the operator (**Identity and
provenance**, above). So whatever can act as the operator can direct every approved agent within
that agent's own permissions: a passkey, a browser signed in with one, an API key holding
`threads:write`, which writes as the operator, or `sessions:approve`, which lets agents in, and the
server itself, meaning the user that runs it (so an agent running as that user can act as the
operator), its data directory, `agention passkey-link` on its machine, and whatever terminates TLS
for its origin, such as `tailscale serve` or a reverse proxy. Guard them as you would the agents'
terminals. Inert content matters for the same reason: a script running in the web UI could write as
the operator.

### Voice

Voice is optional and off until the operator chooses a transcription provider in Settings, or the
server's environment supplies one. Reading a message aloud is the browser's own speech, on the
device, and involves no server.

- **Where audio goes.** The browser sends a recording to the server, which sends it to the provider
  in effect and returns only the text. The server keeps neither the recording nor the text, and logs
  only the kind of a provider's failure and its status, never the request, the key, the audio or
  what the provider answered. Only the operator's signed-in browser can transcribe: the route is on
  the web mount alone, and so are the settings', so no agent reaches any of it. Whoever runs the
  provider's address receives the recordings, under its own terms, which Settings link to for the
  hosted presets.
- **The key.** The provider's key is a secret like the server's own: written in Settings and never
  read back whole, and never logged. No agent receives any of it, and a browser only its last four
  characters, which Settings show in the masked key field so the operator can tell which key is in
  effect; a key shorter than 16 characters shows none, so the four are never more than a quarter of
  it. A key saved in Settings goes only to the base URL it was entered for: changing the base URL
  clears it, and a base URL the environment changes leaves it unused until the operator enters it
  again. A backup holds a key saved in Settings, which is one reason backups are private files. A
  key from `AGENTION_TRANSCRIPTION_KEY` needs `AGENTION_TRANSCRIPTION_URL` too, so it only goes to
  an address from the environment; it is never written to the database, and belongs in an
  environment file only the server's user can read.
- **The base URL.** Changing it needs a recent sign-in, so a browser left signed in cannot redirect
  the recordings or the key. It is absolute, with no user, password, query or fragment; `https`
  reaches any host, and plain `http` only `localhost` and IP addresses on the operator's own network
  (loopback, the private ranges, the tailnet range `100.64.0.0/10` and unique local IPv6 addresses),
  where the key and the recordings cross that network unencrypted, as Settings warn. An IP address
  is judged in whatever spelling it was given, an IPv4-mapped IPv6 address as the IPv4 address it
  maps; an address in the NAT64 well-known prefix `64:ff9b::/96` is refused wherever the IPv4
  address it embeds would be, but is never the operator's own network, since a translator carries it
  across networks they may not control. Over either scheme these are never reached: link-local
  addresses, where most cloud metadata services live; the named metadata addresses outside them,
  `100.100.100.200`, `fd00:ec2::254` and `fd20:ce::254`; the unspecified address; and multicast. A
  host name other than `localhost`, which `https` allows, is not resolved and judged by address:
  there the provider's certificate, which the server verifies, is what keeps the request from
  anything else, since a metadata service or an internal host answering for that name cannot present
  one. The rule is checked when a base URL is saved or read from the environment, and the saved one
  again for each request, and requests to the provider follow no redirect.
- **The text.** A transcript goes into the operator's draft as text, which they read, change and
  send themselves; nothing is sent without them, so a provider can put words in a draft but never in
  a thread.

### API keys

An API key is a bearer credential with the operator's reach within its scopes: whoever holds it acts
as the operator, over every session, until it expires or is revoked. It exists so that programs the
operator runs can act for them ([ADR 0003](docs/adrs/0003-operator-api-keys.md)).

- **The secret.** 256 random bits, after the prefix `agention_` so that people and secret scanners
  recognize one. The server stores only its SHA-256, so a copy of the database, a backup included,
  holds no usable key; it never logs a key, and never sends one back after creating it. Settings
  show the secret once, held only in the page's memory, never in storage, the address or a log,
  until the operator dismisses it.
- **Where it works.** Only on the operator mount, `/api/operator/v1/`, as `Authorization: Bearer`.
  The operator mount refuses any request carrying a cookie, and the web mount any carrying an
  `Authorization` header, so neither credential can borrow the other's authority. A browser never
  attaches a bearer key on its own, so CSRF does not arise on the operator mount, and it needs no
  CSRF token or `Origin`.
- **What it reaches.** The operations its scopes grant, and nothing else: an operation outside them
  answers as one that does not exist, and a read scope grants only reads, which change nothing. No
  key can create, list or revoke keys, add or remove passkeys, change Settings or transcribe; those
  stay behind a passkey, so a leaked key can neither make itself another key nor outlive its
  revocation. A key holding `threads:write` writes as the operator, files it uploads and attaches
  included, and agents take what it writes as the operator's direction. A key holding `threads:read`
  reads every file every thread holds, as the operator can. A key's uploads are the operator's,
  under the operator's pending limits, and a message attaches only its writer's own, so a key can
  remove a pending upload of the operator's but never a file a message carries. A leaked key holding
  `sessions:approve` can approve an agent's registration, letting an agent of its holder's choosing
  into the operator's sessions, so Settings and the operator guide say what that scope grants. A
  message written with a key is the operator's, and records no key.
- **Its life.** A key expires when the operator chose, at most a year after it was created, unless
  they chose no expiry, which Settings warn against. Revocation and expiry take effect at once:
  every operation confirms the key inside its own transaction, and a wait the key holds ends with
  its refusal as soon as the key is revoked or expires. Replacing the passkeys with a passkey link
  revokes every key, since whoever held the old passkeys could have created some. Creating and
  revoking a key need a sign-in within the last 10 minutes, and at most 20 keys are live at once.
- **Refusals.** Every refusal of a key is the same, so none tells whether a key ever existed. Failed
  key authentication spends a shared budget that never refuses a live key.
- **The documentation.** `agention serve --api-docs` serves the API's documentation without sign-in
  to anyone who reaches the origin. It describes the contract, never data, and without the flag
  nothing is served there. Its page is static HTML under a content security policy of its own that
  lets it load, run and submit nothing.

### Attachments

Agents and the operator attach files to messages. A file is uploaded first, then a message names the
upload, and from then on the file is that message's, under its name, for good. The server keeps
files in its database, so they are in every backup.

- **What a file can do.** Nothing a file holds runs as a document of the server's origin, whatever
  its bytes are: the server never reads a file to decide how to serve it, and serves it only under
  these rules. A file is answered as the type it declared when that is on a short allowlist (PNG,
  JPEG, GIF and WebP images, SVG, PDF, and common video and audio types), as
  `text/plain; charset=utf-8` when it is text of any kind, HTML included, and otherwise as
  `application/octet-stream`. Every file response carries `X-Content-Type-Options: nosniff`, the
  content security policy `sandbox; default-src 'none'; frame-ancestors 'none'`, so a file opened on
  its own is a document of an opaque origin that runs, loads and frames nothing,
  `Cross-Origin-Resource-Policy: same-origin`, and a `Content-Disposition` that downloads SVG and
  everything off the allowlist when opened on its own. The web UI shows a file only as an element of
  its own page: images as `<img>`, which runs no script and loads nothing an SVG names, video and
  audio as players, and text as text it fetched and shows as written. A PDF opens in a tab of its
  own, in the browser's viewer. No file is shown in a frame or turned into a `blob:` or `data:` URL.
  Chrome's viewer keeps only the framing rule of a PDF's policy, so there a PDF's safety rests on
  the viewer, which runs no script of the server's origin. Firefox, whose viewer is pdf.js, and
  Apple's browsers are untested for that.
- **Who can read a file.** Whoever can read the thread that holds it: the operator, signed in or
  through an API key holding `threads:read`, and the agents of that thread's session, each on its
  own mount, with the same answer as for a thread that does not exist for anyone else. Uploading and
  removing an upload need `threads:write`. Every chunk read or written checks the credential and its
  scope again, so a revoked agent's or a revoked or expired API key's transfer stops within a
  megabyte.
- **References are private to their writer.** An upload answers with a random 128-bit reference, and
  a message can name only an upload of its own writer, in the same session, that no message has
  named yet and that has not expired. A writer can also remove such an upload of its own before any
  message names it. Any other reference, another session's among them, is refused in the same words
  by both, so a reference learned elsewhere is worth nothing.
- **Disk and the connection.** A file is at most 100 MiB, and a message carries at most 10. Each
  writer holds at most 20 pending uploads, and 1 GiB of them, counting those still arriving and not
  those expired; an upload no message names expires 24 hours after it completes, and a sweep removes
  it. An upload is refused as `storage_full` unless the disk holding the database would keep 1 GiB
  free beyond every upload still arriving, so attachments cannot fill the disk under the database.
  An upload is authenticated from its headers before any of its body is read, and a refused one is
  read for at most half a second or 64 MiB before its connection closes. Its bytes are written a
  megabyte per transaction, each checking the credential again, so other requests run between them,
  and any request body that sends nothing for 30 seconds is cut off.
- **Photos keep their metadata.** Nothing resizes, re-encodes or strips a file, so a photo keeps
  what its camera wrote into it, its location among it, and an agent that fetches it can read that.
  Remove what an agent should not see before attaching it.
- **Files stay in the browser's cache.** Files are cached privately for a year, since the bytes at a
  file's address never change, so seeking a video or reopening a photo does not fetch it again on a
  phone's data plan. The price is deliberate: a file stays in that browser's cache after signing
  out, so on a shared device clear the browser's data for the server's site.

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
  session's proposed names, the public key, and what the bridge's tools are given, the bytes of a
  file `file_upload` names among it.
- **Files it reads.** `file_upload` reads only the path the agent gives it, as the user the bridge
  runs as, and refuses anything but a regular file, a file over 100 MiB, and anything whose real
  path is in `~/.config/agention`, the bridge's key directory, so a key named directly or through a
  symlink is never sent. It opens the path without waiting and without taking a terminal as the
  bridge's own. This keeps an agent from handing the server a credential by mistake; it is no
  boundary against the agent, which runs as the same user and could read the key itself, so a hard
  link to a key elsewhere, whose real path is its own, is not refused.
- **Files it writes.** `file_get` writes only into `~/.cache/agention/files/`, a
  [private](#private-files) directory outside the key directory, each file with mode 0600 and named
  by the file's reference and the extension of the type it was served as, never by the name its
  sender gave it. It writes through a temporary file that a failure removes, writes nothing of an
  answer that does not state a length of at most 100 MiB, and removes what it fetched more than
  seven days ago. A fetched file is material for the agent to work with, never the operator's
  instructions, as the usage skill says.
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
