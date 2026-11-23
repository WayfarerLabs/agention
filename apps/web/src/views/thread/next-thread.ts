import { largestPage, type ThreadList, type ThreadsView } from "@wayfarerlabs/agention-api";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ApiFailure, query, request } from "../../api.ts";
import { listHref, listViewOf, queryOf } from "../../router.tsx";
import { type ListedThread, needsYou } from "../list/listing.ts";

// The next thread needing the operator, from a thread's page: the next thread
// after it in the list the page returns to, with the list's filters, order
// and grouping, that is unread or blocked on them (needsYou, the rule the
// list's n goes by), going round past the list's end.
//
// "After it" is where the thread stood when the page opened, since the page's
// own doing moves the thread in the list: answering an ask, under the
// priority order; replying, under the latest message's; and reading it, out
// of a list kept to the unread, which a flat list is walked without
// (aheadIn).
// So the page walks the list once on opening, until it reaches the thread,
// and keeps the threads that came before it. Whether a thread needs the
// operator, though, is the list's as it stands when they ask: each finding
// walks the list afresh and takes the first thread needing them that is
// neither this one nor one that came before it, so an agent that wrote since
// counts and a thread handled elsewhere does not, and a thread new since the
// page opened counts where it stands now. With none, it goes round, taking
// the first needing them other than this one. A thread the list did not
// hold on opening had none before it, so any thread needing the operator is
// next.

interface Place {
  agent: string;
  session: string;
  number: number;
}

const keyOf = (thread: Place) => `${thread.agent}/${thread.session}/${thread.number}`;

// The most pages one walk reads, ten thousand threads, so a list that keeps
// giving pages cannot keep a walk going.
export const mostPages = 100;

// walk reads the list's pages from the first, the most threads a page holds
// at a time, handing each thread to visit until it says to stop or the list
// ends, and says whether it got that far: false once it read its most pages
// with more to come.
async function walk(
  view: ThreadsView,
  visit: (thread: ListedThread) => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let pages = 0; pages < mostPages; pages += 1) {
    const page = await request<ThreadList>(
      "GET",
      `/threads${query({ ...queryOf(view), cursor, limit: largestPage })}`,
      { signal },
    );
    if (page.threads.some(visit) || page.next === undefined) {
      return true;
    }
    cursor = page.next;
  }
  return false;
}

// threadsAhead gives the threads ahead of a thread in the list, none when the
// list does not hold it, or holds it past the most pages a walk reads.
export async function threadsAhead(
  view: ThreadsView,
  from: Place,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const here = keyOf(from);
  const ahead = new Set<string>();
  let found = false;
  await walk(
    view,
    (thread) => {
      const key = keyOf(thread);
      found = key === here;
      if (!found) {
        ahead.add(key);
      }
      return found;
    },
    signal,
  );
  return found ? ahead : new Set();
}

// findNext walks the list as it stands for the next thread needing the
// operator after a thread, given the threads that were ahead of it. A walk
// that read its most pages without finding one fails, rather than say none
// is left, since one may lie further on.
export async function findNext(
  view: ThreadsView,
  from: Place,
  ahead: ReadonlySet<string>,
): Promise<ListedThread | undefined> {
  const here = keyOf(from);
  let next: ListedThread | undefined;
  let first: ListedThread | undefined;
  const whole = await walk(view, (thread) => {
    const key = keyOf(thread);
    if (key === here || !needsYou(thread)) {
      return false;
    }
    if (!ahead.has(key)) {
      next = thread;
      return true;
    }
    first ??= thread;
    return false;
  });
  if (next === undefined && !whole) {
    throw new ApiFailure(
      "unexpected",
      `The list goes on past the ${(mostPages * largestPage).toLocaleString("en-US")} threads looked through.`,
    );
  }
  return next ?? first;
}

// aheadIn gives the list walked for the threads ahead of a thread. Reading
// the thread takes it out of a list kept to the unread, and can do so before
// the walk reaches it, so a flat list is walked with its unread filter off:
// no order goes by what is unread, so the threads the filter keeps stand in
// the same order without it. A grouped list places each group by its first
// thread the list keeps, so without the filter a read thread can lift its
// group ahead of others, and a grouped list is walked as it is: there, a
// read that lands before the walk reaches the thread leaves it not in the
// list, and any thread needing the operator is next.
const aheadIn = (view: ThreadsView): ThreadsView =>
  view.group === undefined ? { ...view, unread: false } : view;

// The next thread needing the operator, none when none does, as found in the
// list a thread's page returns to, by that list's address.
export interface NextFound {
  next: ListedThread | undefined;
  from: string;
}

// The list a thread's page returns to, by its address, and the walk for the
// threads ahead of the thread in it.
interface Listed {
  href: string;
  view: ThreadsView;
  ahead: Promise<ReadonlySet<string>>;
}

// useNextThread gives a way to find the next thread needing the operator from
// a thread's page, in the list it returns to. The page walks the list for the
// threads ahead of this one on opening, and again when the list changes, as
// the list beside the thread can side by side, abandoning a walk still going
// (aheadIn).
// Each finding walks the list afresh, after walking again for the threads
// ahead when that walk failed; when the list changes while it is under way,
// it starts again on the list as it now stands. A page that closes meanwhile
// drops what it finds.
export function useNextThread(place: Place, origin: ThreadsView): () => Promise<NextFound> {
  const href = listHref(origin);
  const view = useMemo(
    () => listViewOf(new URL(href, window.location.origin).searchParams),
    [href],
  );
  const listed = useRef<Listed>(undefined);
  useEffect(() => {
    const walking = new AbortController();
    const ahead = threadsAhead(aheadIn(view), place, walking.signal);
    // A failure shows only once the operator asks for the next thread.
    ahead.catch(() => undefined);
    listed.current = { href, view, ahead };
    return () => walking.abort();
  }, [href, view, place]);
  return useCallback(() => {
    const find = async (): Promise<NextFound> => {
      const now = listed.current;
      if (now === undefined) {
        throw new Error("The page has not walked the list it returns to yet.");
      }
      const moved = () => listed.current?.href !== now.href;
      const known = await now.ahead.catch(() => {
        // A walk abandoned for another list leaves that list's own.
        if (moved()) {
          return undefined;
        }
        // The list is the same, and no other finding runs meanwhile, so this
        // walk takes the failed one's place.
        const again = threadsAhead(aheadIn(now.view), place);
        listed.current = { ...now, ahead: again };
        return again;
      });
      if (known === undefined || moved()) {
        return find();
      }
      const next = await findNext(now.view, place, known);
      return moved() ? find() : { next, from: now.href };
    };
    return find();
  }, [place]);
}
