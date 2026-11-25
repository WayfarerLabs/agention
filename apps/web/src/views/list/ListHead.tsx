import {
  type ThreadGrouping,
  threadGrouping,
  type ThreadSort,
  type ThreadsView,
  threadSort,
} from "@wayfarerlabs/agention-api";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { unfiltered } from "../../router.tsx";
import { DirectionButton, HeadButton, HeadSelect } from "../list-head.tsx";
import { SearchBox, type SearchText } from "./search.tsx";

// The thread list's head: one row of icon buttons, Search, Filters, the
// order beside the button reversing it, and the grouping, each marked while
// it is set to anything but its default, Filters with how many filters are
// on. Search, whose name says the search on, opens the search field holding
// it in place of the row, until it is closed, the one way to edit it; the
// search applied shows beneath, with the other filters, as a chip that
// removes it.

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

// Where focus goes once the head shows a change: into the search field,
// selecting what it holds, or back to Search.
type FocusTo = "field" | "search";

// The head's search field: whether it is open, opening it with focus in it,
// selecting what it holds, closing it, and holds on Search and on the
// field's box.
export interface HeadSearch {
  open: boolean;
  show: () => void;
  close: () => void;
  button: RefObject<HTMLButtonElement | null>;
  box: RefObject<HTMLInputElement | null>;
}

// useHeadSearch keeps the head's search field. Closing it applies the text
// it holds at once, as Enter does, or, when the search cannot take that text,
// puts back the search applied, which its chip shows; either way focus
// returns to Search.
export function useHeadSearch(search: SearchText, applied: string | undefined): HeadSearch {
  const [open, setOpen] = useState(false);
  // Wrapped in an object of its own each time, so asking again for the same
  // place, as / does with the field already open, moves focus again.
  const [focusTo, setFocusTo] = useState<{ to: FocusTo }>();
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (focusTo === undefined) {
      return;
    }
    if (focusTo.to === "search") {
      button.current?.focus();
      return;
    }
    box.current?.focus();
    box.current?.select();
  }, [focusTo]);
  const show = useCallback(() => {
    setOpen(true);
    setFocusTo({ to: "field" });
  }, []);
  const close = () => {
    if (search.problem === undefined) {
      search.applyNow();
    } else {
      search.reset(applied);
    }
    setOpen(false);
    setFocusTo({ to: "search" });
  };
  return { open, show, close, button, box };
}

// ListHead is the thread list's head. Choosing another order takes it in its
// own direction.
export function ListHead({
  view,
  choose,
  search,
  field,
  searchId,
  on,
  opener,
  openSheet,
  sorting,
  grouping,
}: {
  view: ThreadsView;
  choose: (change: Partial<ThreadsView>) => void;
  search: SearchText;
  field: HeadSearch;
  searchId: string;
  // How many filters are on.
  on: number;
  // Filters, which opens the sheet.
  opener: RefObject<HTMLButtonElement | null>;
  openSheet: () => void;
  // The order's select and the grouping's.
  sorting: RefObject<HTMLSelectElement | null>;
  grouping: RefObject<HTMLSelectElement | null>;
}) {
  if (field.open) {
    return (
      <div className="list-head">
        <div className="list-search">
          <SearchBox
            search={search}
            id={searchId}
            label="Search threads"
            box={field.box}
            done={field.close}
          />
          <HeadButton icon="close" shown="Close" name="Close search" onClick={field.close} />
        </div>
      </div>
    );
  }
  return (
    <div className="list-head">
      <HeadButton
        icon="search"
        shown="Search"
        name={view.search === undefined ? "Search" : `Search, "${view.search}"`}
        marked={view.search !== undefined}
        button={field.button}
        onClick={field.show}
      />
      <HeadButton
        icon="filters"
        shown="Filters"
        name={on > 0 ? `Filters, ${on} on` : "Filters"}
        count={on}
        button={opener}
        popup="dialog"
        onClick={openSheet}
      />
      <div className="sort-control">
        <HeadSelect
          icon="sort"
          label="Sort"
          value={view.sort}
          options={threadSort.options.map((each) => ({ value: each, label: sortLabel[each] }))}
          marked={view.sort !== unfiltered.sort}
          select={sorting}
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
        marked={view.group !== undefined}
        select={grouping}
        choose={(value) => choose({ group: threadGrouping.safeParse(value).data })}
      />
    </div>
  );
}
