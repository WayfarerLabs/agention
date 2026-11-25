# Pull request and branch links: High-Level Architecture

- Requirements: [FRD](frd.md); research: [prior art](prior-art-research.md); plan: [plan](plan.md)
- Status: The FRD is accepted with the operator's rulings; this HLA follows them.

## Decisions at a glance

| Decision             | Choice                                                                                                         | Why                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Shape on a message   | Two new optional parts, `pull_requests` and `branches`, beside `references`                                    | Exact identity to match on (FRD R2, R8, R9); a reference's label is free text by contract |
| Storage              | One append-only table, `message_links`, one row per entry per message, like `attachments`                      | Typed, checked keys and an indexed filter that every count query repeats while it is on   |
| Identity             | One text key per entry: `owner/name#135` or `owner/name:branch`, owner and name lower-cased, branch as written | FRD R2; one column serves dedupe, the rollup, the filters and the counts                  |
| Rollup               | Computed in queries over `live_messages`, never stored                                                         | Review check A8; replaced messages drop out by construction (FRD R5)                      |
| Display form and URL | From the latest live mention (the URL from the latest that gave one), by Agention's message order              | A later message can correct a casing or add a URL; order never rests on a writer's clock  |
| Agent contract       | New fields on `thread_create`, `message_send`, `thread_get`, `thread_list`; agent API version bumped           | Review check A12                                                                          |
| Operator contract    | New optional fields and filters on `/api/operator/v1/`                                                         | Additive under A19                                                                        |

## Identity and short forms

A repository is exactly `owner/name`: `owner` is 1 to 39 characters of letters, digits and hyphens;
`name` is 1 to 100 characters of letters, digits, `.`, `-` and `_`, as GitHub allows, and neither
`.` nor `..`. A pull request number is a positive integer. A branch name follows git's ref name
rules (`git check-ref-format --branch`: no space, control character, `~`, `^`, `:`, `?`, `*`, `[`,
backslash, `..`, `@{`, leading `-` or `/`, trailing `/` or `.`, no component starting with `.` or
ending `.lock`) and is at most 255 characters.

The short forms are `owner/name#135` and `owner/name:branch`. They parse unambiguously: the
repository holds no `#` or `:`, a branch holds no `:`, and the kind of filter says which form to
expect, so a `#` inside a branch name is harmless. `#` follows GitHub's own autolink form; GitLab's
`!` is not needed while only GitHub is supported (FRD R2).

The key is the short form with the owner and name lower-cased; a branch name is never folded. Two
entries with the same key are the same. Adding another forge later adds an optional `host` whose key
is prefixed only when it is not GitHub, so every existing key keeps its value.

## Data model additions

A new migration adds:

```sql
CREATE TABLE message_links (
  thread_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pull_request', 'branch')),
  position INTEGER NOT NULL CHECK (position >= 0),
  link_key TEXT NOT NULL,      -- the folded short form
  repo TEXT NOT NULL,          -- as written
  number INTEGER CHECK (number > 0),
  branch TEXT,                 -- as written
  url TEXT,
  CHECK ((kind = 'pull_request') = (number IS NOT NULL AND branch IS NULL)),
  PRIMARY KEY (thread_id, seq, kind, position),
  UNIQUE (thread_id, seq, link_key),
  FOREIGN KEY (thread_id, seq) REFERENCES messages (thread_id, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX message_links_key ON message_links (link_key);
```

It gets `no_update` and `no_delete` triggers, as `attachments` has: rows are written with their
message, in the same transaction, and never change (FRD R4). Text is stored as written, as every
text column is; only `link_key` is derived. A message naming the same entry twice is refused as
invalid input.

## The API

`packages/api` gains, beside `references.ts`, a `code-links.ts` holding:

- `pullRequestLink`: `repo`, `number`, optional `url` (`isLinkableUrl`).
- `branchLink`: `repo`, `branch`, optional `url`.
- The short forms, their parser and the key, used by the store, the filters and the web UI.
- `maxLinks`: each list's bound per message, 20, as references have.

`messageParts` gains `pull_requests` and `branches`, each optional and omitted rather than empty,
and `needsAPart` counts them. The message read schema returns them as written. `threadGetResult`
gains `pull_requests` and `branches`, the rollup, each bounded by `maxListed` with a `truncated`
flag. A thread summary, which list rows read, gains `links`: how many distinct pull requests and
branches the rollup holds, and the one entry itself when there is exactly one (FRD R7).
`threadStartInput` gains both lists, for the New Thread sheet (FRD R10).

Filters: `listFilters` gains `pull_request` and `branch`, each a list of short forms bounded by
`maxNarrowed`, like `topic`; `threadCounts` gains their counts; `sessionThreadsQuery` gains one
short form for each, as its `topic` takes one.

## The store

- **Write.** `appendMessage` inserts the rows after the message. The request digest covers them
  through `parts`, so a retried write replays and a changed one is refused, as for everything else.
- **Read.** The message read assembles each message's lists from the table, as the attachments read
  does (`apps/server/src/store/attachments.ts`, `readAttachments`).
- **Rollup.** One query over `message_links` joined to `live_messages`, grouped by `link_key`: the
  entry as its latest live mention wrote it, and the URL of the latest live mention that gave one.
  Ordered by latest mention, newest first, bounded by `maxListed` with `truncated`.
- **Filters.** A part per kind whose `keeps` is
  `th.id IN (SELECT k.thread_id FROM message_links k JOIN live_messages l USING (thread_id, seq) WHERE k.kind = ... AND k.link_key IN (SELECT value FROM json_each(:pull_request)))`,
  binding the keys as a JSON array as `topic` binds its values.
- **Counts.** Per key, the number of distinct threads, with that kind's filter off, as
  `countThreads` does for agent, session and topic. Unlike topics, keys accumulate without end, so
  the counts list only keys with at least one thread under the other filters, ordered by latest
  mention, newest first, then cut at `maxListed` with `truncated`. The oldest pull requests are the
  ones left out.

## The agent side

- **Tools.** `thread_create` and `message_send` take both lists; `thread_get` returns the rollup;
  `thread_list` takes `pull_request` and `branch`, one short form each.
- **Answer size.** The bridge's answer fitting (`apps/bridge/src/fit.ts`) learns the new fields: a
  message's lists join the text it may leave out, and the thread's rollup, a new top-level field, is
  the first thing it leaves out of an oversized answer, saying so, before it shrinks the page.
- **Compatibility.** Each new tool field joins the released-bridge compatibility suite, and the
  agent API version goes up by one.
- **The skill** (`apps/agent-plugin/skills/agention/SKILL.md`, generated into both plugins) gains:
  - name the pull requests and branches a message is about, with their URLs whenever you have them;
  - when a pull request moves significantly (opened, ready for review, reviewed, merged, closed),
    list your threads about it and bring each up to date: say what changed, withdraw the asks the
    move settled, and archive what is done.

## The web UI

- **A message:** `CodeLinks` beneath the text and references, before files. One entry shows inline:
  its short form, as a link when its URL is linkable. Two or more fold to a count line that unfolds
  to the list.
- **The thread head:** a fold beside Files, "Pull requests and branches (n)", hidden at zero,
  listing the rollup with links.
- **The filter sheet:** two multi-selects like Topic, fed by the counts, with chips and the address
  carrying the short forms.
- **A thread list row:** with one entry, its short form, compact like a chip; with more, a single
  "several" mark with the count in its accessible name (FRD R7).
- **Writing them (FRD R10):** the reply composer and the New Thread sheet gain a control beside
  Attach and dictation, with a git branch icon rather than a forge's logo. It opens a small form
  that takes a pasted URL (a GitHub pull request or branch URL fills in the entry) or a short form,
  lists what the message will carry with Remove beside each, and refuses what the API would refuse,
  saying why. A sent message shows them as any message does.

## Security model additions

None beyond inert content. Entries are data a writer declares, shown as text and links under
`isLinkableUrl` (review check A9), which gains them in its list beside references, as
`SECURITY.md`'s inert-content invariant does. No new route, scope or credential. A writer can name
any repository; the rollup says what was declared, not that it exists. Agention never calling a
forge joins ADR 0001's "Not doing".

## Testing

- Store: write and read; refusal of a duplicate entry in one message, of a bad repository or branch
  name and of a URL that is not linkable; the rollup over replacement (an entry only a replaced
  message names drops out; one its replacement names again stays); the latest form and URL; keys
  differing only in owner case meeting, and branch names differing only in case staying apart; the
  filters, and the counts per distinct thread, beside the existing ones.
- HTTP and OpenAPI parity for the new fields.
- The released-bridge compatibility suite for every new tool field, and the answer fitting for an
  oversized rollup.
- Web unit tests for the message line, its fold, the thread head fold and the filter sheet; browser
  tests for the display at a phone's width and the filters through the address.

## Decision record

- **Typed references were set aside** (FRD ruling 1): a reference's label is free text by contract,
  so a kind would make its schema conditional, its label redundant for these kinds, and its display
  collide with the new compact line.
- **A JSON column was set aside** for a table. Measured at 500,000 messages, a filter scanning a
  JSON column took about 25 ms against 0.1 ms indexed; counts cost about the same either way, since
  the `live_messages` join dominates. The filter repeats in every count query while it is on, and
  the table gives typed, checked keys, as `attachments` does.
- **Stored roll-ups were set aside** under A8: a query over `live_messages` is exact by
  construction.
- **A pull request state was set aside for now** (FRD ruling 4). The research names staleness shown
  as truth as the main risk of declared state, and the field could never be removed from the agent
  API once released, while adding it later is one optional field and one migration. Latest mention
  wins, by message order, when it comes; A6 rules out refusing a declared "open" after "merged".
- **A pull request's head branch was set aside**: nothing in the FRD needs a branch to fold under
  its pull request, and it can be added later as an optional field.
- **Fetching was set aside** (FRD R11): it needs forge credentials and network access the server
  does not have, and makes Agention a forge client.
- **Other forges were set aside** (FRD R2): none is in use, and their case rules are unverified.
- **Rows show one entry or a count** (FRD R7), so no thread-level aggregate state is needed.
