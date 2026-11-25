# Deleting threads: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md); research:
  [prior art](prior-art-research.md)
- Status: draft; building starts once the operator accepts the FRD.
- Vehicle: two pull requests, each usable alone. P1 makes deletion work end to end for one thread:
  the server, both APIs, the skill, and the web UI's thread head and deleted page. P2 adds Delete to
  the multi-select toolbar, after the multi-select effort merges with the list's `as_of` position.
  The development contract lists no `sdd:` label, so the pull requests cite this directory by path.

## Design

- [ ] Requirements, prior-art research, HLA and plan drafted, with the operator's direction quoted
      and the open choices asked in Agention.
- [ ] Requirements, HLA and plan reviewed (project review and complexity pass), findings disposed.
- [ ] The operator accepts the FRD; rulings recorded verbatim in it, and the HLA and plan updated
      for any choice answered otherwise.
- [ ] On acceptance, the development contract names this effort as active.
- [ ] `delete-lld.md`: the migration (columns, the replaced guards, the insert guard, FTS5
      `secure-delete`, the two durable markers); the delete transaction, including finding each
      contentless index entry's rowid by `thread_id` and deleting it with its original values; the
      sweep's third candidate; the open's rewrite and its fallback; the checkpoint with a zero busy
      timeout; that nothing assumes session positions run without gaps; the shapes and the `deleted`
      message's wording.

## P1: delete one thread, everywhere but the multi-select

- [ ] Migration: `deleted_at` and `deleted_pos`, `threads_fixed` allowing only the tombstone change,
      the tombstone-gated delete guards, the `messages` insert guard, the file guards on "no
      attachment names the file", FTS5 `secure-delete` on both indexes, the markers; its frozen
      hash.
- [ ] Database: `PRAGMA secure_delete = ON` at open; the one rewrite when first enabled, logged and
      retried as the vacuum-mode switch is.
- [ ] Store: delete threads in one transaction, all or none, idempotent, honoring `as_of`;
      `requireThread` throws `deleted`; `checkReferences` refuses a deleted thread; `readFileChunk`
      stops once no attachment names the file; `message_wait`'s `deleted`.
- [ ] Sweep: the third candidate, a pass right after a delete, and the truncating checkpoint with
      its pending marker.
- [ ] `packages/api`: `deleted` (410); `threads:delete`; the deletion input and answer; the wait's
      `deleted`; agent API version 5.
- [ ] HTTP: `deleteThreads`, `POST /deletions`, in the operator operations; the API reference
      regenerated.
- [ ] Bridge: tool descriptions say what `deleted` means; the released-bridge compatibility suite
      reads, writes to, waits on and lists a deleted thread.
- [ ] The skill: what a deleted thread means and what to do (FRD Q3), why secrets still stay out,
      and no thread content in status notes (FRD Q7); both plugins regenerated.
- [ ] Web: `Confirmation` focuses Cancel and takes a body; the thread head's Delete with the
      warning; the deleted page; forgetting the deleted thread's draft; a bulk mark meeting
      `deleted` reloads the list; creating a key offers `threads:delete`.
- [ ] Docs: the new ADR (numbered when written), stating the tombstone-gated rule for every
      thread-keyed table; ADR 0001 and ADR 0004 marked superseded where they promise permanence;
      review checks A3, A5, A8 (the same rule), A12, A13, A17 and A18; architecture ("Database",
      "Store", "HTTP API"), `SECURITY.md`, the operator guide ("API keys", "Attachments", "Using the
      web UI", "Using the operator API", "Backing up" with what a delete does not reach and the
      free-space note until the rewrite), and every other place the HLA's table lists.
- [ ] Tests as the HLA's "Testing" lists, but for the multi-select.
- Done when:
  - on a database holding content from before the change, the open's rewrite succeeds; then a
    program with a `threads:delete` key deletes a thread with a message, an ask and a 1 MiB file,
    and the database and its log, searched after the purge, hold none of the text, title or bytes;
  - the thread's number is not reused by the next thread in its session;
  - an agent's `thread_get`, `message_send`, `thread_read`, `thread_archive` and `file_get` on it
    answer `deleted`, its `message_wait` reports the number, its `thread_list` never shows it, and
    every released bridge passes;
  - a key with `threads:write` alone is refused, and an unauthorized caller gets `not_found`;
  - the operator deletes an open thread from its head after the warning, with Cancel focused, and a
    link to it then shows that it was deleted.

## P2: Delete in the multi-select toolbar

- [ ] Selection mode: Delete last in its options menu, in red, acting on the selection or every
      matching thread, in batches of 100 with the list's `as_of`, with progress and the threads left
      out.
- [ ] Docs: the operator guide's selection mode.
- [ ] Web unit tests and browser tests, at a phone's width too.
- Done when: the operator selects three threads, sees the warning naming three, cancels and nothing
  changes; confirms and the three leave the list; deleting every matching thread leaves out one
  started after the list was read, and says so.

## Closeout

- [ ] Load-bearing content promoted to the new ADR, architecture, the operator guide, the security
      model, the review checklist and the skill; no permanent doc points into this directory.
- [ ] `locked.md` written.
