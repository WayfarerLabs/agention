# Settled threads: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md); research:
  [prior art](prior-art-research.md)
- The operator accepted the FRD on 2026-11-27, each open choice at its recommended answer; building
  starts with P1.
- Vehicle: one pull request for the feature, after this SDD's own. The development contract lists no
  `sdd:` label, so the pull requests cite this directory by path. The HLA carries the design without
  an LLD.

## Design

- [x] Requirements and prior-art research drafted, with the operator's direction quoted and the open
      choices asked in Agention (thread 39; #199).
- [x] Requirements reviewed in the private review loop (project review and complexity pass),
      findings disposed (#199).
- [x] The operator accepts the FRD; rulings recorded verbatim in it (#199).
- [x] HLA and plan drafted and reviewed, findings disposed (#199).
- [x] On acceptance, the development contract names this effort as active: its "SDD location"
      entry's list of active efforts gains "settled threads
      (`docs/sdd/2026-11-27-settled-threads/`), accepted 2026-11-27" (#199).

## P1: settled threads

Each box lands in the feature's pull request, with the docs that its change makes true.

- [ ] `packages/api`: `settles` in `messageFields`, `null` in `partNames`, and the text refinement
      covering it, renamed for detail and settling both; `settles` on a message as read;
      `settled_by` on `threadSummary`; the `settled` list filter, after `status`, and its counts;
      the next agent API version with its constant.
- [ ] Migration: `messages.settles`; its frozen hash.
- [ ] Store: `appendMessage` and `Parts` writing it; the open-asks refusal in `sendMessage`;
      `threadsSeen` deriving `settled_by` from the latest message its `base` already joins;
      `listParts`, `parametersOf`, and `countThreads` for the filter.
- [ ] HTTP: the `added[]` entry leaving `settles` and `settled_by` out below the new version; the
      API reference regenerated, which is the operator API's description.
- [ ] Audit: `settles` in `MessageEntry` and `messageResource`.
- [ ] Bridge: `message_send`, `thread_list`, and `thread_get` descriptions; the compatibility
      suite's settle case and its version-gated fields.
- [ ] Web: the composer's **Settle the thread**, needing text, showing the server's refusal at it,
      and kept by an edit; the events line; the head; the row's words with who settled it; the
      filter sheet's **Settled** segment and its chip.
- [ ] The word: `settledWords` and the `.thread-status` comment renamed; the other uses the HLA
      lists, test fixtures included, reworded.
- [ ] Agents' guidance: the usage skill's four points; the generated plugins regenerated.
- [ ] Docs: the new ADR amending ADR 0001's limit; `docs/architecture.md` ("Messages and asks",
      "Writing a message", "Derived state", "Filters", "Counts", "Versions of the APIs", "Audit
      log", "Tools", "The thread list", "The composer"); `docs/web-ui.md`; `docs/operator-guide.md`;
      `SECURITY.md`'s **Roles**; review check A5; `CONTRIBUTING.md` "The agent API";
      `docs/live-testing.md`'s web UI surfaces (the composer's settle, the filter's segment, the
      row's words, and the head); `README.md` unchanged, since it names none of the list's filters.
- [ ] Tests at the levels the HLA's "Testing" names; gates and CI pass.

Done when: an agent settles a thread it started, saying why, after withdrawing its open asks; the
operator sees the row mark and the head, filters the list to Settled threads, selects them, and
reads and archives them together; the operator's next message in a Settled thread ends it; a saved
view with `settled: hide` leaves them out; an older bridge works unchanged against the new server.

## Closeout

- [ ] Permanent docs describe Settled with no reference to this SDD; `locked.md` written; the
      development contract no longer lists this effort as active.
