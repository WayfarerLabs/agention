# Pull request and branch links: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md); research:
  [prior art](prior-art-research.md)
- Building starts once the operator accepts the FRD.
- Vehicle: two pull requests, each usable alone. The development contract lists no `sdd:` label, so
  the pull requests cite this directory by path.

## Design

- [x] Requirements, prior-art research, HLA and plan drafted, with the operator's direction quoted
      and four open choices asked in Agention (#139).
- [ ] Requirements, HLA and plan reviewed (project review and complexity pass), findings disposed.
- [ ] The operator accepts the FRD; rulings recorded verbatim in it, and the HLA and plan updated
      for any choice answered otherwise.
- [ ] On acceptance, the development contract names this effort as active.
- [ ] `links-lld.md`: the short-form grammar and its bounds, the table and its triggers, the rollup
      and count queries, the response shapes, and the answer fitting's order.

## P1: links on messages, the thread's rollup, agents' filters

- [ ] `packages/api`: `code-links.ts` (both links, short forms, parser and key, `maxLinks`); the
      message parts, the message read, `threadGetResult`'s rollup, and `sessionThreadsQuery`'s
      `pull_request` and `branch`.
- [ ] Migration: `message_links`, its index and append-only triggers; its frozen hash.
- [ ] Store: write with the message, read with it, the rollup over `live_messages`, and the session
      list's two filters.
- [ ] Agent API version bumped; the bridge's `thread_create`, `message_send`, `thread_get` and
      `thread_list` carry the fields; answer fitting leaves the rollup out first; each field joins
      the released-bridge compatibility suite.
- [ ] The skill: name pull requests and branches with URLs, and bring a pull request's threads up to
      date when it moves; both plugins regenerated.
- [ ] Web: the message line and its fold, the thread head's fold.
- [ ] Docs: architecture (data model, rollup, agent API), the operator guide (what a message and a
      thread show), the API reference regenerated, `SECURITY.md` and review check A9's inert
      content, ADR 0001's "Not doing".
- Done when:
  - an agent names a pull request on one message and replaces it with a message naming another, and
    the thread's rollup shows only the second while the replaced message still shows the first;
  - `thread_list` by either finds the thread only as the rollup says;
  - a program sends a message with a branch through the operator API and reads it back;
  - the web UI shows one entry inline, folds two or more, and offers the thread's fold;
  - the released bridges pass.

## P2: the operator's filters

- [ ] `listFilters` and `threadCounts` gain `pull_request` and `branch`; the store's parts and
      counts.
- [ ] Web: the filter sheet's two multi-selects, their chips, the address.
- [ ] Docs: the operator guide's filters, architecture's filters and counts, the API reference.
- Done when: the operator narrows the list to one pull request from the sheet, the chip shows it,
  and a copied link opens the same list; the operator API's thread list and counts take the same
  filters.

## Closeout

- [ ] Load-bearing content promoted to architecture, the operator guide, the security model and the
      skill; no permanent doc points into this directory.
- [ ] `locked.md` written.
