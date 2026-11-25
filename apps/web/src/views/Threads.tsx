import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ErrorBoundary, PageFailed } from "../boundary.tsx";
import { focusLanding } from "../components.tsx";
import { ShortcutArea } from "../keyboard.tsx";
import { useMedia } from "../media.ts";
import {
  correctPoppedEntry,
  currentListView,
  listHref,
  listViewOf,
  matchRoute,
  showList,
  useListView,
  useLocation,
} from "../router.tsx";
import { ListBeside } from "./list/beside.ts";
import { ThreadList } from "./ThreadList.tsx";
import { ThreadView } from "./thread/ThreadView.tsx";

// At a desktop's width the Threads tab shows the thread list and the thread
// open side by side, on the list's address and on each thread's alike, and
// on a narrower screen one at a time, as on a phone. 64rem is 1024px at the
// browser's default text size, the narrowest common desktop width: there a
// list pane of at least 20rem, about as wide as a phone shows the list, fits
// beside a thread of at least 36rem, a comfortable reading width, with the
// page's padding and the gap between (styles.css, .side-by-side). Like the
// 40rem at which the banner's tabs join its row, it is in rem, so larger
// text brings back one pane at a time before either grows cramped. The width
// is read in the script, not in CSS alone, since it decides what is mounted:
// one at a time, the list is not mounted while a thread is open.
const sideBySideQuery = "(min-width: 64rem)";

// Threads is the Threads tab, on the list's address and on each thread's:
// the list's pane, then the thread's, the thread in the same place at every
// width, so crossing the breakpoint keeps it as it is, with what it holds
// and focus. Side by side, the list's pane stays mounted, with its filters,
// folds and scroll, while threads open and close beside it; the thread's
// pane mounts afresh for each, holding a word on how to open one while none
// is; each pane is the area of its shortcuts and fails on its own; and the
// list on screen is the layout's own (useKeptList). A navigation to a thread
// lands in its pane, as on a phone in the page's content, and one back to
// the list on the row of the thread it left (focusLanding).
// Clicking within a pane gives it focus, so a key both bind acts where the
// operator is.
export function Threads({
  thread,
}: {
  thread: { agent: string; session: string; thread: number } | undefined;
}) {
  const sideBySide = useMedia(sideBySideQuery);
  const { pathname } = useLocation();
  const open = thread === undefined ? undefined : pathname;
  // The thread last open, whose row going back to the list lands on.
  const [last, setLast] = useState<string>();
  if (open !== undefined && open !== last) {
    setLast(open);
  }
  const left = open === undefined ? last : undefined;
  const beside = useMemo(() => (sideBySide ? { open, left } : undefined), [sideBySide, open, left]);
  useKeptList(sideBySide);
  const layout = useRef<HTMLDivElement>(null);
  const listPane = useRef<HTMLElement>(null);
  const threadPane = useRef<HTMLElement>(null);
  useFocusKept(sideBySide, layout);
  // A pane's own name and focus, side by side alone.
  const pane = (name: string) => (sideBySide ? { "aria-label": name, tabIndex: -1 } : {});
  return (
    <div ref={layout} className={sideBySide ? "side-by-side" : undefined}>
      {(sideBySide || open === undefined) && (
        <section ref={listPane} className="list-pane" {...pane("Thread list")}>
          <ShortcutArea.Provider value={listPane}>
            <ListBeside.Provider value={beside}>
              {/* A list that fails to render leaves the thread standing. */}
              <ErrorBoundary fallback={<PageFailed />}>
                <ThreadList />
              </ErrorBoundary>
            </ListBeside.Provider>
          </ShortcutArea.Provider>
        </section>
      )}
      {(sideBySide || open !== undefined) && (
        <section
          ref={threadPane}
          key={pathname}
          {...pane("Thread")}
          data-landing={sideBySide && open !== undefined ? "" : undefined}
        >
          <ShortcutArea.Provider value={threadPane}>
            {/* A thread that fails to render leaves the list standing, and
                another thread starts afresh. */}
            <ErrorBoundary fallback={<PageFailed />}>
              {thread === undefined ? (
                <NoThread />
              ) : (
                <ThreadView agent={thread.agent} session={thread.session} thread={thread.thread} />
              )}
            </ErrorBoundary>
          </ShortcutArea.Provider>
        </section>
      )}
    </div>
  );
}

// useKeptList keeps the list on screen side by side as the layout's own, so
// going back or forward between threads, or onto the list's own entry,
// neither changes nor remounts it: before the page follows the entry gone to,
// it is corrected to the list as set, a thread's as the list it returns to
// and the list's own as its address, so the entry, a reload, u and the list
// agree. One at a time, each entry's list shows as it was.
function useKeptList(sideBySide: boolean): void {
  const here = listHref(useListView());
  useLayoutEffect(() => {
    if (!sideBySide) {
      return;
    }
    return correctPoppedEntry(() => {
      const route = matchRoute(window.location.pathname).name;
      if ((route === "threads" || route === "thread") && listHref(currentListView()) !== here) {
        showList(listViewOf(new URL(here, window.location.origin).searchParams));
      }
    });
  }, [sideBySide, here]);
}

// useFocusKept moves focus to where a navigation lands when crossing the
// breakpoint took away what held it: the list's pane, which goes below it
// while a thread is open, or a pane itself, which one at a time takes no
// focus.
function useFocusKept(sideBySide: boolean, layout: RefObject<HTMLElement | null>): void {
  const was = useRef(sideBySide);
  useLayoutEffect(() => {
    if (was.current === sideBySide) {
      return;
    }
    was.current = sideBySide;
    const page = layout.current?.closest("main");
    const focus = document.activeElement;
    const lost =
      focus === null || focus === document.body || focus.parentElement === layout.current;
    if (page !== null && page !== undefined && lost) {
      focusLanding(page);
    }
  }, [sideBySide, layout]);
}

// NoThread holds the thread's pane while none is open.
function NoThread() {
  return <p className="empty">Choose a thread in the list to read it here.</p>;
}
