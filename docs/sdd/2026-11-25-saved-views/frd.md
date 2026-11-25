# Saved views: Functional Requirements

- Status: Draft, awaiting the operator's acceptance. Four choices are open with the operator, listed
  under [Open choices](#open-choices); these drafts assume the first option of each and say so where
  it matters.
- Date: 2026-11-25
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA and plan, and
  records operator rulings here verbatim.
- Origin: the operator's direction in Agention, quoted under
  [The operator's direction](#the-operators-direction).

## Why this exists

The thread list already narrows, orders, and groups by everything the operator cares about, and its
address holds all of that, so a list can be linked and reopened. What it lacks is a place to keep
the lists the operator returns to. Today they get back to one by going to the sessions view and
following a filter link from there (`apps/web/src/views/filter-links.tsx`), or by setting the
filters again. A saved view keeps a list under a name, on the server, one step from the list.

## Who this is for

- **The operator**, who keeps the lists they return to, such as "Blocking me", "Billing migration,
  by session", or "Overdue", and opens each in one step on any of their browsers.
- **Programs using the operator API.** Every operator surface but credentials and Settings is an
  operation of the operator API (review check A18; `docs/architecture.md` "HTTP API"), so saved
  views are too, under scopes of their own.

Agents are not among them: a saved view organizes the operator's attention, as session groups and
tags do, and agents never see it.

## The operator's direction

Verbatim:

> I find myself routinely going back to sessions to jump into different filters. It would be really
> nice to be able to save those and easily come back to them. At a minimum these should be complete
> filter configs. Perhaps we save more than that (grouping, order) but I'm not so sure. Please look
> into it and investigate prior art and best practices and lmk what you'd suggest. I think these
> should be server-side, too.

## Open choices

The first three are asked in Agention thread 34; the fourth arose in review. The drafts assume the
first option of each.

1. **What a view saves.** Filters, order, and grouping, everything the list's address holds
   (assumed); or filters only. Prior art leans to the whole presentation (Linear, GitHub Projects,
   Notion, Zendesk, and Todoist), and Jira's filters-only saves draw recurring complaints in its
   tracker ([prior art](prior-art-research.md)). Answered "filters only", R1 drops the order and
   grouping, and opening a view keeps the order and grouping on screen.
2. **Notification rules on views.** Later notification rules build on saved views (assumed); or
   rules stay separate; or decide later. Nothing here depends on the answer, which shapes only the
   notifications effort.
3. **This SDD first.** A short SDD before building (assumed, and this is it).
4. **A place always in sight.** One way in, a control at the top of the list that opens the views
   (assumed: two clicks to a view); or also a row of views beside the list on a wide screen, in an
   order the operator sets (one click). The research favors a persistent place; it costs the row,
   its fold past a handful of views, and a manual order.

## Functional requirements

**R1. A name and one list.** A saved view is a name and one thread list: every filter, the order and
its direction, and the grouping, everything the list's address holds (assumes open choice 1). It
keeps the list as it was saved, every part included, even one then at its default, so a later change
to a default does not change a view. Nothing passing is saved: not the page of threads loaded, a
selection, the scroll, which groups are folded, or the thread open.

**R2. Saved from the list.** With the list as they want it, the operator saves it as a new view and
names it. A view's name is one line, and no two views share a name, comparing the letters A to Z
without their case and every other character exactly.

**R3. Opening a view opens its list.** Opening a view shows its list exactly as the list's own
address would, so Back, reloading, and copying the link behave as they do for any list. A filter
that depends on the time, such as overdue, is judged when the list shows, not when the view was
saved.

**R4. The current view, and replacing one.** A view is current while the list on screen is its list,
the values chosen for a filter compared in any order. The operator can replace a view's list with
the list on screen, which asks first. Nothing else changes a view's list: changing the list after
opening a view leaves the view as it was.

**R5. Managing views.** The operator renames, replaces, and removes their views. Removing one asks
first, and leaves every list and thread as it was. Views are listed by name.

**R6. Within reach.** The views are one step from the top of the list, at every width, and a key
opens them from anywhere. There is no limit on how many views the operator keeps that real use would
reach.

**R7. Home stays the default list.** The **Threads** tab and its key still open the list with no
filter on. No view replaces it as the default.

**R8. On the server.** Views are stored by Agention's server, so every browser the operator signs in
on sees the same views, and a backup holds them. Programs reach them through the operator API, under
scopes of their own. Agents never see or change them.

**R9. What a view names keeps meaning the same.** A view naming a session group or a tag still names
it after the group or tag is renamed. A view naming a removed group or tag keeps that condition and
shows it as the list's address does: the condition keeps no threads, its chip says the group or tag
was removed, and the list never quietly shows more threads instead. One limit is shared with the
address: tags are named by name, so once a tag of the removed one's name exists again, created anew
or renamed to it, the view matches that tag.

## Out of scope

- Views shared with other people. Agention v1 has one operator.
- A view as the default list (R7), and per-view layouts or columns, which the list does not have.
- Colors, icons, and a manual order for views, which are listed by name.
- Counts on views. They can be added later as a new response field, without breaking the operator
  API.
- Notifications: their own effort decides whether and how a rule names a view.
- Agents reading or writing views (R8).

## Definition of done

- R1 to R9 hold on `main`, each shown by tests at the level that proves it: store and HTTP tests for
  storing, reading, the tag rename, and the scopes; web tests and browser tests for saving, opening,
  replacing, and managing, at a phone's width and side by side.
- The architecture document, the web UI page, the operator guide, the API reference, the security
  model, the review checklist, the live testing surfaces, and a decision record describe saved
  views, with no reference to this SDD.

## Operator rulings, 2026-11-25 onward

None yet. Answers to the open choices are recorded here verbatim when they come.
