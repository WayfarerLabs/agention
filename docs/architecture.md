# Architecture

This document describes what exists in the repository today. Its design, and the alternatives
considered, are recorded in [ADR 0001](adrs/0001-agention-v1-architecture.md).

Agention is TypeScript on Node, in npm workspaces with one lockfile.

| Component                   | State                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/api`              | The API contract: zod schemas for every route's requests and responses, which are also their bounds, the error codes and the scopes, and their JSON Schema for the API's documentation.                      |
| `packages/build`            | The bundle build the server and the bridge use, one esbuild file each, and the build of the web UI's diagram frame script, with the license notices of the npm packages each includes.                       |
| `packages/private-files`    | The private-file rule the server's database and the bridge's key files obey, which both bundle.                                                                                                              |
| `packages/harness-observer` | Reads whether an agent harness in a tmux pane is running and, at rest, what its screen holds and why it stopped, by a profile of its screens, and nudges it at its own prompt; it knows nothing of Agention. |
| `apps/server`               | The `agention` CLI: `serve` runs the HTTP API, with agent, passkey and API key authentication, over the database, identity and store; `backup` copies the database.                                          |
| `apps/bridge`               | The `agention-mcp` agent bridge: a stdio MCP server whose tools make requests on the agent API, signed with the session's key.                                                                               |
| `apps/web`                  | The React web UI, built with Vite, which the server package ships and serves: passkey sign-in and the operator's views.                                                                                      |
| `apps/agent-plugin`         | The canonical plugin definition and usage skill, and the generator that renders the Claude Code and Codex plugins.                                                                                           |
| `scripts/`                  | The checks CI runs, file linting, plugin generation, and the generation of the API's OpenAPI document.                                                                                                       |

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
- a session's status update and the status it answers with, and the status a session's writes report
  or infer; the sessions view's page of agents, each with its tags and its sessions; how many
  sessions have updates the operator has not read; a session's log and the operator's read mark on
  it; and the operator's start of a thread on a session;
- the operator's session groups and tags: the list of them, creating, renaming, recoloring, ordering
  and removing groups, creating, renaming, recoloring and removing a tag, and setting a session's
  group and an agent's or a session's tags, on their own or with an approval;
- the agent API's version, the header that carries it and the oldest version the server serves;
- monitoring (`packages/api/src/monitoring.ts`): a bridge's id, its background poll's query and
  answer, its report of what it observes (`monitorReport`), its nudge's claim and outcome
  (`monitorNudge`) and their answer, and the report and the latest nudge as the operator sees them
  (`monitorState`, `nudgeState`);
- the browser session's state, the passkey ceremonies' inputs and the operator's passkey list;
- the operator's settings: voice's settings and their bounds, the base URL rule (`checkBaseUrl`),
  the hosted presets, the types a recording is sent as, a transcription's answer, and the space
  attachments take;
- files (`packages/api/src/files.ts`): the limits on files and pending uploads, a file's name and
  reference, an upload's query and result, a message's `attachments` as written and as read, a
  thread's file list and file totals, and the types: the type an upload declares (`declaredTypeOf`),
  the type a name's extension suggests (`typeOfName`), and the type a file is served as and its
  disposition (`servedTypeOf`, `dispositionOf`), which the server serves by and the web UI shows by;
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
every description holding one references by `$ref`: each component is the body zod gives the named
schema under the `$defs` of a description that holds it, and the descriptions name it by its plain
id. A schema reads the same both ways unless it has defaults or reads text into values, or holds one
that does, so such a named schema is described in one direction only, as `Ask` is only sent and
`AskRead` only answered; a component its descriptions would give two bodies, or a cycle no named
schema breaks, throws. An answer's description never forbids properties it does not list, since a
version may add response fields.

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
answers or withdraws them). A session records when its agent last checked in, kept to the minute,
with the agent API version of that call, when its bridge last made a background request, and its
latest nudge: when its bridge claimed it, by the server's clock, and whether it was sent, unknown
while it is under way or where its outcome never arrived; `monitor_reports` holds each session's
latest monitoring report, one row each, which the next replaces, its checks holding the report's
shape, whether the session can be nudged among it. A thread changes only its latest sequence, which
a trigger holds. A full-text index, `thread_titles`, holds every thread's title for search, word
prefixes matched with case and accents ignored; a trigger fills it as a thread is created, and it
relies on titles never changing. Checks hold the rest of what the store keeps true: one operator,
whose id is 1; a registration's session set exactly when it is approved or revoked; and a message's
detail only beside its text. `transaction()` runs one synchronous function under `BEGIN IMMEDIATE`,
so no write interleaves with another in the process.

A session's status lives only in its log, `session_updates`, append-only by the same triggers as
messages: each entry, numbered from 1 within its session, holds the session's whole status after it
(its state, the outcome it stopped with, its title, goal and percent), its own note, the credential
behind it and whether the server inferred it, so the current status is the entry with the highest
number, read through the primary key, and nothing about it is stored on the session. A check holds
an outcome exactly beside the stopped state, and an inferred entry only as working, without a note.
`session_marks` holds each actor's read cursor on a session's log, as `thread_marks` holds one on a
thread.

The operator's session groups are rows of their own, `session_groups`, each with a name unique
ignoring the case of ASCII letters, since a group can be empty and renamed, a color, and a position
in the operator's order, unique by an index. A group keeps its id when renamed, and ids never
repeat, so a filter or fold naming a removed group never reaches a later one.
`session_group_members` is keyed on the session, so a session sits in at most one group, and
removing a group takes its memberships with it by a cascade. A tag is a row of its own too, `tags`,
with a unique name and a color, and exists until it is removed; an agent (`agent_tags`) or a session
(`session_tags`) carries it by its name, a foreign key whose cascades rename it everywhere it is
carried and take it off everything when it is removed. A check holds each color to the palette.
Agents and sessions are never deleted, so no membership or tag outlives what it is on. A second
full-text index, `message_texts`, holds the text and detail of every message that has text, matched
as titles are. It keeps no copy of them, only each message's thread and sequence, since a message
has no integer key of its own for an external-content index to rest on; a trigger fills it as a
message is written, since messages are append-only, and a search joins its rows to `live_messages`,
so a replaced message no longer matches.

Files have three tables. `files` holds one row per upload: its random reference, the name and
declared type it was uploaded with, its size, as its `Content-Length` declared it before any byte
arrived, who uploaded it, in which session and with which registration, and, once every byte has
arrived, its SHA-256 and when it completed; a file is pending until a message first names it, which
`attached_at` records. `file_chunks` holds its bytes, in chunks of 1 MiB numbered from 0, all full
but the last, in a rowid table, since rows of 1 MiB would leave a `WITHOUT ROWID` tree's pages one
row each. `attachments` holds the files each message carries, in the order it gave them, each under
a name unique within the message, append-only as messages are; a trigger marks a file attached as
the first message names it, with that message's time, and a check refuses attaching a file that is
not complete. Triggers let a file's row change only by completing once and being attached once, keep
a chunk's bytes from ever changing, and refuse removing an attached file or any of its chunks. A
file is missing when its last chunk is gone, which is what a future purge, deleting all of a file's
chunks, would leave; a zero-byte file never is.

The database uses incremental vacuuming, so the pages that removing an upload frees return to the
disk a step at a time. SQLite takes that mode only on a database without tables, or through a
`VACUUM` that rewrites the whole file, and neither inside a transaction, so it cannot be a
migration: `apps/server/src/database/vacuum-mode.ts` switches a database whose header still says no
vacuuming, after its migrations, with `PRAGMA auto_vacuum = INCREMENTAL`, `VACUUM` and a truncating
checkpoint. Reading the header rather than the migration number means a backup restored from an
older release switches too. `VACUUM` builds its copy in SQLite's temporary directory
(`SQLITE_TMPDIR`, else `TMPDIR`, else `/var/tmp`, else `/tmp`), needing about the database's size
free there, then writes the database whole through the log beside it. A switch of a database that
held data before the open is logged once it is done, and one of a new database is not. A switch that
fails logs why and the space it needs, and the open carries on without it, since the migrations have
committed and an older release refuses the migrated database; freed pages then stay in the file for
reuse, and the next open tries again. `Database` has `vacuumStep(pages)`, which runs
`PRAGMA incremental_vacuum` outside any transaction, `freePages()`, and `incrementalVacuum`, which
says whether the database is in that mode, for the sweep to skip the vacuum until it is. Every open
also sets `journal_size_limit` to 16 MiB, so a log that a backup's long read let grow is truncated.

`voice_settings` holds at most one row, what the operator's Settings last saved for voice: the base
URL and model in effect when it was saved, the environment's included, so the row always records the
address its key was entered for, an optional prompt (Settings' additional context), and an optional
key. Turning voice off deletes the row. Which provider it means is worked out from its base URL,
never stored apart from it.

`api_keys` holds the operator's API keys: each one's name, its scopes as a JSON array, the SHA-256
of its secret, which is unique, and when it was created, when it expires (null for a key without an
expiry, and otherwise after its creation), when it was last used, kept to the hour, and when it was
revoked. A revoked or expired key keeps its row, so the operator's list can show it, until the
operator next creates or revokes a key. Ids never repeat, so an id names one key for good.

`message_positions` gives every message a position among all messages, in the order they are
written, which the operator's wait across sessions counts from. A message has no stable integer key
of its own: it is keyed by its thread and sequence, and its table's rowid is no column's alias, so
`VACUUM` may renumber it. A position is an `INTEGER PRIMARY KEY AUTOINCREMENT`, which keeps its
value and is never reused, so positions never go backwards. A trigger gives each message its
position as it is written, triggers refuse every update and delete of a position, and the migration
that added the table numbered the messages already written in the order they were stored.

A test freezes the text of every migration by its SHA-256. A migration a release has shipped is
never edited, so a schema change is always a new migration, which adds its hash; an edit to a
migration no release has shipped updates its hash. Others open a database the first migration alone
wrote, and those the first two, three and four wrote, under every later one: the tables they had
keep their rows, the new ones start empty but for the positions of the messages written before, in
the order they were written, and a message written before the full-text index of messages existed is
found by it.

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
names, and input its schema has already parsed. An identity holds scopes, `<resource>:<access>`
([HTTP API](#http-api)): a browser session holds every one, an API key those the operator gave it,
and an agent's registration `threads:write` over its own session. Inside the operation's
transaction, `authorizeScope` confirms the credential is still live (the registration approved, the
browser session unexpired, the API key neither revoked nor expired) and that it holds the scope the
operation requires, and to an identity without it the operation does not exist; an operation on one
session uses `authorize`, which does the same and confirms the credential grants the target session,
an unknown session and someone else's both failing as `not_found`. The mounts refuse a missing scope
too, before reading any input, but every operation confirms its own, so each adapter over the store
is held to the same scopes. A write then checks, in order, request-id replay, roles (only the
requester asks, withdraws asks or sets a topic, only the audience answers), staleness, and the rules
that depend on the thread's messages: a replacement names a live message of the writer's own; each
answer names an open ask and fits it, and a message answers an ask at most once; a replacement
answers again every ask the message it replaces answered that is still live, and none its requester
since revised or retracted, an answer to such an ask going with the replaced message, and may answer
open asks besides; each withdrawal names an open ask, the replaced message's own included, and a
message withdraws an ask at most once; a replacement withdraws again every ask the message it
replaces withdrew, with the same reason or a new one, whether or not the ask's own message is still
live, so a withdrawal is never undone; a replacement of a message holding open asks asks each again
or withdraws it by name, its asks and its withdrawals of those asks numbering at least as many as it
holds open, since a replacement's asks are numbered anew and the count is what can be checked; and a
thread reference names a thread in the same session. Refusals name asks by their numbers. An answer
is a decline, or distinct picks among the ask's suggested answers and the answerer's own words, at
least one of them: an ask without suggested answers takes own words alone, and one that allows a
single answer takes one pick at most. The own words are part of the answer, notes beside its picks
or the whole answer without them, plain text apart from the message's Markdown text and detail,
which are any additional information. It appends the message with its asks and answers and raises
the writer's read mark through it in the same transaction, where a writer for whom the thread is
archived keeps it archived, its archive mark moving to its own message. A later message carries some
part unless it replaces another, a rule the request's schema holds, since no constraint on a
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
every conversation, marks its session's presence before its own work, in a transaction of its own,
so a call refused later still counts. The bridge's background requests, its monitoring poll and
report and its nudges' claims and outcomes (`backgroundOperations` in
`apps/server/src/http/agent-operations.ts`) and a `register` that says `background`, which the
registration route reads from its body, stamp when the session's bridge last made one, on every one,
and never mark the agent checked in; a registration's stamp follows its body's parse, so a body that
fails to parse stamps nothing. Every other call is the agent checking in, stamped with the agent API
version the call states, and only when that moves the last check-in a minute or more, when the last
check-in is after now, so a clock stepped back never holds it still, when the version differs from
the last one's, or when the last check-in is before the latest claim of a nudge, so a check-in
during a nudge, or in reply to one, always shows. Check-ins are otherwise stamped to the minute, so
a check-in up to a minute after an operator message can still leave one nudge due for it, which the
agent reading the thread ends. A stamp wakes no poll, though it can end a nudge being due, since the
bridge's claim checks again that one is. A stamp writes only while the registration is still
approved, so a revocation that commits as a token is verified stamps nothing. A stamp that fails is
logged and the call carries on, since presence is advisory. A pending registration has no session,
so its calls mark nothing.

From those the reads derive, against the request's clock and never stored:

- **Quiet**: the agent never checked in, or has not within `agention serve --quiet-minutes`, 15 by
  default, and the minute a stamp may lag, so an agent that keeps calling never is quiet.
- **Connected**: the bridge made a background request within the last minute. A bridge older than
  agent API version 6 cannot report a connection, so while no bridge is connected and the agent last
  checked in through such a bridge, as every check-in from before versions were kept did, the
  session follows their rule: connected is not stated and never counts against it.
- **Not responding to the nudge**: the session's latest nudge was sent, or its outcome is not known,
  and its agent has not checked in since. Each session's presence carries its latest nudge with
  whether it has, as `last_nudge`'s `answered`, and with `sent` true for a nudge whose outcome is
  not known.
- **Stranded**: a thread holding a live message of the operator's that the session has not read, and
  nothing will bring it to the agent soon: the session has no active credential or is not connected;
  or it cannot be nudged, its connected bridge's report not saying it can, and it is quiet or has
  stopped; or it can be nudged, and the latest nudge since the earliest such message was not sent,
  or was sent, or its outcome is not known, and has had no check-in within the quiet time, or none
  was claimed since and that message is older than the quiet time, whether or not the agent checked
  in since it was written. A session that can be nudged is not stranded for waiting at its prompt,
  since a nudge will bring it.

Only the thread's audience, the operator, sees them, with the state and outcome the session last
reported, which say why it is stranded, and, while it is connected, its bridge's latest report, as
the sessions view's page carries it, so a stranded thread can say what the session's terminal shows;
a grouped list's presence for a session or an agent carries quiet, last seen and connected, and
neither state, outcome nor report. One function describes a session's presence for both reads
(`presenceOf`, `apps/server/src/store/presence.ts`).

The bridge's monitoring (`apps/server/src/store/monitors.ts`) is a background long poll, a report
and a nudge's claim. Several bridges may run for one session with its key, as Codex starts new ones
without ending the old, and one acts for it: the latest to claim it. The store keeps that bridge's
id for each session in memory (`BridgeHolders`), with the number of the latest report accepted from
it, since it matters only while bridges poll this process; a server that starts again holds none
until a bridge polls or reports, and revoking a credential of the session forgets its holder, so the
next bridge to call takes it. A poll names its bridge's id and may claim the session, as a bridge's
reporter does when it starts and when it handles a tool call after being replaced. A claim takes the
session from any other bridge, deletes the session's report, so nothing stale shows until the new
holder reports, and wakes the other bridge's open poll, which answers `replaced`; a poll or report
from a bridge other than the one acting, without a claim, answers `replaced` at once and changes
nothing. Otherwise the poll waits on the session's channel for 25 seconds, or less if it asks,
re-authorizing on each wake as every long poll does. A report carries its bridge's number for it,
`seq`, which counts up with each report the bridge sends, and replaces the session's latest unless
its number is no higher than the latest accepted from that bridge, when it is ignored, so a report
delayed past a later one never overwrites it. The holder changes in memory only once the write that
goes with it, a claim's deletion or a report, has committed. The latest report shows to the operator
only while the session is connected, so a bridge that ended never leaves its last report standing as
current.

The poll also says whether a nudge is due for the session ([ADR 0007](adrs/0007-the-nudge.md)): its
latest report says the session can be nudged and is at its prompt, not stopped by a usage limit
whose reset is unknown or still to come; one of its threads holds a live message by anyone but its
agent that its agent has not read, by the rule the agent's own unread count follows, written after
the agent's last check-in; and no nudge was claimed since that check-in (`nudgeDue`). It is read
from the session's rows on each poll, writing nothing, so it holds across a server restart, a bridge
restart and a takeover, and it says nothing more: no thread, message or presence, and a replaced
bridge is never told one is due. The poll is level-triggered: its query's `nudge` says the bridge
already knows one is due, and the poll answers at once only when that differs from what the server
finds, so a bridge told one is due holds its poll while it still is. What can make one due wakes the
session's channel: a report that says the session can be nudged at its prompt, and a message. What
ends one, a check-in, a mark of the session's own or a claim, wakes nothing, since a claim checks
again that one is due, so a bridge told of one that lapsed learns it when its claim is refused or
its poll's wait ends. The bridge claims a nudge on `POST .../monitor/nudge` (`recordNudge`) before
it puts anything in the pane: `start`, in one transaction, goes ahead only from the bridge that acts
for the session while a nudge is due, recording the claim's time by the server's clock as the
session's latest nudge, its outcome unknown, and answers `go`; `done` sets whether it was sent, only
where the latest claim has no outcome yet, so sending it again changes nothing. A session is nudged
at most once until its agent checks in, even where its bridge restarts or another takes over
mid-nudge.

A session reports its status itself, on the agent mount's status route or beside a write: a thread
it starts or a message it sends may carry a state, with its outcome, and a note, which apply as an
update with them would, in the write's transaction once the write has passed its checks, so a write
that fails changes no status, and a retry of the same request id applies nothing again. The server
infers one change of its own: a write the session makes to one of its threads (starting it, a
message, a read or unread mark, archiving) while it is idle and reports nothing of its status marks
it `working`, since a session that writes is doing something, and logs that change as an inferred
entry, keeping every field but the state, with no note; a write that reports a status takes it
exactly as an update would, so every change the server infers is marked inferred. Reads and waits
change nothing, since an idle session checks for answers by design; a stopped session stays stopped,
since one that writes was started again and says so itself; a session that never reported stays
without a status; and the operator's writes, whose mounts take no status, change nothing. No other
call changes the status. Each update merges into the current status: a state replaces the state,
`stopped` with the outcome the update must give, and `working` and `idle` with none, so a stopped
session stays stopped until it reports one of them; a session that first reports without a state is
`working`, since it is running. A title, goal or percent sets its field, and a goal other than the
current one clears the percent unless the update gives one; a field left out is unchanged, and
nothing clears a field. The note belongs to its entry alone. An update whose merged status equals
the current one and that carries no note appends nothing, so an update carries no request id:
repeating one changes nothing, unless it carries a note, which is logged again. Updates are exempt
from the stale rule and the latest wins, since only the session writes its status. The operator
reads a session's log newest first, with their read mark on it, which marking read raises up to the
latest entry and never lowers; the entries above it are the session's unread updates.

The sessions view's page lists the agents in name order for the operator, each with at most 500 of
its sessions: those working or idle first, then those that never reported, then stopped ones, each
latest seen first. Each session carries its presence, by the formula threads use, with its bridge's
latest report while it is connected; its approved registrations, with their ids and codes; its
status with the latest entry's note, none after an inferred one, and as `updated_at` when that entry
was written; its unread updates; how many of its threads the operator has not archived, with how
many of those hold messages the operator has not read and how many are stranded, counted for every
session of the page in one statement grouped over the threads as the operator sees them; and how
many asks are open in all its threads, with how many of those are blocking, which is what waits on
the operator, counted in one statement grouped over the open asks. The operator can never archive a
thread holding an ask open to them, so their thread list shows every thread counted. A separate read
counts the sessions whose log holds entries the operator has not read, which the web UI's navigation
shows.

The operator sorts sessions into groups and tags agents and sessions, and nothing else does: listing
them needs `sessions:read` and every change to them `sessions:write`, scopes no agent's registration
holds, so to an agent none exists. A group's name is plain text on one line, trimmed, 1 to 100 code
points, unique ignoring the case of ASCII letters; a tag's is a name, as a topic's is. An instance
holds at most 200 groups, and an agent or a session carries at most 20 tags; past either bound a
write is `invalid_input`. A name another group or tag already has is refused as `conflict`, naming
`name`, whether either is created or renamed. A color is one of a fixed palette of eight named
tones, `gray`, `red`, `orange`, `yellow`, `green`, `teal`, `blue` and `purple`, which each client
draws to suit its themes; any other is `invalid_input`. A group or a tag created without a color
takes the palette's in turn, each kind its own: the color after as many as there are groups, or
tags, already. A tag is a row keyed by its name, which the tags agents and sessions carry name by a
foreign key, and an instance keeps at most 500, so the list of them is whole unless an upgrade
carried more tags in use than that, which it then says it left out; creating one past the cap,
directly or by setting tags, is `invalid_input`. A new group goes last in the operator's order, and
ordering the groups gives every group's id once, in the order wanted: a list naming any other set,
as when another client created or removed a group since, is `invalid_input` on `groups` and changes
nothing, so two clients' orders never interleave, and the later whole order stands. A group's rename
changes its name only, so a filter by its id keeps working, and removing it leaves its sessions in
no group. Renaming a tag renames it on every agent and session carrying it, and removing one takes
it off all of them. Setting a session's group names it by id, or none; setting an agent's or a
session's tags gives the whole set, and creates, with its color in turn, any tag it names that does
not exist. Approving a registration may also give the session's group, by id or none, and its tags,
which apply in the approval's transaction, so a new session never shows without them, and which need
`sessions:write` beside `sessions:approve`: to an identity without it, they are `not_found`, naming
the field, and nothing applies. A group is named by its id there as everywhere, so a client creates
a new one first; a tag by its name, which creates it as setting tags does. Agents' tags are set on
their own, since an agent's tags count for every session it has. The list of them gives every group
in the operator's order, with its color and how many sessions it holds, and every tag, at most 500,
in name order, with its color and how many agents and how many sessions carry it, none for a tag
nothing carries, saying when it leaves any out. The sessions view's page carries each agent's tags,
and each session's group and tags.

The operator starts a thread on a session with a title and a first message of text, with its detail
and its files, uploads of theirs to that session, checked as any first message's are. The session
stays the thread's requester and the operator its audience, so the operator's request has no field
for asks or a topic, nor for references, which the web UI does not offer there; a request carrying
any of them starts a thread without them. The session reads the thread as the operator's words and
replies in it. The thread starts whatever the session's state or credential, stranded from the start
when the session is not there to read it; the operator's read mark reaches their message, and the
session's long polls wake. A retry with the same request id is answered as the first was, and one
with other content is a request-id conflict, as for a session's own thread, which a session still
starts only in itself.

An upload (`apps/server/src/store/files.ts`) begins in one transaction, which authorizes the session
under `threads:write` and refuses it while its writer holds 20 pending uploads, or would hold more
than 1 GiB of them by their declared sizes with this one, counting those still arriving and not
those expired; then it inserts the file's row with a reference of 16 random bytes in base64url, and
adds the file to the process's set of uploads in flight. A writer may run several uploads at once.
Each chunk is written in a transaction of its own, which confirms the scope as every store call does
and re-checks the credential, so the upload of a revoked agent's registration or a revoked or
expired API key stops within one chunk. Completing checks that the bytes received number the
declared size, and records the hash and the time. Any failure after the upload begins, a body cut
off, a revoked credential or a length that does not match among them, removes the file and its
chunks in one transaction; a removal that itself fails is logged and left to the sweep. A completed
upload no message names expires 24 hours after it completed, unless its writer removes it first, as
the web UI does for a draft left unsent ([Web UI](#web-ui)).

A message's `attachments` are checked last of the write's message rules (`checkAttachments` in
`store/attachments.ts`). Each `upload` must name a file of the writer's own, uploaded in the
thread's session, complete, not yet attached and not expired; anything else, another writer's or
another session's upload included, is `invalid_input` at `attachments.N.upload` in the same words,
so a reference learned elsewhere tells nothing. Each `keep` needs `replaces` and must name a file of
the replaced message, under its name there, and the message carries it again. The names resolved,
given, kept or an upload's own, must differ after NFC normalization. Attachments are part of the
digest a request id covers, and the replay runs before the check, so a retry whose first attempt
consumed its uploads answers as the first did. A message may carry files alone; a replacement that
keeps files does not retract the message it replaces, and one that does not keep a file leaves it
with the replaced message. A message reads back with its attachments, in order: each file's name,
reference, size, declared type, and whether it is missing. A thread's files are those its live
messages carry: a replaced message still reads back with its own, but they count toward the thread
only while a live message, such as a replacement that kept them, carries them. A thread's answer
carries `files`, the count and bytes of those distinct files, and its file list gives each once,
with the live message that carries it, newest first, paged by an opaque cursor; a file has at most
one live carrier, since an upload is attached once and only a replacement keeps a file. The
settings' `storage` counts every completed file, pending ones included, since that is the disk they
take, and their bytes.

The sweep (`store/file-sweep.ts`) removes the uploads no message will name: those completed more
than 24 hours ago, and those left incomplete that are not in the set of uploads in flight, each in a
transaction of its own. `agention serve` runs it once before it listens, when nothing is in flight,
so every incomplete upload goes, and then every 10 minutes on a timer that never holds the process
open; a pass that fails is logged and the next tries again. When a pass freed pages on a database
using incremental vacuuming, it returns them to the disk 2,048 pages, 8 MiB, at a time, yielding to
other work between steps. The set of uploads in flight is in the process, so one server serves a
database, as the long poll's notifier already requires.

Marking read, marking unread and archiving move only the caller's own marks on a thread; they write
no message, and wake no one. Marking read raises the read mark and never lowers it. Marking unread
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
message of the operator's that the session has not read) or `stranded` (such a message that nothing
will bring to the session soon, by the stranded rule above); `agent` and `session`, up to 50 of
each, a session written `agent/session`; and the operator's `session_group`, up to 50 groups by id,
`none` naming no group, and `tag`, up to 50 tags, keeping a thread whose session or agent carries
one. A group that was removed, or a tag nothing carries or that was removed, keeps nothing. The
filters on asks together keep the threads holding one open ask that meets them all, so any of them
keeps only open threads. One definition of each filter's condition serves the list, its total, its
counts and its roll-ups.

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

Each thread in the operator's list carries its session's group, which no agent's list shows. With
`group`, the operator's list orders its threads by their group, then by the sort, so a group's
threads arrive together: grouped by session group (`group=session_group`), each session's group, no
group being one of its own, and each session within it, is placed by its first thread under the
sort, reversed or not; grouped by session, each session, likewise; grouped by topic, each session,
and each topic within it, likewise; grouped by agent, each agent, and each session within it,
likewise. A group's place is its first thread's keys, which a cursor carries beside the thread's
own. As a moved thread does in the flat list, a change that moves a group ahead of a page's cursor
skips that group's remaining threads for the rest of that pass, and one that moves it behind repeats
them; the next load from the first page shows the list whole, and the web UI reloads from the first
page on every refresh. A group can therefore come in two runs. A change that moves a group's first
thread moves the whole group, so while every thread the list keeps is in one session group, it can
skip or repeat the rest of the pass. Every page of a grouped list carries the roll-up of each
session holding a thread the list keeps, with its group, and, grouped by topic, of each of its
topics: how many threads, how many unread, whether any holds a blocking ask open to the caller, the
highest priority of an open ask, and whether all are archived for the caller, and each session's
presence: when it was last seen, whether it is quiet and whether it is connected. `composeRollup`
rolls up groups into the one holding them, as the web UI does for a session group's sessions and an
agent's, and `composePresence` sessions' presence into their agent's, quiet when all are, last seen
when the latest was, connected when any is, and not connected only when every one says so: a session
whose bridge predates monitoring states no connection and may be running, so beside one, with none
connected, the agent states none either.

The operator's counts take the list's filters and say, for each value of each filter but search, how
many threads it keeps with every other filter as it is. Each value of a filter taking one is counted
by running the list's own total with that value chosen, so one rule says what the list keeps: any
status, and every status but `open`, with the filters on asks off, as choosing it turns them off,
and each value of a filter on asks with `open` chosen, as choosing it chooses `open`. Each agent,
session and topic holding a thread has its own count, whatever that filter's own choices are, each
kind counted in one statement grouped by it with that filter's condition off; so does each group
holding a thread, in the operator's order, beside the count of threads in no group, and each tag
that a session holding a thread, or its agent, carries, a thread counting once for a tag both carry.
`reset` is the total with no filter on.

Counts and roll-ups list at most 500 agents, sessions, topics and tags each, the first in name order
or in the list's, and say when they leave any out; the sessions view's page pages agents, each with
at most 500 of its sessions, and says when it leaves any out. A thread's summary lists at most 50 of
its open asks, the most pressing, beside their count and the earliest.

A session's long poll (`waitForThreads`, in `apps/server/src/store/wait.ts`), the operator's wait
across sessions (`waitForEverySession`) and a bridge's monitoring poll share one loop (`longPoll`):
poll in a transaction that authorizes, wait on the notifier, poll again. A session's long poll
counts from a position among the session's own messages. The operator's needs `threads:read` and
counts from a position in `message_positions`, in an opaque cursor of a kind no session's wait gives
out, so neither takes the other's. It answers the threads of every session the identity reaches that
hold messages the viewer has not read and whose latest message is past `since`, oldest activity
first, each naming its session, with the position its answer covers: the last thread's latest
message when the page is full, and otherwise the latest message's. Passing that back as `since`
wakes the client for no message it was already told of, and a full page continues with the threads
it left out; a `since` past the latest position counts as none, as a session's own does. It waits on
the notifier's channel across every session, which every session's notification wakes, and the end
of an API key or a browser session too, and it polls again when its credential expires, so an expiry
ends the wait with the credential's refusal, as a revocation does. Every message wakes every such
wait to poll again, so one credential, an API key or a browser session, holds at most 4 at once,
which the store's `OperatorWaits` (`apps/server/src/store/operator-waits.ts`) counts in the server
process, as the notifier holds the waits. The operation takes a place once the request is
authenticated and its input read, for a wait longer than 0, which answers at once and takes none,
and gives it back however the wait ends: answered, run out, left by its client, ended by its
credential's end or failed. One past the limit is refused at once as `rate_limited`, with a
`Retry-After` of a second, and no held wait ends to make room, since clients that each wait again
would then push each other out.

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
the path, the query and a JSON body through their schemas, and answers what the handler returns, as
JSON; the store confirms the scope again inside the operation's transaction ([Store](#store)). An
operation whose body or answer is a file's bytes declares it as bytes (`BytesBody`, `BytesAnswer`),
with what the documentation says of it: the mount reads no such body, the handler reads the bytes
from the request, and it answers a response it built, its bytes streamed. The API's documentation is
built from the same lists ([API documentation](#api-documentation)).

- **Operator operations** (`operator-operations.ts`) are every operation an API key may call, each
  with the one scope it requires. Being in the list is what puts an operation on the operator mount,
  so one left out is not there. The web mount serves the same list to the browser session, which
  holds every scope, so both mounts run the same handlers. `threads:read` grants the thread list
  (`GET /threads`), its counts (`GET /threads/counts`), the threads above and below one in it
  (`GET /s/:agent/:session/threads/:thread/neighbors`), the wait across sessions (`GET /wait`) and a
  thread with its messages, a thread's files and the file a message carries; `threads:write`
  starting a thread on a session, sending a message, marking a thread read or unread and archiving
  it, bulk read and archive (`POST /reads` and `POST /archives`), and uploading a file and removing
  a pending upload; `sessions:read` the sessions view (`GET /sessions`), a session's log
  (`GET /s/:agent/:session/updates`), the groups and tags (`GET /groups-and-tags`) and the
  registrations (`GET /registrations`); `sessions:write` the log's read mark and the groups' and
  tags' writes, each a POST naming its action (`/groups`, `/groups/order`, `/groups/:id/name`,
  `/groups/:id/color`, `/groups/:id/remove`, `/tags`, `/tags/:tag/name`, `/tags/:tag/color`,
  `/tags/:tag/remove`, `/s/:agent/:session/group`, `/s/:agent/:session/tags` and
  `/agents/:agent/tags`); and `sessions:approve` approving, rejecting and revoking a registration,
  with `sessions:write` too for an approval that gives the session's group or tags. A write or
  approve scope includes its resource's read, and neither includes the other. A test over the list
  holds every operation a read scope grants to a `GET` without a body whose store work writes
  nothing.
- **Agent operations** (`agent-operations.ts`) are the agent mount's: a session's status, starting a
  thread in it, its thread list and its long poll, its bridge's monitoring poll and report (`GET`
  and `POST /s/:agent/:session/monitor`) and its nudge's claim and outcome
  (`POST /s/:agent/:session/monitor/nudge`), and the operations on one thread and on its session's
  uploads (`thread-operations.ts`), which every mount shares under `/s/:agent/:session`, so the
  role, message and file checks have one handler each: a thread (`/threads/:thread`), a message,
  whose schema each mount gives, since only the agent mount's carries the session's status, its read
  and unread marks and archiving, a thread's files (`GET /threads/:thread/files`), a file a message
  carries (`GET /threads/:thread/messages/:seq/files/:name`), an upload (`POST /uploads`) and
  removing one (`POST /uploads/:upload/remove`). Each names its scope, and an agent's registration
  holds `threads:write` over its own session, which covers every one. One path can name different
  operations on different mounts: `POST /s/:agent/:session/threads` is an agent's `createThread` on
  the agent mount and the operator's `startThread` on the others. Registration, the one agent route
  a key not yet approved may call, authenticates against the key its token carries, so its route is
  built by hand from its declaration.
- **Web-only routes** are plain routes on the web mount, which no key can call: the browser session,
  the passkey ceremonies and signing out; the passkeys; the counts of what waits on the operator
  that the navigation's tabs show (`GET /attention`: the unread threads, the thread list's total
  with Unread the only filter on, and the registrations waiting for approval); the settings,
  `GET /settings`, which includes the space attachments take, `POST /settings/voice` and
  `POST /settings/voice/clear`; `POST /transcriptions`, whose body is a recording sent as
  `audio/webm`, `audio/mp4` or `audio/ogg`, at least 1,000 bytes, under the same body cap as every
  other ([Voice](#voice)); and the API keys, `GET /keys`, `POST /keys` and `POST /keys/:id/revoke`.
  `provider_failed` comes only from the web mount, and transcriptions spend no rate budget.

Every route reads its path, query and body through the shared schemas, so input outside a bound
fails as `invalid_input` before any operation runs, and maps failures to the shared error shape and
its statuses. Anything that is not an API error is logged and answered as `internal`, with no
details. A request body on an API route must declare its length, so its size is known before
anything is read or authenticated: a chunked body is answered with status 411, and one over its
bound with status 413. An upload's bound is 100 MiB, the largest file; every other body's is 2 MiB,
which holds a message with every field at its bound. The bound is chosen by `isUploadRequest`
(`apps/server/src/http/uploads.ts`), from the path Hono routes on any mount, with dot segments
resolved and the query ignored, which the listener's deadlines read too, so both always agree; with
a `Content-Length` the bound compares the header alone and reads nothing. A JSON body that is not
valid UTF-8 is refused, never repaired. Every request's `Host` must be the origin's host, so a page
on another name that resolves to the server cannot reach it, and no forwarded header is read. Every
response carries the security headers: a content security policy that allows only the server's own
scripts, styles, images, media and connections, `blob:` images and the diagram frame as its only
frame, and no framing of its own pages, HSTS, `nosniff`, `DENY` framing, no referrer, and
`no-store`. The security headers middleware sets every one of them after the route has run,
replacing what the route set, except those the route declared its own for its response with
`ownHeaders` (`apps/server/src/http/own-headers.ts`): the diagram frame's page and script declare
their policy, framing and caching, a file's response its policy and caching, and the API
documentation's page its policy, as described below.

The long poll answers at once while a thread in the session has unread messages newer than its
`since`, and otherwise ends when such a message commits, when its credential is revoked, when the
client disconnects, when the server shuts down, or when its wait runs out. The operator's wait
across sessions, `GET /wait`, answers and ends the same way across every session, and also when its
API key or browser session ends or expires ([Store](#store)).

The agent mount speaks a version of the agent API, `agentApi` in `packages/api`, serving every
version from its `oldest`, which only a maintainer's decision moves. Every change to the agent
contract bumps it ([CONTRIBUTING.md](../CONTRIBUTING.md#the-agent-api)). Every answer on the agent
mount, the refusals of the checks before it included, states the server's version in the
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
old, by a maintainer's decision. Until 1.0, a change in what an existing field or value means may
land in place by a maintainer's decision, marked breaking
([ADR 0005](adrs/0005-operator-api-meaning-before-1-0.md)). `GET /api/operator`, which needs no
credential, answers the versions the server serves, `{"versions":[1]}`, and a version it does not
serve is unknown, as any unknown API route is.

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
cached for good. Both routes declare those headers their own with `ownHeaders`.

### Files

The routes on files are operations on one thread and its session's uploads (`thread-operations.ts`),
so they are the same on every mount under `/s/:agent/:session`, behind each mount's own
authentication: uploading and removing an upload require `threads:write`, and a thread's files and
reading a file `threads:read`. An API key's uploads are the operator's, as its messages are, so they
share the operator's pending limits, and the web UI can name one in a message.

- **Uploading.** `POST /s/:agent/:session/uploads?name=<name>` takes the file's bytes as the raw
  body, with its `Content-Length` and a `Content-Type` read as its declared type: the type's
  essence, lowercased, under its standard name where it has a common alias, or
  `application/octet-stream`. In order: the app's checks of the host, the length and the bound; the
  mount's checks and authentication, from headers alone; the name, a file name of 1 to 200 code
  points on one line, with no `/` or `\`, not `.` or `..`, and no white space at either end; the
  free-space floor; the start of the upload, with its limits; the bytes, a chunk at a time; and the
  completion. The floor refuses an upload as `storage_full`, status 507, unless the disk holding the
  database, by `statfs`'s blocks available to an unprivileged user, would keep 1 GiB free beyond
  this file and every byte still to arrive across all incomplete uploads. The answer is the upload's
  reference, name, size, declared type, the type it is served as, and when it expires. An agent's
  upload spends one request of its key's budget, as any call does, and so does an API key's; the
  browser session's spends none. A refused upload leaves its body unread, and `@hono/node-server`
  then reads it for at most 500 ms or 64 MiB before closing the connection, so a refusal goes out
  first and no refused upload holds the server longer.
- **Removing an upload.** `POST /s/:agent/:session/uploads/:upload/remove` removes one of the
  writer's own completed uploads that no message names, uploaded in that session, with its bytes, so
  it stops counting against the writer's pending limits at once. Any other reference, another
  writer's, another session's, one attached or one still arriving, is `not_found`, as for a
  reference that names nothing. An upload still arriving has not yet answered with its reference;
  ending its request stops it, and the server removes what arrived. The web UI's **Remove** calls it
  for an uploaded file; the bridge has no tool for it.
- **A thread's files.** `GET /threads/:thread/files?cursor=&limit=` lists the files a thread's live
  messages carry, each once with the message that carries it, its author and its time, newest first,
  up to 50 a page by default.
- **Reading a file.** `GET` and `HEAD /threads/:thread/messages/:seq/files/:name?file=<reference>`
  read the file a message carries under a name, percent-encoded in the path and compared after NFC
  normalization (`apps/server/src/http/files.ts`). The thread must be the session's, the message the
  thread's and the name the message's, and `file`, when given, the reference of that file, or the
  read is `not_found`; the web UI always gives it, so a URL always names the same bytes, and a copy
  cached before a restore from an older backup never shows in place of a later file. A missing file
  is `not_found`, saying its contents are missing. A single range, `bytes=a-b`, `bytes=a-` or
  `bytes=-n`, is answered 206 with `Content-Range`, reading only the chunks it covers; several
  ranges, another unit or a malformed header are answered 200 with the whole file; a range starting
  at or beyond the end, any range of an empty file included, is 416 `invalid_input` with
  `Content-Range: bytes */<size>`. `If-None-Match` and `If-Range` are ignored, since the bytes at a
  URL never change. `HEAD` reads no chunk. The body streams a chunk at a time, each read in its own
  transaction, which confirms the scope as every store call does and re-checks the credential, so a
  revoked or expired agent's registration, browser session or API key stops it within one chunk; the
  first chunk is read before the answer starts, so a credential revoked meanwhile or a chunk that is
  gone is answered as any refusal is. A read that fails later, at a refused credential, a missing
  chunk or anything else, is logged once through the server's log, naming the file, the chunk and
  why (an internal error with its stack, as every internal error is logged), and drops its
  connection, so the client sees the body cut short rather than ended.
- **A file's headers.** `Content-Type` is the served type: the declared type when it is PNG, JPEG,
  GIF, WebP or SVG (`image/svg+xml`), PDF, `video/mp4`, `video/webm` or `video/ogg`, or
  `audio/mpeg`, `audio/mp4`, `audio/ogg`, `audio/webm`, `audio/wav` or `audio/flac`;
  `text/plain; charset=utf-8` for every `text/` type and for JSON, XML, NDJSON, YAML and TOML;
  otherwise `application/octet-stream`. No served type is a script or style type, so the app's own
  policy can never be pointed at a file. `Content-Disposition` is `attachment` for SVG and
  `application/octet-stream`, `inline` for the rest, with an ASCII fallback name and the name itself
  in RFC 5987's `filename*`. Beside `Content-Length`, a file answers with `Accept-Ranges: bytes`, a
  strong `ETag` of its SHA-256 in hex, `Cross-Origin-Resource-Policy: same-origin`,
  `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'` and
  `Cache-Control: private, max-age=31536000, immutable`, the last two declared its own, and the
  other security headers, the agent API version on the agent mount included.

| Situation                                                     | Code            | Status |
| ------------------------------------------------------------- | --------------- | ------ |
| A body sent chunked                                           | `invalid_input` | 411    |
| A body over its bound, an upload's over 100 MiB               | `invalid_input` | 413    |
| A body that stopped arriving, or took over 30 seconds         | `invalid_input` | 408    |
| Pending uploads at their limit, by count or bytes             | `invalid_input` | 400    |
| An upload's bytes not numbering its `Content-Length`          | `invalid_input` | 400    |
| A message's `attachments` refused                             | `invalid_input` | 400    |
| The disk under the free-space floor                           | `storage_full`  | 507    |
| An unknown thread, message or name, or a file's missing bytes | `not_found`     | 404    |
| An upload to remove that is not the writer's pending one      | `not_found`     | 404    |
| A range outside the file                                      | `invalid_input` | 416    |

## API documentation

`apps/server/src/http/openapi.ts` builds one OpenAPI 3.1 document of the operator API and the agent
API from the operation lists the mounts build their routes from, so it cannot describe a route,
field or bound the server does not have. Each operation has its path, an `operationId` of its
mount's name and its own, such as `operatorListThreads`, its summary, its parameters and body
described as input and its answer as output, and its authentication: on the operator mount the
`apiKey` bearer scheme with the scope the operation requires, and on the agent mount the
`agentToken` scheme and the agent API's version header. An upload's body is described as any media
type, `*/*`, with what its `Content-Type` declares, and a file read's answer as its served types,
with the `Range` header, 206 and 416. `GET /api/operator` is in it too. Every refusal is one shared
`error` response, whose description gives each error code's status. The schemas come from
`@wayfarerlabs/agention-api/json-schemas` ([API contract](#api-contract)), so each named schema is
described once under `components.schemas` and referenced wherever it appears. Rules a schema
enforces only in code, zod refinements such as a key's scopes never repeating, are absent from the
JSON Schema, so the document may describe less than the server checks, never more; a request
breaking such a rule answers `invalid_input`, naming the field when the rule concerns one.

The document is committed at `docs/api/openapi.json`, written by `scripts/generate-api-docs.sh`, and
a test in the server's suite fails while the committed document differs from what the code
generates, so every change to the contract is reviewed as a change to that file.

`agention serve --api-docs` serves the document at `/docs/api/openapi.json` and, at `/docs/api/`, a
page the server renders from it once, as it starts (`api-docs.ts`): the API's description, the
authentication schemes and the error response, each mount's operations with their method, path,
summary, authentication and scope, parameters, body and answer, and a section for each shared
schema, which every reference to it links to. The page is static HTML with no script or style, and
everything it shows from the document is escaped; it is served under a content security policy of
its own, `default-src 'none'` with no base, form action or framing allowed, so it loads, runs and
submits nothing, whatever it holds. `/docs/api` leads to the page with a permanent redirect. Both
are served without sign-in, since they describe the contract and no data. Without the flag, every
path under `/docs/api` answers the JSON `not_found`, never the web UI's page.

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
  origin. The registration route verifies the token against the key it names, which may be new; a
  `register` that says `background` only reads, so for a key no registration has it records nothing
  and answers `not_found`.
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
  first time, and afterwards replaces their passkeys, which ends every browser session and revokes
  every API key that has not already ended, waking any wait they hold. A replacement keeps the
  WebAuthn user id, so an authenticator overwrites the old passkey instead of keeping it.
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
  newest first, with its scopes, its status and its times, a revoked or expired one until the
  operator next creates or revokes a key. On the operator mount, the key must exist, unrevoked and
  unexpired, and each operation's transaction confirms it again, so a revoked key is refused from
  its next request, a wait it holds ends at once, and a file it is uploading or reading stops within
  a chunk. Every refusal of a key is the same `unauthenticated`, telling the client to check the key
  or create a new one in Settings, so it never says whether a key existed. A key's use is recorded
  at most hourly. A key acts as the operator over every session, within its scopes; the API keys,
  passkeys, settings and transcription are web-only routes, so no key reaches them.

Browser sessions, links and API keys are 256 random bits, stored only as their SHA-256. Expired
sessions, links and used challenges are deleted whenever their table is next written, and so are
registrations that expired while pending, and revoked and expired API keys are deleted when a key is
next created or revoked, so no timer runs.

## An external issuer

An issuer of agent credentials other than Agention's own registrations, such as an organization's
identity provider, would change Agention in these places:

- **The credential.** `Credential` in `apps/server/src/identity.ts` is a closed union of a
  registration, a browser session and an API key; an issuer's credential would be a fourth kind, and
  every check that branches on the kind, such as `checkCredential`, would take it.
- **The status call.** A session's status update accepts only a registration's credential, and so do
  a write's report and the inference from a write (`updateSession` and `statusOnWrite` in
  `apps/server/src/store/sessions.ts`).
- **The session log.** Each entry in `session_updates` names the registration that wrote it, in a
  column that is never null.
- **The signals.** Whether a session holds a working credential (`credential_active`, in the thread
  list and the registrations' queries) and its presence stamps (`markCheckedIn` and
  `markBackground`, which the agent mount calls for a registration) are both keyed on registrations.

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
a saved key; a hosted preset's base URL needs a key in effect. No answer carries more of a key than
its last four characters: `GET /settings` says whether a saved one is set, saved for another
address, or missing, gives the key in effect's last four as `key_ending`, none of a key shorter than
16, and says which fields the environment supplies. The row is checked against the rules a save is
held to on every read, each transcription's included; one they refuse, as a later release's stricter
rule can, is reported as invalid and never used, and a clear or a save replaces it.

The base URL rule has two halves. `normalizeBaseUrl`, in `packages/api`, reads a URL into its stored
form, which the web UI and the server both use. `checkBaseUrl`
(`apps/server/src/transcription/base-url.ts`) judges the host that form holds with `net.BlockList`:
link-local addresses, the cloud metadata addresses outside them, the unspecified address and
multicast are never reached, and plain http only `localhost` and the operator's own network. An
address in the NAT64 well-known prefix is refused as the IPv4 address it embeds would be, and is
never the operator's own network, since a translator carries it across networks; one in the
local-use prefix is refused outright, since where it embeds the IPv4 address depends on the
network's translator. A host name other than `localhost` is not resolved; over https, the provider's
certificate binds it.

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

A transcript that is the prompt sent, ignoring case, punctuation and the spacing between words, is
answered as empty, since Whisper sometimes answers silence with its prompt.

## Rate budgets

Token buckets in `apps/server/src/http/rates.ts` keep one kind of traffic from starving another, and
none is keyed on the source address. A request signed by a key the server has a registration for
spends that key's own budget, whether it is a pending agent checking its registration or an approved
agent's session call, and a request on the operator mount carrying a live API key spends that key's
own (`apiKey`). A key's bucket that has refilled is dropped when another key's is added, so the
server holds buckets only for keys that spent recently, however many it has ever seen. Everything
else spends one budget per class: registrations of new keys, failed agent authentication, failed API
key authentication (`failedKeyAuth`), failed passkey sign-ins and failed passkey links. Every class
but new registrations is charged only for a request that failed, after it was checked, so draining
one never refuses a valid key, passkey or link, and beginning a ceremony costs nothing. An exhausted
budget answers `rate_limited`, with a `Retry-After` header, as does a wait across sessions past its
credential's limit ([Store](#store)). The [operator guide](operator-guide.md#rate-budgets) lists the
rates.

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
a non-loopback address unless `--allow-plain-http` is given. Before it listens, it runs the first
sweep of uploads ([Store](#store)). A client gets 10 seconds to send its request headers, checked
every second, and an idle keep-alive connection closes after 120 seconds.

The listener keeps its own deadlines on request bodies (`apps/server/src/http/deadlines.ts`), with
Node's `requestTimeout` set to 0, since Node's is server-wide, cannot be lifted for one request and
is checked only every 30 seconds. It tracks each request from when its headers arrive until its body
is complete or its connection closes, not until its answer is written, and checks them all every
second on a timer that never holds the process open. A request whose body sends nothing for 30
seconds is cut off, an upload's included, judged by the bytes its socket has read whether or not the
route reads them; every request but an upload is cut off once it is still arriving 30 seconds after
its headers. An upload has no total deadline, so a slow link finishes; a long poll's request is
complete once its headers arrive, so no deadline touches its wait. A request cut off before its
answer started is answered 408 `invalid_input` with `Connection: close`, carrying the security
headers and, on agent paths, the agent API version, which the listener adds itself since the answer
is written outside the app; the request is then destroyed, so the route's read of the body fails and
an upload removes what arrived, and the route's own later answer is discarded. A request cut off
after its answer started, or after it finished, has its connection destroyed. On `SIGINT` or
`SIGTERM` the server ends its long polls, answers every request still open with `Connection: close`,
closes idle connections, and exits once the open requests finish. Three seconds after it starts
stopping it closes every connection still open, whatever its state, a TLS handshake that never
finished included.

## Agent bridge

`apps/bridge/` is a stdio MCP server on `@modelcontextprotocol/server`, connected straight to the
SDK's stdio transport, so it serves the protocol revisions hosts open with `initialize` and answers
`server/discover` as a method it does not have. Its entry point checks for Node 24 or later before
loading anything else. Without `--version` or `--help`, which print and exit, `agention-mcp` serves,
taking monitoring's two options, `--tmux-socket` and `--harness-profile`, and the nudge's,
`--nudge`. It exits once the host closes its standard input, ending its reporter's requests and its
reading of the pane. Its answer to `initialize` carries instructions that state the usage skill's
first rule, to ask through Agention and never wait at the terminal for an answer, and tell the agent
to load the skill, so the agent has the rule before the skill loads. Claude Code adds them to the
agent's system prompt. Codex describes the bridge's tools with them and shows only their first 250
characters until the agent loads the tools, so they stay within that.
[SECURITY.md](../SECURITY.md#the-agent-bridge) states what the bridge holds and sends: its key file,
its tokens and where its requests may go.

- **Configuration.** `AGENTION_URL` is read through `canonicalOrigin`, and `AGENTION_CONNECT`, when
  set and not empty, as a host and port: a host name or address, IPv6 in brackets, and a port from 1
  to 65535. When `AGENTION_URL` is missing or not an HTTPS origin, when `AGENTION_CONNECT` is not a
  host and port, when the home directory is not an absolute path of at most 4,096 bytes, or when
  `NODE_TLS_REJECT_UNAUTHORIZED` turns certificate checks off, the bridge still serves, and every
  tool answers with what the operator must change. The session's names come from the first
  `register` call that gives them, else from `AGENTWORKS_AGENT` and `AGENTWORKS_SESSION`, a name
  `register` leaves out falling back to its variable. Whichever the bridge uses first fixes the
  session for the life of the process; naming another afterwards is `invalid_input`. Monitoring
  reads `--tmux-socket`, else `AGENTION_TMUX_SOCKET`, the socket of the tmux server whose one pane
  the agent host runs in, and `--harness-profile`, else `AGENTION_HARNESS_PROFILE`, else `auto`; an
  empty value counts as unset, and the bridge never reads `TMUX` or `TMUX_PANE`. The nudge reads
  `--nudge`, else `AGENTION_NUDGE`, and is off without either; `tmux` is the one type, and it needs
  the socket. No setting of monitoring's or the nudge's stops the bridge or changes a tool's answer
  but `register`'s word on how answers arrive: a profile name the harness observer's registry does
  not know is logged once, and the strict generic profile reads the pane instead, and a nudge type
  the bridge does not know, or `tmux` without a socket, is logged once and leaves the nudge off.
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
- **Tokens.** `jose` mints a token for each request, signed with the session's key.
- **Bodies.** A JSON body is sent whole, as a string, so it declares its length. A file's bytes
  stream from the open file with its `Content-Length`, the size the file had when it was opened, so
  Node never sends it chunked: a file that grows sends only that much, and one that shrinks while it
  is read fails the upload, saying the file changed. A download streams into its file, and an answer
  that does not state a length of at most 100 MiB is refused before any of it is written; Node then
  holds the body to that length.
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
- **Time limits.** A request has 30 seconds to be answered, beyond any wait it asks for. A transfer
  has no total deadline: it fails once its bytes, sent or received, stop moving for 30 seconds,
  telling the agent the transfer stalled. Once an upload's body is written its answer has 30 seconds
  and the file's size at 64 KiB a second, since buffers on the way, the socket's own, a proxy's or a
  tunnel's, can hold megabytes the server has yet to receive. The answer and transfer limits share
  one timer per request, which never keeps the process alive, so a bridge whose host has gone exits
  even while a call waits. A host also limits how long one tool call may take: the Codex plugin sets
  `tool_timeout_sec` to 600 seconds for every tool, and Claude Code's default limit, which
  `MCP_TOOL_TIMEOUT` changes, is long enough.
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
- **Tools.** Eleven: `register`, seven thread tools, `thread_create`, `message_send`, `thread_get`,
  `thread_list`, `thread_read`, `thread_archive` and `message_wait`, `session_update`, which reports
  the session's status, and two file tools, `file_upload` and `file_get`, each annotated neither
  read-only nor destructive and as acting on a closed world. `thread_create` and `message_send` take
  a message's detail beside its text, refusing detail without text as the server does, and its
  `attachments`, which may be all a message carries, and the session's `state`, with its `outcome`,
  and a `note`, which report its status with the write, refusing an outcome apart from `stopped` as
  `session_update` does. A session never answers an ask, so `message_send` takes no answers; it
  takes the withdrawals of the session's own open asks. `message_wait` waits for nothing by default
  and answers at once, which is how an agent checks for answers as it works; a longer wait is for an
  agent with no other work and open asks or unread messages, or for a waiter of its own.
  `register`'s answer, once approved, says how answers reach the agent, in its message and as
  `answers`: `nudge` where the session can be nudged, as monitoring says, its nudge on, its profile
  one that knows its harness's prompt marker and its pane read and running the harness, and nudging
  not stopped by a refusal, and otherwise `check`, when it checks; a pending answer says nothing of
  it. No tool marks a thread unread, which agents have no use for, though the agent API offers it as
  the web API does. The SDK advertises each tool's JSON Schema, generated from the shared schemas,
  but the bridge parses the arguments itself, so input outside a bound is `invalid_input` naming the
  field, as the server would answer it. A tool also refuses a field it does not know, at any depth,
  as `invalid_input` naming it, so a misspelled field never drops silently, while the server's
  request schemas ignore unknown fields, and the agent API version keeps a newer bridge from relying
  on that against an older server. An answer is the API's JSON as text, followed by the status
  reminder when one is due, and a call the server refuses is an error result holding the API's error
  JSON. A problem the bridge finds itself, such as its configuration, an unreachable server, missing
  names or a cancelled call, is an error result in plain text, worded for the agent: what to do, or,
  for what only the operator can fix, to tell them at the terminal what to change and whether the
  session must restart. `apps/bridge/src/errors.ts` words those. `message_wait` gives every error
  but `invalid_input` no sooner than its `wait_seconds` would have ended, counted from the call's
  start, so an agent that waits again at once does not call a server it cannot use in a tight loop.
- **Reporter** (`apps/bridge/src/reporter.ts`). The reporter holds the session's background
  connection and reports what monitoring observes, beside the tools, which work as without it and
  whose answers carry nothing of it. It starts with the bridge when the default session, the one
  `AGENTWORKS_AGENT` and `AGENTWORKS_SESSION` name, has its key on disk, once the host has
  initialized, so the `auto` profile is chosen from the client's name: a bridge started again under
  Agentworks shows its session connected with no tool call. That start fixes the session's names,
  creates no key and logs nothing; with no key, or a key file it cannot read, the reporter does not
  start, and a key that is not approved is read as below. `register` starts it too, whatever it
  answers, and so does the first tool call that finds the session's credential while it is not
  running, as in a bridge started before the key was on disk. While the registration is pending it
  reads its state every 15 seconds with the request `register` makes, marked `background`, until two
  minutes before it expires by the bridge's clock, the clock skew tokens allow; once the operator
  approves, it starts with no tool call. A registration that is rejected, revoked or expired, a
  pending one past that margin, or a key the server does not know, as once it has pruned the key's
  expired pending registration, which a background read answers `not_found` and never registers,
  ends it, logging nothing, until the next `register`, or a tool call that finds the credential.
  Approved, it long-polls `GET /api/agent/s/<agent>/<session>/monitor` with an id of 16 random bytes
  it drew when the bridge started, one poll at a time, each waiting 25 seconds, the next starting at
  least a second after the last began, and backing off from 1 to 60 seconds, doubling, while
  requests fail; a key the server no longer accepts has its registration read again. Its first poll
  claims the session and asks for no wait, so the server has taken the claim before any report
  follows. From then on it watches the monitor and sends `POST .../monitor` with the whole report
  and its number, counting up from 1 for the life of the process: the first on claiming, then one
  for each observation that differs from the last, one request at a time. A report that fails to
  reach the server, or that the server fails on or answers `rate_limited`, is sent again, or the one
  that replaced it, after a pause that backs off from 1 to 60 seconds, doubling, or as soon as a
  poll is answered. One the server refuses with any other error of the 4xx range, such as
  `invalid_input`, which sending again would not change, is dropped, and the bridge logs the error's
  code, once for a run of the same refusal, never the report or the server's message. A poll or
  report answered `replaced` means another bridge of the session claimed it: the reporter stops
  polling, watching and reporting until this bridge next handles `register` or a tool call that
  finds the credential, when it claims the session again. Its requests sign with the key on disk and
  act in the names granted to it, and a request it makes to learn them is marked `background` too,
  so none marks the agent checked in. Against a server older than the bridge's agent API version,
  its requests fail as every tool's do and it backs off to a minute between them. A poll answered
  `nudge: true` makes the reporter remember that a nudge is due, so its next polls say `nudge=true`
  and the server holds them until that changes, and has monitoring nudge the agent with texts of
  `apps/bridge/src/nudge.ts`: a warning of fixed words and 4 random bytes in hex from
  `crypto.randomBytes`, which the observer removes and never submits, and a fixed message telling
  the agent to check in with Agention, each one line of printable ASCII. Nothing from the server or
  the screen reaches either. While the session is not ready, the reporter asks again about once a
  second, which reads only the pane and makes no request, until it is ready or a poll says no nudge
  is due. Once ready, the observer asks it to claim the nudge, `POST .../monitor/nudge` with
  `{phase: "start"}`, and goes on only where the server answers `go` and the pane still shows the
  same screen; one it answers no is not tried. A nudge it claimed is logged by the step it stopped
  at, never a text, and its outcome sent as `{phase: "done", sent}`. A claim or an outcome is sent
  again after a pause that backs off from 1 to 60 seconds, doubling, while it fails to reach the
  server or the server fails on or rate limits it, a claim within the one try, before the observer
  reads the pane again. Where such a failure may have left the server holding a claim that the claim
  sent again finds no longer due, the reporter sends `{phase: "done", sent: false}`, so a nudge
  never typed is not shown as sent. A claim or outcome the server refuses as `invalid_input` stops
  nudging for the life of the process, logged by the code alone, and from then on its reports say
  the session cannot be nudged and `register` says `check`; any other refusal is the poll's to deal
  with. A takeover or the bridge closing stops a nudge under way with no key more.
- **Monitoring** (`apps/bridge/src/monitoring.ts`). Without a socket, the report says the bridge
  monitors no pane. With one, a `PaneObserver` from `packages/harness-observer` reads the tmux
  server's one pane through a `TmuxPane` once a second, while the bridge acts for its session, with
  the profile the configuration names; `auto` takes the harness from the name and version of the MCP
  client's `initialize`, each a string of at most 100 and 50 characters or none, and an unknown
  harness gets the strict generic profile. The pane is read only while its first process is an
  ancestor of the bridge's, walking `/proc`'s parent links, so a socket that names another session's
  pane reads as unknown. A report carries the profile's name, the condition and since when, what
  stopped the harness with its reset time, all spelled as the API spells them, with a reset time the
  API would not take left out, and whether the session can be nudged: the nudge is on, the profile
  knows its harness's prompt marker, as a harness's own does, and the condition is anything but
  unknown. A generic profile reads the cursor's whole row as the input line, so it cannot tell a
  draft at the prompt from an empty one, and a session read with one is never nudged. The observer's
  `nudge` carries out the nudge, with every check before each key that `packages/harness-observer`'s
  README lists, against the observations the bridge is reading; the pane passes its pastes and keys
  to tmux and logs neither. The observer says whether the harness is running and, at rest, what its
  screen holds; the bridge spells that as one condition, the screen naming it at rest (its prompt
  `at_prompt`, a screen the profile does not recognize `waiting`), and puts the stopped-by reason
  beside whatever condition it is. The bridge logs to its standard error, once each time one begins,
  a pane it cannot read (no tmux server at the socket, a path too long for a socket, no `tmux`
  command), a machine with no `/proc`, which monitoring needs Linux for, a tmux that leaves the
  formats it is asked for empty, which no tmux tested, 3.3 or later, does, a pane that does not run
  the bridge, a tmux server holding more than one pane, and a pane whose first process does not hold
  its terminal, each of which the observer reads as unknown; the line names the socket, process ids
  and what tmux said, never the screen's text.
- **Status reminder** (`apps/bridge/src/status-reminder.ts`). The bridge keeps, within its process,
  when it last sent a status update the server logged (one with a note, one whose status differs
  from the last it knew, or its first), or, until then, when a tool first answered in the session,
  which needs approval. A `session_update` answers with the status, which the bridge compares; a
  write's answer carries none, so for a write the bridge applies the server's rule to the status it
  last knew: the state and note the write gave, or, for a write that reports neither, `working`
  while the status was `idle`. A write that reports nothing therefore restarts the count only when
  it ends an idle status, as the server then logs an inferred entry, and the reminder comes again
  once that `working` has gone unreported past the threshold, since an inferred entry carries no
  note on what the session does. While the status the bridge last knew is `working`, or it knows
  none, and its last logged update is more than 20 minutes ago, the next successful answer of any
  tool but `register` and `session_update` ends with one more text block after the API's JSON,
  saying how many minutes this bridge has gone without sending a status update and to report what
  the agent is doing with `session_update` and a note, which the server logs even when the status is
  unchanged. Another comes each further 20 minutes until the bridge sends an update the server logs,
  so an agent that checks Agention every half minute is not told on every answer. An idle or stopped
  status gets none: it holds while the session waits or has stopped, and the sessions view shows its
  age. No reminder comes on an error result. The bridge knows only its own updates, since the agent
  API offers no reading of the status: a bridge started anew counts from its own first answer, one
  sharing a session with another bridge does not see that bridge's updates, and a key revoked and
  approved again keeps the count it had. A bridge sends its `session_update` calls and its writes to
  threads one at a time, recording each once answered, so what it records follows the order the
  server committed them in. The clock is the one tokens are minted by, which tests replace.
- **File tools** (`apps/bridge/src/file-tools.ts`). `file_upload` takes an absolute path and an
  optional name, by default the path's last segment, and declares the type `typeOfName` gives the
  name, reading nothing of the file to choose it. It opens the path with `O_RDONLY`, `O_NONBLOCK`
  and `O_NOCTTY`, so a FIFO cannot hold the call and a terminal never becomes the bridge's own, then
  refuses, from the open file, anything but a regular file, anything whose real path is at or under
  the real path of `~/.config/agention`, which is skipped when that directory does not exist, and a
  file over 100 MiB, before a byte is sent. The key check resolves the path again rather than the
  open file, so a symlink swapped between the two is out of its scope: only something running as the
  agent's user could swap it, and that already holds the key. It answers with the server's upload
  result and a line saying to name it in `attachments` before it expires. `file_get` takes a thread,
  a message's sequence and a file's name. It reads that message first, for the file's reference and
  declared type, then the file by its URL with the reference, into `~/.cache/agention/files/`, a
  directory under the private-file rule outside the key directory, which every server and session
  shares, since references are random. The file is named by its reference and the extension of its
  served type, `bin` for one without, never by the sender's name, and only a reference that parses
  as one names a file. It streams into a `.<random>.part` file of mode 0600, renamed into place once
  whole, which any failure removes. Each call, once it has read the message and before it fetches
  the file, removes every file of the directory last written more than seven days ago, partial files
  included, leaving directories alone. It answers with the path, name, size, declared type and
  served type, and when the file is a PNG, JPEG, GIF or WebP of at most 3.5 MiB whose leading bytes
  carry that type's signature, an `image` block of it after the text, which both hosts show the
  model; a larger image's answer says to read the file at its path. Answers are text, with that
  block alone beside it, and the status reminder after both when one is due: no `resource_link` or
  `structuredContent`.
- **Answer cap.** `apps/bridge/src/fit.ts` keeps a result, and separately an error's text, within
  sizes in UTF-8 bytes that both hosts pass to the model whole; each tool also declares the result
  size to Claude Code in its `_meta`: the cap, 40,000 bytes, and 500 more for the status reminder,
  since how Claude Code measures a result of several blocks is not documented. A page of messages or
  threads over the limit is asked for again with half as many elements as the smaller of the last
  page size and what the answer held, down to one; `message_wait` asks for those smaller pages with
  no wait. The bridge gives a server 30 seconds to answer a request beyond any wait it asks for, and
  a whole `message_wait` call, its credential lookup and every request included, the same 30 seconds
  beyond its `wait_seconds`, so it ends within 55 seconds, under Codex's 60-second tool timeout, and
  answers that the server did not answer in time if it runs out. An answer still over it at one
  element leaves out its largest text-bearing fields, largest first, until it fits: texts (each
  answer's own words included) and details, references, a message's attachments whole, each ask's
  fallback text, question and suggested answers, the question each answer carries, and the reasons
  of withdrawals, the thread's and each ask's included, each named in `omitted` as a dotted path,
  such as `messages.0.asks.2.fallback`. A detail of one-byte characters that JSON need not escape
  always comes back whole beside its text, unless the message's other fields are large too; one in
  other scripts can be left out and named in `omitted`, from roughly 19,000 code points in a
  two-byte script down to about 9,500 in emoji, and the web UI always shows it in full. A `stale`
  error lists only the leading missed messages that fit and says from which sequence to read the
  rest, or that none fits; every other error stays within its limit by construction, quoting at most
  100 characters of any configured value.

The bridge's tests run the server from `apps/server` in process, over TLS with a certificate made at
test time, and drive bridges through the MCP SDK's client: in memory, message by message for the
protocol, and as a process over stdio. The agent compatibility gate runs each released bridge's
published bundle the same way against the server at HEAD
([CONTRIBUTING.md](../CONTRIBUTING.md#the-agent-api) "The agent API"). `AGENTION_CONNECT`'s tests
run it at an origin whose host resolves nowhere, under `.test`, which bridges reach only at the
address it listens on. The reporter's tests pace it in milliseconds, record the requests bridges
make, and read monitoring from a pane they draw themselves or from the harness observer's scripted
harness in a tmux server of their own.

## Web UI

`apps/web/` is a React application with no framework beyond React, which Vite builds into the server
package's `web/` directory.

| Path                 | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/router.tsx`     | The routes, over the History API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/session.tsx`    | The browser's sign-in, as `GET /session` reports it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/data.ts`        | The data hooks: loading, live refresh, answers out of order, an ended sign-in, and marking read what a view shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/api.ts`         | The web API's client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/keyboard.tsx`   | The keyboard shortcuts: their declarations, the document's key handler and the help overlay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/passkeys.ts`    | The passkey ceremonies, through the browser's WebAuthn JSON helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/voice/`         | Dictation, which records, has the server transcribe and puts the text in a message's boxes, and reading aloud through the browser's speech synthesis                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/attach/`        | Attaching files to a message as the operator writes it: Attach, the files' list and their uploads, which a thread's composer and the new-thread sheet share                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/markdown/`      | The inert Markdown renderer, and diagrams: the page's diagram frame, the image it makes from the frame's answer, and the viewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/diagram-frame/` | The diagram frame's script, which only the frame runs, and the messages it exchanges with the page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/views/`         | One view per route, but for the thread list and a thread, which share the Threads tab's (`Threads.tsx`); `views/list/` holds the thread list's search, sheet, chips, rows and groups, `views/thread/` the thread page and its writes, with `views/thread/files/` its attachments, `views/sessions/` the sessions view's arrangement, folds, rows, log, registrations, groups and tags, and new-thread sheet, `views/settings/` the Settings sections, declared in `sections.ts`, with passkeys, API keys, groups and tags, voice, storage, keyboard, signing out and the recent sign-in they share |
| `src/styles.css`     | The design tokens and styles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `e2e/`               | The browser tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The thread list's page address is the API's own list query without its page, read part by part with
the API's schemas, and the web UI and the server share one rule, from `packages/api`, for the
filters on open asks and the status they keep. A session group is named in the address by its id, so
the list loads the operator's groups and tags while the sheet is open, a group or tag filter is on
or the list is grouped by session group, to name the groups chosen, to say which group or tag was
removed, and to color them. A tag the operator's groups and tags do not list was removed, since they
list every tag, those nothing carries among them. Grouped by session group, the list folds the
sessions under their groups only while the roll-ups or the rows loaded hold two or more, no group
among them, and composes a group's roll-up from its sessions', as it does an agent's; this browser
keeps a group's fold by the group's id. A header's label and the marks of its roll-up that a filter
matches link to the list's address with the header's own filter (its group by id, its session, topic
or agent) and the mark's added to the view, and a plain click chooses that view in place, as the
filters do, replacing the address and, when the view changes, moving focus to **Filters**. While a
filter on open asks is on, Blocked on you and the priority stay plain: a roll-up counts every open
ask of the threads kept, while those filters keep a thread for one ask meeting them all, so the
mark's filter could replace the one on or keep nothing. A header of no topic, which no filter names,
links nothing. The sessions view's header links are these same links (`src/views/filter-links.tsx`),
starting from no filters instead of the list on screen.

Every fold, the thread list's headers, the sessions view's and its session rows, is a disclosure
button holding the chevron, with a plain label inside it and a linked one beside it, so no link sits
in a button; a header's heading takes the button's name alone, so a linked label does not repeat it.
A header's roll-up and its links sit at the end of its heading's row, wrapping beneath it where the
width ends, each wrapped row a touch's height from the next, and an options menu keeps the bar's
right end. The button's box stretches under the whole header or row, beneath its links and controls,
so a pointer anywhere else on it folds or unfolds it while keyboards and assistive technology use
the button; the links reach across the bar's height, so a tap near one lands on it.

At a desktop's width, `64rem` and up, the Threads tab shows the list and the thread open side by
side, on `/` and on each thread's address alike; below it, one at a time, as on a phone. Side by
side, the page takes the window's whole width, the list's pane 30% of it, from `20rem` to `36rem`,
and the thread's the rest, while rendered Markdown keeps a readable line length (`90ch`). The shell
mounts both routes as one view, `src/views/Threads.tsx`: the list's pane, then the thread's, the
thread's in the same place at every width, so crossing the breakpoint keeps the thread mounted, with
its draft files, staged answers, folds and focus. The width is read in the script, with a media
query, since it decides what is mounted: one at a time, the list is not mounted while a thread is
open. Side by side, the list stays mounted with its filters, folds, loaded pages and scroll, and
loads again on each return to it from a thread and as each change the page makes lands, besides its
refresh; each thread mounts afresh in its pane; and each pane has its own error boundary. The list
beside a thread is the list its history entry returns to (`currentListView` in `src/router.tsx`),
and choosing another order or filter there replaces that entry's state (`showList`), so the thread
stays open. The list on screen is the layout's own: going back or forward, between threads or onto
the list's own entry, keeps it as set and rewrites the entry gone to, a thread's list to return to
or the list's address, so the entry, a reload, `u` and the list agree. The router has the one
listener to `popstate`, and runs the corrections views register (`correctPoppedEntry`) within it,
with telling the page: a listener of its own would run only once the page had rendered the entry
uncorrected. A row's link records the list on screen as it is followed. The open thread's row is
`aria-current="page"`, and opening it again moves focus into the thread's pane. The page keeps one
title and one level-one heading, the thread's while one is open, and a change that leaves a thread,
such as Archive all or a send that goes back to the list, returns to the list as it stands once the
change lands. After a navigation the shell moves focus to where it lands (`focusLanding` in
`src/components.tsx`), the place a view marks with `data-landing`, its heading or else the place
itself: side by side the thread's pane, on a phone the page's content, or on returning to the list,
the row of the thread just left (`src/views/list/beside.ts`). A landing with no heading yet, as a
thread's while it loads, is pending: the first heading to show in it (`PageHeading`) takes focus as
it shows, while focus is still on the landing itself or on nothing, as when the control that had it
went, never from where the operator has put it meanwhile, within the landing or not. So a thread
opened from the list, by Thread above or below, by archiving or after sending lands on its heading
at every width. A row that goes while it holds focus passes it to the page's heading, and crossing
the breakpoint, if it took away what held focus, moves focus to where a navigation lands. The thread
keeps the page's own scroll, and the list's pane is sticky and scrolls on its own.

A thread page's **Thread above** and **Thread below**, and Archive all as Auto-advance says, go to
the row just above or below the thread in the list it returns to, as that list stands when the
operator asks: the list Back to threads goes to, which its history entry names, or the list with no
filters for a thread opened from a link. Side by side it is the list on screen, and a phone, showing
no list, gets the same answer. The server answers it
(`GET /s/:agent/:session/threads/:thread/neighbors`, `findThreadNeighbors` in
`src/store/thread-lists.ts`), ranking the list once, as the list's pages rank it, grouping included,
with the thread kept at its own place though the filters would leave it out, as they do a thread
just archived or read out of a list kept to the unread, and answering the rows on either side. A
kept thread stands within its own group, and the groups stay where the list shows them, so it never
moves one; only a group it alone would hold takes its place from it. The request costs about what
one page of the list does. The page (`src/views/thread/leaving.ts`) asks on each press, and Archive
all asks once the archive has landed, so archiving never waits on the list. Should the operator
change the list while the server answers, the page asks again in the list as it then stands, so it
keeps their latest choice and opens a thread found in the list it returns to; should the list change
three times running, it stays and says so rather than go by an answer for a list left behind.
Archive all archives only through what the page shows: after sending, it waits until the page has
loaded through the message sent, with any the agent wrote before it. The buttons push the thread
found as a new history entry, carrying on the list it was found in; Archive all replaces the
archived thread's entry, so Back does not return to it, and stays on the thread, archived, with the
failure shown, should the request fail. At the end of the list that way each goes back to the list,
leaving it a notice to say so; nothing goes round. Auto-advance is a choice the browser keeps
(`useAutoAdvance`), the thread above unless the operator chooses otherwise in Settings' Threads
section. While one way on is under way no other starts, the buttons are marked busy, and Send and
After sending wait, so a send never lands to find its own way on refused or its choice changed.

The UI reads the server's name from the `application-name` metadata the server writes into its page,
in `src/server-name.ts`, and shows it as the banner's brand and after each page's own name in its
title.

A component that moves focus does it in a layout effect, never a passive one. A passive effect runs
after the browser paints, so when the change that calls for the move came from an awaited request,
the control that had focus is already gone and focus rests on the page's body until the effect runs.
Tests judge focus the first time the change shows, inside `waitFor`, since a late move has already
run by the time `waitFor` resolves.

The sessions view answers `/sessions`, and `/registrations`, the path released bridges send the
operator to. It loads the agents whole, at most 500 in pages of 100, since the approval form chooses
among them, and a session's log only while its row is unfolded under an unfolded agent, since what a
fold hides is not rendered: one entry more than it shows, so what the oldest entry shown changed can
be read against the one before it. It reads each entry against the one before and shows consecutive
entries that changed only the percent, with no note, as one line. While the page is visible, an
unfolded log marks the operator's read through its newest entry whenever that is beyond their mark,
with the read marking the thread page uses for its messages. The agents a browser folds, and whether
it shows the past requests, are kept in its local storage, as the thread list's groups are, and a
session's row starts folded on every visit. The view arranges what it loaded in the browser
(`views/sessions/arrangement.ts`), grouped by session group, by agent or by session, and sorted at
every level alphabetically, A to Z, by registration time, newest first, as the thread list's
`created`, a session's `created_at`, which its first approval sets, and an agent's or a group's its
earliest session's, or, grouped by session group only, manually, no group last under every sort. The
arrangement lives in the address, as `/sessions?group=agent&sort=registered&reverse=true`, each part
left out at its default (by session group, manual, or alphabetic grouped otherwise, in the sort's
own direction), and a part the view cannot take, such as manual grouped by agent, reads as its
default. Choosing replaces the address, as the thread list's head does, sharing its controls
(`views/list-head.tsx`), so going back leaves the view and returns to it as it was. Grouped by
session group, once any session carries a group, the view folds the agents under their groups,
splitting each agent's sessions by the group each carries; sorted manually, groups go in the
operator's order as `GET /groups-and-tags` lists them, which the view loads beside its sessions, a
group it does not list yet after those in name order, so until they load the groups show by name and
then move into the operator's order, and their agents and sessions in name order. There, each
group's head moves it as Settings' list of groups does, sharing its order (`views/group-order.tsx`):
its buttons and a drag handle put it in the place of the group shown before or after it, or the one
whose head it is dropped on, sending the whole order, groups holding no session among it. Only
groups the loaded order holds move, so none move before the groups load, and a drop takes only a
group's own drag, by a type of its own. Once a move is taken, the order sent shows until the reload
it then starts has brought the groups, the resource's `refresh` settling once its own answer has and
saying whether the data shown is at least as new as that load, so a refresh that started before the
move cannot undo it meanwhile; when that reload fails, the order sent, if no later move sent
another, shows until a later load succeeds and clears the failure, which renders with the data it
kept, so a poll from before the move landing beside the failure cannot undo it either, and the view
says its groups and tags could not load, with a retry, as Settings does. A group the order sent
lacks, as one another client created, shows after those it holds. Grouped by agent, each agent folds
over its sessions; grouped by session, the rows stand alone, each naming its agent. This browser
keeps a group's fold by its id, and an agent's under a group by the group's id and the agent's name,
and by its name alone otherwise. Each heading sits a level below the one it folds under. Each
session's row shows its threads' roll-up from its summary, and an agent's header and a group's head
compose theirs from the sessions they show, none when the view or the agent left sessions out, each
with a link opening the thread list on those threads, the agent's within its group while the view
folds by group; a row's and an agent's count of stranded threads, while there are any, link likewise
to the stranded among them, by the list's stranded filter, an agent that left sessions out flagging
them with no count. Blocked on the operator shows once, in the thread list's words and tone, as
Blocked on you in the danger tone, before a row's and an agent's open asks, in the attention tone,
and on a group's head, which has none. Every mark that stands for threads links to the thread list
with no other filter on: a group's, an agent's and a session's name and its envelope to its threads
and its unread ones, Blocked on you to those holding a blocking ask, the open asks to the open ones,
each within the header or row it sits on, and a group's or a tag's chip to the threads in that group
or carrying that tag alone. Each session's row says, on the line under its head, where the session
is as the server knows it, apart from the state its agent reports among its facts: whether its
bridge is connected, which the presence of a bridge from before monitoring does not state; while it
is, what the bridge last reported of its terminal, from the presence's `monitor`, and since when;
what came of its latest nudge, from `last_nudge` (`nudgeWords`, `src/format.tsx`), in the warning's
tone while the agent has not checked in since, so a sent one reads as not responding to the nudge;
when its agent last checked in, from `last_seen_at`, as quiet while it is and has not stopped; and
how long ago its status was updated, from the status's `updated_at`, since an agent can go on
checking in long after its status stopped saying what it does. The words for a condition come from
one function (`conditionWords`, `src/format.tsx`), following the API's model: a stopped-by reason
leads, with any prompt on the screen beside it, and a permission or other prompt with no reason
reads as stopped on that prompt; a condition the page does not know, which a newer server may
report, reads as unknown, and a reason it does not know as stopped by something. A session needs the
operator while its report shows a permission or other prompt or a stopped-by reason, whatever the
reason (`terminalNeedsYou`, and `sessionNeedsYou` in `views/sessions/arrangement.ts`); its row flags
it as Needs you, in the warning's tone, and an agent's header and a group's head count their
sessions that do, or flag them with no count when sessions were left out. The view's one filter,
Needs you, lives in the address beside the arrangement, as `needs_you=true`, and shows only those
sessions, and the agents and groups holding any, arranged exactly as the view would be without it;
it hides rows and nothing else, so every count and link on a header or a head still covers all its
sessions. Each flag and count links to the view with it on, keeping the arrangement, and stays that
link, marked `aria-current`, once it is on, so keyboard focus stays where it was; a chip beneath the
head removes it, through the thread list's chips (`views/list/Chips.tsx`), focus moving to the
head's grouping as the chip goes, as the thread list's moves to Filters. Turning it on or off pushes
a history entry, while choosing the arrangement replaces the one it was chosen in
(`views/sessions/needs-you.tsx`, `views/Sessions.tsx`). An unfolded row names the profile the bridge
reads its terminal with, or that it monitors none, and whether the bridge can nudge the agent. Each
session's row shows its group and tags, and each agent's header its tags, from the sessions view's
page, in the colors the operator's groups and tags give them, which views that show groups and tags
pass down through a palette (`src/organizing.tsx`); the stylesheet draws each of the API's named
colors as a tone and a background for each color scheme, at AA contrast. A session's group and an
agent's or a session's tags are set in pickers (`views/sessions/Picker.tsx`), modal dialogs placed
beside the control that opened them on a wide screen and rising as a sheet on a phone, whose search
box is a combobox owning a listbox of the groups or tags, the item the arrow keys are on its active
descendant. Each pick applies at once, a picker taking one at a time, its items unavailable until
the change settles, so tags picked fast never land out of order; a failed change shows the tags as
last applied, and the view reloads with the groups and tags once a change lands. The same pickers,
in a registration's approval (`views/sessions/Organize.tsx`), keep their picks for the approval
request, starting from an existing session's own group and tags and over for another agent or
session, a new session keeping them as it is named, dropping a pick that lands after they changed,
and create a group picked new at once since the approval names its group by id. Settings' groups and
tags (`views/settings/`) list them to create, rename, recolor, remove and, for groups, order, each
move sending the whole order to `POST /groups/order`, which refuses one that does not name every
group, so a stale order reloads the list, as it does the sessions view's groups. A move or a color
under way marks its controls `aria-disabled` rather than disabling them, so keyboard focus stays
where it was. While the operator is signed in, the navigation reads what waits on the operator, from
`GET /attention`, and shows it as a badge on each tab while there is any: the unread threads on
Threads and the registrations waiting for approval on Sessions. The counts refresh on an interval,
on returning to the page, on going to another view, and at once after any change the page makes
lands, which the web API client announces for every request but a read and signing in or out. From
the moment the operator starts ending the session, by signing out or by removing the passkey that
signed this browser in, the page asks nothing more that needs the session on its own: no view
refreshes, no count is read and a load under way stops before it asks again, since the server may
sign the browser out before anything sent meanwhile arrives and would refuse it. Wherever a thread
shows as stranded, the UI says why from the session's presence in the thread's summary (`absenceOf`,
`src/format.tsx`): for a session its bridge can nudge, no active credential; otherwise its latest
nudge with no check-in since, not responding to it or not sent; otherwise that no nudge came. For
any other session, the stop it reported, with its outcome; otherwise quiet, with when its agent last
checked in; otherwise no active credential; otherwise its bridge not connected. Beside any but the
last, it says what the session's terminal shows, where the bridge reports it. The new-thread sheet
warns of the same reasons but the last of a session that can be nudged, which a new thread's nudge
will reach.

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

The keyboard shortcuts are declared once, each with where it acts, its keys and what it does, in
`shortcuts` in `src/keyboard.tsx`, and the help overlay, a `Sheet` that `?` opens, lists that
declaration whole, so it cannot drift from the keys. While it is mounted, each place's view gives
every shortcut of its place its action, through a hook typed by the place (`useShortcuts` for the
thread list and a thread, `useFieldShortcuts` for the composer, and the provider for those that act
anywhere), so a place binds exactly its declared shortcuts, and no shortcut listed goes without an
action. Only one component holds a shortcut's action at a time; a second registering one throws.
Each action does what a control on the page does, only while that control could, and otherwise
nothing. A matching key is always taken from the browser: no key bound does anything of the
browser's own where it acts, apart from `/` on the thread list, which takes Firefox's Quick Find,
deliberately; `Enter` on a row is left out, since the row is a link the browser follows. One handler
on the document, added after the page's own, acts on a key only when nothing handled it first, it
was not typed into a text field, a select or editable content, no dialog or options menu is open,
and Ctrl, Alt and Meta are up, AltGr, which Chrome on Windows reports as Ctrl and Alt held, counting
as neither for the punctuation it types, such as `[` on a German keyboard; Chrome on Windows reports
a real Ctrl and Alt chord as AltGr too, so with a letter, a digit or a named key such as `Escape`,
which types nothing, it counts as Ctrl and Alt; the first key of two, `g`, waits 1.5 seconds for the
second. A screen reader's browse mode takes single keys before the page sees them, so the shortcuts
reach the page only once it passes keys through, and never compete with its own. The composer's own
keys, Send and leaving it, act within its fields from its form's key handler (`useFieldShortcuts`),
and likewise not while a dialog or options menu is open, such as Attach's within the form. Side by
side, the list's shortcuts and the thread's act together, each pane naming the area of its view's
(`ShortcutArea`), which clicking within a pane gives focus. While focus is in one place's area,
another place's keys act only if they reach across (`reachesAcross`): the list's do, moving focus
into it, but the thread's do not, so `e`, a digit or `u` never acts on the thread from the list. A
key both bind, `n`, acts in the place whose area holds focus, or else in the later place declared,
the thread. The thread list's selection is the row whose link has focus
(`src/views/list/shortcuts.ts`), or, side by side with focus on no row, the open thread's, so moving
it moves focus, which the focus ring shows and a screen reader follows; the number keys choose a
suggestion on the ask card that holds focus or else the first open one, by pressing its control. The
shortcuts are on unless the operator turns them off in Settings' Keyboard section, which this
browser keeps in its local storage (`src/device.ts`).

The thread page parses a message's detail only once its fold is opened, and the message list keeps
each message's place by its sequence, so a refresh keeps an opened fold open. A message's copy
button (`src/views/thread/copy.ts`) writes its text, and its detail while that fold is open, to the
clipboard as Markdown, through `navigator.clipboard`, and says under the message when the browser
refuses. The composer checks its boxes against the API's bounds of a message's text and detail,
counted with the API's `codePointLength` as the server counts them, and never cuts what is typed
into them. Its Send row, which holds what answers Send, sticks to the foot of the screen within the
composer, and the page's viewport asks a phone to shrink the layout for its keyboard
(`interactive-widget=resizes-content`), so the keyboard does not hide Send. The composer measures
the row as it changes and the page's scroll padding keeps that much clear, so the caret and a
control focused from the keyboard scroll into view above the row.

The composer's After sending is where a message the server accepts takes the operator, a choice the
browser keeps (`useDeviceOption` in `src/device.ts`); without one kept, the choice an earlier
release kept, going back or staying, stands in its place, as it does for a value After sending does
not know. A message that lands while the page is still open goes by the choice as it stands then
(the composer's `onward`): back to the list, which says what was sent; to the thread above or below,
as their buttons go; or Archive all's own path, run without the page's check for asks open to the
operator, since the message may have answered them, so the server's refusal, naming the ask, shows
instead and the page stays. What was sent goes with the operator: the thread opened says it beside
Send (`leaveNotice` for the thread, in `src/notice.ts`), and a list gone back to says it, before
saying it reached its end when it did. When a send's way on fails, its composer says so beside Send,
after what was sent, in the head's own words, which a phone's keyboard can hide. An archive after
sending goes through the message sent at least, which a stale send's retry can place past the latest
the page has loaded. One rule holds for leaving the page: while a way on is under way, or a message
that will take the page somewhere is on its way, no other way on starts, the buttons', Archive all's
or a send's; a send's own way on, once it lands, waits only for the others. Each way on checks and
marks it as it stands when it starts (`start`), not as the render that set it up saw it, and the
buttons are disabled meanwhile, as Archive all is.

The composer keeps a thread's draft in the browser's local storage (`src/device.ts`, through
`src/views/thread/kept-draft.ts`), under the thread's agent, session and number, the origin
separating servers. The thread list marks a thread with a kept draft from the same storage.

- **What is kept:** the text and details, and the message the draft was started from, which the
  stale-write check counts from, so a restored draft still misses what landed while it was away.
  What the composer held besides, staged, attached or being recorded, is left behind, since a
  replacement's message may be replaced and an upload expire meanwhile; the draft says it left
  something behind, and the composer says so.
- **When:** as it changes, except the text and details a replacement loaded while they are as
  loaded, which would come back as a new message the operator never wrote. A write that lands keeps
  what is left, or forgets the draft, at once, since going back after sending unmounts the page in
  the same render.
- **Forgetting:** once there is nothing to keep, a page forgets the draft, and a write that lands
  keeps what is left, only while the stored record is still the one the page kept, or there is none,
  so a draft kept since, in another tab or by opening the thread again, stays; a page refused so
  keeps what is left only once it is typed on. A draft the browser refuses to keep forgets the one
  kept before, which would come back older.
- **Limits:** a draft kept more than 30 days ago, or after now, is none, opening its thread keeps it
  again, and a new draft forgets those that are none and the oldest past 50, which caps the storage
  drafts take.
- **Signing out**, from Settings or by removing the passkey this browser signed in with, forgets
  every draft, then writes a fresh random mark, which a page reads as it opens: a page whose mark
  has changed since keeps none again.

Settings is a list of sections, declared once in `src/views/settings/sections.ts`, each with a slug,
a title, the group it is listed under and its component: Passkeys and API keys under Access, Voice,
Storage and Keyboard under Features, and Sign out after the groups. The navigation and
`/settings/<slug>` are built from that list, so a new section is one entry and one component, and a
slug no section has is Not found. `/passkeys`, where passkeys had a page of their own, redirects to
`/settings/passkeys`, replacing the history entry. The layout is decided in CSS alone: below the
layout's `40rem` breakpoint `/settings` shows the navigation as a list and a section's page shows a
back link to it; above it the navigation is a column beside the open section, and `/settings` opens
the first section, which it mounts, and so loads, on every width, hidden below the breakpoint. Each
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

The Storage section (`src/views/settings/Storage.tsx`) says from the settings' `storage` how much
space attachments take, in how many files, and that every backup copies them; nothing there changes
it.

Writing a message is alike wherever the operator does it. Every box whose words become part of a
message takes dictation while voice is on, and every place that writes and sends a message, a
thread's composer and the new-thread sheet, offers Attach and attaches images pasted into its
message and Details boxes. An ask's own-words field takes dictation on its card; its answer goes
with the composer's message, which carries the files. Send waits, wherever it is, until the
message's files have uploaded and while a recording for it opens the microphone, records,
transcribes or awaits Retry, saying why on Send's `aria-describedby` (`sendWait` in
`src/attach/attach.ts`); a recording on an ask's card counts for the composer's Send, which sends
that answer, and the composer's Ctrl or Cmd+Enter waits as its Send does. A thread's title, search
boxes and names are not message text, and take neither.

A message's files come in two halves: attaching them, in `src/attach/`, which the composer and the
new-thread sheet share, and showing them, in `src/views/thread/files/`. Wherever the operator writes
a message, **Attach**, an icon beside Send, opens a hidden file input that takes several files, with
no `accept` and no `capture`. Where the primary pointer is coarse (`(pointer: coarse)`), a phone or
a tablet, whose browser would hand that input to the system's chooser, Attach is an options menu of
its own instead, of four items each opening its own hidden input: **Take a photo**
(`accept="image/*"`, `capture="environment"`), **Record a video** (`video/*`, likewise), **Photos
and videos** (`image/*,video/*`, several, which recent Android shows in its photo picker) and
**Other files** (`application/*,text/*`, several: a picker that could take images, video or audio is
one Android hands to its chooser of camera, video camera and files, which the menu stands in for). A
touchscreen laptop's primary pointer is its trackpad or mouse, so it keeps the one input, which
`(any-pointer: coarse)` would not. The page's sizes follow the primary pointer the same way: where
it is fine (`(pointer: fine)`), a mouse or a trackpad, the size tokens shrink, `--touch` from 44 to
32 pixels and the spacing scale by about a quarter, and a touch screen keeps the sizes for a
fingertip. The browser tests' Chromium has a mouse, so `resize` in `e2e/fixtures.ts` turns on touch
emulation below a phone's width, and the phone's checks see a phone's sizes. Focus stays on Attach
as the menu opens, as in every options menu, and Escape or a tap elsewhere closes it with focus back
on Attach; whatever an input gives is added alike. `useMedia` in `src/media.ts` follows a media
query, this one and the color scheme diagrams are drawn in; the component tests run on a
`matchMedia` that matches nothing, from `src/test-setup.ts`, unless a test stubs it. A paste into
the message or Details box whose clipboard holds only image files, PNG, JPEG, GIF or WebP, attaches
them, named `pasted-YYYYMMDD-HHMMSS` in local time with their type's extension, and inserts nothing;
a paste that carries `text/plain` stays text, since some programs put a picture of what was copied
beside its text. A name another file of the draft has gets `-2`, `-3` and so on before its
extension. A file whose name cannot be a file's (`fileName`), one over 100 MiB, or an eleventh, is
refused in the list, saying why, without uploading. The others upload one at a time, in the order
added, since a browser opens only a few connections to one host and the long poll and every read
share them. `uploadFile` in `src/api.ts` sends each with `XMLHttpRequest`, which reports upload
progress, as the `File` itself, so the browser states its length, declaring `File.type`, else
`typeOfName`; no progress for 60 seconds aborts it, longer than the server's own idle limit so the
server's answer comes first, and there is no total deadline. `request` announces each change that
lands, but an upload alone changes none of the navigation's counts, so it announces none. The list
shows each file's name, size and state, with a progress bar while it uploads, **Retry** for one that
failed, **Upload again** for one that expired, and **Remove**, which stops an upload under way while
bytes remain, lets one whose every byte has gone answer and then removes it from the server, and
removes a finished one from the server, so it stops counting against the operator's pending uploads
at once. It decides by the bytes the upload last reported and the answer as it arrives, not by what
the list shows, so only a Remove in the instant after the last bytes leave and before the browser
reports them, or a removal the connection loses, leaves the upload counting until it expires. Send
waits until every file has uploaded, saying what it waits on, and sends kept files as `{keep}`, then
uploads as `{upload, name}`; a refusal naming an upload marks that file expired. Editing a message,
or changing its answers, loads its files as kept, which **Remove** drops from the replacement. A
stale write keeps the files with the draft, except the kept files of a replacement its missed
messages drop. The new-thread sheet's files upload to the session before the thread exists, since an
upload belongs to a session and not to a thread, and go with the start; a refusal naming an upload
marks that file expired there too. While a start is on its way the sheet holds still: Cancel waits,
it refuses Escape's `cancel` and the keydown that would raise it, Attach and Dictate wait, and a
paste attaches nothing, so nothing added meanwhile is left behind.

A writer that goes without sending, the thread page left or the sheet closed, by Cancel, Escape, a
link, Back or its session leaving the list, removes its uploads from the server as it unmounts, in
`useDraftFiles`, so they stop counting against the operator's pending uploads: it stops the upload
under way as **Remove** does and removes each finished upload no send carries. A write or start
carries its files from when it is sent, and for good once it lands, since the server may yet attach
them, and **Remove** waits on a file a send on its way carries; a file carried by two sends stays
carried until both have settled, and a send that fails after its writer went removes its files then.
Each finished upload is recorded as its answer arrives, before the list shows it, and one stopped as
its answer arrives is removed, so an answer landing in the same tick as the writer goes is removed
too. Kept files are a sent message's, and a kept draft keeps no files, so leaving touches neither. A
tab closed or reloaded unmounts nothing, so its uploads expire, as does an upload whose removal
fails or the connection loses.

A message lists its files under its text, detail and references, each with its name, type and size,
and **Download**, an `<a download>`, while its bytes are present; a missing file is marked, with
nothing to open. Every element and link loads the file's own URL, with its reference, so the
server's headers always apply: no file becomes a `blob:` or `data:` URL, and none shows in a frame.
By the served type, `servedTypeOf`: an image of up to 2 MiB shows at once as a lazily loaded
`<img>`, and a larger one behind **Show image**; video and audio as their players with
`preload="none"`, so nothing loads until played; text behind **Show text**, which reads at most the
first 256 KiB with a `Range` request and decodes it as UTF-8 with replacement, saying when there is
more; a PDF as **Open**, a link that opens it in a new tab, since Chromium shows no PDF in a frame;
and anything else as **Download** alone. A Markdown link whose destination is `attachment:` and a
name, percent-encoded or in angle brackets, is live when the name, decoded and NFC-normalized, is
one of that message's own files, and opens it as its entry in the list does; any other is its text,
and an image written with one still never loads. The thread's head, while its live messages carry
any file, holds a fold, **Files** with their count and size, folded on every visit, which reads the
thread's file list a page at a time while it is open, each entry with who attached it, when its
message was written, and a link to that message. Sizes are written in binary units, KiB, MiB and
GiB.

Dictation (`src/voice/Dictation.tsx`) shows in the composer, the new-thread sheet and an ask's card,
and in Settings' Try it, while the settings the page read when it opened say voice is on and the
browser has a `MediaRecorder` for `audio/webm;codecs=opus`, `audio/mp4` or `audio/ogg;codecs=opus`,
tried in that order. It records at 32 kbit/s with a one-second timeslice, so it can count the data,
and stops at five minutes by the clock or 1.9 MiB of data, which keeps a recording within the API's
body cap; a page hidden while it records stops it and transcribes what it recorded, and one still
hidden when the microphone opens closes it unused, so the microphone never runs unwatched. A
recording under the API's 1,000 bytes is not sent, and reads as nothing heard. The upload declares
the type the recorder was asked for and waits up to two minutes. A recording counts from the moment
the microphone is asked for until it is done with, refused or failed: one opening, recording, or
awaiting a transcription or a retry, in the composer or on an ask's card, holds the composer's draft
open, so its stale-write check counts from when the recording started, and a microphone that opens
once its caller has held dictation back closes unused. While the microphone opens, Cancel stands in
for Dictate, since a browser may never answer while its permission prompt goes unanswered; Cancel
ends the attempt, and a microphone that opens after it closes unused. `useDictationInto` puts the
text in at the caret of the caller's box that last had focus, unless the draft was discarded
meanwhile: the thread page counts the drafts its composer ends, which the composer's and the cards'
dictation check a transcript against. Dictate waits while a message is on its way, in the composer
and on the cards as in the new-thread sheet, since the draft a recording would be for may be the one
sent. A failure keeps the recording for Retry until it is discarded. The page records one dictation
at a time: one starting stops any other under way, which then transcribes what it recorded as its
Stop would, so no two microphones run and nothing is heard twice. A dictation whose caller goes away
tells it none is left, as one that ends does. `useDictation` gives its caller the controls, what
went wrong and what it says otherwise apart. The composer puts all three in its Send row, a failure
before Send and anything else after it; the new-thread sheet puts the controls in its foot beside
Attach and the rest under its boxes; and an ask's card puts all three under its own-words field. The
composer's row and the sheet's foot stay short on a phone whatever their fonts: the microphone is
its icon alone, the recording's time and a failure drop the words the rest says, and After sending
moves below the row, and Discard draft hides, while dictation shows more than Dictate (`busy`),
keeping focus as it moves. Each control that replaces another moves focus to the next state's own
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
local stub of a transcription provider, and record through Chromium's fake microphone. The
attachment tests attach a file and paste an image, open Attach's menu in a touch context at a
phone's width and choose from it, show images, video, audio and text in place and open a PDF's tab,
download every file, and serve HTML and script bytes declared as each served type, which run nothing
in the page or opened on their own. The API keys tests start one as well, create a key in Settings,
and call the operator mount with its secret from outside the browser.

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
`AGENTION_CONNECT`, `AGENTION_HARNESS_PROFILE`, `AGENTION_TMUX_SOCKET`, `AGENTION_URL`,
`AGENTWORKS_AGENT`, `AGENTWORKS_SESSION` and `NODE_EXTRA_CA_CERTS`. The definition's
`toolTimeoutSeconds`, 600, becomes the Codex declaration's `tool_timeout_sec`, since Codex ends a
tool call after 60 seconds by default and a file's transfer can take longer; Claude Code's plugin
format has no such setting.

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
