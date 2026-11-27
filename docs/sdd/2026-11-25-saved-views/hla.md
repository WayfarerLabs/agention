# Saved views: High-Level Architecture

- Requirements: [FRD](frd.md); research: [prior art](prior-art-research.md); plan: [plan](plan.md)
- Status: The FRD is accepted with the operator's rulings, each open choice at its first option;
  this HLA follows them.

## Decisions at a glance

| Decision        | Choice                                                                                         | Why                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| What a view is  | A name and one whole `ThreadsView`: every filter, the order, the direction, and the grouping   | FRD R1; the value the list's address already encodes                        |
| Source of truth | The address; opening a view navigates to its list                                              | FRD R3; no second edit state to keep in step with the address               |
| Stored form     | The parsed view, every part, as a JSON object; read back strictly, failing loudly              | Persisted state is checked; a view keeps the list as it was saved           |
| Identity        | An id never reused; names unique ignoring the case of A to Z; listed by name                   | As session groups are; FRD R2, R5                                           |
| Where it lives  | One table, operator operations in the one list both mounts serve, `saved-views` scopes         | Operator-owned records follow the groups and tags pattern; review check A18 |
| Agents          | No agent route or tool                                                                         | FRD R8                                                                      |
| Current         | Computed in the web UI: the list on screen equals the view, multi-value parts compared as sets | FRD R4; nothing to store or track                                           |
| Reaching views  | **Saved views** in the list's head, opening a sheet; `g v`; Settings to manage them            | FRD R5, R6                                                                  |

## What a view holds

A saved view is a name and one value of `threadsView` (`packages/api/src/thread-lists.ts:275`): the
list's filters, `sort`, `reverse`, and `group`. That is the value the web UI's address encodes
(`listViewOf` and `listHref`, `apps/web/src/router.tsx:86-107`) and the query the list's operations
take, so opening a view navigates to the list its address would show (FRD R3). Nothing passing is
part of it: not `cursor` or `limit`, which `threadsQuery` adds, nor the selection, scroll, folds, or
the thread open (FRD R1). `overdue` is judged by the server at query time, so a view holding it is
judged when it opens.

## Data model

A new migration adds:

```sql
CREATE TABLE saved_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused, as session_groups
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  view TEXT NOT NULL CHECK (json_valid(view) AND json_type(view) = 'object'),
  created_at INTEGER NOT NULL
) STRICT;
```

It follows `session_groups` (`apps/server/src/database/migrations.ts:378`): ids that never repeat,
so a reference to a removed view never reaches a later one, and names unique under `NOCASE`, which
folds only the ASCII letters (FRD R2). A view is the operator's configuration, not a log, so it is
updated in place, as a group is. The store module is `apps/server/src/store/saved-views.ts`, since
`store/views.test.ts` already tests the database's SQL views.

### Writing and reading

Writing parses the request's view with `threadsView`, so a view the list would refuse is refused as
`invalid_input`, naming the part, and the parsed value is stored whole, every part included, even
one at its default. A view so keeps the list as it was saved, the defaults then in force included
(FRD R1): if a later release changes a default, a saved view keeps its own, while the address, which
leaves defaults out, follows the new one. That difference is deliberate: a view is a list the
operator chose, not a link.

Reading parses the stored text with `threadsView.strict()`. A stored view is persisted state, so it
is checked rather than trusted, and one that fails is a loud server error, never a guess, as the API
keys' scopes are read back (`apps/server/src/auth/api-keys.ts:48-51`). The column holds the one
shape of `threadsView` the server serves; a later operator API version maps its own shape to and
from it, as it would the list's query. A change to `threadsView` that would refuse a stored view
ships with a migration rewriting the stored views, which review check A19 gains as a line, so the
strict read never meets one.

JSON rather than the address's query string: the operator API carries the view as an object the
OpenAPI document describes by the `threadsView` schema, and a migration or a tag rename rewrites
JSON directly, where a query string needs URL decoding first.

## References that outlive renames

What each name a view can hold does at HEAD:

- **Session groups** are named by id (`sessionGroupsFilter`, `thread-lists.ts:184`), so a rename
  changes nothing, and a removed group's id is never reused. The list's chip names a removed one
  **Removed group**, keeping nothing (`apps/web/src/views/list/Chips.tsx:62-81`,
  `listing.ts:40-58`).
- **Tags** are named by name. Removing a tag leaves the name, which keeps nothing, and the chip says
  **Removed tag** (`Chips.tsx:83-98`). Renaming a tag would leave a view naming the old name, so
  `renameTag` (`apps/server/src/store/groups-and-tags.ts:244-263`) also rewrites every saved view's
  `tag` list in its transaction, as the cascades rename the tag on everything carrying it, and
  removes any duplicate the rename makes: a view holding `["gone", "billing"]`, where `gone` was
  removed, holds `["gone"]` once `billing` is renamed to `gone`, since the filter refuses a name
  twice. Removing a tag rewrites nothing, since dropping the name would show more threads. A new tag
  taking a removed tag's name matches the views still naming it, as it matches the address (FRD R9).
- **Agents and sessions** are never renamed or removed: no store function does either at HEAD.
- **Topics** are names on threads, not records; a topic no thread carries keeps nothing.
- **Pull requests and branches** are identities, matched by their keys.

The server refuses none of these: every filter by name is an `IN` over the values given
(`apps/server/src/store/thread-lists.ts:118-145`), so a name nothing has keeps no threads, without
an error. A view naming one narrows, never widens.

## The API

One resource name throughout, spelled as each layer spells several words: the route `/saved-views`,
as `/groups-and-tags` and `/api-keys` are; the table `saved_views`; the operations `*SavedView*`;
and the scopes `saved-views:read` and `saved-views:write`, the first scopes of two words, spelled as
the route is.

`packages/api` gains `saved-views.ts`, beside `groups-and-tags.ts`: an id; a name, one line,
trimmed, 1 to 100 characters, as a group's; `maxSavedViews`, 200, as `maxGroups`, a bound that keeps
answers bounded rather than a limit real use reaches (FRD R6); a view as read (`id`, `name`,
`view`); the list of them by name; and the inputs below. The operations join the operator operations
list (`apps/server/src/http/operator-operations.ts`), which both the operator mount and the web
mount serve:

| Operation          | Route                          | Scope               | Does                                    |
| ------------------ | ------------------------------ | ------------------- | --------------------------------------- |
| `listSavedViews`   | `GET /saved-views`             | `saved-views:read`  | Every view, by name                     |
| `createSavedView`  | `POST /saved-views`            | `saved-views:write` | A name and a view                       |
| `renameSavedView`  | `POST /saved-views/:id/name`   | `saved-views:write` | A new name                              |
| `replaceSavedView` | `POST /saved-views/:id/view`   | `saved-views:write` | The list on screen in place of its list |
| `removeSavedView`  | `POST /saved-views/:id/remove` | `saved-views:write` | Removes it                              |

A name another view has is refused as `conflict`, as a group's is. Writes are last-writer-wins, as
the groups' are.

**Scopes.** Views are a new resource, so they get scopes of their own
(`packages/api/src/scopes.ts`), the write including the read. Folding them into `threads:read` and
`threads:write` would change what those grant, which review check A18 rules out. A browser session
holds every scope, so the web UI needs nothing more; Settings' API key form and the operator guide's
scope table gain the two. One crossing is intended: `renameTag`, under `sessions:write`, rewrites
saved views so they keep their meaning, which A18's text records as an exception.

## The web UI

- **Saved views in the list's head.** A button, the first of the head's icon controls
  (`apps/web/src/views/list/ListHead.tsx:143-192`), with Material's `bookmark` symbol and the words
  **Saved views** where there is room. A button's face does not hold a choice, which is a pick
  list's signature (`apps/web/src/icon-controls.tsx:9-19`), so it carries no view's name; as
  Search's name says the search on (`ListHead.tsx:145-152`, `views/list-head.tsx:12-15`), its name
  and tooltip add the current view, such as "Saved views, Blocking me". It opens a dialog, as a
  button may: the **Saved views** sheet, a sheet from the bottom on a phone and a panel on a wide
  screen, as the filter sheet is.
- **The sheet** lists the views by name, each a link to its list, the current one checked as a
  picker marks its choice. Each other row offers **Replace with this list**, which asks first
  (`ConfirmButton`, `apps/web/src/components.tsx:318`). Beneath them, **Save as new view** takes a
  name, and **Manage saved views** opens Settings' section.
- **The key** `g v`, **Go to saved views**, opens the sheet from anywhere, going to the list first
  from a thread on a phone. `g` already starts the go-to keys and `g v` is free
  (`apps/web/src/keyboard.tsx:79-162`).
- **Settings** gains a **Saved views** section under **Features**
  (`apps/web/src/views/settings/sections.ts:39-52`), built from the parts **Groups and tags** uses
  (`views/settings/Organizer.tsx`): each view with a link opening it, **Rename**, and **Remove**,
  which asks first.
- **Current** is computed, never stored: a view is current while the list on screen, as `listViewOf`
  reads it, equals the view, comparing each part that takes several values as a set (FRD R4). Two
  views alike are both current.

**Home stays the default list** (FRD R7): the **Threads** tab and `g t` still open `/`.

## Security model additions

No new trust. Views are the operator's configuration, read and written only by the operator's
identities, and grant nothing. A view's name is text shown as text (review check A9). The two new
scopes join `SECURITY.md`'s API keys and the operator guide's table; a key holding
`saved-views:write` can change which lists the operator's views open, nothing more. A tag rename by
a key holding `sessions:write` rewrites the views naming it, as it renames the tag everywhere else.

## Testing

- Store: create, read, rename, replace, and remove; names refused when taken ignoring the case of A
  to Z; the bound; ids never reused; a stored view the schema refuses failing loudly; a tag rename
  rewriting views, a view holding `["gone", "billing"]` holding `["gone"]` once `billing` is renamed
  to `gone`.
- HTTP: every operation under its scope, refused without it (`operations.test.ts`), and the OpenAPI
  parity test.
- Web: the head's button and its name, the sheet, current with multi-value parts in another order,
  replace and save as new, `g v`, and Settings' section; browser tests at a phone's width and side
  by side.

## Decision record

- **Filters only** was the alternative to saving the whole list (FRD ruling 1). The research favors
  the whole presentation, and Jira's filters-only saves draw recurring complaints in its tracker.
- **Storing only the parts not at their default** was set aside: a view would follow a changed
  default, and the read would need the address's tolerant reader.
- **A tolerant read**, leaving an unreadable part at its default and naming it, was set aside for a
  strict read and the migration rule: it builds a reporting path for a state the rule rules out.
- **The address's text as the stored form** was set aside for JSON, under
  [Writing and reading](#writing-and-reading).
- **Browser storage** was set aside: the operator asked for views on the server.
- **A changed mark** with an update action, tracking the view a list was opened from in the history
  entry, was set aside: replacing a view from the sheet does the same with nothing to track.
- **A row of views in sight, a fold, and a manual order** were set aside for now (FRD ruling 4): the
  web UI has no sidebar (`apps/web/src/App.tsx:128-159`), and the head's button gives one way in at
  every width.
- **Counts** were set aside (FRD out of scope); they can come as a new response field.
- **A default view** was set aside (FRD R7), and **agents' access** (FRD R8): an agent lists its own
  session's threads with its own filters.
