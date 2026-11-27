import {
  type SavedView,
  type SavedViewList,
  type ThreadsView,
  threadsView,
} from "@wayfarerlabs/agention-api";
import { useEffect, useRef } from "react";
import { request } from "./api.ts";
import { afterNextNavigation, currentListView, listHref, navigate } from "./router.tsx";

// The operator's saved views as the web UI uses them: each a name and one
// thread list, which opening it navigates to, at its address. The address
// stays the list's source of truth; a view is current while the list on
// screen is its list, which is worked out here, never stored.

export const loadSavedViews = () => request<SavedViewList>("GET", "/saved-views");

// sameValue says whether two values of a part of the list are alike, a part
// that takes several values compared as a set, in any order.
function sameValue(one: unknown, other: unknown): boolean {
  if (Array.isArray(one) && Array.isArray(other)) {
    const values = new Set<unknown>(one);
    return one.length === other.length && other.every((each) => values.has(each));
  }
  return one === other;
}

// sameList says whether two lists are the same list: every part alike.
function sameList(one: ThreadsView, other: ThreadsView): boolean {
  return (Object.keys(threadsView.shape) as (keyof ThreadsView)[]).every((part) =>
    sameValue(one[part], other[part]),
  );
}

// currentViews gives the views whose list is the one on screen. Two views of
// the same list are both current.
export const currentViews = (views: readonly SavedView[], shown: ThreadsView): SavedView[] =>
  views.filter((each) => sameList(each.view, shown));

// The Saved views sheet's key, g v, opens it from anywhere. The thread list
// opens its own sheet while it is mounted, as on the list's page and beside
// a thread; elsewhere, as on a thread's page alone, on a phone, or in
// Sessions or Settings, the page goes to the list first, the one a thread
// page returns to, and the list opens its sheet as it mounts. The sheet is
// owed to that navigation alone, so a list it does not mount, as for a
// redirect to sign-in or on the list's own address while the list has
// failed, never opens it later unasked: the next navigation forgets it. The
// request lives only in this page's memory, so a reload never repeats it.
let opener: (() => void) | undefined;
let owed = false;

const forget = () => {
  owed = false;
};

export function openSavedViews(): void {
  if (opener !== undefined) {
    opener();
    return;
  }
  navigate(listHref(currentListView()));
  // Set once the navigation is announced, so only the next one forgets it.
  owed = true;
  afterNextNavigation(forget);
}

// useSavedViewsOpener makes open what g v does while the calling component,
// the thread list, is mounted, and does it at once if g v asked before the
// list was there.
export function useSavedViewsOpener(open: () => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const each = () => latest.current();
    opener = each;
    if (owed) {
      owed = false;
      each();
    }
    return () => {
      if (opener === each) {
        opener = undefined;
      }
    };
  }, []);
}
