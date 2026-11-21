# Agention v1: Completion LLD

- Status: Draft; the operator's answers on the mockup are in (rulings 74 to 77)
- Date: 2026-11-21
- Governs: plan Delivery 4
- Requirements: FRD R4's seam, R14's diagrams, R25's search of messages and its group and tag
  filters, R26's groups and tags, R28 and R34; rulings 30, 38, 39, 40, 41, 44, 64, 65 and 74 to 77;
  the HLA's groups, tags, backup and diagram frame.

Delivery 4 completes v1. The operator sorts sessions into groups and tags agents and sessions,
filters the thread list by both and groups it by group, and sees the Sessions view folded by group.
Threads stay on the thread list and session status on the Sessions view, which links to the threads
of each group, agent and session. Search reaches what messages say. A `mermaid` block draws as a
diagram without the diagram code ever running in the app. The operator backs up a running server
with one command.

This document settles what the HLA, the [Working inbox LLD](working-inbox-lld.md) and the
[Sessions LLD](sessions-lld.md) left open, and does not repeat them. Code, tests and public
documentation written from it state behavior in their own words, without requirement or ruling
numbers.

## Decisions at a glance

- Groups and tags are the operator's alone. They key on sessions and agents and appear on no agent
  route, so the agent API version stays 2.
- A group is a row of its own, since it can be empty and renamed, and a session sits in at most one,
  which a table keyed on the session enforces. A tag is only a name on an agent or a session, as a
  topic is a name on a thread: it exists while something carries it. A tag on an agent counts for
  each of its sessions.
- The group filter names groups by id, since a group can be renamed, with No group as a value of its
  own. The tag filter names tags, as the agent, session and topic filters name theirs.
- The list gains a grouping by group: group, session, topic, thread, each group placed by its first
  thread under the sort, No group included (ruling 44). The session grouping stays session, topic,
  thread. Focusing on groups is the Group filter (ruling 75).
- The Sessions view folds group, agent, session once some session is in a group, each group's head
  carrying its roll-up and a link to the thread list filtered to it.
- The operator's search matches thread titles and the text and detail of live messages, through a
  second full-text index. The agent's search stays on titles, so the two lists' search parts split.
- Session updates stay in the Sessions view (ruling 74). Its tab carries a badge counting sessions
  with unread updates, and each session row and agent header carries its threads' roll-up and a link
  to them.
- A `mermaid` block is drawn in one sandboxed frame per page, scripts only, served from a route of
  its own with a CSP of its own that sandboxes it too. The frame returns SVG, which the page shows
  as a `blob:` image. The app's own CSP gains only `frame-src` for that route and `img-src blob:`.
- `agention backup --data DIR FILE` copies the database in one step of SQLite's online backup,
  opening it without migrating it. Restoring is stop, replace the database and its WAL files, start.
- Nothing in this delivery depends on registrations, and the architecture document names the places
  an external issuer would change.

## Database

Migration 3 adds tables and an index and changes nothing that exists. Like the migrations before it,
it is STRICT and keeps times in Unix milliseconds. Once it runs, a 0.3 server refuses the database
as newer than it knows, which the operator guide's upgrading section says, as for 0.3.

```sql
-- AUTOINCREMENT, so a removed group's id never returns for another group.
CREATE TABLE session_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
) STRICT;

-- A session's group. Keyed on the session, so a session sits in at most one.
CREATE TABLE session_group_members (
  session_id INTEGER PRIMARY KEY REFERENCES sessions (id),
  group_id INTEGER NOT NULL REFERENCES session_groups (id) ON DELETE CASCADE
) STRICT;
CREATE INDEX session_group_members_groups ON session_group_members (group_id);

-- Tags are names on agents and sessions; a tag exists while something carries it.
CREATE TABLE agent_tags (
  agent_id INTEGER NOT NULL REFERENCES agents (id),
  name TEXT NOT NULL,
  PRIMARY KEY (agent_id, name)
) STRICT, WITHOUT ROWID;
CREATE INDEX agent_tags_names ON agent_tags (name);

CREATE TABLE session_tags (
  session_id INTEGER NOT NULL REFERENCES sessions (id),
  name TEXT NOT NULL,
  PRIMARY KEY (session_id, name)
) STRICT, WITHOUT ROWID;
CREATE INDEX session_tags_names ON session_tags (name);

-- The search index of what messages say, matched as the titles' index is. It
-- keeps no copy of the text, only each message's thread and sequence, since a
-- message has no integer key of its own for an external-content index to rest
-- on. Messages are append-only, so a message goes in as it is written; the
-- migration indexes those before it.
CREATE VIRTUAL TABLE message_texts USING fts5 (
  text, detail,
  thread_id UNINDEXED, seq UNINDEXED,
  content = '', contentless_unindexed = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_index_text AFTER INSERT ON messages WHEN new.text IS NOT NULL
BEGIN
  INSERT INTO message_texts (text, detail, thread_id, seq)
  VALUES (new.text, new.detail, new.thread_id, new.seq);
END;
INSERT INTO message_texts (text, detail, thread_id, seq)
  SELECT text, detail, thread_id, seq FROM messages WHERE text IS NOT NULL;
```

- **Bounds.** The store holds them, as it holds every other bound. A group's name is 1 to 100
  characters of plain text, trimmed, and unique ignoring the case of ASCII letters, which is what
  `NOCASE` compares. A tag's name matches a topic's pattern, so it is lowercase already. An agent or
  session carries at most 20 tags, and the instance holds at most 200 groups, each refused with
  `invalid_input` past its bound.
- **Removing.** Removing a group deletes its row, and the cascade takes its memberships in the same
  statement (`foreign_keys` is on). Removing a tag deletes its name from both tag tables, and
  renaming it rewrites both in one transaction. A group's rename changes its name only, so a filter
  by its id keeps working.
- **Agents and sessions are never deleted**, so memberships and tags never outlive them.

The test for a database an earlier release wrote gains a Delivery 3 database: migrations 1 and 2
with raw rows, opened at HEAD. Every earlier table is unchanged, the new tables other than the index
are empty, and a search finds a message written before the migration. The existing test's comparison
of every table changes to the tables that existed before. Migration 3's text is pinned once it
ships, as the others are.

## Groups and tags

### The web API

Every route is on the web mount, behind the operator's sign-in, and follows the passkey routes'
shape: reads are GET, and each write is a POST naming its action. None is on the agent mount, and a
test checks that each is unknown there.

| Route                                              | Does                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /groups-and-tags`                             | Every group and tag, with how many sessions and agents each holds        |
| `POST /groups`                                     | Creates a group                                                          |
| `POST /groups/:id/name`, `POST /groups/:id/remove` | Renames or removes a group; a removed group's sessions are in no group   |
| `POST /tags/:name/name`, `POST /tags/:name/remove` | Renames or removes a tag everywhere it is carried                        |
| `POST /s/:agent/:session/group`                    | Sets the session's group, by id or `null`                                |
| `POST /s/:agent/:session/tags`                     | Sets the session's tags                                                  |
| `POST /agents/:agent/tags`                         | Sets the agent's tags, the agent resolved as `/s/*` resolves its session |
| `GET /sessions/unread-updates`                     | How many sessions have updates the operator has not read, for the badge  |

A rename onto a name another group or tag already has is refused with `conflict`, a new error code
(409) that only the web mount sends; the bridge never reads error codes, so agents are unaffected.

### The thread list

- **Filters.** `session_group` takes group ids, and `none` for No group; `group` is already the
  list's grouping. `tag` takes tag names. A thread is kept when its session is in a chosen group, or
  when its session or its agent carries a chosen tag. Each is a part of the list's query beside
  `agent` and `session`, with a count on every value under the other filters, as R25 asks of every
  filter.
- **Grouping.** The `session_group` arrangement, named as its filter is, beside `session` and
  `agent`, folds group, session, topic, thread; the Group control lists it as **Group** between Flat
  and Session. Each group, No group included, is placed by its first thread under the sort, as every
  other level is, and its place joins the arrangement's cursor keys. The `session` arrangement is
  session, topic, thread, as before groups. A cursor names its arrangement, as now. Each group's
  head carries the roll-up the other heads do: unread threads, blocked on the operator, the highest
  open priority, and archived when all are, composed on the client from its sessions', as an agent's
  is. Like every level it shows only when it branches, so with no session in a group the group
  arrangement looks like the session one. A group's fold state is kept by its id.
- **What the operator sees of a group or tag** is its name as it is now. A filter on a group that
  was removed, or a tag no longer carried, keeps nothing, and its chip says so.

### The Sessions view

Each session row shows its group and tags as chips, and each agent's header its tags. A session's
options menu gains **Group** and **Tags**, and an agent's header menu **Tags**:

- **Group** lists the groups, No group, and **New group** with a name field.
- **Tags** is a multi-select with a search box, as the filters' Agent and Session are. Typing a name
  no tag has offers to add it.

A **Groups and tags** button at the top of the view opens a sheet listing each group and tag with
what it holds, with Rename and Remove. Remove asks first in the sheet itself, saying what it takes
the group or tag off.

- **Folded by group.** Once some session is in a group, the view folds group, agent, session, groups
  in name order and No group last. An agent whose sessions sit in two groups appears under both,
  each time with that group's sessions only. With no session in a group, the view is as before. The
  sessions page stays one entry per agent, as before; the client, which reads the whole view before
  showing it, folds the sessions by the group each carries. A group's fold state is kept by its id.
- **Roll-ups.** A session's summary gains how many of its threads have messages the operator has not
  read. Its row shows its threads' roll-up as the list's heads do (threads, the envelope with unread
  threads; blocked on the operator stays in its open-asks mark) and its unread updates as a mark of
  their own ("2 new updates"), so the envelope means unread threads everywhere. An agent's header
  and a group's head compose theirs on the client from the sessions they hold, and show none when
  the view was cut short. Blocked on the operator shows once: as the open-asks mark where a row or
  header has one, and as a Blocked flag on a group's head.
- **Links.** A session row's "N threads", an agent header's and a group head's open the thread list
  filtered to that session, agent or group (`session_group=none` for No group), with no other
  filter, as the thread page's path does. Under a group, an agent header's link also filters by the
  group, since its roll-up counts only that group's sessions. A row's and an agent header's stranded
  count link the same way, with the stranded filter added (ruling 80), and show no count where the
  threads link shows none.
- **Session rows** (ruling 81). Each row shows when its session was last seen on a line of its own
  between its head and its chips, in the thread list's words, warning while the session is quiet and
  not stopped; there is no quiet chip, and the unfolded row does not repeat it. Every chip in the
  view, a row's or a header's, has one look.
- **The badge.** The Sessions tab in the navigation shows how many sessions have updates the
  operator has not read, from one small read the navigation makes while visible, refreshed as views
  are. Reading a session's log there lowers it.
- **No filter.** The view has no group or tag filter in v1; its folds and links do that work.

## Search

The operator's search keeps a thread when its title matches, or when the text or detail of one of
its live messages does. Each word matches as the start of a word, case and accents ignored, as
titles do now, and every word must match within the one title or the one message. A replaced message
no longer matches: the index's rows join `live_messages` on the thread and sequence, so live keeps
its one definition. The list keeps its own order rather than ranking.

The agent's search stays on titles. The two lists share one search part today, and a list's parts
combine with AND, so the operator's list gets a search part of its own that keeps a thread whose
title or live message matches, while the agent's keeps the titles part. The agent mount's query
schema and its description are unchanged.

## Diagrams

### The frame

The server serves `/diagram-frame` as a small HTML page that loads one script, the frame's bundle.
The bundle is a classic script, built in its own pass from Mermaid with every dynamic import
inlined, since a sandboxed frame has an opaque origin, from which a module script, or a module that
Mermaid loads on demand, is a cross-origin load that fails. Its file name carries its content's
hash, and its response keeps a `Cache-Control` of its own, to be cached for good, where every other
response is `no-store`.

The frame route's responses carry their own policy, which the security headers middleware leaves in
place, rather than setting the app's over it; `nosniff`, HSTS and the referrer policy stay as for
every response:

```text
Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src <origin>/<the bundle's path>; style-src 'unsafe-inline';
  base-uri 'none'; form-action 'none'; frame-ancestors <origin>
X-Frame-Options: SAMEORIGIN
```

- **`sandbox allow-scripts`** in the policy itself keeps the frame sandboxed even when it is opened
  on its own, and its script does nothing unless it is framed. The page embeds it with
  `sandbox="allow-scripts"` too.
- **The script's full URL and the origin** rather than `'self'`, in `script-src` and
  `frame-ancestors`, so the policy does not depend on how a browser reads `'self'` in an opaque
  origin.
- **`style-src 'unsafe-inline'`** because Mermaid styles its SVG inline and measures text with those
  styles. It holds only inside the frame, which can reach neither the app nor the network.

In the sandbox the frame cannot read the app's cookies, storage or DOM, navigate the page, open
windows, submit forms or fetch. The app's own CSP gains `frame-src <origin>/diagram-frame` and
`img-src blob:`; nothing else in it changes.

### Drawing

- **One frame per page**, created on the first diagram. Diagrams are drawn one at a time, in the
  order they appear. Mermaid is never in the app's bundle.
- **The exchange.** The page posts `{ id, source, theme }` to the frame, and the frame answers
  `{ id, svg, title, description }` or `{ id, error }`. The page accepts answers only from the
  frame's window, and the frame only messages from its parent.
- **Showing it.** The frame turns Mermaid's output into SVG an image can show: well-formed XML, its
  width and height taken from its `viewBox`. The frame sits laid out but out of sight, so Mermaid
  can measure text. The page makes the SVG a `blob:` URL and shows it as an `<img>` at its natural
  size, capped at the column's width. An image runs no script and loads nothing. A `blob:` URL
  opened on its own by navigation takes none of the web UI's policy, so the page revokes each
  image's URL as soon as the image has loaded, and the viewer makes and revokes its own. Its
  alternative text is the diagram's `accTitle`, or "Diagram" without one, and its `accDescr`, when
  it has one, describes it. A **Source** toggle under it shows the source as a code block.
- **Failing safely.** A source over 10,000 characters, a Mermaid error, or no answer within 10
  seconds of posting it to a loaded frame, or a frame that does not load within 60 seconds, shows
  the source instead, with a note saying it is too long to draw or could not be drawn. A frame that
  did not answer is thrown away and the next diagram gets a new one. Mermaid runs at its strict
  security level, set explicitly, with its own limits at their defaults.
- **What the timeout cannot do.** Where the browser runs the frame on the page's own thread, a busy
  loop in Mermaid freezes the page and its timer with it; the size cap and Mermaid's own limits are
  the only defense there.
- **Theme.** A diagram is drawn in Mermaid's default or dark theme to match the app, and drawn again
  when the theme changes.
- **Versions.** Mermaid and `@panzoom/panzoom` are chosen at build time as the newest stable
  releases at least seven days old, pinned exactly.
- **ELK kept.** Mermaid 12 lays out most diagrams with ELK by default, and the frame keeps it
  (ruling 77). `elkjs` is EPL-2.0, file-level copyleft that leaves Agention's MIT license as it is.
  Its notice carries the copyright lines minification strips from its code and says where its source
  is available under the EPL (the Eclipse Layout Kernel's and elkjs's repositories at the shipped
  version), and the frame's script opens with a comment carrying the same. The build keeps such
  text, for any package whose own files don't give it, in one table, and fails for a package under
  the EPL without an entry, or for any shipped package whose notice would carry no license text.

### The viewer

A tap on a diagram opens it full screen in a dialog. `@panzoom/panzoom` zooms and pans the image by
pinch, drag, double-tap and the wheel, with buttons for zoom in, zoom out, fit and actual size, and
the keys `+`, `-`, `0` (fit) and `1` (actual size). `touch-action: none` applies only inside the
viewer, so pages keep the browser's own zoom. Escape or Close returns focus to the diagram.

### What stays inert

The Markdown renderer turns a fenced block whose language is `mermaid` into the diagram component,
and every other block into code as now. The rendered Markdown itself still holds no `iframe`, `svg`
or `img`: the frame belongs to the page, and the only image is the one the page makes from the
frame's answer. The Markdown tests stay as they are, and the diagram component's own tests cover
that image.

## Backup

`agention backup --data DIR FILE` writes a consistent copy of the database of the data directory
that `serve` uses, while the server runs or not:

- **It never changes what the database holds.** It opens it read-only, without migrating, and
  refuses a missing file or one that is not an Agention database. Opened read-only while no server
  runs, SQLite still leaves an empty `-wal` and a `-shm` beside it. A copy taken with a newer
  release before upgrading is a copy of the database as the older server left it.
- **The copy is a private file.** It holds what the database holds, the instance's key included, so
  the backup applies the private-file rule the data directory follows to the directory it writes
  into, and refuses one that breaks it.
- **It creates `FILE` itself**, readable by its owner only, in a directory that already exists, and
  refuses a file that exists, one with SQLite's `-journal`, `-wal` or `-shm` files beside it, or one
  that is the database's own `-journal`, `-wal` or `-shm` path, then copies into it with
  `node:sqlite`'s `backup()` in one step, its rate the largest integer, so a server writing
  meanwhile cannot restart the copy.
- **It checks the copy** by opening it read-only as immutable, which leaves no files beside it, and
  running `PRAGMA quick_check`, then prints the file, its size and its schema version.
- **A failure leaves no file behind** and exits non-zero.

The database is the whole of an instance's state: the instance's key, the passkeys' records, every
thread and the session logs. Restoring is stop the server, move `agention.db` and its `-wal` and
`-shm` files aside, put the copy in as `agention.db`, and start it. A `-wal` file left beside the
copy, as a server that was killed leaves one, would be replayed onto it. The operator guide's backup
section gives the commands for Linux and macOS, and keeps its advice to keep a copy off the machine,
encrypted.

## The issuer seam

Nothing in this delivery depends on registrations: groups and tags key on agents and sessions. The
architecture document gains a short section on what an external issuer would change, so the seam is
written down where it outlives this SDD:

- **The credential.** A new kind beside registrations and browser sessions in `Identity`'s
  credential union, whose checks branch on the kind.
- **The status call.** `session_update` accepts only a registration today.
- **The session log.** Each entry names the registration that wrote it.
- **The signals.** Whether a session holds a working credential, and its last-seen stamp, are keyed
  on registrations.

## Documentation

The plan's Delivery 4 items list the documents. Beyond them: the operator guide's backup section
replaces stop-and-copy with `agention backup`, and **SECURITY.md** gains the frame's isolation and
the CSP's two additions.

## Testing

- **Store:** groups' bounds, uniqueness and cascade; tags' bounds, rename and removal; the group and
  tag filters and their counts; the group level, its placement under each sort and its roll-up;
  search of live messages, not replaced ones; the agent's search unchanged; the unread threads on a
  session's summary; the count behind the badge.
- **Routes:** every new route's authorization, and each unknown on the agent mount.
- **Migration:** the Delivery 3 database opened at HEAD.
- **Web:** the menus, the sheet, the chips, the filters' values and counts, the Group grouping, the
  Sessions view's group folds, roll-ups and links, and the badge.
- **Browser** (Chromium, as every browser test here runs):
  - a diagram drawn through the frame, under the real CSP, with no page error;
  - a hostile source that tries to run script in the page, fetch, reach the parent or navigate the
    frame away achieving none of it;
  - the frame opened on its own doing nothing;
  - the fallback for a source that cannot be drawn, and a new frame after a timeout;
  - the viewer at 390 px;
  - the Sessions view folded by group, and a group's link landing on the filtered thread list, at
    desktop width and 390 px;
  - an open options menu of the last session of the last agent, grouped and not, clickable over the
    past requests' fold, collapsed and expanded, at desktop width and 390 px.
- **On a real phone:** diagrams and the viewer in iOS Safari, which no automated test here runs.
- **CLI:** `agention backup` against a server that is writing, leaving the source unmigrated,
  refusing a destination that breaks the private-file rule, and a restore from its copy with a stale
  `-wal` left by the database it replaces.
