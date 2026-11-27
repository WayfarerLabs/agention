import { useShortcuts } from "../../keyboard.tsx";
import { currentRow, openRow, stepRow } from "../row-keys.ts";
import type { MarkKey } from "./ListBar.tsx";
import { needsYou, rowLinks } from "./ThreadRow.tsx";

// The thread list's keyboard shortcuts. The current row is the row holding
// focus, on its link, its checkbox, or its pull request or branch, or else,
// side by side, the row of the thread open beside the list; o opens only the
// row holding focus (row-keys.ts). Selecting threads to act on together
// (selection.tsx) is apart from this: x selects the current row's thread, and
// I and U mark read or unread the threads selected, or with none, the
// current row's.

const row = ".thread-row";
const current = (links: HTMLAnchorElement[]) => currentRow(links, row);
const step = (by: 1 | -1) => stepRow(rowLinks(), row, by);

// seek moves focus to the next row, or the previous, whose thread is
// unread or blocked on the operator, going round past either end.
function seek(by: 1 | -1): void {
  const links = rowLinks();
  const at = current(links);
  // From before the first row going on, or from the first going back, so
  // the last row comes first.
  const from = at !== -1 ? at : by === 1 ? -1 : 0;
  for (let count = 1; count <= links.length; count += 1) {
    const link = links[(((from + by * count) % links.length) + links.length) % links.length];
    if (link !== undefined && needsYou(link)) {
      link.focus();
      return;
    }
  }
}

// open opens the thread of the row holding focus, as following its link
// does.
const open = () => openRow(rowLinks(), row);

// The current row's thread, by its key, if a row is current.
function currentKey(): string | undefined {
  const links = rowLinks();
  return links[current(links)]?.dataset.thread;
}

// What the thread list's shortcuts act through, beyond its rows: search opens
// the list's search, filters its sheet of filters, and sort and grouping the
// choice of its order and of its grouping, as their controls in the list's
// head do; toggle selects or unselects a thread by its key, as the current
// row's checkbox does; and mark marks read or unread, as the bar at the
// list's foot does, the threads selected, or with none, the current row's
// thread, by its key.
export interface ListKeys {
  search: () => void;
  filters: () => void;
  sort: () => void;
  grouping: () => void;
  toggle: (key: string) => void;
  mark: MarkKey;
}

// useListShortcuts gives the thread list's shortcuts their actions while the
// list is mounted.
export function useListShortcuts({
  search,
  filters,
  sort,
  grouping,
  toggle,
  mark,
}: ListKeys): void {
  useShortcuts("Thread list", {
    nextThread: () => step(1),
    previousThread: () => step(-1),
    nextNeeding: () => seek(1),
    previousNeeding: () => seek(-1),
    openThread: open,
    toggleSelected: () => {
      const key = currentKey();
      if (key !== undefined) {
        toggle(key);
      }
    },
    markRead: () => mark("read", currentKey()),
    markUnread: () => mark("unread", currentKey()),
    search,
    openFilters: filters,
    chooseSort: sort,
    chooseGrouping: grouping,
  });
}
