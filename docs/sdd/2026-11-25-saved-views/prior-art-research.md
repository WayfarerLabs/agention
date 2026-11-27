# Prior-art research: saved views

Research date: 2026-11-25. Scope: how established trackers, inboxes, and workspaces save a filtered
list for later: what a saved view stores, where it lives, how the person reaches it, how unsaved
changes show, counts, the link to notifications, and what goes wrong. Each finding is tied to a
design implication (marked **Implication**) for Agention. Source IDs such as [S1] refer to the
sources table at the end, with grades: **A** official documentation read directly; **B** official
documentation read through search snippets, or a vendor's own bug tracker; **C** third party.

## Executive summary

- Saved views are stored by the service and follow the person across devices in every tool studied.
  **Implication:** store views on the server (FRD R8), as the operator asked.
- Most tools save the whole presentation, not only the filter: Linear [S1], GitHub Projects [S2],
  Notion [S6], Zendesk [S10], and Todoist [S5] keep order and grouping with the view. Jira keeps
  only the query, and its bug tracker shows people expecting more [S4]. **Implication:** a view
  holds everything the list's address holds (open choice 1).
- Views are reached from a persistent place (a sidebar, tabs, or a starred list) and by keyboard.
  **Implication:** one step from the list and a key from anywhere (FRD R6); a place always in sight
  is open choice 4.
- An unsaved change is marked, with explicit save, save-as, and discard [S2], [S4]. **Implication:**
  Agention keeps it simpler: a view changes only when the operator replaces its list (FRD R4).
- Inbox tools count what each view holds; counts are costly and go stale when cached [S8], [S10].
  **Implication:** no counts now; they can come later as a new field.
- Notifications on a view are opt-in and separate from saving it [S1], [S3], [S4]. **Implication:**
  no notifications here; that effort decides whether a rule names a view.

## 1. What a view stores

- **Linear** [S1] (A): a custom view stores filters; display options (grouping, ordering, layout,
  and shown properties) are set per view [S1b]. Views are personal by default.
- **GitHub Projects** [S2] (A): a view tab stores layout, filter, sort, group, slice, shown fields,
  and sums.
- **GitHub Issues dashboard** [S3] (A, changelog 2025-05-15): a personal saved view is a title, a
  description, an icon, and one query.
- **Jira** [S4] (A, with B for the bug tracker): a filter is a saved JQL query; in Jira Cloud the
  columns are not saved with it, and a change to the columns alone does not enable Save
  (JRACLOUD-70177, JRACLOUD-93879, and JRASERVER-30714).
- **Todoist** [S5] (A): a filter is a name, a color, a query, a description, and a favorite flag,
  with grouping and sorting kept on it and a **Reset all** to clear them.
- **Notion** [S6] (A): a view stores its layout, what is visible, filters, sorts, and groups.
- **Zendesk** [S10] (A): a view holds conditions, up to 15 columns, a group by, and an order by.
- **Implication:** the whole list, filters with order, direction, and grouping, which in Agention is
  exactly one `ThreadsView`. Nothing passing (page, selection, or scroll) is in any of these.

## 2. Where views live and who sees them

- **Linear** [S1] (A): personal by default; **Set as default** shares display options with a team.
- **Notion** [S6] (A): changes are personal unless saved for everyone.
- **GitHub Projects** [S2] (A): unsaved edits are private to the person making them.
- **Front** [S9] (A): views are private or shared; a view over a resource whose access was removed
  shows an error.
- **Implication:** one operator, so no sharing; views live in the store and reach every browser.
  Front's error on lost access is the pattern to avoid: Agention keeps the condition and narrows
  (FRD R9).

## 3. Reaching views

- **Linear** [S1] (A): **Save** appears once a filter is set (Alt+V); a starred view joins the
  sidebar; `O` then `V` searches views; the view's URL can be copied, and extra URL parameters are
  temporary overrides.
- **GitHub Issues dashboard** [S3] (A): views in a sidebar section, **Views**, up to 25, each
  editable, able to be duplicated, and removable.
- **Jira** [S4] (A): a starred filter joins the **Filters** menu.
- **Gmail** [S7] (A): labels are sidebar views with unread counts; searches have URLs; Multiple
  Inboxes show sections by query, on desktop only.
- **Notion** [S6] (A): views as tabs, folding the rest under "N more", each with its own link.
- **Superhuman** [S8] (B): a split is a saved search made through Cmd+K; Tab and Shift+Tab cycle
  splits; drag to reorder; its own guidance suggests five to seven splits.
- **Front** [S9] (A): up to 50 views in the sidebar, which can be hidden.
- **Zendesk** [S10] (A): 10 personal views listed, beside standard views.
- **Implication:** a key to open them (Linear's `O` then `V`) and a link per view, which the address
  already gives. Every tool keeps views in a persistent place, which Agention's web UI, with no
  sidebar, offers only as an added row (open choice 4); were it added, Notion's fold and
  Superhuman's guidance suggest folding past about seven. No tool's limit is one Agention needs to
  copy.

## 4. Unsaved changes

- **GitHub Projects** [S2] (A): a changed view shows a dot until **Save changes**; creating,
  renaming, and reordering save at once.
- **Jira** [S4] (A): an edited filter shows **Edited** with **Save**, **Save as**, and **Discard**;
  saving someone else's filter saves a copy.
- **Linear** [S1] (A): URL parameters beyond the view's are temporary.
- **Implication:** the address stays the one source of truth, as Linear's overrides suggest; a view
  shows as current while the list equals it, and replacing its list is an explicit action that asks
  first, with renaming applying at once.

## 5. Counts

- **Gmail** [S7] (A) counts unread per label. **Superhuman** [S8] (B) hides a split's count at zero
  or above 999, and can hide an empty split. **Front** [S9] (A) shows counters per view.
- **Zendesk** [S10] (A): counts refresh every minute, and stale counts are a recurring incident.
- **Implication:** out of scope now; if they come, count at read time, never cache, and hide at
  zero.

## 6. Notifications and time

- **Linear** [S1] (A): a person can subscribe to a view to be notified. **Jira** [S4] (A):
  subscriptions email a filter's results, capped at 200. **Gmail** [S7] (A): filters are rules that
  act on incoming mail, a different thing from a saved search.
- **Linear** [S1] (A): "Today" relative filters roll over daily. **Todoist** [S5] (A): filters are
  computed on open, and relative dates do not refresh while one stays open.
- **Implication:** notifications stay separate and opt-in, decided by their own effort. The overdue
  filter is judged when the list loads, and the list's refresh every 10 seconds already keeps it
  current while open.

## Pitfalls

- **References that break or widen** on rename or removal: Todoist filters naming a renamed project
  stop working [S5]; Front errors on removed access [S9]. **Implication:** groups by id, tags
  renamed in views with the tag, and removed ones kept and shown as removed (FRD R9).
- **Partial saves**: Jira's columns and column-only changes [S4]. **Implication:** save the whole
  list.
- **Unclear unsaved state** [S2], [S4]. **Implication:** no unsaved state at all: a view changes
  only when replaced.
- **Too many views**: Superhuman's own five-to-seven guidance [S8]. **Implication:** listed by name
  in a sheet, which scrolls.
- **Stale or costly counts** [S10]. **Implication:** none built now.
- **A link and a view disagreeing**: Linear treats extra URL parameters as temporary [S1].
  **Implication:** the address is the one source of truth, and opening a view only navigates to it.

## Refuted / do-not-rely-on

- "Gmail's Multiple Inboxes has five sections": stated only by third parties [C]; Google's own page
  [S7] was not found to say so. Not used.
- Superhuman's help center was read only through search snippets [S8], so its counts' bounds and its
  guidance on how many splits are graded B and used only as corroboration.
- GitHub's shared repository views were in public preview in June 2026 [S3]; nothing here relies on
  them.

## Open questions

1. Whether the operator wants views to save the order and grouping (open choice 1).
2. Whether a place always in sight is worth its row, fold, and manual order (open choice 4).
3. For the notifications effort: whether a rule names a view, and if so whether it follows the view
   as it changes or copies its filters when made.

## Sources

| ID  | Source                                                                         | Grade |
| --- | ------------------------------------------------------------------------------ | ----- |
| S1  | linear.app/docs/custom-views                                                   | A     |
| S1b | linear.app/docs/display-options                                                | A     |
| S2  | docs.github.com: Projects, managing your views                                 | A     |
| S3  | github.blog changelog 2025-05-15: issues dashboard saved views                 | A     |
| S4  | support.atlassian.com: manage filters; JRACLOUD-70177, -93879, JRASERVER-30714 | A, B  |
| S5  | todoist.com/help/articles/introduction-to-filters-V98wIH, 360017135159         | A     |
| S6  | notion.com/help/views-filters-and-sorts                                        | A     |
| S7  | support.google.com/mail/answer/6579 and 9694882                                | A     |
| S8  | help.superhuman.com: Custom Split Inboxes                                      | B     |
| S9  | help.front.com/t/g9h003t/views                                                 | A     |
| S10 | support.zendesk.com articles 4408888828570 and 11033239544602                  | A     |
