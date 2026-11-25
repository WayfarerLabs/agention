import {
  type GroupsAndTags,
  type ThreadCounts,
  threadFilters,
  type ThreadGrouping,
  threadGrouping,
  type ThreadList as ThreadListAnswer,
  type ThreadSort,
  type ThreadsView,
  threadSort,
} from "@wayfarerlabs/agention-api";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { changeLanded, query, request } from "../api.ts";
import { Loadable, MoreButton, PageHeading, Status, usePageTitle } from "../components.tsx";
import { useFollowing, usePages } from "../data.ts";
import { Icon } from "../icons.tsx";
import { takeNotice } from "../notice.ts";
import { PaletteProvider } from "../organizing.tsx";
import {
  arrangementOf,
  currentListView,
  listHref,
  matchRoute,
  queryOf,
  showList,
  unfiltered,
  useListView,
  useLocation,
} from "../router.tsx";
import type { ListShown } from "./filter-links.tsx";
import { ListBeside } from "./list/beside.ts";
import { BulkActions } from "./list/BulkActions.tsx";
import { DirectionButton, HeadSelect } from "./list-head.tsx";
import { Chips, chipsOf } from "./list/Chips.tsx";
import { FilterSheet } from "./list/FilterSheet.tsx";
import { GroupedRows } from "./list/Groups.tsx";
import { distinct, type ListedThread } from "./list/listing.ts";
import { SearchBox, useSearchText } from "./list/search.tsx";
import { ListSelection, useSelection } from "./list/selection.tsx";
import { SelectHead, SelectionToolbar } from "./list/SelectionBar.tsx";
import { useListShortcuts } from "./list/shortcuts.ts";
import { ThreadRow } from "./list/ThreadRow.tsx";

// The thread list, built filters first: with no filter on it holds every
// thread the operator has not archived, and every way of narrowing it is a
// filter that combines with the others. The head holds a search box across
// its top, then the order the list is in beside the button that reverses it,
// how the list is grouped, and a Filters button, which opens a sheet holding
// every filter, the search among them, whose box there edits the same text;
// each filter that is on shows beneath as a chip that removes it. Grouped,
// each header's links add its group, and a mark's filter, to the filters on.
// All of it lives in the address. The head stays put while the list below it
// loads afresh, so its controls keep focus.

const sortLabel: Record<ThreadSort, string> = {
  priority: "Priority",
  due: "Due",
  effort: "Effort",
  latest: "Latest message",
  created: "Created",
};

// Each order's direction in words: its own, then reversed.
const directionLabel: Record<ThreadSort, [own: string, reversed: string]> = {
  priority: ["Most pressing first", "Least pressing first"],
  due: ["Soonest first", "Latest first"],
  effort: ["Quickest first", "Longest first"],
  latest: ["Newest first", "Oldest first"],
  created: ["Newest first", "Oldest first"],
};

const groupLabel: Record<ThreadGrouping, string> = {
  session_group: "Group",
  session: "Session",
  topic: "Topic",
  agent: "Agent",
};

export function ThreadList() {
  const view = useListView();
  const here = listHref(view);
  // The total shown is the list's on screen, so it clears while another
  // loads.
  const [loaded, setLoaded] = useState<{ list: string; total: number }>();
  const total = loaded?.list === here ? loaded.total : undefined;
  const onTotal = useCallback((count: number) => setLoaded({ list: here, total: count }), [here]);
  // The page has one title and one level-one heading: side by side, the
  // thread's while one is open beside the list, and the list's otherwise.
  const threadBeside = useContext(ListBeside)?.open !== undefined;
  usePageTitle(threadBeside ? undefined : "Threads");
  // Choosing a filter, an order or a grouping shows that list in place of
  // this one (showList), so going back leaves the list rather than stepping
  // through every choice. Choosing a search, as removing its chip does,
  // replaces any search still being typed.
  const search = useSearchText(view, (text) => showList({ ...currentListView(), search: text }));
  const choose = (change: Partial<ThreadsView>) => {
    if ("search" in change) {
      search.reset(change.search);
    }
    showList({ ...view, ...change });
  };
  // Reset filters turns every filter off, and keeps the order, its direction
  // and the grouping.
  const reset = () => {
    search.reset(undefined);
    showList({ ...unfiltered, ...arrangementOf(view) });
  };
  const sheet = useRef<HTMLDialogElement>(null);
  const sheetHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const searchId = useId();
  // The sheet's counts load while it is open, and again after each change.
  const [sheetOpen, setSheetOpen] = useState(false);
  const openSheet = () => {
    sheet.current?.showModal();
    setSheetOpen(true);
    // On the heading, not the search box, so a phone's keyboard does not
    // rise over the sheet as it opens.
    sheetHeading.current?.focus();
  };
  // The search shortcut puts focus in the head's search box, which shows
  // wherever the list does, scrolling it into view, and selects what it
  // holds, so typing starts a new search rather than narrowing the one on.
  const focusSearch = useCallback(() => {
    searchBox.current?.focus();
    searchBox.current?.select();
  }, []);
  const filters = query(queryOf(view, threadFilters.shape));
  const counts = useFollowing(filters, sheetOpen, () =>
    request<ThreadCounts>("GET", `/threads/counts${filters}`),
  );
  // The operator's groups and tags, which name the groups chosen, say which
  // groups and tags are gone and color them, loaded while the sheet is open,
  // either filter is on or the list is grouped by session group.
  const naming =
    view.session_group !== undefined || view.tag !== undefined || view.group === "session_group";
  const known = useFollowing(`${filters}|${sheetOpen}`, sheetOpen || naming, () =>
    request<GroupsAndTags>("GET", "/groups-and-tags"),
  );
  const chips = chipsOf(view, known);
  const on = chips.length;
  return (
    <PaletteProvider known={known}>
      {!threadBeside && <PageHeading visuallyHidden>Threads</PageHeading>}
      <div className="list-head">
        <div className="list-search">
          <SearchBox search={search} id={searchId} label="Search threads" box={searchBox} />
        </div>
        {/* Choosing another order takes it in its own direction. */}
        <div className="sort-control">
          <HeadSelect
            icon="sort"
            label="Sort"
            value={view.sort}
            options={threadSort.options.map((each) => ({ value: each, label: sortLabel[each] }))}
            choose={(value) =>
              choose({ sort: threadSort.safeParse(value).data ?? view.sort, reverse: false })
            }
          />
          <DirectionButton
            labels={directionLabel[view.sort]}
            reverse={view.reverse}
            onReverse={() => choose({ reverse: !view.reverse })}
          />
        </div>
        <HeadSelect
          icon="group"
          label="Group"
          value={view.group ?? ""}
          options={[
            { value: "", label: "Flat" },
            ...threadGrouping.options.map((each) => ({ value: each, label: groupLabel[each] })),
          ]}
          choose={(value) => choose({ group: threadGrouping.safeParse(value).data })}
        />
        <button
          ref={opener}
          type="button"
          className="secondary filters-button"
          aria-haspopup="dialog"
          aria-label={on > 0 ? `Filters, ${on} on` : "Filters"}
          onClick={openSheet}
        >
          <Icon name="filters" />
          {on > 0 && (
            <span className="badge" aria-hidden="true">
              {on}
            </span>
          )}
        </button>
      </div>
      {/* A chip removed leaves the button that had focus gone, so focus
          moves to Filters. */}
      <Chips
        chips={chips}
        remove={(chip) => {
          choose(chip.remove);
          opener.current?.focus();
        }}
      />
      <FilterSheet
        sheet={sheet}
        heading={sheetHeading}
        opener={opener}
        view={view}
        search={search}
        total={total}
        counts={counts}
        known={known}
        choose={choose}
        reset={reset}
        onClose={() => setSheetOpen(false)}
      />
      {/* A header's link followed to another list leaves the list it was
          on gone, so focus moves to Filters, as removing a chip does. */}
      <ListBody
        key={here}
        list={{
          view,
          choose: (change) => {
            if (listHref({ ...view, ...change }) !== here) {
              choose(change);
              opener.current?.focus();
            }
          },
        }}
        empty={on > 0 ? "No threads match these filters." : "No threads to show."}
        onTotal={onTotal}
        onSearch={focusSearch}
      />
    </PaletteProvider>
  );
}

// ListBody is the list as its address names it, a page at a time, flat or
// grouped. One polite status region says what the list's actions did and, on
// arrival from a thread page that went back after sending, what it sent. The
// list is mounted afresh for each address, so a list chosen afresh starts
// quiet. Side by side it stays mounted as threads open beside it, so what it
// said goes as the page moves on, and it loads again on each return to it
// from a thread, so a list gone back to is current, as one mounted afresh
// would be, and as each change the page makes lands, such as the thread
// beside it being read, besides its refresh. It holds the list's selection
// (useSelection) and its keyboard shortcuts, among them the one that selects
// a row; onSearch is what the search shortcut does. Escape within the list
// clears the selection.
function ListBody({
  list,
  empty,
  onTotal,
  onSearch,
}: {
  // The list on screen, which a grouped header's links choose changes to.
  list: ListShown;
  empty: string;
  onTotal: (total: number) => void;
  onSearch: () => void;
}) {
  const { view } = list;
  const [said, say] = useState("");
  const { pathname } = useLocation();
  useEffect(() => {
    say(takeNotice() ?? "");
  }, [pathname]);
  const pages = usePages<ListedThread, Omit<ThreadListAnswer, "threads" | "next">>(
    (cursor, signal) =>
      request<ThreadListAnswer>("GET", `/threads${query({ ...queryOf(view), cursor })}`, {
        signal,
      }).then(({ threads, ...rest }) => ({ ...rest, rows: threads })),
  );
  const beside = useContext(ListBeside) !== undefined;
  const { refresh } = pages;
  const seen = useRef(pathname);
  useEffect(() => {
    const returned = seen.current !== pathname && matchRoute(pathname).name === "threads";
    seen.current = pathname;
    if (beside && returned) {
      refresh();
    }
  }, [beside, pathname, refresh]);
  useEffect(() => {
    if (!beside) {
      return;
    }
    window.addEventListener(changeLanded, refresh);
    return () => window.removeEventListener(changeLanded, refresh);
  }, [beside, refresh]);
  const { data } = pages;
  const shown = useMemo(
    () => (data === undefined ? undefined : { ...data, rows: distinct(data.rows) }),
    [data],
  );
  useEffect(() => {
    if (data !== undefined) {
      onTotal(data.total);
    }
  }, [data, onTotal]);
  const body = useRef<HTMLDivElement>(null);
  // The threads shown, by key: those loaded but for any under a folded
  // header, which renders none. They are read from the rows on the page after
  // every render, before anything can act on them, and as a header folds,
  // which it does by its own state.
  const [rendered, setRendered] = useState<readonly string[]>(noRows);
  const readRendered = useCallback(() => {
    const keys = Array.from(
      body.current?.querySelectorAll<HTMLAnchorElement>("a.thread-link[data-thread]") ?? [],
      (link) => link.dataset.thread ?? "",
    );
    setRendered((current) =>
      current.length === keys.length && current.every((key, index) => key === keys[index])
        ? current
        : keys,
    );
  }, []);
  useLayoutEffect(readRendered);
  useLayoutEffect(() => {
    const shownNow = body.current;
    if (shownNow === null) {
      return;
    }
    const observer = new MutationObserver(readRendered);
    observer.observe(shownNow, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [readRendered]);
  const selection = useSelection(shown?.rows ?? noRows, rendered);
  useListShortcuts(onSearch, selection.toggle);
  const selectAll = useRef<HTMLInputElement>(null);
  // Where focus goes from the toolbar as it goes: the header checkbox, or
  // where it is not shown, the page's heading.
  const fallback = () =>
    selectAll.current ?? body.current?.closest("main")?.querySelector<HTMLElement>("h1");
  return (
    <div
      ref={body}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selection.selecting && !event.defaultPrevented) {
          event.preventDefault();
          selection.clear();
        }
      }}
    >
      <Status>{said}</Status>
      <Loadable data={shown} failure={pages.failure} retry={pages.refresh}>
        {({ rows, next, groups, total, as_of: asOf }) =>
          rows.length === 0 ? (
            <p className="empty">{empty}</p>
          ) : (
            <ListSelection.Provider value={selection}>
              {!selection.selecting && (
                <BulkActions
                  view={view}
                  threads={rows}
                  more={next !== undefined}
                  refresh={pages.refresh}
                  say={say}
                />
              )}
              <SelectHead selection={selection} total={total} checkbox={selectAll} />
              {view.group === undefined ? (
                <ul className="threads">
                  {rows.map((thread) => (
                    <ThreadRow
                      key={`${thread.agent}/${thread.session}/${thread.number}`}
                      thread={thread}
                      level={2}
                    />
                  ))}
                </ul>
              ) : (
                <GroupedRows threads={rows} groups={groups} grouping={view.group} list={list} />
              )}
              <MoreButton next={next} loading={pages.loading} more={pages.more} />
              {selection.selecting && (
                <SelectionToolbar
                  view={view}
                  selection={selection}
                  total={total}
                  asOf={asOf}
                  refresh={pages.refresh}
                  say={say}
                  fallback={fallback}
                />
              )}
            </ListSelection.Provider>
          )
        }
      </Loadable>
    </div>
  );
}

// No rows, while the list loads, and none shown.
const noRows: never[] = [];
