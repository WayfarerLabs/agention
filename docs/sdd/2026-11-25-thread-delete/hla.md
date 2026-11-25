# Deleting threads: High-Level Architecture

- Requirements: [FRD](frd.md); research: [prior art](prior-art-research.md); plan: [plan](plan.md)
- Status: Draft beside the FRD; it assumes the FRD's recommended answers to its open questions, and
  says where another answer changes it.

## Decisions at a glance

| Decision          | Choice                                                                                                        | Why                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Tombstone         | The `threads` row stays, with `deleted_at`, the session position of the delete, and an emptied title          | FRD R6, R10; numbers come from `MAX(number) + 1` (`apps/server/src/store/threads.ts:516-518`) |
| Append-only rules | Every delete guard on a thread-keyed table lets a row go only once its thread is tombstoned, which is one-way | Live threads keep A8 exactly; a permanent rule for every such table, present and future       |
| The delete        | One transaction per batch, all or none: the thread's rows and its attachments, not its files' bytes           | As bulk read and archive; affordable because file bytes leave the transaction                 |
| The purge         | The existing upload sweep gains a third candidate, attached files no attachment names                         | One removal path, one vacuum loop, crash recovery by the sweep's own start and timer          |
| Erasure           | `secure_delete`, FTS5 `secure-delete`, one full rewrite when first enabled, a truncating checkpoint           | Each closes a place the content survives (research, section 4)                                |
| Agent answer      | New error code `deleted`, HTTP 410, to every agent API version; `message_wait` reports deleted numbers        | FRD R9, R10, R12; agent API version 4 to 5 by the operator's rule                             |
| Operator contract | `POST /api/operator/v1/deletions`, 1 to 100 threads, scope `threads:delete`                                   | A18: a new scope, since `threads:write` may not change meaning; FRD R8                        |
| The promise       | A new ADR supersedes ADR 0001's "nothing is erased" for deleted threads; docs, skill and schemas follow       | FRD R13; ADR 0001 is edited in place only before v1                                           |

## What the codebase holds today

- A thread is a row of `threads` (`apps/server/src/database/migrations.ts:134-145`) whose
  `threads_fixed` trigger lets only `last_seq` change (`:161-168`). Removing the row of a session's
  highest number would give that number out again.
- Everything else keyed by a thread is append-only by trigger: `messages` (`:207-214`), `asks`,
  `answers`, `withdrawals` (`:272-295`), `attachments` (`:520-527`), `message_positions`
  (`:573-580`); `files` and `file_chunks` refuse removing an attached file or its bytes (`:479-482`,
  `:497-501`). `thread_marks` (`:323-329`) has no trigger.
- Two full-text indexes hold content: `thread_titles`, external content on `threads.title`
  (`:151-160`), and `message_texts`, contentless, storing only its thread and sequence (`:411-421`).
- A purge of files was foreseen (`docs/adrs/0004-attachments.md:105`;
  `apps/server/src/store/attachments.ts:16-20`), but the only removal is the sweep of uploads no
  message names (`apps/server/src/store/file-sweep.ts:25-50`), and the browser tests lift the
  trigger by dropping and recreating it (`apps/web/e2e/files.ts:171-191`).
- The database vacuums incrementally (`apps/server/src/database/vacuum-mode.ts`); nothing sets
  `secure_delete` (`apps/server/src/database/database.ts:53-57`).

## The tombstone

A new migration adds `threads.deleted_at` and `threads.deleted_pos`, both null while the thread
lives. Deleting sets them and empties the title; `threads_fixed` is replaced so that this is the one
other change it allows, once. The tombstone keeps the session and the number. What else stays is FRD
Q6: recommended, the parties stay as they are, `created_at` becomes the deletion time and `last_seq`
becomes 1; the columns are `NOT NULL`, so blanking further means rebuilding the table.

`deleted_pos` is the session position the delete takes: the delete advances `sessions.last_pos` by
one, as a message would, so the wait's cursor covers deletions (below). The LLD confirms nothing
assumes a session's message positions run without gaps.

## The delete

One transaction per request, all or none, as bulk read and archive are
(`apps/server/src/store/marks.ts:187-229`). For each thread, after authorization:

1. Its `message_texts` entries go by FTS5's `delete` command, which on a contentless table needs
   each entry's rowid, found by scanning for the thread's `thread_id`, and its original text and
   detail, read from `messages`; reading `text` back from the index gives null, and a delete with
   null values leaves the tokens in place. Its `thread_titles` entry goes the same way, with the
   title it still holds.
2. The tombstone is set, which empties the title and lets the guards below allow deletes.
3. `withdrawals`, `answers`, `asks`, `attachments`, `message_positions`, `messages` and
   `thread_marks` rows go.
4. The session is notified, so waits wake.

Files are not touched: once their attachments are gone, the sweep removes them. This keeps the
transaction small whatever the files weigh, which is what makes all-or-none affordable. Deleting an
already deleted thread succeeds and changes nothing, so a retried request is safe.

## Passing the append-only rules

A permanent rule, recorded in review check A8 and the new ADR: **every delete guard on a
thread-keyed table refuses unless the row's thread is tombstoned, and deleting a thread removes
those rows.** For example:

```sql
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
WHEN (SELECT deleted_at FROM threads WHERE id = old.thread_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'messages are append-only'); END;
```

and likewise for `asks`, `answers`, `withdrawals`, `attachments` and `message_positions`. Update
guards stay as they are. A new `BEFORE INSERT` guard on `messages` refuses a message in a tombstoned
thread, below the store; marks need none, since every mark write passes `requireThread`. The file
guards become "refuse unless no attachment names the file", with no join to threads: an attached
file loses its last attachment only when its thread is deleted, since a file is carried only within
its thread (`checkAttachments`).

A live thread is exactly as append-only as before, the only way to remove history is the
irreversible tombstone, and no code outside migrations runs DDL. The pull request and branch links
effort (#139) adds `message_links` with unconditional guards; whichever of the two lands second
adapts its table to the rule. A schema-driven test lists every table with a `thread_id` column and
holds that none keeps a row for a tombstoned thread. The frozen v1 migration's comment "Threads are
never deleted" (`migrations.ts:150`) cannot be edited; the new migration and `docs/architecture.md`
say what holds.

## The purge

`sweepFiles` (`file-sweep.ts:25-50`) gains a third kind of candidate beside expired and unfinished
uploads: `attached_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attachments WHERE file_id = f.id)`.
It removes them with `removePending`'s deletes, one file per transaction, then runs its vacuum loop,
still guarded by `db.incrementalVacuum`, then the checkpoint below. A delete runs one pass at once;
the pass at start and the timer finish one a crash interrupted. There is no separate purge.

A download under way stops at the delete: `readFileChunk`
(`apps/server/src/store/file-reads.ts:128-141`) checks, with each chunk, that an attachment still
names the file.

## Erasure

Freeing pages returns space; it does not erase. Erasure takes four measures:

- **`PRAGMA secure_delete = ON`** at open (`database.ts:53-57`), so SQLite zeroes the content a
  delete frees, on b-tree and freelist pages alike. The strongest reason: `agention backup` copies
  free pages too, so without it a backup taken after a delete can still hold the deleted content.
- **FTS5 `secure-delete`** on `thread_titles` and `message_texts`, set by the migration, so an index
  delete removes the entries rather than appending markers that leave the old tokens behind. It
  needs SQLite 3.42; the schema already uses `contentless_unindexed`, from 3.47, so every SQLite
  that opens the database has it.
- **One full rewrite when secure deletion is first enabled.** Content written before it was enabled
  can survive in unused space within live pages, such as an index's interior pages, which neither
  option reaches. The open runs one `VACUUM` with `secure_delete` on, as `vacuum-mode.ts` switches
  the vacuum mode, with the same fallback: a failure (a full disk, a busy database) is logged with
  the space it needs, the open carries on, and the next open retries. A durable marker records
  success. Until then, the server says so where the web UI's warning reads it and the operator guide
  explains it (FRD R2, R5).
- **A truncating checkpoint** after a delete and after each purge pass, so the log no longer holds
  earlier copies of the pages. It runs with a zero busy timeout, since a reader holding a snapshot,
  such as an online backup, would otherwise stall the server for its 5 seconds before failing
  silently. It checks the `busy` it returns, and a durable pending marker, set by the delete, keeps
  the sweep's timer retrying until one succeeds.

The research's measurement [M1] found the content gone only with all of these together, and the
review's found older content surviving without the rewrite. Limits the operator guide states: the
filesystem and the disk below SQLite may keep old blocks, and backups keep everything until
replaced.

## The agent's view

- **`deleted`**, HTTP 410, joins `statusByErrorCode` (`packages/api/src/errors.ts:6-39`), and the
  typed error set of review check A12. It is sent only after the caller is authorized for the
  session, so A3 holds: a caller without access still gets `not_found`. `findThread`
  (`threads.ts:79-91`) reads the tombstone and `requireThread` throws `deleted`, which covers every
  thread route on both mounts. Its message, worded for the agent, says the operator deleted the
  thread and everything in it, that its asks will never be answered, and what to do (FRD Q3).
- **References.** `checkReferences` (`threads.ts:278-289`) refuses a reference to a deleted thread
  as `invalid_input`. References already written elsewhere stay; the web UI's link leads to the
  deleted page.
- **Lists and waits.** Every list and wait reads threads through `threadsSeen`, which inner-joins
  the latest message (`apps/server/src/store/thread-reads.ts:126-129`), so a tombstone never
  appears; each operation's tests hold it. `message_wait` gains `deleted`, the numbers of the
  session's threads whose `deleted_pos` is past `since`, an additive field (FRD R10).
- **Compatibility.** The agent API version goes from 4 to 5 (`packages/api/src/agent-api.ts:12`):
  the operator ruled that every agent contract change bumps it, a new error code and a new field
  included, and `CONTRIBUTING.md` says so once #145 merges. Every version gets `deleted`: released
  bridges check only that an error has a string code and message
  (`apps/bridge/src/agent-api.ts:590-595`), so it reaches the agent as written. The compatibility
  suite gains a deleted thread every released bridge reads, writes to, waits on and lists.
- **Races.** Every store operation is a transaction on the one connection, so a `message_send`
  commits before the delete, and goes with the thread, or after, and gets `deleted`; the insert
  guard holds the same below the store. An upload meant for the thread stays pending and expires.
- **One accepted gap.** A `thread_create` whose answer was lost and that is retried after the thread
  was deleted starts a new thread, since the request id went with the messages.

## The operator API and the web mount

- **Scope.** `threads:delete` joins `packages/api/src/scopes.ts`, including `threads:read` and
  included by nothing. Review check A18 never lets an existing scope change what it grants, so
  deletion cannot join `threads:write`, and FRD R8 needs a writing key unable to delete. A browser
  session holds every scope; creating a key offers it with its own warning, as `sessions:approve`
  has.
- **Roles (A5).** Deletion is the audience's power: only the thread's audience may delete it, which
  is always the operator, so no agent credential can, whatever it holds. `threads:delete` is the
  gate for keys acting as the operator.
- **Operation.** `deleteThreads`, `POST /deletions` in `operatorOperations`, so the web mount serves
  it too. Body: `threads`, 1 to 100 of `{agent, session, thread}`, and the list's `as_of` when the
  threads came from "every matching thread". Answer: `deleted`, and `left_out`, the threads named
  that started after `as_of` (FRD R3). The `as_of` position is the global high-water mark the list
  answer carries, which the multi-select effort adds for its own matching actions; this effort
  reuses it.
- **Audit log.** The audit-log effort (#123) records one event per thread deleted, naming it
  `thread:<id>` and `<agent>/<session>/<number>`, never its title. It depends on that effort's
  events holding no message content at all, ask questions, reference labels and topics included,
  since an event outlives the thread it describes.

## The web UI

- **The shared `Confirmation`** (`apps/web/src/components.tsx:241-278`) changes once: Cancel is
  focused, for every irreversible action, and it gains a body slot for what the warning lists. No
  one-off dialog.
- **The warning (FRD R2, Q5).** "Delete 12 threads?", what is lost, that it cannot be recovered,
  that backups and copies agents fetched are not reached, the free-space note while the rewrite is
  pending; then Cancel and the red "Delete 12 threads".
- **One thread (FRD R4).** The thread head gains Delete beside Archive all, then returns to the
  list.
- **A deleted thread.** Opening one, by address or reference, shows "This thread was deleted" and
  nothing more. The deleting browser forgets its kept drafts of the deleted threads
  (`apps/web/src/device.ts:157-170`).
- **A stale list.** A bulk mark that meets `deleted` reloads the list rather than reporting a
  failure.
- **The selection toolbar (FRD R1).** Delete, last and in red, in batches of 100, with progress for
  every matching thread, bounded by the list's `as_of`, and the result naming any threads left out.

## Changing the promise

| Where                                                                                                | Today                                               |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `apps/agent-plugin/skills/agention/SKILL.md:111-112`, `:133-135`                                     | Files and messages kept for good, never deleted     |
| `packages/api/src/threads.ts:72-73` (`messageDetail`), regenerated into `docs/api/openapi.json`      | "Messages are never deleted"                        |
| `apps/bridge/src/file-tools.ts:122`                                                                  | "the message carries it for good"                   |
| `SECURITY.md:22`, `:193-194`                                                                         | "Nothing is edited or erased"; a file is "for good" |
| ADR 0001 (`:48`, `:66`, `:110-123`, `:473-474`); ADR 0004 (`:15`, `:105`)                            | History kept for good; the foreseen purge           |
| `docs/architecture.md` "Database" (`:136-140`, `:176`, `:186-191`)                                   | Append-only messages and files; the purge as future |
| `docs/review-checklist.md` A3, A8 (`:132-140`), A12, A13 (`:217`), A17 (`:265`)                      | No deletes on log rows; history retained; error set |
| `apps/server/src/store/attachments.ts:16-20`; `apps/web/e2e/files.ts:171-174`                        | "A future purge"                                    |
| `docs/operator-guide.md:499`, `docs/operator-api.md:81`, "Backing up" (`docs/operator-guide.md:806`) | Files for good; backups say nothing of deleted data |

The new ADR records the decision: history is append-only and attributed while a thread lives, and
the operator alone may delete a thread whole, leaving a tombstone. The skill keeps telling agents to
leave secrets out, now because copies outside the database survive a delete, and never to put a
thread's content in a status note (FRD Q7).

## Security model additions

- Deleting is the operator's, as the audience, by passkey session or a key granted `threads:delete`;
  no agent credential can.
- Unknown equals unauthorized still: `deleted` only follows authorization.
- History stays append-only for every live thread, enforced by triggers; a tombstone is irreversible
  and holds no content.
- Once the rewrite and the purge are done, the database file and its log keep no trace of a deleted
  thread's content; copies outside them are named in the guide.
- A deleted thread's number is never reused, so a reference or a link never reaches another thread.

## Testing

- Store: every row of the thread gone and the tombstone as specified; the guards refusing a delete
  on a live thread and a message in a tombstoned one; the number not reused; idempotence; all or
  none; `as_of`; search no longer matching the thread's words; each list, count, neighbor and wait
  leaving it out; the schema-driven test over every table with a `thread_id`.
- Forensics: data seeded before secure deletion is enabled, then the migration, the open's rewrite,
  a delete and the purge, then the database and log files searched for the text, title and file
  bytes; and the checkpoint retried while a reader holds a snapshot.
- HTTP: `deleted` and 410 on every thread route of both mounts, `not_found` for an unauthorized
  caller, a key without the scope refused, a download stopping at the delete, OpenAPI parity.
- Released bridges: reading, writing to, waiting on and listing a deleted thread.
- Web and browser: the menus, the warning and its focus, batches and progress, the deleted page, a
  stale list reloading.

## Decision record

- **Removing the thread row was set aside**: the number would be reused, and references and links
  would reach a different thread.
- **Dropping and recreating triggers around each delete was set aside**: DDL in the store, a schema
  change per delete, and a window in which the guard is gone for the whole table.
- **A purge of its own was set aside** for the sweep's third candidate: one removal path, and the
  sweep already recovers from a crash.
- **Skipping threads with newer messages was set aside** (FRD Q4): an agent writing steadily could
  keep a pasted secret from ever being deleted.
- **A trash or undo was set aside**: it would keep the secret that prompted the delete.
- **A `VACUUM` per delete was set aside**: one rewrite when secure deletion starts suffices, after
  which secure deletion keeps the file clean.
- **`not_found` for deleted threads was set aside**: GitHub's REST API answers 410 for a deleted
  issue to callers who may read it, and RFC 9110 prefers 410 when the removal is known to be
  permanent.
- **Keeping the title was set aside**: a title is written by the thread's starter and can hold what
  prompted the delete.
