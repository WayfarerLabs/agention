import { useShortcuts } from "../../keyboard.tsx";
import { rowLinks, rowNeedsYou } from "./ThreadRow.tsx";

// The thread list's keyboard shortcuts. The row selected is the row whose
// link has focus, so moving the selection moves focus, which a screen reader
// follows, and the focus ring shows it. With focus on no row, side by side,
// the row of the thread open beside the list is selected, so moving starts
// from it and opens nothing; with none selected, moving selects the first row
// there is to move to.

function selected(links: HTMLAnchorElement[]): number {
  const focused = links.findIndex((link) => link === document.activeElement);
  return focused !== -1
    ? focused
    : links.findIndex((link) => link.getAttribute("aria-current") === "page");
}

// step moves the selection by one row, stopping at either end.
function step(by: 1 | -1): void {
  const links = rowLinks();
  const at = selected(links);
  (at === -1 ? links[0] : links[at + by])?.focus();
}

// seek moves the selection to the next row, or the previous, whose thread is
// unread or blocked on the operator, going round past either end.
function seek(by: 1 | -1): void {
  const links = rowLinks();
  const at = selected(links);
  // From before the first row going on, or from the first going back, so
  // the last row comes first.
  const from = at !== -1 ? at : by === 1 ? -1 : 0;
  for (let count = 1; count <= links.length; count += 1) {
    const link = links[(((from + by * count) % links.length) + links.length) % links.length];
    if (link !== undefined && rowNeedsYou(link)) {
      link.focus();
      return;
    }
  }
}

// open opens the selected row's thread, as following its link does.
function open(): void {
  const links = rowLinks();
  links[selected(links)]?.click();
}

// useListShortcuts gives the thread list's shortcuts their actions while the
// list is mounted; search opens the list's search.
export function useListShortcuts(search: () => void): void {
  useShortcuts("Thread list", {
    nextThread: () => step(1),
    previousThread: () => step(-1),
    nextNeeding: () => seek(1),
    previousNeeding: () => seek(-1),
    openThread: open,
    search,
  });
}
