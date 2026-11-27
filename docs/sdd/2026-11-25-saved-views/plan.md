# Saved views: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md); research:
  [prior art](prior-art-research.md)
- The operator accepted the FRD on 2026-11-25, each open choice at its first option; building starts
  with P1.
- Vehicle: one pull request for the feature, after this SDD's own. The development contract lists no
  `sdd:` label, so the pull requests cite this directory by path. The HLA carries the design without
  an LLD.

## Design

- [x] Requirements, prior-art research, HLA, and plan drafted, with the operator's direction quoted
      and the open choices asked in Agention (thread 34; #170).
- [x] Requirements, HLA, and plan reviewed, findings disposed (#170).
- [x] The operator accepts the FRD; rulings recorded verbatim in it, and the HLA and plan updated
      for any choice answered otherwise (#170).
- [x] On acceptance, the development contract names this effort as active alongside pull request and
      branch links: its "SDD location" entry's "active effort: pull request and branch links
      (`docs/sdd/2026-11-25-pr-and-branch-links/`), accepted 2026-11-25" becomes "active efforts:
      pull request and branch links (`docs/sdd/2026-11-25-pr-and-branch-links/`), accepted
      2026-11-25, and saved views (`docs/sdd/2026-11-25-saved-views/`), accepted" with its date
      (#170).

## P1: saved views

- [x] `packages/api`: `saved-views.ts` (id, name, `maxSavedViews`, the view as read, the list, and
      the inputs); `saved-views:read` and `saved-views:write` in `scopes.ts`; the route params
      (#184).
- [x] Migration: `saved_views`; its frozen hash (#184).
- [x] Store: `saved-views.ts`, create, list by name, rename, replace, and remove, each confirming
      its scope in its transaction, reading strictly; `renameTag` rewriting the views naming the
      tag, without duplicates (#184).
- [x] HTTP: the five operations in the operator operations list; the API reference regenerated
      (#184).
- [x] Web: **Saved views** in the list's head, with the current view in its name; the sheet, with
      **Replace with this list**, **Save as new view**, and **Manage saved views**; `g v` in the
      shortcuts and their help; the `bookmark` icon (#184).
- [x] Web: Settings' **Saved views** section with rename and remove; the API key form's two new
      scopes (#184).
- [x] Docs (#184):
  - [x] architecture: the table, the store, the operations, the scopes, and the web UI (#184);
  - [x] the web UI page: using saved views, the Settings section, and `g v` in its keyboard
        shortcuts; the operator guide's API key scope table (#184);
  - [x] `SECURITY.md`: the two scopes in API keys, and saved views in the Isolation invariant, which
        no agent sees or changes (#184);
  - [x] the review checklist: A3's look-for names saved views, which no agent sees or changes; A18
        gains the scopes and records the intended crossing, `renameTag` under `sessions:write`
        rewriting saved views to keep their meaning; A19 gains the line that a change to the list's
        view schema ships with a migration of stored views (#184);
  - [x] `docs/live-testing.md` surfaces: on the web, the sheet, `g v`, and the Settings section; on
        the HTTP API, the operator mount's `saved-views` operations with a key of each scope, and
        their refusals to a key without them (#184);
  - [x] the README: no change, since it names none of the list's filters (#184);
  - [x] a new ADR in the format of ADR 0000, the contract's home for decision records, carrying the
        durable rationale: the whole list saved as it was, strict reads with migrations, scopes of
        their own, no agent access, and no default view (#184).
- Done when:
  - the operator sets filters, an order, and a grouping, saves them as a view, reloads in another
    browser, and opens the same list from the view, with the link and Back behaving as the
    address's;
  - the view shows as current, with its filters chosen in another order too; changing the list and
    then **Replace with this list**, confirmed, saves the change, and nothing else does;
  - `g v` opens the sheet from a thread, on a phone and side by side;
  - renaming a tag keeps a view naming it working, and removing a group or tag a view names shows
    the chip as removed with the list kept narrow;
  - a program with `saved-views:write` creates, renames, and removes views through the operator API,
    and one without it is refused.

## Closeout

- [ ] Load-bearing content confirmed promoted, with no permanent doc pointing into this directory.
- [ ] `locked.md` written.
