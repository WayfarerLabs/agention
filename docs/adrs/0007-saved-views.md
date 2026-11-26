# 7. Saved views, kept whole on the server

Date: 2026-11-26

## Status

Accepted

## Context

The thread list narrows, orders and groups by everything the operator cares about, and its address
holds all of it, so a list can be linked and reopened. What it lacked was a place to keep the lists
the operator returns to, such as "Blocking me" or "Billing migration, by session": they got back to
one by following a filter link from the sessions view or by setting the filters again. The operator
asked for those lists to be kept, on the server.

Trackers, inboxes and workspaces that keep lists mostly save the whole presentation, the filters
with the order and the grouping, and store them on the service so they follow the person across
devices; those that keep only the query draw recurring complaints from people who expected more.

## Decision

- **A view is a name and one whole list.** It holds every filter, the order and its direction, and
  the grouping: the thread list's view schema, `threadsView`, the value the list's address encodes,
  without the page. Nothing passing is part of it, such as the threads loaded, a selection, the
  scroll or the folds.
- **Kept as it was saved.** Writing a view parses it with `threadsView` and stores the parsed value
  whole, as JSON, every part included, even one at its default, so a view keeps the defaults in
  force when it was saved, while the address, which leaves defaults out, follows a changed default.
  A view is a list the operator chose, not a link.
- **Read strictly, changed by migrations.** A stored view is persisted state, read back with
  `threadsView.strict()`, and one that fails is a loud server error, never a guess. A change to
  `threadsView` that would refuse a stored view ships with a migration rewriting the stored views,
  so the strict read never meets one.
- **The address stays the source of truth.** Opening a view navigates to its list's address, so
  Back, reloading and copying the link behave as for any list, and a filter that depends on the time
  is judged as the list shows. A view is current while the list on screen equals it, computed in the
  web UI, never stored; nothing but replacing a view's list, which asks first, changes it.
- **Names that outlive renames.** Groups are named by id, so a view keeps a renamed group, and one
  naming a removed group keeps no threads. Tags are named by name, so renaming a tag rewrites the
  views naming it in the same transaction, and removing one leaves the name, which keeps no threads
  rather than showing more.
- **An operator resource with scopes of its own.** Views are operator operations, on the web mount
  and the operator mount alike, under `saved-views:read` and `saved-views:write`, the write
  including the read. Folding them into the thread scopes would change what those grant. One
  crossing is intended: a tag's rename, under `sessions:write`, rewrites the views naming it, as it
  renames the tag everywhere else.
- **No agent access.** A view organizes the operator's attention, as groups and tags do, so no agent
  route or tool reads or writes one; an agent lists its own session's threads with its own filters.
- **No default view.** The Threads tab and its key still open the list with no filter on; no view
  takes its place.

## Alternatives considered

- **Filters only**, without the order and the grouping: the narrower save that draws complaints
  where it is used, and less than the address already holds.
- **Storing only the parts not at their default**, as the address does: a view would follow a
  changed default, and its read would need the address's tolerant reader.
- **A tolerant read**, leaving an unreadable part at its default and naming it: a reporting path for
  a state the migration rule rules out.
- **The address's text as the stored form**: the operator API carries a view as an object its
  documentation describes, and a migration or a tag's rename rewrites JSON directly, where a query
  string needs decoding first.
- **Browser storage**: the operator asked for views on the server, and a backup should hold them.
- **A changed mark**, tracking the view a list was opened from and offering to update it: replacing
  a view from the sheet does the same with nothing to track.
- **A row of views always in sight, a manual order, colors, icons and counts**: the web UI has no
  sidebar, and the list's head gives one way in at every width; views are listed by name, and counts
  can come later as a new response field.

## Consequences

- Every browser the operator signs in on sees the same views, and a backup holds them.
- A view naming a removed group or tag narrows the list to nothing, its chip saying what was
  removed. Tags being named by name, a tag created later with a removed tag's name matches the views
  still naming it, as it matches the address.
- `threadsView` gains a duty: a change to it that would refuse a stored view is not done until a
  migration rewrites the views, which review checks.
- Notifications, when they come, can build their rules on saved views.
