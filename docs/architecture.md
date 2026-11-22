# Architecture

This document describes what exists in the repository today. Its design, and the alternatives
considered, are recorded in [ADR 0001](adrs/0001-agention-v1-architecture.md).

Agention is TypeScript on Node, in npm workspaces with one lockfile.

| Component                | State                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api`           | The API contract: zod schemas for every route's requests and responses, which are also their bounds, the error codes and the scopes, and their JSON Schema for the API's documentation. |
| `packages/build`         | The bundle build the server and the bridge use, one esbuild file each, and the build of the web UI's diagram frame script, with the license notices of the npm packages each includes.  |
| `packages/private-files` | The private-file rule the server's database and the bridge's key files obey, which both bundle.                                                                                         |
| `apps/server`            | The `agention` CLI: `serve` runs the HTTP API, with agent, passkey and API key authentication, over the database, identity and store; `backup` copies the database.                     |
| `apps/bridge`            | The `agention-mcp` agent bridge: a stdio MCP server whose tools make requests on the agent API, signed with the session's key.                                                          |
| `apps/web`               | The React web UI, built with Vite, which the server package ships and serves: passkey sign-in and the operator's views.                                                                 |
| `apps/agent-plugin`      | The canonical plugin definition and usage skill, and the generator that renders the Claude Code and Codex plugins.                                                                      |
| `scripts/`               | The checks CI runs, file linting, plugin generation, and the generation of the API's OpenAPI document.                                                                                  |

## Source and packages

Node runs the TypeScript sources directly, by stripping their types, so development and the plugin
generator need no build step; Vitest compiles the sources for the tests. `packages/api` needs no
build either: its `exports` point at its source.

The server and the bridge each build into one esbuild bundle, which is what their npm packages
contain. The packages declare no dependencies, so installing either resolves nothing beyond what the
repository's lockfile built. The server's build first runs the web UI's build and copies it into the
package's `web/` directory. The web UI's build is Vite's, followed by a pass of its own that builds
the diagram frame's script with esbuild, through `packages/build`, as one classic script named for
its content's hash, which `web/diagram-frame.json` names for the server. Beside each bundle the
build writes `THIRD-PARTY-NOTICES.txt`, the license of every npm package the bundle includes and,
for the server, of every package in the web build, which Vite and the frame's pass report. An
included package whose own build inlined other npm packages names them in its files' region or path
comments; the notices include those too, read from copies the bundling package lists under
`devDependencies` at the inlined versions, and the build fails if one is missing. The build fails
for a package whose notice would carry no license text; `packages/build` supplies, per package
version, text a package's own files do not give it, such as license terms that live only in a
README. A package under the Eclipse Public License, such as `elkjs`, which Mermaid lays out diagrams
with, always needs that text: the copyright notices in its code, which minification strips, and a
statement of where its source code is available. The frame's script opens with a comment that
carries it and names the server package's notices, and the build fails for a package under the EPL
without it. Each package carries a copy of the repository's `LICENSE` and a `README.md` of its own
for its npm page. Each bundle embeds its package's `package.json` at build time and reports that
version.

The checks pack each package as npm would publish it, confirm it declares no dependencies and ships
both license files and a `README.md`, then install it from the tarball outside the repository and
run its command through `node_modules/.bin`, which must print the package's version. The installed
server is also started on loopback, and must serve the web UI its package ships and answer the API.

## API contract

`packages/api` defines, as zod schemas, the requests and responses of every route, and exports the
inferred types the server, the bridge and the web UI share:

- starting a thread, sending a message, reading a thread, a session's thread list and its long poll,
  and the operator's wait across sessions;
- read, unread and archive marks; the operator's thread list with its total and, grouped, its
  groups' roll-ups; the counts of what each filter value keeps; and bulk read and archive;
- registration submit and state, the registrations list and approval;
- a session's status update and the status it answers with; the sessions view's page of agents, each
  with its tags and its sessions; how many sessions have updates the operator has not read; a
  session's log and the operator's read mark on it; and the operator's start of a thread on a
  session;
- the operator's session groups and tags: the list of them, creating, renaming and removing a group,
  renaming and removing a tag, and setting a session's group and an agent's or a session's tags;
- the agent API's version, the header that carries it and the oldest version the server serves;
- the browser session's state, the passkey ceremonies' inputs and the operator's passkey list;
- the operator's settings: voice's settings and their bounds, the base URL rule (`checkBaseUrl`),
  the hosted presets, the types a recording is sent as, and a transcription's answer;
- the scopes, `<resource>:<access>`, and which each includes (`holdsScope`); an API key's secret,
  name, scopes and expiry, the key list, a new key with its secret, a revoked key, and the bound of
  20 keys; and the operator API's versions;
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
schemas ignore fields they do not know, so a server still reads what an older bridge sends; a newer
bridge never relies on that, since it refuses a server older than itself (see
[HTTP API](#http-api)). `invalidInputBody` turns a schema failure into the error shape, naming the
field at fault as a dotted path.

The registration code, which the bridge and the server both derive from a session key, has its own
entry point, `@wayfarerlabs/agention-api/registration-code`, because it uses `node:crypto` and must
stay out of the web bundle. It takes a key the `publicKey` schema has accepted.

The schemas' JSON Schema, for the API's documentation, has its own entry point too,
`@wayfarerlabs/agention-api/json-schemas`, which only the server imports, so the web bundle never
carries it. `JsonSchemas` describes a schema in one direction, what a client sends or what the
server answers, with zod's own `z.toJSONSchema`, which carries each field's description. The named
schemas it lists, such as `Message` and `ThreadSummary`, are described once each, as components that
every description holding one references by `$ref`. A schema reads the same both ways unless it has
defaults or reads text into values, or holds one that does; such a schema has a second component for
its input, named with `Input` after it, such as `AskInput`. An answer's description never forbids
properties it does not list, since a version may add response fields. A named schema whose inline
form would differ from its component, or a cycle no name breaks, throws, so a reference always says
exactly what the schema would say inline.

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

A session's status lives only in its log, `session_updates`, append-only by the same triggers as
messages: each entry, numbered from 1 within its session, holds the session's whole status after it
(its state, the outcome it stopped with, its title, goal and percent), its own note and the
credential behind it, so the current status is the entry with the highest number, read through the
primary key, and nothing about it is stored on the session. A check holds an outcome exactly beside
the stopped state. `session_marks` holds each actor's read cursor on a session's log, as
`thread_marks` holds one on a thread.

The operator's session groups are rows of their own, `session_groups`, each with a name unique
ignoring the case of ASCII letters, since a group can be empty and renamed. A group keeps its id
when renamed, and ids never repeat, so a filter or fold naming a removed group never reaches a later
one. `session_group_members` is keyed on the session, so a session sits in at most one group, and
removing a group takes its memberships with it by a cascade. A tag is only a name on an agent
(`agent_tags`) or a session (`session_tags`), as a topic is a name on a thread: it exists while
something carries it. Agents and sessions are never deleted, so no membership or tag outlives what
it is on. A second full-text index, `message_texts`, holds the text and detail of every message that
has text, matched as titles are. It keeps no copy of them, only each message's thread and sequence,
since a message has no integer key of its own for an external-content index to rest on; a trigger
fills it as a message is written, since messages are append-only, and a search joins its rows to
`live_messages`, so a replaced message no longer matches.

`voice_settings` holds at most one row, what the operator's Settings last saved for voice: the base
URL and model in effect when it was saved, the environment's included, so the row always records the
address its key was entered for, an optional prompt, and an optional key. Turning voice off deletes
the row. Which provider it means is worked out from its base URL, never stored apart from it.

`api_keys` holds the operator's API keys: each one's name, its scopes as a JSON array, the SHA-256
of its secret, which is unique, and when it was created, when it expires (null for a key without an
expiry, and otherwise after its creation), when it was last used, kept to the hour, and when it was
revoked. A revoked or expired key keeps its row, so the operator's list can show it, until the table
is next written. Ids never repeat, so an id names one key for good.

`message_positions` gives every message a position among all messages, in the order they are
written, which the operator's wait across sessions counts from. A message has no stable integer key
of its own: it is keyed by its thread and sequence, and its table's rowid is no column's alias, so
`VACUUM` may renumber it. A position is an `INTEGER PRIMARY KEY AUTOINCREMENT`, which keeps its
value and is never reused, so positions never go backwards. A trigger gives each message its
position as it is written, triggers refuse every update and delete of a position, and the migration
that added the table numbered the messages already written in the order they were stored.

A test freezes the text of every migration a release has shipped, by its SHA-256, so a schema change
is always a new migration. Others open a database the first migration alone wrote, and those the
first two, three and four wrote, under every later one: the tables they had keep their rows, the new
ones start empty but for the positions of the messages written before, in the order they were
written, and a message written before the full-text index of messages existed is found by it.

`agention backup` (`apps/server/src/database/backup.ts`) copies the database without the `Database`
class, so it never migrates it: it checks the database file as opening does, refusing a missing one,
and opens it read-only; like any read-only connection to a database in WAL mode, that may leave
SQLite's empty `-wal` file and its `-shm` beside a database no server has open, which the next
server to open it uses as its own. It creates the copy itself, with the private-file rule applied to
the copy's directory, exclusively and with mode 0600, refusing a file that exists, one beside which
SQLite would find a journal or log of its own, and, before creating anything, one at the database's
own journal, log or shared-memory path. `node:sqlite`'s `backup()` copies every page in one step,
its rate the largest it accepts, so a server writing meanwhile cannot restart it, and the copy is
the database as it stood at one moment. The copy is then opened read-only and `immutable`, which
leaves nothing beside it, and passes `PRAGMA quick_check`; a backup that fails removes what it
created.

## Store

Every operation (`apps/server/src/store/`) takes the caller's identity, the target the request
names, and input its schema has already parsed. Inside the operation's transaction, `authorize`
confirms the credential is still live (the registration approved, the browser session unexpired, the
API key neither revoked nor expired) and that it grants the target session; an unknown session and
someone else's both fail as `not_found`. An identity also holds scopes, `<resource>:<access>`
([HTTP API](#http-api)): a browser session holds every one, an API key those the operator gave it,
and an agent's registration `threads:write` over its own session. An operation across sessions, such
as listing them or deciding a registration, confirms its scope with `authorizeScope` in the same
transaction, and to an identity without it the operation does not exist. A write then checks, in
order, request-id replay, roles (only the requester asks, withdraws asks or sets a topic, only the
audience answers), staleness, and the rules that depend on the thread's messages: a replacement
names a live message of the writer's own; each answer names an open ask and fits it, and a message
answers an ask at most once; a replacement answers again every ask the message it replaces answered
that is still live, and none its requester since revised or retracted, an answer to such an ask
going with the replaced message, and may answer open asks besides; each withdrawal names an open
ask, the replaced message's own included, and a message withdraws an ask at most once; a replacement
withdraws again every ask the message it replaces withdrew, with the same reason or a new one,
whether or not the ask's own message is still live, so a withdrawal is never undone; a replacement
of a message holding open asks asks each again or withdraws it by name, its asks and its withdrawals
of those asks numbering at least as many as it holds open, since a replacement's asks are numbered
anew and the count is what can be checked; and a thread reference names a thread in the same
session. Refusals name asks by their numbers. An answer is a decline, or distinct picks among the
ask's suggested answers and the answerer's own words, at least one of them: an ask without suggested
answers takes own words alone, and one that allows a single answer takes one pick or own words,
never both. The own words are the answer's, plain text apart from the message's Markdown text and
detail, which are any additional information. It appends the message with its asks and answers and
raises the writer's read mark through it in the same transaction, where a writer for whom the thread
is archived keeps it archived, its archive mark moving to its own message. A later message carries
some part unless it replaces another, a rule the request's schema holds, since no constraint on a
message's row sees the rows of its own; a thread's first message may carry nothing, since its title
speaks for it, and a replacement carrying nothing retracts the message it replaces, which the rules
above allow only while that message holds no open ask. A replacement is a whole message: what it
leaves out, its detail included, is gone with the message it replaces. A write answers with the
thread number and the message's sequence, and a retry of the same request id gets that same answer,
while a retry with any part changed, its detail included, is a request-id conflict. A stale write
appends nothing, so its retry may reuse the id. Everything a thread shows beyond its title, roles
and latest sequence, such as its topic, open asks, status, unread count and count of live messages,
is derived in queries over the two views, never stored. A thread's status rolls up the asks on its
live messages and those a live message withdraws, so an ask its own message's replacement withdrew
counts and a revised ask does not: `open` while any is open; otherwise `withdrawn` when every one is
withdrawn, with the latest such withdrawal, and `answered` when there are any; `none` when there are
none. It is the same whoever views it. After a write or a registration's revocation commits, an
in-process notifier wakes the long polls waiting on the session, and with them the waits across
every session. Revoking an API key and ending a browser session, by signing out, signing in again on
that browser, removing the passkey that signed it in or replacing the passkeys through a link, wake
the waits across every session alone once they commit, since no session's own changed.

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
quiet, has no active credential or has stopped: the agent is not there to read it. Both are derived
in queries against the request's clock, and only the thread's audience, the operator, sees them,
with the state and outcome the session last reported, which say why it is stranded; a grouped list's
presence for a session or an agent carries neither.

A session reports its status itself, on the agent mount's status route, and no other call changes
it. Each update merges into the current status: a state replaces the state, `stopped` with the
outcome the update must give, and `working` and `idle` with none, so a stopped session stays stopped
until it reports one of them; a session that first reports without a state is `working`, since it is
running. A title, goal or percent sets its field, and a goal other than the current one clears the
percent unless the update gives one; a field left out is unchanged, and nothing clears a field. The
note belongs to its entry alone. An update whose merged status equals the current one and that
carries no note appends nothing, so an update carries no request id: repeating one changes nothing,
unless it carries a note, which is logged again. Updates are exempt from the stale rule and the
latest wins, since only the session writes its status. The operator reads a session's log newest
first, with their read mark on it, which marking read raises up to the latest entry and never
lowers; the entries above it are the session's unread updates.

The sessions view's page lists the agents in name order for the operator, each with at most 500 of
its sessions: those working or idle first, then those that never reported, then stopped ones, each
latest seen first. Each session carries its presence, by the formula threads use; its approved
registrations, with their ids and codes; its status with the latest entry's note; its unread
updates; how many of its threads the operator has not archived, with how many of those hold messages
the operator has not read and how many are stranded, counted for every session of the page in one
statement grouped over the threads as the operator sees them; and how many asks are open in all its
threads, with how many of those are blocking, which is what waits on the operator, counted in one
statement grouped over the open asks. The operator can never archive a thread holding an ask open to
them, so their thread list shows every thread counted. A separate read counts the sessions whose log
holds entries the operator has not read, which the web UI's navigation shows.

The operator sorts sessions into groups and tags agents and sessions, and nothing else does: listing
them needs `sessions:read` and every change to them `sessions:write`, scopes no agent's registration
holds, so to an agent none exists. A group's name is plain text on one line, trimmed, 1 to 100 code
points, unique ignoring the case of ASCII letters; a tag's is a name, as a topic's is. An instance
holds at most 200 groups, and an agent or a session carries at most 20 tags; past either bound a
write is `invalid_input`. A name another group or tag already has is refused as `conflict`, naming
`name`, whether a group is created or either is renamed. A group's rename changes its name only, so
a filter by its id keeps working, and removing it leaves its sessions in no group. Renaming a tag
rewrites it on every agent and session carrying it, and removing one takes it off all of them, each
in one transaction. Setting a session's group names it by id, or none; setting an agent's or a
session's tags gives the whole set. The list of them gives every group in name order, with how many
sessions each holds, and every tag carried, at most 500, in name order, with how many agents and how
many sessions carry it, saying when it leaves any out. The sessions view's page carries each agent's
tags, and each session's group and tags.

The operator starts a thread on a session with a title and a first message of text, with its detail.
The session stays the thread's requester and the operator its audience, so the operator's request
has no field for asks or a topic, nor for references, which the web UI does not offer; a request
carrying any of them starts a thread without them. The session reads the thread as the operator's
words and replies in it. The thread starts whatever the session's state or credential, stranded from
the start when the session is not there to read it; the operator's read mark reaches their message,
and the session's long polls wake. A retry with the same request id is answered as the first was,
and one with other content is a request-id conflict, as for a session's own thread, which a session
still starts only in itself.

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
read as query syntax, and in the operator's list also those one of whose live messages holds every
word in its text and detail together, through `message_texts` joined to `live_messages` on the
thread and sequence, so live keeps its one definition; `status` those of one status; `unread` those
with unread messages; and `topic` those on a topic, a name as an agent's and a session's are: a
session's list takes one bare topic name, and the operator's list up to 50 topics, each written with
its session as `agent/session/topic`. The operator's list also takes filters on the properties of
open asks: `priority` (an open ask at that level or higher), `impact` (an open ask blocking, or
assuming), `overdue` (an open ask past its answer-by) and `effort` (an open ask that states that
effort or less, so an ask stating none meets no effort filter); `agent_read`, `unread` (a live
message of the operator's that the session has not read) or `stranded` (such a message while the
session is quiet, has no active credential or has stopped); `agent` and `session`, up to 50 of each,
a session written `agent/session`; and the operator's `session_group`, up to 50 groups by id, `none`
naming no group, and `tag`, up to 50 tags, keeping a thread whose session or agent carries one. A
group that was removed, or a tag nothing carries, keeps nothing. The filters on asks together keep
the threads holding one open ask that meets them all, so any of them keeps only open threads. One
definition of each filter's condition serves the list, its total, its counts and its roll-ups.

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
characters, room for a grouped list's position, four sets of keys. All of these keys change as
threads do, so a thread that changes between two pages can be skipped or repeated, and the next
refresh shows it. Beside a page, the operator's list says how many threads it holds. Bulk read and
archive take each thread through the message the list showed; bulk archive skips the threads holding
an ask open to the operator and names them.

Each thread in the operator's list carries its session's group, which no agent's list shows. With
`group`, the operator's list orders its threads by their group, then by the sort, so a group's
threads arrive together: grouped by session group (`group=session_group`), each session's group, no
group being one of its own, each session within it, and each topic within that, is placed by its
first thread under the sort, reversed or not; grouped by session, each session, and each topic
within it, likewise; grouped by agent, each agent, and each session within it, likewise. A group's
place is its first thread's keys, which a cursor carries beside the thread's own. As a moved thread
does in the flat list, a change that moves a group ahead of a page's cursor skips that group's
remaining threads for the rest of that pass, and one that moves it behind repeats them; the next
load from the first page shows the list whole, and the web UI reloads from the first page on every
refresh. A group can therefore come in two runs. A change that moves a group's first thread moves
the whole group, so while every thread the list keeps is in one session group, it can skip or repeat
the rest of the pass. Every page of a grouped list carries the roll-up of each session holding a
thread the list keeps, with its group, and, grouped by session group or by session, of each of its
topics: how many threads, how many unread, whether any holds a blocking ask open to the caller, the
highest priority of an open ask, and whether all are archived for the caller, and each session's
presence: when it was last seen and whether it is quiet. `composeRollup` rolls up groups into the
one holding them, as the web UI does for a session group's sessions and an agent's, and
`composePresence` sessions' presence into their agent's, quiet when all are and last seen when the
latest was.

The operator's counts take the list's filters and say, for each value of each filter but search, how
many threads it keeps with every other filter as it is. Each value of a filter taking one is counted
by running the list's own total with that value chosen, so one rule says what the list keeps: any
status, and every status but `open`, with the filters on asks off, as choosing it turns them off,
and each value of a filter on asks with `open` chosen, as choosing it chooses `open`. Each agent,
session and topic holding a thread has its own count, whatever that filter's own choices are, each
kind counted in one statement grouped by it with that filter's condition off; so does each group
holding a thread, beside the count of threads in no group, and each tag that a session holding a
thread, or its agent, carries, a thread counting once for a tag both carry. `reset` is the total
with no filter on.

Counts and roll-ups list at most 500 agents, sessions, topics and tags each, the first in name order
or in the list's, and say when they leave any out; the sessions view's page pages agents, each with
at most 500 of its sessions, and says when it leaves any out. A thread's summary lists at most 50 of
its open asks, the most pressing, beside their count and the earliest.

A session's long poll (`waitForThreads`, in `apps/server/src/store/wait.ts`) and the operator's wait
across sessions (`waitForEverySession`) share one loop: poll in a transaction that authorizes, wait
on the notifier, poll again. A session's long poll counts from a position among the session's own
messages. The operator's needs `threads:read` and counts from a position in `message_positions`, in
an opaque cursor of a kind no session's wait gives out, so neither takes the other's. It answers the
threads of every session the identity reaches that hold messages the viewer has not read and whose
latest message is past `since`, oldest activity first, each naming its session, with the position
its answer covers: the last thread's latest message when the page is full, and otherwise the latest
message's. Passing that back as `since` wakes the client for no message it was already told of, and
a full page continues with the threads it left out; a `since` past the latest position counts as
none, as a session's own does. It waits on the notifier's channel across every session, which every
session's notification wakes, and the end of an API key or a browser session too, and it polls again
when its credential expires, so an expiry ends the wait with the credential's refusal, as a
revocation does.

## HTTP API

`apps/server/src/http/` serves one Hono application on `@hono/node-server`, with three mounts:
`/api/agent/` for the agent bridge, `/api/web/` for the web UI, and `/api/operator/v1/` for a client
acting as the operator with an API key. Each mount authenticates its own credential and refuses the
others': the agent mount and the operator mount refuse any request carrying a cookie, so a browser's
sign-in never reaches them, and the web mount refuses any request carrying an `Authorization`
header, so no token or key rides a cookie's authority. The operator mount takes only an API key, as
`Authorization: Bearer`, and needs no CSRF token or `Origin`, since a browser never sends a bearer
key on its own.

Most routes are operations (`operations.ts`), each declared once: its name, method and path, a
one-line summary, the scope it requires, its path, query and body schemas and its response schema
from `packages/api`, and its handler, which the compiler holds to those schemas. A mount builds its
routes from a list of operations: each route authenticates, refuses an identity without the
operation's scope as `not_found`, as if the operation did not exist, before reading any input, reads
the path, the query and the body through their schemas, and answers what the handler returns. The
API's documentation is built from the same lists ([API documentation](#api-documentation)).

- **Operator operations** (`operator-operations.ts`) are every operation an API key may call, each
  with the one scope it requires. Being in the list is what puts an operation on the operator mount,
  so one left out is not there. The web mount serves the same list to the browser session, which
  holds every scope, so both mounts run the same handlers. `threads:read` grants the thread list
  (`GET /threads`), its counts (`GET /threads/counts`), the wait across sessions (`GET /wait`) and a
  thread with its messages; `threads:write` starting a thread on a session, sending a message,
  marking a thread read or unread and archiving it, and bulk read and archive (`POST /reads` and
  `POST /archives`); `sessions:read` the sessions view (`GET /sessions`), its count of sessions with
  unread updates (`GET /sessions/unread-updates`), a session's log
  (`GET /s/:agent/:session/updates`), the groups and tags (`GET /groups-and-tags`) and the
  registrations (`GET /registrations`); `sessions:write` the log's read mark and the groups' and
  tags' writes, each a POST naming its action (`/groups`, `/groups/:id/name`, `/groups/:id/remove`,
  `/tags/:tag/name`, `/tags/:tag/remove`, `/s/:agent/:session/group`, `/s/:agent/:session/tags` and
  `/agents/:agent/tags`); and `sessions:approve` approving, rejecting and revoking a registration. A
  write or approve scope includes its resource's read, and neither includes the other. A test over
  the list holds every operation a read scope grants to a `GET` without a body whose store work
  writes nothing.
- **Agent operations** (`agent-operations.ts`) are the agent mount's: a session's status, starting a
  thread in it, its thread list and its long poll, and the operations on one thread
  (`thread-operations.ts`), which every mount shares under `/s/:agent/:session/threads/:thread`, so
  the role and message checks have one handler each. An agent's registration holds `threads:write`
  over its own session, which those require. One path can name different operations on different
  mounts: `POST /s/:agent/:session/threads` is an agent's `createThread` on the agent mount and the
  operator's `startThread` on the others. Registration, the one agent route a key not yet approved
  may call, authenticates against the key its token carries, so its route is built by hand from its
  declaration.
- **Web-only routes** are plain routes on the web mount, which no key can call: the browser session,
  the passkey ceremonies and signing out; the passkeys; the settings, `GET /settings`,
  `POST /settings/voice` and `POST /settings/voice/clear`; `POST /transcriptions`, whose body is a
  recording sent as `audio/webm`, `audio/mp4` or `audio/ogg`, at least 1,000 bytes, under the same
  body cap as every other ([Voice](#voice)); and the API keys, `GET /keys`, `POST /keys` and
  `POST /keys/:id/revoke`. `provider_failed` comes only from the web mount, and transcriptions spend
  no rate budget.

Every route reads its path, query and body through the shared schemas, so input outside a bound
fails as `invalid_input` before any operation runs, and maps failures to the shared error shape and
its statuses. Anything that is not an API error is logged and answered as `internal`, with no
details. A request body on an API route must declare its length, so its size is known before
anything is read or authenticated: a chunked body is answered with status 411, and one over 2 MiB,
which holds a message with every field at its bound, with status 413. A body that is not valid UTF-8
is refused, never repaired. Every request's `Host` must be the origin's host, so a page on another
name that resolves to the server cannot reach it, and no forwarded header is read. Every response
carries the security headers: a content security policy that allows only the server's own scripts,
styles, images and connections, `blob:` images and the diagram frame as its only frame, and no
framing of its own pages, HSTS, `nosniff`, `DENY` framing, no referrer, and `no-store`; the diagram
frame's page and script set their own policy, framing and caching, as described below.

The long poll answers at once while a thread in the session has unread messages newer than its
`since`, and otherwise ends when such a message commits, when its credential is revoked, when the
client disconnects, when the server shuts down, or when its wait runs out. The operator's wait
across sessions, `GET /wait`, answers and ends the same way across every session, and also when its
API key or browser session ends or expires ([Store](#store)).

The agent mount speaks a version of the agent API, `agentApi` in `packages/api`: 2 in this release,
serving every version from its `oldest`, 1, which only a maintainer's decision moves. Every change
to the agent contract, a new route or a new field on one, bumps it. Every answer on the agent mount,
the refusals of the checks before it included, states the server's version in the
`Agention-Agent-API` header, set by the first middleware for the mount's paths. A request states its
own there, and a missing one means 1, which every bridge released before the header sends. The
mount's first middleware refuses a request stating a version above the server's or below its oldest
as `unsupported_version`, status 400, before authentication or any other work, worded for the agent
as the bridge's own problems are: a newer bridge is told to have the operator upgrade the server or
pin the plugin to a release that matches the server, an older one to have them update the plugin.
Anyone who reaches the server can read the refusal, so it names the versions the server serves,
never its release. A version is read whole, however many digits it has, and a header that is not a
positive integer written without leading zeros is `invalid_input`, naming it. The web mount is not
versioned: the server serves its own web UI, always in step.

The operator mount's version is in its path, `/api/operator/v1/`. A version changes only additively,
with new operations, new optional request fields and new response fields, so a client ignores
response fields it does not know; a change that would break a client is a new version beside the
old, by a maintainer's decision. `GET /api/operator`, which needs no credential, answers the
versions the server serves, `{"versions":[1]}`, and a version it does not serve is unknown, as any
unknown API route is.

Unknown API routes answer `not_found`, and so does every path under `/docs/api` while the API's
documentation is not served. Every other path serves the web UI: a file of the Vite build, or the
UI's index page for any other path, whose router shows the route. The server prepares the index page
once, as it starts, writing its name, HTML-escaped, into the page's title and its `application-name`
and `apple-mobile-web-app-title` metadata, and never serves the page's file as it is; a build whose
page lacks one of those stops the server from starting. A server built without the UI serves a
placeholder page instead.

`/diagram-frame` (`apps/server/src/http/diagram-frame.ts`) serves the page the web UI frames to draw
diagrams, which loads one script, the one `diagram-frame.json` in the build names; a manifest that
names no script of the build stops the server from starting. The page's response carries its own
content security policy, `sandbox allow-scripts`, nothing allowed but that script, named by its full
URL, and inline styles, and `frame-ancestors` naming the server's origin, with
`X-Frame-Options: SAMEORIGIN`. The script's name carries its content's hash, so its response is
cached for good. The security headers middleware sets every header after the route, and leaves a
header a route set itself only for the frame's two routes, and only those they name: the page's
policy and framing, and the script's caching.

## API documentation

`apps/server/src/http/openapi.ts` builds one OpenAPI 3.1 document of the operator API and the agent
API from the operation lists the mounts build their routes from, so it cannot describe a route,
field or bound the server does not have. Each operation has its path, an `operationId` of its
mount's name and its own, such as `operatorListThreads`, its summary, its parameters and body
described as input and its answer as output, and its authentication: on the operator mount the
`apiKey` bearer scheme with the scope the operation requires, and on the agent mount the
`agentToken` scheme and the agent API's version header. `GET /api/operator` is in it too. Every
refusal is one shared `error` response, whose description gives each error code's status. The
schemas come from `@wayfarerlabs/agention-api/json-schemas` ([API contract](#api-contract)), so each
named schema is described once under `components.schemas` and referenced wherever it appears. Rules
a schema enforces only in code, zod refinements such as a key's scopes never repeating, are absent
from the JSON Schema, so the document can describe less than the server checks, never more; each
such rule is stated in its field's description.

The document is committed at `docs/api/openapi.json`, written by `scripts/generate-api-docs.sh`, and
a test in the server's suite fails while the committed document differs from what the code
generates, so every change to the contract is reviewed as a change to that file.

`agention serve --api-docs` serves the document at `/docs/api/openapi.json` and, at `/docs/api/`, a
page the server renders from it once, as it starts (`api-docs.ts`): the API's description, the
authentication schemes and the error response, each mount's operations with their method, path,
summary, authentication and scope, parameters, body and answer, and a section for each shared
schema, which every reference to it links to. The page is static HTML with no script or style, so
the content security policy holds as it is, and everything it shows from the document is escaped.
`/docs/api` leads to the page with a permanent redirect. Both are served without sign-in, since they
describe the contract and no data. Without the flag, every path under `/docs/api` answers the JSON
`not_found`, never the web UI's page.

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
- **API keys.** The operator creates a key on the web mount, with a name, one or more scopes and an
  expiry: 7, 30, 60 or 90 days, a time after now and at most 365 days away, or none. Its secret,
  `agention_` and 256 random bits in unpadded base64url, so people and secret scanners recognize
  one, is answered once, as the key is created. Creating and revoking a key need a session opened
  within the last 10 minutes, as passkey changes do; listing them does not, and the list says
  whether the sign-in is recent, as the passkey list does. The operator holds at most 20 keys that
  are neither revoked nor expired, counted in the creating transaction. The list holds every key,
  newest first, with its scopes, its status and its times, a revoked or expired one until the table
  is next written. On the operator mount, the key must exist, unrevoked and unexpired, and each
  operation's transaction confirms it again, so a revoked key is refused from its next request and a
  wait it holds ends at once. Every refusal of a key is the same `unauthenticated`, telling the
  client to check the key or create a new one in Settings, so it never says whether a key existed. A
  key's use is recorded at most hourly. A key acts as the operator over every session, within its
  scopes; the API keys, passkeys, settings and transcription are web-only routes, so no key reaches
  them.

Browser sessions, links and API keys are 256 random bits, stored only as their SHA-256. Expired
sessions, links and used challenges are deleted whenever their table is next written, and so are
revoked and expired API keys, and registrations that expired while pending, so no timer runs.

## An external issuer

An issuer of agent credentials other than Agention's own registrations, such as an organization's
identity provider, would change Agention in these places:

- **The credential.** `Credential` in `apps/server/src/identity.ts` is a closed union of a
  registration, a browser session and an API key; an issuer's credential would be a fourth kind, and
  every check that branches on the kind, such as `checkCredential`, would take it.
- **The status call.** A session's status update accepts only a registration's credential
  (`updateSession` in `apps/server/src/store/sessions.ts`).
- **The session log.** Each entry in `session_updates` names the registration that wrote it, in a
  column that is never null.
- **The signals.** Whether a session holds a working credential (`credential_active`, in the thread
  list and the registrations' queries) and its last-seen stamp (`markSeen`, which the agent mount
  calls for a registration) are both keyed on registrations.

Everything else keys on agents and sessions themselves, not on the credential that let them in.

## Voice

`apps/server/src/store/voice-settings.ts` reads and writes the voice settings, and
`apps/server/src/transcription/` reaches the provider. The environment may supply the base URL, the
model and the key (`AGENTION_TRANSCRIPTION_URL`, `_MODEL` and `_KEY`), which `agention serve` reads
once at start, each under the bounds and base URL rule a save is held to, refusing to start, naming
the variable but never its value, on one that breaks them or on a key without a base URL. What is in
effect is the environment's base URL and model, else the row's, and voice is on while both exist.
The key in effect is the environment's, else the row's only while the base URL in effect is the
row's. A save, which needs a recent sign-in, refuses a field the environment supplies, writes the
base URL and model then in effect, and keeps the stored key only when none is given and the base URL
written is the stored one, so a changed address, from the request or the environment, never receives
a saved key; a hosted preset's base URL needs a key in effect. No answer carries a key:
`GET /settings` says only whether a saved one is set, saved for another address, or missing, and
which fields the environment supplies. The row is checked against the rules a save is held to on
every read, each transcription's included; one they refuse, as a later release's stricter rule can,
is reported as invalid and never used, and a clear or a save replaces it.

The base URL rule has two halves. `normalizeBaseUrl`, in `packages/api`, reads a URL into its stored
form, which the web UI and the server both use. `checkBaseUrl`
(`apps/server/src/transcription/base-url.ts`) judges the host that form holds with `net.BlockList`:
link-local addresses, the cloud metadata addresses outside them, the unspecified address and
multicast are never reached, and plain http only `localhost` and the operator's own network. An
address in the NAT64 well-known prefix is refused as the IPv4 address it embeds would be, and is
never the operator's own network, since a translator carries it across networks. A host name other
than `localhost` is not resolved; over https, the provider's certificate binds it.

`TranscriptionProvider` is the one interface a transcription goes through, and `openAiCompatible`
its one implementation: `POST {base URL}/audio/transcriptions`, `multipart/form-data` with the
recording under a file name for its type, the model, `response_format=json` and the prompt, and a
bearer key when one is set. It follows no redirect, never retries, and reads at most 1 MiB of the
answer, whose `text` must be a string. It gives up after 60 seconds, and the browser abandoning its
request aborts it, through the request's signal, which `@hono/node-server` aborts when the client
disconnects. A failure, `fetch`'s own included, becomes a `ProviderFailure` of one kind:
unreachable, redirected (a 3xx answer, which is never followed), timed out, cancelled, the key
refused (401 or 403), rate limited (429), the request refused (400 or 404), another status, or an
answer that is not a transcript. `POST /transcriptions` answers it as `provider_failed`, status 502,
with a message naming the kind and never the provider's body, and logs only the kind and status. An
upload the browser abandons before it arrives whole is logged as cancelled too.

## Rate budgets

Token buckets in `apps/server/src/http/rates.ts` keep one kind of traffic from starving another, and
none is keyed on the source address. A request signed by a key the server has a registration for
spends that key's own budget, whether it is a pending agent checking its registration or an approved
agent's session call, and a request on the operator mount carrying a live API key spends that key's
own (`apiKey`). Everything else spends one budget per class: registrations of new keys, failed agent
authentication, failed API key authentication (`failedKeyAuth`), failed passkey sign-ins and failed
passkey links. Every class but new registrations is charged only for a request that failed, after it
was checked, so draining one never refuses a valid key, passkey or link, and beginning a ceremony
costs nothing. An exhausted budget answers `rate_limited`, with a `Retry-After` header. The
[operator guide](operator-guide.md#rate-budgets) lists the rates.

## Serving

`agention serve` canonicalizes `--origin`, checks `--name` and reads the voice settings the
environment supplies ([Voice](#voice)), then reads the server's name from the database's `instance`
row and refuses a `--name` that names another. Without a stored name it takes `--name`, `Agention`
without one, and stores it there once it is listening, so a start that fails before serving leaves
the name unset. Of first starts racing on a new database, the first to store its name keeps it; a
racer with the same name serves too, and one with another closes its listener and exits refused.
After that the name never changes. The name feeds the index page, the relying party and new
passkeys' user names. The server listens on `--listen`, an IP address and port. With `--tls-cert`
and `--tls-key` it terminates TLS 1.3 itself; without them it serves plain HTTP, which it refuses on
a non-loopback address unless `--allow-plain-http` is given. A client gets 10 seconds to send its
request headers and 30 to send its whole request, and an idle keep-alive connection closes after 120
seconds; a long poll's response may take longer. On `SIGINT` or `SIGTERM` the server ends its long
polls, answers every request still open with `Connection: close`, closes idle connections, and exits
once the open requests finish. Three seconds after it starts stopping it closes every connection
still open, whatever its state, a TLS handshake that never finished included.

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

- **Configuration.** `AGENTION_URL` is read through `canonicalOrigin`, and `AGENTION_CONNECT`, when
  set and not empty, as a host and port: a host name or address, IPv6 in brackets, and a port from 1
  to 65535. When `AGENTION_URL` is missing or not an HTTPS origin, when `AGENTION_CONNECT` is not a
  host and port, when the home directory is not an absolute path of at most 4,096 bytes, or when
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
- **Agent API version.** Every request states the version the bridge speaks in the
  `Agention-Agent-API` header. An answer in Agention's JSON that states an older version, or none,
  as every server before the header does, is refused before anything uses it, as a problem only the
  operator can fix: they upgrade the server to the bridge's release or pin the plugin to the
  server's. Such a server ignores what it does not know of a request, so a field the bridge sent
  could otherwise go missing without a word. Every session calls `register` first, so a bridge meets
  an older server there: for a key the server knows, on a call that changes nothing; for a new key,
  the server records a pending registration before the bridge refuses its answer, so the agent never
  relays its code, and the registration expires unapproved. A newer server's answers are used: it
  serves the bridge's version, or refuses it in words of its own. An answer that is not Agention's
  JSON, such as a proxy's, keeps its own problem.
- **Connections.** Requests go out through `node:https`, on one keep-alive agent per bridge with the
  settings of Node's global agent. The agent opens every connection at the origin's host and port,
  or at the address in `AGENTION_CONNECT`, and either way gives TLS the origin's host name as the
  server name the certificate is checked against, while each request's `Host` header names the
  origin too. A connection that has not opened within 10 seconds, its TLS handshake included, fails
  as unreachable. A connection that fails is reported naming `AGENTION_CONNECT` and its address when
  that is set, since the tunnel or forward there is the operator's.
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
- **Tools.** `register`, seven thread tools, `thread_create`, `message_send`, `thread_get`,
  `thread_list`, `thread_read`, `thread_archive` and `message_wait`, and `session_update`, which
  reports the session's status, each annotated neither read-only nor destructive and as acting on a
  closed world. `thread_create` and `message_send` take a message's detail beside its text, and
  refuse it without text, as the server does. A session never answers an ask, so `message_send`
  takes no answers; it takes the withdrawals of the session's own open asks. `message_wait` waits
  for nothing by default and answers at once, which is how an agent checks for answers as it works;
  a longer wait is for an agent with no other work and open asks or unread messages, or for a waiter
  of its own. `register`'s answer, once approved, says how answers reach the agent: when it checks.
  No tool marks a thread unread, which agents have no use for, though the agent API offers it as the
  web API does. The SDK advertises each tool's JSON Schema, generated from the shared schemas, but
  the bridge parses the arguments itself, so input outside a bound is `invalid_input` naming the
  field, as the server would answer it. A tool also refuses a field it does not know, at any depth,
  as `invalid_input` naming it, so a misspelled field never drops silently, while the server's
  request schemas ignore unknown fields, and the agent API version keeps a newer bridge from relying
  on that against an older server. An answer is the API's JSON as text, and a call the server
  refuses is an error result holding the API's error JSON. A problem the bridge finds itself, such
  as its configuration, an unreachable server, missing names or a cancelled call, is an error result
  in plain text, worded for the agent: what to do, or, for what only the operator can fix, to tell
  them at the terminal what to change and whether the session must restart.
  `apps/bridge/src/errors.ts` words those. `message_wait` gives every error but `invalid_input` no
  sooner than its `wait_seconds` would have ended, counted from the call's start, so an agent that
  waits again at once does not call a server it cannot use in a tight loop.
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
protocol, and as a process over stdio. The agent compatibility gate runs each released bridge's
published bundle the same way against the server at HEAD
([CONTRIBUTING.md](../CONTRIBUTING.md#the-agent-api) "The agent API"). `AGENTION_CONNECT`'s tests
run it at an origin whose host resolves nowhere, under `.test`, which bridges reach only at the
address it listens on.

## Web UI

`apps/web/` is a React application with no framework beyond React, which Vite builds into the server
package's `web/` directory.

| Path                 | Contents                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/router.tsx`     | The routes, over the History API                                                                                                                                                                                                                                                                                                                                                                  |
| `src/session.tsx`    | The browser's sign-in, as `GET /session` reports it                                                                                                                                                                                                                                                                                                                                               |
| `src/data.ts`        | The data hooks: loading, live refresh, answers out of order, an ended sign-in, and marking read what a view shows                                                                                                                                                                                                                                                                                 |
| `src/api.ts`         | The web API's client                                                                                                                                                                                                                                                                                                                                                                              |
| `src/passkeys.ts`    | The passkey ceremonies, through the browser's WebAuthn JSON helpers                                                                                                                                                                                                                                                                                                                               |
| `src/voice/`         | Dictation, which records and has the server transcribe, and reading aloud through the browser's speech synthesis                                                                                                                                                                                                                                                                                  |
| `src/markdown/`      | The inert Markdown renderer, and diagrams: the page's diagram frame, the image it makes from the frame's answer, and the viewer                                                                                                                                                                                                                                                                   |
| `src/diagram-frame/` | The diagram frame's script, which only the frame runs, and the messages it exchanges with the page                                                                                                                                                                                                                                                                                                |
| `src/views/`         | One view per route; `views/list/` holds the thread list's sheet, chips, rows and groups, `views/thread/` the thread page and its writes, `views/sessions/` the sessions view's rows, log, registrations, groups and tags, and new-thread sheet, `views/settings/` the Settings sections, declared in `sections.ts`, with passkeys, API keys, voice, signing out and the recent sign-in they share |
| `src/styles.css`     | The design tokens and styles                                                                                                                                                                                                                                                                                                                                                                      |
| `e2e/`               | The browser tests                                                                                                                                                                                                                                                                                                                                                                                 |

The thread list's page address is the API's own list query without its page, read part by part with
the API's schemas, and the web UI and the server share one rule, from `packages/api`, for the
filters on open asks and the status they keep. A session group is named in the address by its id, so
the list loads the operator's groups and tags while the sheet is open or a group or tag filter is
on, to name the groups chosen and to say which group was removed and which tag nothing carries.
Grouped by session group, the list folds the sessions under their groups only while the roll-ups or
the rows loaded hold two or more, no group among them, and composes a group's roll-up from its
sessions', as it does an agent's; this browser keeps a group's fold by the group's id.

The UI reads the server's name from the `application-name` metadata the server writes into its page,
in `src/server-name.ts`, and shows it as the banner's brand and after each page's own name in its
title.

The sessions view answers `/sessions`, and `/registrations`, the path released bridges send the
operator to. It loads the agents whole, at most 500 in pages of 100, since the approval form chooses
among them, and a session's log only while its row is unfolded under an unfolded agent, since what a
fold hides is not rendered: one entry more than it shows, so what the oldest entry shown changed can
be read against the one before it. It reads each entry against the one before and shows consecutive
entries that changed only the percent, with no note, as one line. While the page is visible, an
unfolded log marks the operator's read through its newest entry whenever that is beyond their mark,
with the read marking the thread page uses for its messages. The agents a browser folds, and whether
it shows the past requests, are kept in its local storage, as the thread list's groups are, and a
session's row starts folded on every visit. Once any session carries a group, the view folds the
agents under their groups, splitting each agent's sessions by the group each carries, groups in name
order ignoring the case of ASCII letters, as the server compares them, and no group last; this
browser keeps a group's fold by its id, and an agent's under a group by the group's id and the
agent's name. Each heading sits a level below the one it folds under. Each session's row shows its
threads' roll-up from its summary, and an agent's header and a group's head compose theirs from the
sessions they show, none when the view or the agent left sessions out, each with a link opening the
thread list on those threads, the agent's within its group while the view folds by group; a row's
and an agent's count of stranded threads, while there are any, link likewise to the stranded among
them, by the list's stranded filter, an agent that left sessions out flagging them with no count.
Blocked on the operator shows once, in the thread list's words and tone: a row's and an agent's open
asks say it, as Blocked on you before how many are open, in the danger tone while any blocks and the
attention tone otherwise, and a group's head, which has none, shows Blocked on you. Each session's
row says when the session was last seen, from its presence, as quiet while it is and has not
stopped. Each session's row shows its group and tags, and each agent's header its tags, from the
sessions view's page; the sheets that set them, and the Groups and tags sheet, load the operator's
groups and tags while they are open, and reload the view once a change lands. While the operator is
signed in, the navigation reads how many sessions have unread updates, refreshing it as views
refresh, and the sessions view refreshes it at once whenever it reloads, as reading a log does.
Wherever a thread shows as stranded, the UI says why from the session's presence in the thread's
summary: the stop the session reported, with its outcome; otherwise quiet, with when it was last
seen; otherwise no active credential.

A fenced `mermaid` block renders as a diagram. Mermaid never runs in the page and is not in its
bundle: the page creates one frame, for its first diagram, at `/diagram-frame`, sandboxed with
scripts only and laid out, though out of sight, so Mermaid can measure text, and draws its diagrams
there one at a time, in order. It posts the frame each diagram's text with an id and the Mermaid
theme that matches the color scheme, and accepts an answer only from that frame's window, for the
diagram it is drawing, read through the shapes in `src/diagram-frame/protocol.ts`. The frame runs
Mermaid at its strict security level and answers with the SVG, as standalone XML with the dimensions
of its view box, and the title and description the diagram declares, or with an error. The page
shows the SVG as an `<img>` of a `blob:` URL, which it revokes as soon as the image has loaded, or
failed to, so no URL remains that would open the SVG on its own, outside the page's policy; it keeps
the SVG, to draw again and for the viewer, which makes its own URL from it the same way
(`src/markdown/SvgImage.tsx`). A diagram over 10,000 characters is never sent, and shows its source
with a note that it is too long to draw; one that errs, is not answered within 10 seconds of being
posted to a loaded frame, or whose frame does not load within 60 seconds, its script's download
included, shows its source with a note that it could not be drawn; a frame that did not answer or
load is removed, and the next diagram gets a new one. Diagrams are drawn again when the color scheme
changes. The viewer is a modal dialog holding the image, zoomed and panned by `@panzoom/panzoom`;
only its stage sets `touch-action: none`. The Markdown renderer's output itself holds no frame, SVG
or image: the frame belongs to the page.

The thread page parses a message's detail only once its fold is opened, and the message list keeps
each message's place by its sequence, so a refresh keeps an opened fold open. The composer checks
its boxes against the API's bounds of a message's text and detail, counted with the API's
`codePointLength` as the server counts them, and never cuts what is typed into them. Its Send row,
which holds what answers Send, sticks to the foot of the screen within the composer, and the page's
viewport asks a phone to shrink the layout for its keyboard (`interactive-widget=resizes-content`),
so the keyboard does not hide Send. The composer measures the row as it changes and the page's
scroll padding keeps that much clear, so the caret and a control focused from the keyboard scroll
into view above the row.

Settings is a list of sections, declared once in `src/views/settings/sections.ts`, each with a slug,
a title, the group it is listed under and its component: Passkeys and API keys under Access, Voice
under Features, and Sign out after the groups. The navigation and `/settings/<slug>` are built from
that list, so a new section is one entry and one component, and a slug no section has is Not found.
`/passkeys`, where passkeys had a page of their own, redirects to `/settings/passkeys`, replacing
the history entry. The layout is decided in CSS alone: below the layout's `40rem` breakpoint
`/settings` shows the navigation as a list and a section's page shows a back link to it; above it
the navigation is a column beside the open section, and `/settings` opens the first section. Each
section loads only its own data, and a section that changes a secret, Passkeys, API keys and Voice,
offers to sign in again while the sign-in is not recent (`RecentSignIn.tsx`): API keys reads
`recent` from the key list, and Passkeys and Voice from the passkey list. The voice form starts
afresh from what the server holds whenever that changes, and normalizes a base URL with the API's
own reader; which hosts it may reach is the server's to judge, when it is saved. After a save or a
clear, focus waits for the settings the server then holds before moving to the control that shows
them, and moves only from the control pressed. Signing in again moves focus to the open section's
heading.

The API keys section (`src/views/settings/ApiKeys.tsx`) lists the keys as the server does, each with
its scopes and when it was created, expires and was last used, flagged while it is live with no
expiry, and marked revoked or expired while the server still lists it. Its form (`ApiKeyForm.tsx`)
takes a name, the scopes, each with what it grants, and an expiry, 30 days unless another is chosen;
a scope that a chosen one includes, by the API's own `holdsScope`, shows chosen with it and
unavailable, and is not sent. Choosing no expiry shows a warning, and a date is the operator's local
date, through whose end the key works. A new key's secret shows once, alone, with Copy, which
selects the secret instead where the browser will not copy it; it lives only in the page's memory,
never in storage, the address or a log, until Done dismisses it, and focus then moves to the new
key. Revoke asks first. Create an API key is unavailable while 20 keys are live, and creating and
revoking while the sign-in is not recent, each saying why.

Dictation (`src/voice/Dictation.tsx`) shows in the composer, and in Settings' Try it, while the
settings the page read when it opened say voice is on and the browser has a `MediaRecorder` for
`audio/webm;codecs=opus`, `audio/mp4` or `audio/ogg;codecs=opus`, tried in that order. It records at
32 kbit/s with a one-second timeslice, so it can count the data, and stops at five minutes by the
clock or 1.9 MiB of data, which keeps a recording within the API's body cap; a page hidden while it
records stops it, so the microphone never runs unwatched, and transcribes what it recorded. A
recording under the API's 1,000 bytes is not sent, and reads as nothing heard. The upload declares
the type the recorder was asked for and waits up to two minutes. A recording, or one awaiting a
transcription or a retry, holds the composer's draft open, so its stale-write check counts from when
the recording started. The text goes in at the caret of the box that last had focus, unless the
draft was sent meanwhile; a failure keeps the recording for Retry until it is discarded.
`useDictation` gives its caller the controls, what went wrong and what it says otherwise apart, and
the composer puts all three in its Send row, a failure before Send and anything else after it. The
row stays short on a phone whatever its fonts: the microphone is its icon alone, the recording's
time and a failure drop the words the rest says, and Go back after sending moves below the row while
dictation has controls in it. Each control that replaces another moves focus to the next state's own
control, unless the operator has put focus somewhere else meanwhile, as into the message box while
the microphone opens, and starting a recording is announced once.

Read aloud (`src/voice/speech.ts`) speaks one message at a time through `speechSynthesis`, which
Stop, another message, a recording or leaving the thread cancels at once. It speaks a sentence at a
time, since browsers cut a long utterance off partway. It walks the message's text and detail block
by block, as the Markdown renderer parses them, saying each block's text through `plainText` and
naming code blocks and diagrams instead of reading them, then its asks and answers. An utterance
that fails other than by being cut off says once, under the message, that the device could not read
it, until anything is read or stopped.

A tab opened before the server is upgraded keeps running the UI it loaded, so it may need a reload
to work with the new server.

The browser tests start the built server, serving its built web UI over TLS at
`https://agention.test:<port>`, and drive it in Chromium with CDP virtual authenticators. Passkeys
need a domain name and a secure context, so Chromium resolves `agention.test` to the loopback
address with `--host-resolver-rules` and trusts the certificate made for that name at run time by
its public key with `--ignore-certificate-errors-spki-list`. That makes the page a real secure
context rather than one that bypasses a certificate error. The diagram tests start a server of their
own, and drive the frame under the server's real policies. The voice tests start one too, with a
local stub of a transcription provider, and record through Chromium's fake microphone. The API keys
tests start one as well, create a key in Settings, and call the operator mount with its secret from
outside the browser.

## Generated plugins

`apps/agent-plugin/plugin.json` and `apps/agent-plugin/skills/` are the only plugin sources.
`scripts/generate-plugins.sh` renders them into `out/claude-plugin/`, `out/codex-plugin/`,
`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. The outputs are committed,
and CI fails if they drift from their sources. Installing the plugins from the repository's
marketplace is in daily use on Claude Code; on Codex, the live tests' basic plugin-integration
prompts exercise it.

Each plugin carries the usage skill and declares one MCP server, the bridge, in `.mcp.json` at the
plugin root. The definition names the bridge's package, and the generator pins it to the plugin's
version: `npx -y @wayfarerlabs/agention-mcp@<version>`. Claude Code passes the server its whole
environment. Codex passes a server only a few common variables, such as `HOME` and `PATH`, and those
the server lists, so the Codex declaration lists the bridge's configuration variables:
`AGENTION_CONNECT`, `AGENTION_URL`, `AGENTWORKS_AGENT`, `AGENTWORKS_SESSION` and
`NODE_EXTRA_CA_CERTS`.

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

The agent API has a version of its own, which a release bumps only when it changes the agent
contract, as [HTTP API](#http-api) describes.
