# Pull request and branch links: LLD

- Status: Reviewed with P1; the lead keeps it current as P2 and P3 refine it.
- Date: 2026-11-25
- Requirements: [FRD](frd.md) R1 to R11 and its rulings; architecture: [HLA](hla.md); plan:
  [plan](plan.md)

This settles what the HLA leaves open for building. Code and permanent docs written from it state
behavior in their own words, without requirement numbers or pointers here. Tests read
`migrations.length` and `agentApi.version` rather than hard-coding either.

## Grammar and bounds

All in `packages/api/src/code-links.ts`, which the store, the bridge and the web UI share.

| Field             | Rule                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `owner`           | 1 to 39 of `A-Z a-z 0-9 -`                                                                                   |
| repository `name` | 1 to 100 of `A-Z a-z 0-9 . _ -`, neither `.` nor `..`                                                        |
| `repo`            | `owner/name`, exactly one `/`                                                                                |
| `number`          | an integer from 1 to `Number.MAX_SAFE_INTEGER`                                                               |
| `branch`          | 1 to 255 code points, single-line text (below), and git's branch name rules (below)                          |
| `url`             | optional; `isLinkableUrl`, as a reference's URL (at most 2,048 code points), never checked against the entry |
| `maxLinks`        | 20 pull requests and 20 branches a message, each list omitted rather than empty                              |

A branch name is `singleLineText({ min: 1, max: 255 })`, which already refuses control and invisible
format characters, and `git check-ref-format --branch` holds it besides: no space, `~`, `^`, `:`,
`?`, `*`, `[` or `\`; no `..` or `@{`; no leading `-` or `/`, trailing `/` or `.`, or `//`; no
component starting with `.` or ending in `.lock`; and not `@` or `HEAD`. Non-ASCII letters stay, as
git allows them.

Short forms, written and parsed:

```text
pull request   <owner>/<name>#<number>     number: [1-9][0-9]*, at most 16 digits
branch         <owner>/<name>:<branch>     split at the first ":", which no repository holds
```

The parser takes the kind it expects, so a `#` inside a branch name is part of the branch. A short
form that parses gives the entry with no URL; one that does not is refused with the reason of the
rule it breaks. Bounds as JSON Schema `maxLength`: 157 for a pull request, 396 for a branch.

The key (`linkKey`) is the short form with `owner` and `name` lower-cased (ASCII only, so
`toLowerCase` is exact); the number and the branch are never folded. Keys of the two kinds never
meet: a pull request's key holds no `:`, a branch's always does.

Within one message's list, two entries with the same key are refused as `invalid_input`, naming the
second (`pull_requests.3`), as `eachAskOnce` does for answers. The table's `UNIQUE` holds it too.

## Database: the next migration

```sql
-- The pull requests and branches each message names, in the order it gave
-- them, a list of each. link_key is the entry's identity, the short form with
-- the repository's owner and name lower-cased; repo, branch and url are as
-- written. Append-only, as messages are.
CREATE TABLE message_links (
  thread_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pull_request', 'branch')),
  position INTEGER NOT NULL CHECK (position >= 0),
  link_key TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER CHECK (number > 0),
  branch TEXT,
  url TEXT,
  CHECK (IIF(kind = 'pull_request', number IS NOT NULL AND branch IS NULL,
    number IS NULL AND branch IS NOT NULL)),
  PRIMARY KEY (thread_id, seq, kind, position),
  UNIQUE (thread_id, seq, link_key),
  FOREIGN KEY (thread_id, seq) REFERENCES messages (thread_id, seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX message_links_keys ON message_links (link_key);

CREATE TRIGGER message_links_no_update BEFORE UPDATE ON message_links
BEGIN
  SELECT RAISE(ABORT, 'message links are append-only');
END;
CREATE TRIGGER message_links_no_delete BEFORE DELETE ON message_links
BEGIN
  SELECT RAISE(ABORT, 'message links are append-only');
END;
```

The kind check is the HLA's, made two-sided so a branch row without a branch is refused too. The
index carries the primary key, so a filter reads `(link_key, thread_id, seq)` from it alone.

## Store

**Write.** `appendMessage` inserts each list in order, `position` from 0, after the message and
before its attachments, in the write's transaction. The request digest covers the lists through
`parts`, unchanged for a write that carries none, so earlier replays keep their digests.

**Read.** `readLinks(db, span)` reads the rows of a page's messages, `ORDER BY seq, kind, position`,
and the message gains `pull_requests` and `branches` as written, each omitted when the message has
none.

**Roll-up**, one statement per kind, `:kind` and `:limit` (`maxListed + 1`) bound:

```sql
WITH mentions AS (
  SELECT k.*,
    row_number() OVER (PARTITION BY k.link_key ORDER BY k.seq DESC) AS newest,
    first_value(k.url) OVER (
      PARTITION BY k.link_key ORDER BY k.url IS NULL, k.seq DESC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS latest_url
  FROM message_links k
  JOIN live_messages l ON l.thread_id = k.thread_id AND l.seq = k.seq
  WHERE k.thread_id = :thread AND k.kind = :kind
)
SELECT repo, number, branch, latest_url AS url FROM mentions
WHERE newest = 1
ORDER BY seq DESC, position
LIMIT :limit
```

A key appears once a message, so `seq DESC` picks one latest mention. The newest mentioned comes
first, and within one message the order it gave. The extra row says `truncated`; the oldest are the
ones left out.

**Session list filters.** The session's list keeps two parts, `pull_request` and `branch`, beside
its topic. The store's list filters are the operator's `ThreadFilters` plus these two, each a list
of short forms (one, from the session's query), which `parametersOf` binds as a JSON array of keys.
P2 moves them into `listFilters` without changing the parts:

```sql
th.id IN (
  SELECT k.thread_id FROM message_links k
  JOIN live_messages l ON l.thread_id = k.thread_id AND l.seq = k.seq
  WHERE k.kind = 'pull_request' AND k.link_key IN (SELECT value FROM json_each(:pull_request))
)
```

and the same with `'branch'` and `:branch`. They read the same live messages as the roll-up, so a
thread is kept exactly when its roll-up lists the entry.

**Counts** are P2's: per kind, `count(DISTINCT thread)` per key under every other filter, keys with
at least one thread, ordered by the latest live mention, cut at `maxListed` with `truncated`, as the
HLA says.

## Response shapes

```ts
pullRequestLink = { repo, number, url? }
branchLink      = { repo, branch, url? }

message        += { pull_requests?: pullRequestLink[]; branches?: branchLink[] }   // as written
threadGetResult += {
  pull_requests: { links: pullRequestLink[]; truncated: boolean };   // the roll-up, newest first
  branches:      { links: branchLink[];      truncated: boolean };   // at most maxListed each
}
sessionThreadsQuery += { pull_request?: shortForm; branch?: shortForm }
```

The roll-up is always present, empty when the thread names none, as `files` is. The operator and web
mounts read the same `threadGetResult`. A pull request's entry has no state (FRD ruling 4).

`needsAPart` counts both lists, so a message naming only a pull request is a message. The web UI's
"carries nothing" test, which decides that a replacement retracts, counts them too.

## Bridge: what answer fitting leaves out, in order

`answerThatFits` fits each answer it receives in this order, stopping as soon as it fits:

1. The answer as the server gave it.
2. Without the roll-up: the top-level `pull_requests` and `branches` each go when they list any
   entry, named in `omitted`. Only `thread_get` answers have them.
3. A smaller page, asked for as today; each new answer is tried whole, then without the roll-up.
4. At one element, still over: the largest text-bearing fields, as today, with a message's
   `pull_requests` and `branches` among them, each list whole. `omitted` keeps the roll-up's names
   from step 2 first.

So an agent reading a thread always gets the messages it asked for before the roll-up, and reads a
dropped roll-up again by asking for fewer messages, unless the roll-up alone is over the cap, when
the messages' own lists still name its entries and the web UI shows it whole.

## Web UI (P1)

- **A message:** `CodeLinks`, after references and before files. One entry: a line with the branch
  icon and the short form, a link when its URL passes `liveUrl`. More: a fold button, "2 pull
  requests, 1 branch", unfolding to the list, pull requests first.
- **The thread head:** after Files, a fold "Pull requests and branches (n)", hidden at zero, listing
  the roll-up as the message's list does, and saying when either list was cut.
- **Icon:** Material's `merge` symbol, two lines merging into one, since Material has no git-branch
  symbol; no forge's mark.

## Agent API

`agentApi.version` goes up by one. `thread_create` and `message_send` take both lists through the
shared message parts; `thread_get` returns the roll-up; `thread_list` takes `pull_request` and
`branch`, one short form each. The released-bridge suite exercises each field in a release whose
tools take it (`takes`), as it does for status fields.

An older bridge's answer fitting knows neither a message's lists nor the roll-up, so one message
naming 20 of each with long URLs, or a large roll-up, would reach it over its cap. The server leaves
them out of every answer to a request stating a version before `codeLinksAgentApiVersion`, beside
`agentApi`: `requireServedAgentApiVersion` puts the stated version on the context, and
`answerAsStatedVersion`, the agent mount's next middleware, drops `pull_requests` and `branches`
from a JSON answer's top level (the roll-up), its `messages` and a stale error's `missed`. The
general rule, in `CONTRIBUTING.md`: an answer to an older bridge leaves out the fields added after
its version. Every released bridge reads an operator's message naming 20 of each with
2,048-character URLs within its cap, and one whose tools do not take the lists reads it without
them. A message carrying only links reaches an older bridge with nothing in it, which is accepted:
its agent could not have used them.

## P2: the operator's filters, counts, and summaries

**Filters.** `listFilters` gains `pull_request` and `branch`, each
`queryList(array of short forms).min(1).max(maxNarrowed)`, after `tag` and before
`include_archived`, so the web UI's address keeps them in that place. A list refuses two short forms
of one key (`Acme/X#1` and `acme/x#1`) as naming an entry twice; branches differing only in case are
two entries. The store's separate `ListFilters` type is gone: `ThreadFilters` carries both, and a
session's list wraps its one short form in a list. `namedBy`, the roll-up, and the summary read the
same live mentions, `liveLinks` in `store/code-links.ts`. A known bound, left as it is: 50 short
forms at the longest branch name take about 20 KiB of a list's query, past Node's 16 KiB limit on a
request's head, which refuses the request whole; a real list of branches is far shorter.

**Counts.** `threadCounts` gains, each list at most `maxListed`:

```text
pull_request: { pull_requests: [{ repo, number, total }], truncated }
branch:       { branches:      [{ repo, branch, total }], truncated }
```

One statement per kind, with that kind's filter off and every other on:

```sql
SELECT k.repo, k.number, k.branch, k.position AS position, count(DISTINCT th.id) AS total,
  max(p.pos) AS latest
FROM seen th
JOIN message_links k JOIN live_messages l ON l.thread_id = k.thread_id AND l.seq = k.seq
JOIN message_positions p ON p.thread_id = k.thread_id AND p.seq = k.seq
WHERE k.thread_id = th.id AND k.kind = :kind AND <every other filter>
GROUP BY k.link_key ORDER BY latest DESC, position LIMIT :listed
```

"Latest mention" across threads is `message_positions` order, Agention's own. The statement has one
`max`, so SQLite takes the bare `repo`, `number`, `branch`, and `position` from that row: an entry
is listed as its latest mention among the threads kept wrote it, and the entries one message names
last come in its order, as the roll-up lists them. Only keys naming a kept thread appear.

**Summaries.** `threadSummary` gains `links`, always present:

```text
links: { pull_requests, branches, pull_request?: pullRequestLink, branch?: branchLink }
```

`pull_request` or `branch` is present exactly when `pull_requests + branches = 1`. A summary's
`links` ranks, filters, groups, and counts nothing, so `threadsSeen` does not compute it: a
post-pass, `summaryLinksFor(db, threadIds)`, reads it for the rows that become summaries, in one
statement over `liveLinks` for those threads. It takes each thread's distinct keys, each by its
latest live mention with the latest URL given, as the roll-up does, and groups them by thread,
counting each kind; while a thread has one key, the bare columns are that key's row. The one check
of "exactly one" is where the counts become `links`. Every place a row becomes a summary calls it: a
list's page, the neighbors of a thread, a thread read (`readThread`) and both waits (`summariesOf`).

Measured at 1,500 threads (median of seven), against P1 and the first draft, which computed `links`
in `threadsSeen` for every thread a list ranks:

| Read          | P1     | correlated in `threadsSeen` | post-pass |
| ------------- | ------ | --------------------------- | --------- |
| counts        | 38.5ms | 45.9ms                      | 44.8ms    |
| list, flat    | 7.1ms  | 14.3ms                      | 7.4ms     |
| list, grouped | 19.3ms | 30.9ms                      | 19.5ms    |

The counts' rise is their two new statements, one per kind.

**Agent API.** `agentApi.version` goes to 7, and `summaryLinksAgentApiVersion = 7` beside
`codeLinksAgentApiVersion`, since P1 ships first. `answerAsStatedVersion` keeps a list of
`{ version, leaveOut }` and applies each whose version is above the stated one;
`summaryLinksAgentApiVersion`'s drops `links` from a JSON answer's `thread` and from each of its
`threads`, which covers `thread_get`, `thread_list`, and `message_wait`. The bridge's answer fitting
counts a summary's `links.pull_request` and `links.branch` among a thread's text-bearing fields; the
counts stay. The released-bridge suite has every release read a summary naming one pull request
through all three, recording the version each release's requests state: `links` is exact at
`summaryLinksAgentApiVersion` or later, and absent before it.

**Web UI.** `src/views/code-links.tsx` holds what every place shares: `narrowingOf(link)`,
`countOf`, `CodeLinkEntry`, `RowCodeLink`, and `CodeLinksMark`. On a thread page, from a message and
the head's fold, `CodeLinkEntry` leads to `narrowedHref(origin, narrowing)`, the router's rule that
`threadPathParts` now uses too, the origin passed down in `MessageContext`, and keeps the forge link
beside it: an `ExternalLink` holding an external-link icon and a hidden name, followed by the host.
A row's one entry, `RowCodeLink`, leads through `FilterLink` with the list on screen and carries no
forge link, so rows stay compact; it is a paragraph after the row's thread link inside its `li`,
never inside the link. A row with a checkbox, while the list selects, is a grid, the checkbox in its
first column and the link and the entry in its second, so the entry stays beneath the link's
content. The row itself takes a touch selection's tap and hold, so either selects the row from
anywhere on it, the entry included, in place of following it. A row's `CodeLinksMark`, counting
several, links nothing and sits among the row's marks inside its link, so tapping it opens the
thread, whose head lists them. The filter sheet's two multi-selects take their options from the
counts, each by its short form; a chosen short form is shown and kept as the counted one of the same
key. Every multi-select offers a chosen value the counts leave out with a count of 0, named by its
`nameOf`. A chip shows the `branch` icon and the short form, or the number chosen, cut at its front
as a badged chip is. `listHref` leaves a branch's `:` unescaped, as it does a session's `/`.
