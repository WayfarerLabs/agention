# Agention v1: Sessions LLD

- Status: Built; the operator approved the view and the requirement edits
- Date: 2026-11-20
- Governs: plan Delivery 3
- Requirements: FRD R21's stranded for a stopped session, R22, R23, R26's view of the sessions and
  the threads the operator starts, R33's rule that agent routes only grow and its agent API version;
  rulings 48, 56, 64, 65, 67 and 68; the HLA as amended for the status tool.

Delivery 3 lets a session say what it is doing and whether it will see what the operator writes, and
gives the operator one view of every session, where they approve registrations, read each session's
updates and start a thread with it. Groups, tags and session updates in the thread list are
Delivery 4.

This document settles what the HLA and the [Working inbox LLD](working-inbox-lld.md) left open for
sessions and does not repeat them. Code, tests and public documentation written from it state
behavior in their own words, without requirement or ruling numbers.

## Decisions at a glance

- One tool, `session_update`, carries a session's state, outcome, title, goal, percent and a note,
  on one agent route; no other call changes them (ruling 65).
- A session's status has two dimensions (ruling 68). What it is doing, it reports: working, idle
  (nothing left to do but wait for something, such as the operator's answers, CI or a review, while
  it still checks Agention) or stopped. Whether it is waiting on the operator, the server derives
  from its open asks, which the session never reports, so the two can never disagree.
- Stopped means the session is not likely to see new messages until something starts it again. It is
  sticky: only a later update to working or idle clears it. A stopped session's threads holding
  messages it has not read are stranded, beside a quiet one's and one without a credential's.
- A session that has never reported has no state, and reads as not stopped. Bridges before this
  delivery never report, so their sessions keep Delivery 2's signals unchanged.
- The session log is append-only. Each entry stores the session's full status after it, so the
  current status is the latest entry, read through an index; nothing derived is stored on `sessions`
  (R21).
- The operator reads a session's log with a read cursor of their own, in a table of its own.
- The sessions view replaces the registrations page and keeps answering `/registrations`, the path
  released bridges tell the operator to open.
- The operator starts a thread on a session with a title and a first message. The session stays the
  thread's requester and the operator its audience; the operator's request carries no asks or topic
  at all, so requester-only actions stay out of their hands by construction.
- A gate runs every released bridge, as published, against the server at HEAD through every tool, so
  a change to an agent route that an older bridge cannot use fails before release.
- Bridge and server state the agent API version they speak on every request and answer, a missing
  one meaning 1. This release speaks 2. A bridge refuses a server older than itself, and the server
  a bridge outside its versions, so a mismatch fails loudly before any field is silently dropped
  (ruling 67).

## Database

Migration 2 adds two tables and changes nothing that exists. Like migration 1, it is STRICT, keeps
times in Unix milliseconds, and enforces its log as append-only with triggers. Once it runs, an
older server refuses the database as newer than it knows, so going back to 0.2 means restoring a
backup; the operator guide's upgrading section says so.

```sql
CREATE TABLE session_updates (
  session_id INTEGER NOT NULL REFERENCES sessions (id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  registration_id INTEGER NOT NULL REFERENCES registrations (id),
  -- The session's status after this entry.
  state TEXT NOT NULL CHECK (state IN ('working', 'idle', 'stopped')),
  outcome TEXT CHECK (outcome IN ('completed', 'withdrawn', 'stalled')),
  title TEXT,
  goal TEXT,
  percent INTEGER CHECK (percent BETWEEN 0 AND 100),
  -- This entry's own note, which no later entry carries.
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  CHECK ((state = 'stopped') = (outcome IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE session_marks (
  actor_id INTEGER NOT NULL REFERENCES actors (id),
  session_id INTEGER NOT NULL REFERENCES sessions (id),
  read_seq INTEGER NOT NULL DEFAULT 0 CHECK (read_seq >= 0),
  PRIMARY KEY (actor_id, session_id)
) STRICT, WITHOUT ROWID;
```

- `session_updates` takes the no-update and no-delete triggers of `messages`.
- The entry's `seq` counts within its session, from 1. It is not `sessions.last_pos`, which counts
  messages for `message_wait`.
- The current status is the entry with the highest `seq`, found through the primary key. The stopped
  term in stranded reads it the same way inside `threadsSeen`'s base, one index search per thread it
  reads, as `credential_active` is read there now.
- `session_marks` holds a read cursor as `thread_marks` does, created on first use; it is only
  raised, since session updates have no mark unread.
- Migration 2's hash joins the frozen list in `migrations.test.ts` with this delivery, labelled with
  the release that ships it.

A first entry with no state given takes `working`, since a session that reports is running.

## Store

### `session_update`

`updateSession(identity, session, input)` runs in one `BEGIN IMMEDIATE` transaction:

1. Authorize the session's actor with an approved credential, as every agent write does.
2. Merge the input into the current status:
   - `state` replaces the state. `stopped` needs an `outcome` in the same update, and `outcome` is
     accepted only beside `state: stopped`; working and idle clear the outcome.
   - `title`, `goal` and `percent` set their field. A goal different from the current one clears
     `percent` unless the same update gives one. Nothing clears a field: a new value replaces it.
   - `note` belongs to this entry only.
   - A field left out is unchanged.
3. If the merged status equals the current one and there is no note, append nothing. Otherwise
   append the entry; the web shows it on its next refresh.

The answer is the session's status after the call: state, outcome, title, goal and percent. An
update carries no request id: repeating one changes nothing, unless it carries a note, which is then
logged again. Session updates are exempt from the stale rule and the latest wins (R23). Each update
spends the key's own rate budget, as every authenticated agent call does.

### The log and its read marks

- `sessionLog(identity, session, before, limit)` pages the entries newest first, with the operator's
  `read_seq`; more follow while the last entry's `seq` is above 1. To say what the oldest entry
  shown changed, the web asks for one entry more than it shows. Only the operator reads it: the
  store refuses anyone else, as `listSessions` and `startThread` do, and the agent mount has no
  route to it.
- `readSessionLog(identity, session, through)` raises the operator's mark, refusing a `through`
  beyond the session's latest `seq`. A session's unread updates are its entries above the mark.
- An entry's changes are read against the entry before it. Consecutive entries that change only
  `percent`, with no note, collapse into one line where the web shows them, as from 20% to 60%; the
  log itself keeps every entry.

### Stranded

`threadsSeen` gains the session's current state, and stranded becomes:

```text
stranded = unread_by_other AND (quiet OR NOT credential_active OR state IS 'stopped')
```

The thread summary's `presence` gains `state` and `outcome`, both absent for a session that has
never reported, so the web can say why a thread is stranded. Only the audience sees `presence`, as
now. A group header's presence, which the list composes per agent from its sessions', carries
neither: headers say when they were last seen, not why a thread is stranded.

### Listing sessions

`listSessions(identity, cursor, limit)` answers agents by name, each with up to 500 sessions and
`truncated` beyond them, taking the place of `listAgents`. The store orders each agent's sessions as
the view shows them, since the cut at 500 depends on it. Each session carries:

- its name, when it was created, when it was last seen and whether it is quiet, by the same formula
  as `threadsSeen`;
- its approved registrations, with their ids and codes, which Revoke needs; a session may hold more
  than one;
- its current status, absent when it has never reported, with the latest entry's note;
- how many of its log's entries the operator has not read;
- its threads: how many the operator has not archived, and how many are stranded;
- its open asks across all its threads, and how many of them are blocking: what the view shows as
  waiting on the operator. The operator can never archive a thread holding an ask open to them, so
  the thread list shows every thread counted.

The thread counts come from one grouped statement over `threadsSeen` for the page's sessions, and
the ask counts from one over `open_asks` joined to the threads, not one per session. The view
refreshes every 10 seconds; measured as built, the page takes about 7 ms over 1,000 threads, 77 ms
over 10,000 and 217 ms over 20,000 threads holding 200,000 messages, in line with the thread list's
own refresh. Quiet is one formula shared with `threadsSeen`.

### Threads the operator starts

`startThread(identity, session, input)` takes `request_id`, `title`, `text`, and optional `detail`;
it has no parameter for asks, a topic or references, since the sheet that calls it offers none. It
authorizes the operator, finds the session, inserts the thread with the session's actor as requester
and the operator's as audience, appends the operator's first message as seq 1, raises the operator's
read mark to it, and wakes the session's `message_wait`. A retry with the same request id and
content answers as it did, and with other content is `request_id_conflict`, as `createThread` does.
The session's credential may be missing or the session stopped or quiet: the thread is created all
the same and is stranded from the start, which the web warns of before sending. `createThread` keeps
its rule that a session starts threads only in itself.

### Bounds

| Field     | Bound                                                |
| --------- | ---------------------------------------------------- |
| `title`   | One line, 1 to 200 characters, as a thread's title   |
| `goal`    | One line, 1 to 300 characters                        |
| `note`    | One line, 1 to 300 characters                        |
| `percent` | An integer, 0 to 100                                 |
| `text`    | As a message's text; required on the operator's post |

An update giving none of state, title, goal, percent or note is `invalid_input`, and so is one
giving `outcome` without `state: stopped`.

## HTTP API

Agent mount, under `/api/agent/s/:agent/:session`:

- `POST /status`: `session_update`'s input, answering the session's status. Authentication and the
  last-seen stamp come with the mount.

Web mount, under `/api/web`:

- `GET /sessions?cursor&limit`: the sessions view's page.
- `GET /s/:agent/:session/updates?before&limit`: a page of the session's log, newest first, with the
  operator's read mark.
- `POST /s/:agent/:session/updates/read`: `{ through }`, answering the read mark.
- `POST /s/:agent/:session/threads`: the operator's new thread, answering its number and first
  message's sequence, as `thread_create` does.

`/api/web/agents` and `listAgents` go: the approval form takes the agents and sessions to choose
from from the sessions view's page, which has loaded them already. The web mount is the web UI's
own, so removing a route there breaks no released client.

## Agent bridge

`session_update` is the ninth tool. Its description says what each state means for the operator:
working, that the agent is doing something now; idle, that it has nothing left to do but wait, while
it still checks Agention; stopped, that it no longer checks, until something starts it again, which
needs an outcome. It says the agent never reports waiting on the operator, since its open asks say
so, and names what else it waits on in the note. It says a goal is the one the agent was given,
never one it infers. The bridge's `instructions` and `register`'s answers stay as they are: the
skill, which every plugin carries with the bridge, says when to report.

The plugins pin the bridge at its release, so a plugin installed from `main` between releases can
carry a skill that names `session_update` before its pinned bridge has it; the operator guide
already recommends installing from a release tag for this reason.

## Plugin and skill

- **The model** gains the session's state: working while it does something; idle while nothing is
  left but waiting, for the operator's answers, CI or a review, and it still checks; or stopped,
  with an outcome, once it stops checking. Open asks already tell the operator what waits on them,
  so a session working on one thing while an ask on another is open stays working. The note names
  anything else it waits on.
- **Idle and back:** the agent reports `idle`, with a note, when it starts waiting with nothing else
  to do, and `working` when it picks work up again.
- **Register** says to report `working` once registered, with a title for the line of work and the
  goal if the operator gave one.
- **The loop's** last step reports `stopped`, with its outcome, before the agent stops: completed
  when the work is done, withdrawn when the operator called it off, stalled when it cannot go on. An
  agent that resumes, because the operator prompts it at its terminal or in Agention, reports
  `working` first.
- **Percent** is rough and updated at natural points, never on every step.
- **The operator's messages** rule covers a thread the operator starts: the agent reads it as their
  words at its terminal and replies in that thread.

## Web

### The sessions view

The **Sessions** tab replaces **Registrations**, at `/sessions`; `/registrations` shows the same
view. Top to bottom:

1. **Waiting for approval**: the pending registrations, as the registrations page shows them now.
2. **Agents**: one foldable header per agent, as the thread list's group headers fold, each with its
   session count and roll-up: open asks, unread updates and stranded threads. Under it, one folded
   row per session, so that many fit on a screen, ordered with working and idle first, then sessions
   without a state, then stopped ones, each by last seen. A folded row carries the key facts on two
   lines, wrapping to three on a phone:
   - the session's name and title, cut to fit, and its percent;
   - what it is doing, as a chip: **Working**, **Idle**, **Stopped · completed** (or withdrawn or
     stalled), or **No status** when it has never reported;
   - **Waiting on you** with its open asks and how many are blocking, when it has any, linking to
     its threads;
   - **Quiet**, with when it was last seen, unless the session is stopped, which already says it
     will not see messages; and **No credential** whenever it holds;
   - unread updates, as the closed envelope and a count;
   - its threads, as a link to the thread list filtered to the session, with the stranded count when
     any is;
   - its latest note, cut to fit;
   - an options menu: **New thread**, and **Revoke** for each approved credential.
3. **Credentials and past requests**, folded, as now.

Rows are folded by default. Unfolding one shows its goal with the percent as a thin bar, when it was
last seen, its credentials, and its log: the newest entries first, unread ones marked, consecutive
progress-only entries collapsed, and **Older** for the rest. Unfolding marks read through the
entries shown.

**New thread** opens a sheet with the session named at its head, a title, the message's text and
detail, and Send. When the session is stopped, quiet or without a credential, the sheet says it is
not likely to see the thread, and why: until it is started again, when stopped; soon, when it has
not been seen lately; until the operator approves a registration for it, without a credential. Send
opens the new thread.

**Approve** keeps its form, which now takes the agents and sessions to choose from from this view's
page.

The view refreshes every 10 seconds while visible, as every view does, and keeps the agent folds
this browser chose, as the thread list's groups do. Session rows start folded on every visit, and a
row's log loads, refreshes and is marked read only while the row is unfolded under an unfolded
agent, so nothing is read that the operator has not been shown.

### Stranded, explained

Wherever a thread shows as stranded, one reason follows the session, the first that holds: stopped
and its outcome; quiet and when it was last seen; or no active credential.

## Agent API version

`packages/api` exports `agentApi`: the version this release speaks, 2, and the oldest the server
still serves, 1. Every agent contract change, a new route or a new field on one, bumps the version
by one; the oldest moves only by the operator's decision.

- **The header.** Every request the bridge makes carries `Agention-Agent-API: <version>`, and every
  answer under `/api/agent/` carries the server's own, set before the host and body checks so that
  their refusals, errors and unknown routes carry it too; the refusal check is the agent mount's
  first middleware. A missing header means 1: every bridge and server released before this one sends
  none. A header that is not a positive integer is `invalid_input`.
- **The server refuses** a request whose version is above its own or below its oldest, before
  authentication or any work, with the error `unsupported_version` and status 400. The message is
  worded for the agent, as the bridge's own problems are, and names the versions the server serves,
  never its release, since anyone who reaches the server reads it before authenticating: a newer
  bridge is told to have the operator upgrade the server, or pin the plugin to the server's release;
  an older one, to have the operator update the plugin. Released bridges pass a server error to the
  agent as it is, so they relay it too. The error code joins the shared error types; an older bridge
  reads errors loosely, so a new code reaches it intact.
- **The bridge refuses** an answer in Agention's JSON whose version is below its own, before it uses
  the answer's body, with an operator problem: the server at the origin speaks an older version than
  this bridge, so the operator upgrades the server to this bridge's release or later, or pins the
  plugin to a release no newer than the server. The skill already has every session call `register`
  first, so a bridge meets an older server there. For a key the server knows, that call changes
  nothing; for a new key, the older server records a pending registration before the bridge refuses
  its answer, and since the agent never relays its code, it expires unapproved. A server newer than
  the bridge is fine. An answer that is not Agention's, such as a proxy's 5xx while the server
  behind it is stopped, keeps its own message, since its version says nothing.
- **The web mount** is not versioned: the server serves its own web UI, always in step.

Released bridges send no header, so they count as 1, which this server still serves; the
compatibility gate below proves they still work.

## Agent route compatibility

`scripts/check.sh` gains an **Agent compatibility** gate, which `--fast` skips since it needs the
network. For each `v*` tag reachable from HEAD and not on HEAD itself, it installs that release's
published bridge by its exact version into a scratch directory, a single bundle with no
dependencies, and checks its signatures and provenance with `npm audit signatures` there, as the
"Dependency integrity" gate does. The repository's seven-day hold-back is for others' packages: the
gate turns it off for that one install of its own release, which `CONTRIBUTING.md` "Dependencies"
records as the only exception. A tag whose version the registry does not have yet fails the gate,
naming it, as for a minute after a release; no tag at all, as in a clone without tags, fails it too.

The suite is the bridge tests' harness, `BridgeHarness`, started with the installed bundle in place
of the source. It drives the bundle over standard input and output against the server at HEAD:
register, approval, and every tool the bridge has, with the fields it sends, including asks,
withdrawals, replacements, filters and a wait. It fails on any refusal of valid input and on any
answer the old bridge cannot read. Three releases run today; trimming the oldest is a later decision
for the operator.

This tests what an older bridge actually sends, its parsed and defaulted input with query values as
strings, and the one answer it parses strictly, `register`'s, whose statuses and code format must
therefore never narrow.

## Permanent docs

- `docs/architecture.md`: the status tool, the session log, stranded's stopped term, the sessions
  view and its routes, the operator's threads, the agent API version and the compatibility gate.
- `docs/operator-guide.md`: the sessions view in place of approving on the registrations page, what
  each state means, stranded's reasons, starting a thread, that upgrading past this release is
  one-way without a backup, and, under upgrading, that the server goes first and what an agent
  relays when a bridge and the server do not match.
- `docs/live-testing.md`: the status tool, the sessions view, the operator's threads and the gate.
- `docs/review-checklist.md`: the session state any call may carry becomes the status tool's; the
  envelope's rule, applied whatever the call's outcome, goes; "the operator starts no threads"
  becomes threads they start without asks; and the gate joins its compatibility rule.
- `docs/adrs/0001-agention-v1-architecture.md`: stranded gains stopped, and the agent API version
  joins its transport decisions.
- `CONTRIBUTING.md`: the compatibility gate among the gates, its one exception to the hold-back
  under "Dependencies", and bumping the agent API version with every agent contract change.

## Testing

- Store: each merge rule, the no-op, a note-only entry and its repeat, stopped needing an outcome
  and an outcome needing stopped, a goal change clearing percent, the log's paging and marks,
  stranded for a stopped session and its clearing on resume, `listSessions`' counts and order, its
  open-ask counts across archived and answered threads, and `startThread`'s roles, first message,
  read mark, wake, replay and conflict.
- Migration: a database written by migration 1 alone, with sessions, threads and marks, opens under
  migration 2 with every row intact, and the new tables empty; migration 2's hash joins the frozen
  list when it ships.
- HTTP: the new routes' authorization tables on both mounts, and the operator's thread route
  refusing an agent.
- Bridge: the tool list, `session_update`'s schema and refusals, the version header it sends, its
  refusal of an answer with no header or an older version, and the compatibility gate.
- Server: the version header on every agent answer, errors and unknown routes included; a request
  with no header served as 1; refusal above the server's version and below its oldest, before
  authentication, with the oldest set higher for the test; and a malformed header.
- Web: the sessions view's sections, folds, folded rows and their chips, unfolding to the log and
  its read marking, the approval form fed from the view, the new-thread sheet and its warning,
  `/registrations` showing the view, and stranded's reasons.
- Live: an agent reporting through a session's life on the live server, and the view and a new
  thread checked on a phone.

## Open for the operator

Nothing: the operator confirmed the view, version 4 of its mockup, and approved the requirement
edits to R22, R23, R26, R33, the out-of-scope line and the glossary. Checking the view and a thread
they start on a real phone remains theirs, after release.
