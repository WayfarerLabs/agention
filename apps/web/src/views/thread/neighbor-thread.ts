import { largestPage, type ThreadList, type ThreadsView } from "@wayfarerlabs/agention-api";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ApiFailure, query, request } from "../../api.ts";
import { useDeviceOption } from "../../device.ts";
import { listHref, listViewOf, queryOf } from "../../router.tsx";
import type { ListedThread } from "../list/listing.ts";

// The thread above or below, from a thread's page: the row before or after
// it in the list the page returns to, with the list's filters, order and
// grouping, as k and j move to in the list, going round past either end.
//
// Where it stands is where the thread stood when the page opened, since the
// page's own doing moves the thread in the list: answering an ask, under the
// priority order; replying, under the latest message's; and reading it, out
// of a list kept to the unread, which a flat list is walked without
// (aheadIn). So the page walks the list once on opening, until it reaches
// the thread, and keeps the threads that came before it, the threads ahead.
// What the list holds, though, is the list's as it stands when the operator
// asks: each finding walks the list afresh, and every other thread counts
// where it stands now. The thread sits where it best keeps its place among
// them (findNeighbor), so a thread gone from the list since, as one archived
// elsewhere, is passed over, and one new since counts where it stands. With
// none below, it goes round to the list's first thread other than this one,
// and with none above, to its last. A thread the list did not hold on
// opening had none ahead of it, so it sits before the list's first thread,
// which is below it, and the list's last is above.

// Which way to move from a thread, by its row's place on screen: the row
// above it or the row below.
export const directions = ["above", "below"] as const;
export type Direction = (typeof directions)[number];

// Where this device keeps which way Archive & move on, and a send that moves
// on, go: to the thread above unless the operator chooses otherwise.
export const moveOnChoice = "agention.move-on-to";

// useMoveOnDirection gives the way this device moves on, and a way to change
// and keep it.
export const useMoveOnDirection = () => useDeviceOption(moveOnChoice, directions, "above");

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

// findNeighbor walks the list as it stands for the thread above or below a
// thread, given the threads that were ahead of it. The thread sits at the cut
// in the list that leaves the fewest threads on the wrong side of it, those
// that were ahead of it after the cut and the others before it, the later of
// cuts that tie; the thread above is the last before the cut, and the one
// below the first after it. Past the last of those ahead, every thread adds
// to the count, so the walk stops once it has met all of them and the thread
// sought: about as far as the thread's own place, but to the list's end when
// one of them has left the list since, as every read one has from a flat list
// kept to the unread, and when it goes round. A walk that read its most pages
// first fails, rather than say none is left or give one that a later page
// would displace.
export async function findNeighbor(
  view: ThreadsView,
  from: Place,
  ahead: ReadonlySet<string>,
  direction: Direction,
  signal?: AbortSignal,
): Promise<ListedThread | undefined> {
  const here = keyOf(from);
  // The list's first and last threads other than this one, which a finding
  // goes round to.
  let first: ListedThread | undefined;
  let last: ListedThread | undefined;
  // The best cut so far, by the threads either side of it, with how many
  // more threads each cut leaves on the wrong side than a cut before them all.
  let above: ListedThread | undefined;
  let below: ListedThread | undefined;
  let atCut = true;
  let wrong = 0;
  let fewest = 0;
  const met = new Set<string>();
  const whole = await walk(
    view,
    (thread) => {
      const key = keyOf(thread);
      if (key === here) {
        return false;
      }
      if (atCut) {
        below = thread;
        atCut = false;
      }
      first ??= thread;
      last = thread;
      if (ahead.has(key)) {
        met.add(key);
        wrong -= 1;
      } else {
        wrong += 1;
      }
      if (wrong <= fewest) {
        fewest = wrong;
        above = thread;
        below = undefined;
        atCut = true;
      }
      const sought = direction === "above" ? above : below;
      return met.size === ahead.size && sought !== undefined;
    },
    signal,
  );
  if (!whole) {
    throw new ApiFailure(
      "unexpected",
      `The list goes on past the ${(mostPages * largestPage).toLocaleString("en-US")} threads looked through.`,
    );
  }
  return direction === "above" ? (above ?? last) : (below ?? first);
}

// aheadIn gives the list walked for the threads ahead of a thread. Reading
// the thread takes it out of a list kept to the unread, and can do so before
// the walk reaches it, so a flat list is walked with its unread filter off:
// no order goes by what is unread, so the threads the filter keeps stand in
// the same order without it. A grouped list places each group by its first
// thread the list keeps, so without the filter a read thread can lift its
// group ahead of others, and a grouped list is walked as it is: there, a
// read that lands before the walk reaches the thread leaves it not in the
// list, with none ahead of it.
const aheadIn = (view: ThreadsView): ThreadsView =>
  view.group === undefined ? { ...view, unread: false } : view;

// The thread above or below, none when the list holds no other, as found
// in the list a thread's page returns to, by that list's address.
export interface FoundNeighbor {
  thread: ListedThread | undefined;
  from: string;
}

// The list a thread's page returns to, by its address, and the walk for the
// threads ahead of the thread in it, which walking abandons.
interface Listed {
  href: string;
  view: ThreadsView;
  ahead: Promise<ReadonlySet<string>>;
  walking: AbortController;
}

// useNeighborThread gives a way to find the thread above or below from a
// thread's page, in the list it returns to. The page walks the list for the
// threads ahead of this one on opening, and again when the list changes, as
// the list beside the thread can side by side, abandoning a walk still going
// for the list before (aheadIn), and when the page closes.
// Each finding walks the list afresh, after walking again for the threads
// ahead when that walk failed; when the list changes while it is under way,
// it starts again on the list as it now stands. A page that closes meanwhile
// abandons the finding's walks.
export function useNeighborThread(
  place: Place,
  origin: ThreadsView,
): (direction: Direction) => Promise<FoundNeighbor> {
  const href = listHref(origin);
  const view = useMemo(
    () => listViewOf(new URL(href, window.location.origin).searchParams),
    [href],
  );
  const listed = useRef<Listed>(undefined);
  useEffect(() => {
    const walking = new AbortController();
    const ahead = threadsAhead(aheadIn(view), place, walking.signal);
    // A failure shows only once the operator asks for a thread.
    ahead.catch(() => undefined);
    listed.current = { href, view, ahead, walking };
    return () => walking.abort();
  }, [href, view, place]);
  const open = useRef<AbortController>(undefined);
  useEffect(() => {
    const page = new AbortController();
    open.current = page;
    return () => page.abort();
  }, []);
  return useCallback(
    (direction: Direction) => {
      const find = async (): Promise<FoundNeighbor> => {
        const now = listed.current;
        const signal = open.current?.signal;
        if (now === undefined) {
          throw new Error("The page has not walked the list it returns to yet.");
        }
        const moved = () => listed.current?.href !== now.href;
        // A walk abandoned for another list leaves that list's own.
        const known = await now.ahead.catch(() => {
          if (moved()) {
            return undefined;
          }
          // The list is the same, and no other finding runs meanwhile, so this
          // walk takes the failed one's place, and goes when that list does.
          const again = threadsAhead(aheadIn(now.view), place, now.walking.signal);
          listed.current = { ...now, ahead: again };
          return again.catch((failure: unknown) => {
            if (moved()) {
              return undefined;
            }
            throw failure;
          });
        });
        if (known === undefined || moved()) {
          return find();
        }
        const thread = await findNeighbor(now.view, place, known, direction, signal);
        return moved() ? find() : { thread, from: now.href };
      };
      return find();
    },
    [place],
  );
}
