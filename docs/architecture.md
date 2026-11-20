# Architecture

This document describes what exists in the repository today. Agention v1 is under development; its
intended design, and the alternatives considered, are recorded in
[ADR 0001](adrs/0001-agention-v1-architecture.md).

Agention is TypeScript on Node, in npm workspaces with one lockfile.

| Component                | State                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api`           | The API contract: zod schemas for every route's requests and responses, which are also their bounds, and the error codes.        |
| `packages/build`         | The bundle build the server and the bridge use: one esbuild file each, with the license notices of the npm packages it includes. |
| `packages/private-files` | The private-file rule the server's database and the bridge's key files obey, which both bundle.                                  |
| `apps/server`            | The `agention` CLI: `serve` runs the HTTP API, with agent and passkey authentication, over the database, identity and store.     |
| `apps/bridge`            | The `agention-mcp` agent bridge: a stdio MCP server whose tools make requests on the agent API, signed with the session's key.   |
| `apps/web`               | The React web UI, built with Vite, which the server package ships and serves: passkey sign-in and the operator's views.          |
| `apps/agent-plugin`      | The canonical plugin definition and usage skill, and the generator that renders the Claude Code and Codex plugins.               |
| `scripts/`               | The checks CI runs, file linting, and plugin generation.                                                                         |

## Source and packages

Node runs the TypeScript sources directly, by stripping their types, so development and the plugin
generator need no build step; Vitest compiles the sources for the tests. `packages/api` needs no
build either: its `exports` point at its source.

The server and the bridge each build into one esbuild bundle, which is what their npm packages
contain. The packages declare no dependencies, so installing either resolves nothing beyond what the
repository's lockfile built. The server's build first runs the web UI's Vite build and copies it
into the package's `web/` directory. Beside each bundle the build writes `THIRD-PARTY-NOTICES.txt`,
the license of every npm package the bundle includes and, for the server, of every package in the
web build, which Vite reports. An included package whose own build inlined other npm packages names
them in its files' region comments; the bundle's notices include those too, read from copies the
bundling package lists under `devDependencies` at the inlined versions, and the build fails if one
is missing. Each package carries a copy of the repository's `LICENSE` and a `README.md` of its own
for its npm page. Each bundle embeds its package's `package.json` at build time and reports that
version.

The checks pack each package as npm would publish it, confirm it declares no dependencies and ships
both license files and a `README.md`, then install it from the tarball outside the repository and
run its command through `node_modules/.bin`, which must print the package's version. The installed
server is also started on loopback, and must serve the web UI its package ships and answer the API.

## API contract

`packages/api` defines, as zod schemas, the requests and responses of every route, and exports the
inferred types the server, the bridge and the web UI share:

- starting a thread, sending a message, reading a thread, a session's thread list and the long poll;
- read, unread and archive marks; the operator's thread list with its total and, grouped, its
  groups' roll-ups; the counts of what each filter value keeps; and bulk read and archive;
- registration submit and state, the registrations list, approval and the agents list, a page of
  agents each with its sessions;
- the browser session's state, the passkey ceremonies' inputs and the operator's passkey list;
- the claims of an agent's token, and the error shape.

The schemas are the bounds: text lengths count Unicode code points, required text needs a character
other than white space, single-line plain fields refuse line breaks, control characters and
invisible format characters, and a URL is accepted only if `isLinkableUrl` would show it as a link.
An optional list, such as a message's references, is omitted rather than empty. A message's text, a
summary read first, holds at most 1,000 code points, and its detail, the Markdown long form beside
it, at most 20,000; every message's schema refuses detail without text, naming `detail`, and the
descriptions of both fields say what each carries, since the bridge's tools show them to agents.
Query parameters are read into the same schemas as body fields; a filter of several values repeats
its parameter, once for each, and a parameter repeated where one value is taken is refused. Request
schemas ignore fields they do not know, so a newer bridge works against an older server.
`invalidInputBody` turns a schema failure into the error shape, naming the field at fault as a
dotted path.

The registration code, which the bridge and the server both derive from a session key, has its own
entry point, `@wayfarerlabs/agention-api/registration-code`, because it uses `node:crypto` and must
stay out of the web bundle. It takes a key the `publicKey` schema has accepted.

`canonicalOrigin` reads the HTTPS origin a person configures, the server's `--origin` and the
bridge's `AGENTION_URL` alike, into its one spelling, and refuses anything that is not exactly an
origin with a domain name, including an explicit default port and an IP address, for which browsers
refuse passkeys. A domain name is labels of 1 to 63 letters, digits and hyphens, at most 253
characters in all, once an internationalized name is converted to ASCII. A refusal quotes at most
the first 100 characters of the value. Passkeys, browser checks and agent tokens are bound to that
string, so both ends must spell it alike.

## Private files

[SECURITY.md](../SECURITY.md#private-files) states the private-file rule that the server's data
directory and database and the bridge's key files obey. `packages/private-files` holds the functions
that apply it and the `PrivateFileError` they refuse with, which each caller words in its own error;
the server and the bridge bundle it.

## Database

The server opens one `node:sqlite` connection per process (`apps/server/src/database/`), at the
database's real path. Opening refuses, before SQLite reads the file, a data directory, database file
or file beside it that breaks the private-file rule, and a file whose SQLite header is not
Agention's. A refusal is a `DatabaseOpenError` whose `reason` says which rule failed.

Migrations are an ordered list of SQL scripts; `PRAGMA user_version` records how many have run, and
a database written by a newer release is refused. Every table is `STRICT`, times are Unix
milliseconds, and messages are append-only, with their asks, answers and withdrawals, enforced by
triggers that also catch `REPLACE`. A message's asks, answers and withdrawals are rows of their own:
each ask is numbered within its thread, from 1 in the order asks are written and a message's own in
the order given, and is never renumbered; each answer belongs to its message and names the number of
the ask it answers, and reads back with that ask's question, so a reader knows what it answers; each
withdrawal belongs to its message and names the number of the ask it withdraws, with the requester's
reason. Two views define once, for every query, which messages are live (`live_messages`: no later
message replaces them) and which asks are open (`open_asks`: on a live message, and no live message
answers or withdraws them). A session records when it was last seen, kept to the minute. A thread
changes only its latest sequence, which a trigger holds. A full-text index, `thread_titles`, holds
every thread's title for search, word prefixes matched with case and accents ignored; a trigger
fills it as a thread is created, and it relies on titles never changing. Checks hold the rest of
what the store keeps true: one operator, whose id is 1; a registration's session set exactly when it
is approved or revoked; and a message's detail only beside its text. `transaction()` runs one
synchronous function under `BEGIN IMMEDIATE`, so no write interleaves with another in the process.

## Store

Every operation (`apps/server/src/store/`) takes the caller's identity, the target the request
names, and input its schema has already parsed. Inside the operation's transaction, `authorize`
confirms the credential is still live (the registration approved, the browser session unexpired) and
that it grants the target session; an unknown session and someone else's both fail as `not_found`. A
write then checks, in order, request-id replay, roles (only the requester asks, withdraws asks or
sets a topic, only the audience answers), staleness, and the rules that depend on the thread's
messages: a replacement names a live message of the writer's own; each answer names an open ask and
fits it, and a message answers an ask at most once; a replacement answers again every ask the
message it replaces answered that is still live, and none its requester since revised or retracted,
an answer to such an ask going with the replaced message, and may answer open asks besides; each
withdrawal names an open ask, the replaced message's own included, and a message withdraws an ask at
most once; a replacement withdraws again every ask the message it replaces withdrew, with the same
reason or a new one, whether or not the ask's own message is still live, so a withdrawal is never
undone; a replacement of a message holding open asks asks each again or withdraws it by name, its
asks and its withdrawals of those asks numbering at least as many as it holds open, since a
replacement's asks are numbered anew and the count is what can be checked; and a thread reference
names a thread in the same session. Refusals name asks by their numbers. An answer is a decline, or
distinct picks among the ask's suggested answers and the answerer's own words, at least one of them:
an ask without suggested answers takes own words alone, and one that allows a single answer takes
one pick or own words, never both. The own words are the answer's, plain text apart from the
message's Markdown text and detail, which are any additional information. It appends the message
with its asks and answers and raises the writer's read mark through it in the same transaction,
where a writer for whom the thread is archived keeps it archived, its archive mark moving to its own
message. A later message carries some part unless it replaces another, a rule the request's schema
holds, since no constraint on a message's row sees the rows of its own; a thread's first message may
carry nothing, since its title speaks for it, and a replacement carrying nothing retracts the
message it replaces, which the rules above allow only while that message holds no open ask. A
replacement is a whole message: what it leaves out, its detail included, is gone with the message it
replaces. A write answers with the thread number and the message's sequence, and a retry of the same
request id gets that same answer, while a retry with any part changed, its detail included, is a
request-id conflict. A stale write appends nothing, so its retry may reuse the id. Everything a
thread shows beyond its title, roles and latest sequence, such as its topic, open asks, status,
unread count and count of live messages, is derived in queries over the two views, never stored. A
thread's status rolls up the asks on its live messages and those a live message withdraws, so an ask
its own message's replacement withdrew counts and a revised ask does not: `open` while any is open;
otherwise `withdrawn` when every one is withdrawn, with the latest such withdrawal, and `answered`
when there are any; `none` when there are none. It is the same whoever views it. After a write or a
revocation commits, an in-process notifier wakes the long polls waiting on the session.

Every authenticated call on the agent mount, and `register` from an approved key, the first call of
every conversation, marks its session seen before its own work, in a transaction of its own, so a
call refused later still counts. It writes only while the registration is still approved, so a
revocation that commits as a token is verified stamps nothing, and only when that moves the
session's last seen a minute or more, or when the last seen is after now, so a clock stepped back
never holds it still. A stamp that fails is logged and the call carries on, since presence is
advisory. A pending registration has no session, so its calls mark nothing. A session is quiet when
it has not been seen within `agention serve --quiet-minutes`, 15 by default, and the minute a stamp
may lag, so a session that keeps calling never is, or when it was never seen. A thread is stranded
when it holds a live message of the operator's that the session has not read while the session is
quiet or has no active credential: the agent is not there to read it. Both are derived in queries
against the request's clock, and only the thread's audience, the operator, sees them.

Marking read, marking unread and archiving move only the caller's own marks on a thread; they write
no message and wake no one. Marking read raises the read mark and never lowers it. Marking unread
names a message, at most the thread's latest, and lowers the read mark to just before it, never
raising it, so it cannot claim a message the caller has not seen. Archiving raises the archive mark
through a message, carried on over the caller's own messages that directly follow it, archiving all
of a thread being archiving through its latest, and is refused while an ask open to the caller sits
in a message at or before it. A thread is archived for the caller exactly while its archive mark
reaches its latest message, so another party's new message brings it back, and the caller's own
keeps it archived; no party ever sees the other's archive mark. Unread messages are the live ones by
another actor after both the read and the archive mark: an archived message is never unread, so an
agent that archives a thread without reading it is not woken for it again. Since an answer is never
retracted and every new ask arrives after the mark, a thread holding an ask open to the caller is
never archived for it.

A list holds the threads not archived for the caller, its own new threads included, and with
`include_archived` the archived ones too. Every other narrowing is a filter. Filters combine with
AND, and the values of one that takes several combine with OR: `search` keeps the threads whose
title holds every word of its text as the start of a word, each word quoted so the text is never
read as query syntax; `status` those of one status; `unread` those with unread messages; and `topic`
those on a topic, a name as an agent's and a session's are: a session's list takes one bare topic
name, and the operator's list up to 50 topics, each written with its session as
`agent/session/topic`. The operator's list also takes filters on the properties of open asks:
`priority` (an open ask at that level or higher), `impact` (an open ask blocking, or assuming),
`overdue` (an open ask past its answer-by) and `effort` (an open ask that states that effort or
less, so an ask stating none meets no effort filter); `agent_read`, `unread` (a live message of the
operator's that the session has not read) or `stranded` (such a message while the session is quiet
or has no active credential); and `agent` and `session`, up to 50 of each, a session written
`agent/session`. The filters on asks together keep the threads holding one open ask that meets them
all, so any of them keeps only open threads. One definition of each filter's condition serves the
list, its total, its counts and its roll-ups.

A session's list has one order, which the operator's list calls `priority` and takes by default:
threads with open asks first, each ranked by its most pressing open ask, the first in the open-asks
order, by that ask's priority, then blocking, then earliest answer-by, then oldest; the rest follow
by latest message, and search keeps that order rather than ranking. The operator's list takes four
more with `sort`: `due`, the threads whose lead ask has an answer-by first, soonest first, then the
other threads with open asks in priority order, then the rest by latest message; `effort`, the
threads whose lead ask states an effort first, quickest first and those alike in priority order,
then the other threads with open asks in priority order, then the rest by latest message; `latest`,
every thread by its latest message, newest first; and `created`, every thread by when it was
created, newest first. `created` orders by the thread's row id, which SQLite gives out one past the
largest, so it keeps the order of creation whatever the clock did, and within a session it is the
order of the threads' numbers, which are given out the same way. A thread's lead ask, the one its
summary names as `lead`, is the first in the order's own among the open asks that meet the filters
on asks: the most pressing in the priority, latest and created orders, the soonest answer-by in the
due order, and the quickest stated effort in the effort order. Each order ranks some threads, which
come first: `priority` those leading with an open ask, `due` those whose lead ask has an answer-by,
`effort` those whose lead ask states an effort, and `latest` and `created` every thread. With
`reverse`, the operator's list reverses the threads its order ranks, every key and tie among them,
and leaves the others after them as they were; it never changes a thread's lead. Ties break on the
thread's number, and across sessions first on the session, so the positions a session's own list
gives out say nothing about other sessions. Lists page by keyset cursors, each bound to its order,
its direction and its grouping, so a cursor another gave out is refused; a cursor is at most 1,024
characters, room for a grouped list's position, three sets of keys. All of these keys change as
threads do, so a thread that changes between two pages can be skipped or repeated, and the next
refresh shows it. Beside a page, the operator's list says how many threads it holds. Bulk read and
archive take each thread through the message the list showed; bulk archive skips the threads holding
an ask open to the operator and names them.

With `group`, `session` or `agent`, the operator's list orders its threads by their group, then by
the sort, so a group's threads arrive together: grouped by session, each session, and each topic
within it, is placed by its first thread under the sort, reversed or not; grouped by agent, each
agent, and each session within it, likewise. A group's place is its first thread's keys, which a
cursor carries beside the thread's own. As a moved thread does in the flat list, a change that moves
a group ahead of a page's cursor skips that group's remaining threads for the rest of that pass, and
one that moves it behind repeats them; the next load from the first page shows the list whole, and
the web UI reloads from the first page on every refresh. A group can therefore come in two runs.
Every page of a grouped list carries the roll-up of each session holding a thread the list keeps
and, grouped by session, of each of its topics: how many threads, how many unread, whether any holds
a blocking ask open to the caller, the highest priority of an open ask, and whether all are archived
for the caller, and each session's presence: when it was last seen and whether it is quiet.
`composeRollup` rolls up groups into the one holding them, and `composePresence` sessions' presence
into their agent's, quiet when all are and last seen when the latest was, as the web UI does for an
agent's sessions.

The operator's counts take the list's filters and say, for each value of each filter but search, how
many threads it keeps with every other filter as it is. Each value of a filter taking one is counted
by running the list's own total with that value chosen, so one rule says what the list keeps: any
status, and every status but `open`, with the filters on asks off, as choosing it turns them off,
and each value of a filter on asks with `open` chosen, as choosing it chooses `open`. Each agent,
session and topic holding a thread has its own count, whatever that filter's own choices are, each
kind counted in one statement grouped by it with that filter's condition off. `reset` is the total
with no filter on.

Counts and roll-ups list at most 500 agents, sessions and topics each, the first in name order or in
the list's, and say when they leave any out; the agents list pages agents, each with at most 500 of
its sessions, and says when it leaves any out. A thread's summary lists at most 50 of its open asks,
the most pressing, beside their count and the earliest.

## HTTP API

`apps/server/src/http/` serves one Hono application on `@hono/node-server`, with two mounts:
`/api/agent/` for the agent bridge and `/api/web/` for the web UI. The routes on one thread are one
sub-application mounted on both under `/s/:agent/:session`, so the role and message checks are the
same for both kinds of caller. Each mount authenticates its own credential and refuses the other's:
the agent mount refuses any request carrying a cookie, and the web mount any request carrying an
`Authorization` header.

Every route reads its path, query and body through the shared schemas, so input outside a bound
fails as `invalid_input` before any operation runs, and maps failures to the shared error shape and
its statuses. Anything that is not an API error is logged and answered as `internal`, with no
details. A request body on an API route must declare its length, so its size is known before
anything is read or authenticated: a chunked body is answered with status 411, and one over 2 MiB,
which holds a message with every field at its bound, with status 413. A body that is not valid UTF-8
is refused, never repaired. Every request's `Host` must be the origin's host, so a page on another
name that resolves to the server cannot reach it, and no forwarded header is read. Every response
carries the security headers: a content security policy that allows only the server's own scripts,
styles, images and connections and no framing, HSTS, `nosniff`, `DENY` framing, no referrer, and
`no-store`.

The long poll answers at once while a thread in the session has unread messages newer than its
`since`, and otherwise ends when such a message commits, when its credential is revoked, when the
client disconnects, when the server shuts down, or when its wait runs out.

Unknown API routes answer `not_found`. Every other path serves the web UI: a file of the Vite build,
or the UI's index page for any other path, whose router shows the route. The server prepares the
index page once, as it starts, writing its name, HTML-escaped, into the page's title and its
`application-name` and `apple-mobile-web-app-title` metadata, and never serves the page's file as it
is; a build whose page lacks one of those stops the server from starting. A server built without the
UI serves a placeholder page instead.

## Authentication

`apps/server/src/auth/` turns credentials into the identities the store takes.

- **Agent tokens.** Each request carries a compact JWS signed with the session's Ed25519 key. Its
  header names the key as `kid` and the algorithm as `EdDSA`, the only one accepted; its claims bind
  it to the canonical origin (`aud`) and expire within 300 seconds of the server's clock (`exp`).
  The server finds the registration by key, verifies the signature against the key, checks the
  claims, and admits only an approved registration; the operation's transaction confirms it is still
  approved. Every refusal of an agent's credential, including one inside the operation, such as a
  long poll a revocation ends, tells the agent to call `register`, which reports what the operator
  still has to do. A token for another audience is refused with a message naming the expected
  origin. The registration route verifies the token against the key it names, which may be new.
- **Passkeys.** `@simplewebauthn/server` runs the ceremonies with user verification required and
  discoverable credentials, so sign-in names no one. A new passkey's relying party carries the
  server's name, and its user name and display name the server's and the operator's, as
  `Work · morgan`, the server's first so that an authenticator shortening a long user name keeps it:
  a passkey belongs to a host name, so servers sharing one under different ports tell theirs apart
  by it. A ceremony's begin stores nothing: it seals the challenge, the ceremony's kind and a
  five-minute expiry with the instance's challenge key, an HMAC key made with the database, into the
  `__Host-agention-<port>-challenge` cookie. `<port>`, in this cookie's name and the session's, is
  the port of the server's origin, 443 when it names none: a browser keeps one set of cookies for a
  host whatever its port, so servers sharing a host under different ports each read only their own.
  Finish accepts only a seal that key verifies, of its kind and unexpired, and a successful finish
  records the challenge as used until it expires, so no flood can fill anything and no finished
  ceremony can be replayed. The answer must come from the exact origin and not from another site's
  frame, and a sign-in's user handle must be the one stored with its passkey.
- **Several passkeys.** The operator holds at most 20 passkeys, which share one WebAuthn user id and
  each carry a name. A browser session records the passkey that signed it in, and goes with it when
  it is deleted. Adding a passkey on the device in hand is a registration ceremony run by a
  signed-in browser, whose options exclude the passkeys already held; a passkey already registered
  is refused, and so is a 21st, when its ceremony begins and again when it finishes, so ceremonies
  running side by side cannot pass the limit. Adding one and removing one need a session opened
  within the last 10 minutes, and the last passkey cannot be removed. Another device signs in with a
  passkey the operator holds, through the browser's cross-device sign-in, and adds its own there.
- **Passkey links.** Links come only from `agention passkey-link`, on the server's machine, so
  holding a passkey never yields one. A link is valid for 15 minutes, and issuing one revokes every
  unused link. Finishing it, in one transaction that also consumes it, creates the operator the
  first time, and afterwards replaces their passkeys, which ends every browser session. A
  replacement keeps the WebAuthn user id, so an authenticator overwrites the old passkey instead of
  keeping it.
- **Browser sessions.** A finished sign-in or link opens a session in the
  `__Host-agention-<port>-session` cookie (`Secure`, `HttpOnly`, `SameSite=Strict`), closing the one
  the browser held before. The session ends after seven days without use or thirty days after it
  opened. Every web mutation also needs the session's CSRF token in `X-CSRF-Token` and an `Origin`
  equal to the origin.

Browser sessions and links are 256 random bits, stored only as their SHA-256. Expired sessions,
links and used challenges are deleted whenever their table is next written, and so are registrations
that expired while pending, so no timer runs.

## Rate budgets

Token buckets in `apps/server/src/http/rates.ts` keep one kind of traffic from starving another, and
none is keyed on the source address. A request signed by a key the server has a registration for
spends that key's own budget, whether it is a pending agent checking its registration or an approved
agent's session call. Everything else spends one budget per class: registrations of new keys, failed
agent authentication, failed passkey sign-ins and failed passkey links. Every class but new
registrations is charged only for a request that failed, after it was checked, so draining one never
refuses a valid key, passkey or link, and beginning a ceremony costs nothing. An exhausted budget
answers `rate_limited`, with a `Retry-After` header. The
[operator guide](operator-guide.md#rate-budgets) lists the rates.

## Serving

`agention serve` canonicalizes `--origin` and checks `--name`, then reads the server's name from the
database's `instance` row and refuses a `--name` that names another. Without a stored name it takes
`--name`, `Agention` without one, and stores it there once it is listening, so a start that fails
before serving leaves the name unset. Of first starts racing on a new database, the first to store
its name keeps it; a racer with the same name serves too, and one with another closes its listener
and exits refused. After that the name never changes. The name feeds the index page, the relying
party and new passkeys' user names. The server listens on `--listen`, an IP address and port. With
`--tls-cert` and `--tls-key` it terminates TLS 1.3 itself; without them it serves plain HTTP, which
it refuses on a non-loopback address unless `--allow-plain-http` is given. A client gets 10 seconds
to send its request headers and 30 to send its whole request, and an idle keep-alive connection
closes after 120 seconds; a long poll's response may take longer. On `SIGINT` or `SIGTERM` the
server ends its long polls, answers every request still open with `Connection: close`, closes idle
connections, and exits once the open requests finish. Three seconds after it starts stopping it
closes every connection still open, whatever its state, a TLS handshake that never finished
included.

## Agent bridge

`apps/bridge/` is a stdio MCP server on `@modelcontextprotocol/server`, connected straight to the
SDK's stdio transport, so it serves the protocol revisions hosts open with `initialize` and answers
`server/discover` as a method it does not have. Its entry point checks for Node 24 or later before
loading anything else. Without options `agention-mcp` serves; `--version` and `--help` print and
exit. It exits once the host closes its standard input. Its answer to `initialize` carries
instructions that state the usage skill's first rule, to ask through Agention and never wait at the
terminal for an answer, and tell the agent to load the skill, so the agent has the rule before the
skill loads. Claude Code adds them to the agent's system prompt. Codex describes the bridge's tools
with them and shows only their first 250 characters until the agent loads the tools, so they stay
within that. [SECURITY.md](../SECURITY.md#the-agent-bridge) states what the bridge holds and sends:
its key file, its tokens and where its requests may go.

- **Configuration.** `AGENTION_URL` is read through `canonicalOrigin`. When it is missing or not an
  HTTPS origin, when the home directory is not an absolute path of at most 4,096 bytes, or when
  `NODE_TLS_REJECT_UNAUTHORIZED` turns certificate checks off, the bridge still serves, and every
  tool answers with what the operator must change. The session's names come from the first
  `register` call that gives them, else from `AGENTWORKS_AGENT` and `AGENTWORKS_SESSION`, a name
  `register` leaves out falling back to its variable. Whichever the bridge uses first fixes the
  session for the life of the process; naming another afterwards is `invalid_input`.
- **Key file.** `apps/bridge/src/key-file.ts` keeps one key per server, agent and session, selected
  by the proposed names, and is the bridge's only state. Its operations are synchronous. Every
  request reads the file, so bridges sharing a session sign with the key now on disk. Only
  `register` creates a key, by writing a temporary file and linking it into place, which fails if a
  key exists, so bridges starting together share the first. Only `register` replaces one: once the
  server answers that its registration was rejected, revoked or expired, it writes a new key to a
  temporary file, renames it into place if the file still holds the refused key, submits it, and
  reads the file again, reporting the registration of whatever key is now on disk. A registration
  left behind when that read finds another bridge's key was never relayed, and expires unapproved.
  Only two replacements interleaving within one round trip can relay a code whose key was
  overwritten; if the operator approves it, the session's next `register` shows the key on disk
  still pending, and the operator revokes the stray registration. Every operation applies the
  private-file rule, and writes, links and renames only in the session directory's real path. The
  home directory must exist: the bridge creates only the directories below it.
- **Tokens.** `jose` mints a token for each request, signed with the session's key. Each body is
  sent as a string, so it declares its length.
- **`register`** submits the key to `POST /api/agent/registrations`, which for a key the server
  knows creates nothing and reports its state. It answers with that state, keeping its `expires_at`
  only while the registration is pending, so an agent never reads it as the credential's; `replaced`
  when it replaced the key; and a `message` saying what to do next: the code to relay, to carry on
  meanwhile with work that does not need Agention, and the names to pass when the agent calls again.
  Once the server has pruned a key's expired pending registration, the same key is registered afresh
  and keeps its code.
- **Granted names.** The bridge keeps the names the operator granted, with the key they were granted
  to. A thread tool that does not know them for the key on disk first makes the request `register`
  makes, and answers `unauthenticated` with what the operator still has to do unless the key is
  approved. Thread requests go to `/api/agent/s/<agent>/<session>/` under the granted names.
- **Tools.** `register` and seven thread tools: `thread_create`, `message_send`, `thread_get`,
  `thread_list`, `thread_read`, `thread_archive` and `message_wait`, each annotated neither
  read-only nor destructive and as acting on a closed world. `thread_create` and `message_send` take
  a message's detail beside its text, and refuse it without text, as the server does. A session
  never answers an ask, so `message_send` takes no answers; it takes the withdrawals of the
  session's own open asks. `message_wait` waits for nothing by default and answers at once, which is
  how an agent checks for answers as it works; a longer wait is for an agent with no other work and
  open asks or unread messages, or for a waiter of its own. `register`'s answer, once approved, says
  how answers reach the agent: when it checks. No tool marks a thread unread, which agents have no
  use for, though the agent API offers it as the web API does. The SDK advertises each tool's JSON
  Schema, generated from the shared schemas, but the bridge parses the arguments itself, so input
  outside a bound is `invalid_input` naming the field, as the server would answer it. A tool also
  refuses a field it does not know, at any depth, as `invalid_input` naming it, so a misspelled
  field never drops silently; the server's request schemas ignore unknown fields, so a newer bridge
  still works against it. An answer is the API's JSON as text, and a call the server refuses is an
  error result holding the API's error JSON. A problem the bridge finds itself, such as its
  configuration, an unreachable server, missing names or a cancelled call, is an error result in
  plain text, worded for the agent: what to do, or, for what only the operator can fix, to tell them
  at the terminal what to change and whether the session must restart. `apps/bridge/src/errors.ts`
  words those. `message_wait` gives every error but `invalid_input` no sooner than its
  `wait_seconds` would have ended, counted from the call's start, so an agent that waits again at
  once does not call a server it cannot use in a tight loop.
- **Answer cap.** `apps/bridge/src/fit.ts` keeps a result, and separately an error's text, within
  sizes in UTF-8 bytes that both hosts pass to the model whole; each tool also declares the result
  size to Claude Code in its `_meta`. A page of messages or threads over the limit is asked for
  again with half as many elements as the smaller of the last page size and what the answer held,
  down to one; `message_wait` asks for those smaller pages with no wait. The bridge gives a server
  30 seconds to answer a request beyond any wait it asks for, and a whole `message_wait` call, its
  credential lookup and every request included, the same 30 seconds beyond its `wait_seconds`, so it
  ends within 55 seconds, under Codex's 60-second tool timeout, and answers that the server did not
  answer in time if it runs out. An answer still over it at one element leaves out its largest
  text-bearing fields, largest first, until it fits: texts (each answer's own words included) and
  details, references, each ask's fallback text, question and suggested answers, the question each
  answer carries, and the reasons of withdrawals, the thread's and each ask's included, each named
  in `omitted` as a dotted path, such as `messages.0.asks.2.fallback`. A detail of one-byte
  characters that JSON need not escape always comes back whole beside its text, unless the message's
  other fields are large too; one in other scripts can be left out and named in `omitted`, from
  roughly 19,000 code points in a two-byte script down to about 9,500 in emoji, and the web UI
  always shows it in full. A `stale` error lists only the leading missed messages that fit and says
  from which sequence to read the rest, or that none fits; every other error stays within its limit
  by construction, quoting at most 100 characters of any configured value.

The bridge's tests run the server from `apps/server` in process, over TLS with a certificate made at
test time, and drive bridges through the MCP SDK's client: in memory, message by message for the
protocol, and as a process over stdio.

## Web UI

`apps/web/` is a React application with no framework beyond React, which Vite builds into the server
package's `web/` directory.

| Path              | Contents                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/router.tsx`  | The routes, over the History API                                                                                                        |
| `src/session.tsx` | The browser's sign-in, as `GET /session` reports it                                                                                     |
| `src/data.ts`     | The data hooks: loading, live refresh, answers out of order, an ended sign-in                                                           |
| `src/api.ts`      | The web API's client                                                                                                                    |
| `src/passkeys.ts` | The passkey ceremonies, through the browser's WebAuthn JSON helpers                                                                     |
| `src/markdown/`   | The inert Markdown renderer                                                                                                             |
| `src/views/`      | One view per route; `views/list/` holds the thread list's sheet, chips, rows and groups, `views/thread/` the thread page and its writes |
| `src/styles.css`  | The design tokens and styles                                                                                                            |
| `e2e/`            | The browser tests                                                                                                                       |

The thread list's page address is the API's own list query without its page, read part by part with
the API's schemas, and the web UI and the server share one rule, from `packages/api`, for the
filters on open asks and the status they keep.

The UI reads the server's name from the `application-name` metadata the server writes into its page,
in `src/server-name.ts`, and shows it as the banner's brand and after each page's own name in its
title.

The thread page parses a message's detail only once its fold is opened, and the message list keeps
each message's place by its sequence, so a refresh keeps an opened fold open. The composer checks
its boxes against the API's bounds of a message's text and detail, counted with the API's
`codePointLength` as the server counts them, and never cuts what is typed into them.

A tab opened before the server is upgraded keeps running the UI it loaded, so it may need a reload
to work with the new server.

The browser tests start the built server, serving its built web UI over TLS at
`https://agention.test:<port>`, and drive it in Chromium with CDP virtual authenticators. Passkeys
need a domain name and a secure context, so Chromium resolves `agention.test` to the loopback
address with `--host-resolver-rules` and trusts the certificate made for that name at run time by
its public key with `--ignore-certificate-errors-spki-list`. That makes the page a real secure
context rather than one that bypasses a certificate error.

## Generated plugins

`apps/agent-plugin/plugin.json` and `apps/agent-plugin/skills/` are the only plugin sources.
`scripts/generate-plugins.sh` renders them into `out/claude-plugin/`, `out/codex-plugin/`,
`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. The outputs are committed,
and CI fails if they drift from their sources. Installing the plugins from the repository has not
been verified on either host yet.

Each plugin carries the usage skill and declares one MCP server, the bridge, in `.mcp.json` at the
plugin root. The definition names the bridge's package, and the generator pins it to the plugin's
version: `npx -y @wayfarerlabs/agention-mcp@<version>`. Claude Code passes the server its whole
environment. Codex passes a server only a few common variables, such as `HOME` and `PATH`, and those
the server lists, so the Codex declaration lists the bridge's configuration variables:
`AGENTION_URL`, `AGENTWORKS_AGENT`, `AGENTWORKS_SESSION` and `NODE_EXTRA_CA_CERTS`.

The generator owns those output paths and replaces them wholesale, never writing through a symlink.
For development it also renders plugins that run the bridge from a packed tarball instead, into a
new directory that it creates, so they cannot overwrite the committed plugins or anything else.

## Versions

One version covers the server, the bridge and the plugins. A release sets it, in the same pull
request, in the root and published `package.json` files, the lockfile, the plugin definition and
both generated manifests, and in the bridge's package spec in both generated MCP declarations, so
the generated outputs stay current without regeneration. A `v*` tag runs
`.github/workflows/release.yml`, which publishes both packages through npm's trusted publishing, as
[CONTRIBUTING.md](../CONTRIBUTING.md#releasing) describes.
