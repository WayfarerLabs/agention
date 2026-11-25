# Pull request and branch links: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md); research:
  [prior art](prior-art-research.md)
- The operator accepted the FRD on 2026-11-25; building starts with the LLD.
- Vehicle: three pull requests, each usable alone. The development contract lists no `sdd:` label,
  so the pull requests cite this directory by path.

## Design

- [x] Requirements, prior-art research, HLA and plan drafted, with the operator's direction quoted
      and four open choices asked in Agention (#139).
- [x] Requirements, HLA and plan reviewed (project review and complexity pass), findings disposed
      (#139).
- [x] The operator accepts the FRD; rulings recorded verbatim in it, and the HLA and plan updated
      for any choice answered otherwise (#139).
- [x] On acceptance, the development contract names this effort as active (#139).
- [x] [`links-lld.md`](links-lld.md): the short-form grammar and its bounds, the table and its
      triggers, the rollup and count queries, the response shapes, and the answer fitting's order
      (#148).

## P1: links on messages, the thread's rollup, agents' filters

- [x] `packages/api`: `code-links.ts` (both links, short forms, parser and key, `maxLinks`); the
      message parts, the message read, `threadGetResult`'s rollup, and `sessionThreadsQuery`'s
      `pull_request` and `branch` (#148).
- [x] Migration: `message_links`, its index and append-only triggers; its frozen hash (#148).
- [x] Store: write with the message, read with it, the rollup over `live_messages`, and the session
      list's two filters (#148).
- [x] Agent API version bumped; the bridge's `thread_create`, `message_send`, `thread_get` and
      `thread_list` carry the fields; answer fitting leaves the rollup out first; each field joins
      the released-bridge compatibility suite (#148).
- [x] The skill: name pull requests and branches with URLs, and bring a pull request's threads up to
      date when it moves; both plugins regenerated (#148).
- [x] Web: the message line and its fold, the thread head's fold (#148).
- [x] Docs: architecture (data model, rollup, agent API), the operator guide (what a message and a
      thread show), the API reference regenerated, `SECURITY.md` and review check A9's inert
      content, ADR 0001's "Not doing" (#148).
- Done when:
  - an agent names a pull request on one message and replaces it with a message naming another, and
    the thread's rollup shows only the second while the replaced message still shows the first;
  - `thread_list` by either finds the thread only as the rollup says;
  - a program sends a message with a branch through the operator API and reads it back;
  - the web UI shows one entry inline, folds two or more, and offers the thread's fold;
  - the released bridges pass.

## P2: the operator's filters and the thread list rows

- [x] `listFilters` and `threadCounts` gain `pull_request` and `branch`; the store's parts and
      counts (#153).
- [x] Thread summaries gain `links`; the store computes it with the rollup's rules (#153).
- [x] The agent mount's answers to an older bridge leave out a summary's `links` wherever agents
      read summaries (`thread_get`, `thread_list`, `message_wait`), with a released-bridge case
      (#153).
- [x] Web: the filter sheet's two multi-selects, their chips, the address; a row's one entry or
      count (#153).
- [x] Web: every shown entry, on a message, in the thread head's fold, and on a row, links to the
      list filtered by it as the HLA's "Where an entry leads" says; on a message and in the head's
      fold, its URL is a small link beside it (#153).
- [x] Docs: the operator guide's filters, architecture's filters and counts, the API reference
      (#153).
- Done when: the operator narrows the list to one pull request from the sheet, the chip shows it,
  and a copied link opens the same list; the operator API's thread list and counts take the same
  filters; a row with one pull request shows it, and one with two shows a count; a pull request on a
  message opens the list of every session's threads that name it, and its forge link beside it opens
  the pull request.

## P3: the operator writes them

- [ ] `threadStartInput` gains both lists, and a start carrying only links needs no text.
- [ ] Web: the git control beside Attach and dictation in the composer and the New Thread sheet, its
      form taking a URL or a short form, and its list with Remove; the list is kept in the draft,
      sent again on a retry and cleared on send, as the message's other parts are.
- [x] Web: editing an operator's message, and changing its answers, loads its references, pull
      requests and branches and sends them again, as an edit keeps its files with `keep` (#148).
- [ ] Docs: the operator guide's composer and New Thread sections, architecture's writers.
- Done when: the operator pastes a pull request URL into the composer's form, sends, and the message
  and the thread's rollup show it; the New Thread sheet does the same for a new thread.

## Closeout

- [ ] Load-bearing content promoted to architecture, the operator guide, the security model and the
      skill; no permanent doc points into this directory.
- [ ] `locked.md` written.
