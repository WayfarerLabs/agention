import { useShortcuts } from "../../keyboard.tsx";
import { needsYou, rowLinks } from "./ThreadRow.tsx";

// The thread list's keyboard shortcuts. The current row is the row whose
// link has focus, so moving from row to row moves focus, which a screen
// reader follows, and the focus ring shows it. With focus on no row, side by
// side, the row of the thread open beside the list is current, so moving
// starts from it and opens nothing; with none current, moving goes to the
// first row there is to move to. Selecting threads to act on together
// (selection.tsx) is apart from this: x selects the current row's thread.

function current(links: HTMLAnchorElement[]): number {
  const focused = links.findIndex((link) => link === document.activeElement);
  return focused !== -1
    ? focused
    : links.findIndex((link) => link.getAttribute("aria-current") === "page");
}

// step moves focus by one row, stopping at either end.
function step(by: 1 | -1): void {
  const links = rowLinks();
  const at = current(links);
  (at === -1 ? links[0] : links[at + by])?.focus();
}

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

// open opens the current row's thread, as following its link does.
function open(): void {
  const links = rowLinks();
  links[current(links)]?.click();
}

// useListShortcuts gives the thread list's shortcuts their actions while the
// list is mounted; search opens the list's search, and toggle selects or
// unselects a thread by its key, as the current row's checkbox does.
export function useListShortcuts(search: () => void, toggle: (key: string) => void): void {
  useShortcuts("Thread list", {
    nextThread: () => step(1),
    previousThread: () => step(-1),
    nextNeeding: () => seek(1),
    previousNeeding: () => seek(-1),
    openThread: open,
    toggleSelected: () => {
      const links = rowLinks();
      const key = links[current(links)]?.dataset.thread;
      if (key !== undefined) {
        toggle(key);
      }
    },
    search,
  });
}
