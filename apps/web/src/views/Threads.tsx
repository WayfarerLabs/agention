import { useLayoutEffect } from "react";
import {
  correctPoppedEntry,
  currentListView,
  listHref,
  listViewOf,
  showList,
  useListView,
  useLocation,
} from "../router.tsx";
import { matchRoute } from "../routes.ts";
import { Panes, useSideBySide } from "./side-by-side.tsx";
import { ThreadList } from "./ThreadList.tsx";
import { ThreadView } from "./thread/ThreadView.tsx";

// Threads is the Threads tab, on the list's address and on each thread's:
// the thread list and the thread open, side by side at a desktop's width and
// one at a time on a narrower screen (side-by-side.tsx). Side by side, the
// thread's pane holds a word on how to open one while none is, and the list
// on screen is the layout's own (useKeptList).
export function Threads({
  thread,
}: {
  thread: { agent: string; session: string; thread: number } | undefined;
}) {
  const sideBySide = useSideBySide();
  const { pathname } = useLocation();
  useKeptList(sideBySide);
  return (
    <Panes
      sideBySide={sideBySide}
      open={thread === undefined ? undefined : pathname}
      list={{ label: "Thread list", content: <ThreadList /> }}
      detail={{
        label: "Thread",
        content:
          thread === undefined ? (
            <NoThread />
          ) : (
            <ThreadView agent={thread.agent} session={thread.session} thread={thread.thread} />
          ),
      }}
    />
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

// NoThread holds the thread's pane while none is open.
function NoThread() {
  return <p className="empty">Choose a thread in the list to read it here.</p>;
}
