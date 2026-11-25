import {
  maxActionThreads,
  statusKept,
  type ThreadAction,
  type ThreadSummary,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActionBar, BarButton, BarCaption, BarSlots } from "../../action-bar.tsx";
import { Failure, focusLeftWith } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { actionLabel, actOn, outcome, targetsOf } from "./actions.ts";
import { threadKey } from "./selection.tsx";
import { rowLinks } from "./ThreadRow.tsx";

// The root's property holding how tall the bar at the list's foot is, which
// the scroll padding of the page and of the list's own pane keeps clear.
const listBarHeight = "--list-bar-height";

// What the list's I and U ask of the bar: to mark read or unread the
// threads selected, or with none, the thread of the current row, by its key,
// if a row is current.
export type MarkKey = (action: "read" | "unread", current: string | undefined) => void;

// What the bar gives what it holds: the bar itself; whether its one action
// is under way, whichever of its states started it, so neither starts
// another meanwhile; run, which runs it, named as it fails; press, which a
// button calls as it starts the action, naming where focus goes back once it
// is done; fromRow, which a mark key calls in press's place, naming the row
// it was pressed on, by its thread's key; leave, which a control in the bar
// calls as it goes, so focus it held goes where it goes from the bar; and
// keys, where the state the bar is in gives the mark keys their action
// (useMarkKeys).
export interface BarActing {
  bar: RefObject<HTMLElement | null>;
  pending: boolean;
  run: <T>(
    name: string,
    change: (csrf: string | undefined) => Promise<T>,
  ) => Promise<T | undefined>;
  press: (target: () => HTMLElement | null | undefined) => void;
  fromRow: (row: string) => void;
  leave: () => void;
  keys: RefObject<MarkKey | undefined>;
}

// rowOf finds the link of the row of a thread, by its key.
export const rowOf = (key: string | undefined): HTMLAnchorElement | undefined =>
  key === undefined ? undefined : rowLinks().find((link) => link.dataset.thread === key);

// withFocus gives the key of a thread whose row holds focus, so a mark key
// pressed there returns focus to it, and undefined for one whose row does
// not, as side by side with focus in the thread, where focus stays.
export const withFocus = (key: string | undefined): string | undefined =>
  rowOf(key)?.contains(document.activeElement) === true ? key : undefined;

// useMarkKeys gives the mark keys the action of the bar's state that calls
// it, as it rendered last, while it is mounted, so they act as that state's
// controls do; with no bar, as while the list is empty, they do nothing.
export function useMarkKeys(keys: BarActing["keys"], mark: MarkKey): void {
  useLayoutEffect(() => {
    keys.current = mark;
    return () => {
      keys.current = undefined;
    };
  });
}

// ListBar is the bar at the list's foot, shown while the list has rows,
// acting on every thread shown while none is selected (ShownActions) and on
// those selected while any are (SelectionActions), as children render them
// from what the bar gives them. The bar itself stays as one state gives way
// to the other, so only what it holds changes. Why its action failed shows
// above them, naming the action, until the next one starts, in whichever
// state the bar is in by then, as when the operator selected a thread while
// it ran on a slow link.
//
// Focus that leaves the bar goes to fallback, without scrolling the page, so
// a phone's list stays where it was: as the action it left is done, and as
// the control holding it goes, the bar's own as the list empties among them.
// keys is where the mark keys find their action, and focusOwed where the bar
// says it owes the rows focus (RowFocusOwed).
export function ListBar({
  fallback,
  keys,
  focusOwed,
  children,
}: {
  fallback: () => HTMLElement | null | undefined;
  keys: BarActing["keys"];
  focusOwed: RefObject<boolean>;
  children: (acting: BarActing) => ReactNode;
}) {
  const bar = useRef<HTMLElement>(null);
  const action = useAction();
  // The action last run, which a failure names.
  const [running, setRunning] = useState<string>();
  const run: BarActing["run"] = (name, change) => {
    setRunning(name);
    return action.run(change);
  };
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const toFallback = useCallback(() => fallbackRef.current()?.focus({ preventScroll: true }), []);
  // Once the commit removing the control is done, so fallback finds what
  // stays, such as the page's heading where Select all went too.
  const leave = useCallback(
    () =>
      queueMicrotask(() => {
        if (focusLeftWith()) {
          toFallback();
        }
      }),
    [toFallback],
  );
  const { press, fromRow, pressed } = useFocusReturn(action.pending, toFallback, focusOwed);
  // As the bar goes, as when an action empties the list: focus in it, or
  // that the action under way left on nothing, as a browser leaves it once
  // the button pressed is disabled.
  useLayoutEffect(() => {
    const shown = bar.current;
    return () => {
      focusOwed.current = false;
      if (shown?.contains(document.activeElement) === true || (pressed() && focusLeftWith())) {
        leave();
      }
    };
  }, [leave, pressed, focusOwed]);
  return (
    <ActionBar label="List actions" height={listBarHeight} bar={bar}>
      <Failure failure={action.failure} action={running} />
      {children({ bar, pending: action.pending, run, press, fromRow, leave, keys })}
    </ActionBar>
  );
}

// Where focus goes back once the bar's action is done: the control pressed,
// as a function, since a question asked first may have replaced it
// meanwhile; or the row a mark key was pressed on, by its thread's key, since
// a refresh may have rendered it afresh meanwhile, with its place among the
// rows as fromRow named it.
type Started = { control: () => HTMLElement | null | undefined } | { row: string; at: number };

// useFocusReturn returns focus to where an action was started from once it
// is done: press names the control, fromRow the row a key was pressed on,
// and pressed says whether either is named and focus has stayed where the
// action left it. Once the action is no longer pending, focus goes back to
// the control while it can act, and otherwise to toFallback; or to the row,
// or, should the action have taken it out of the list, the row now in its
// place, or the last, or with none, to toFallback. Either way, not if the
// operator put focus anywhere else meanwhile, even for a moment, where it
// stays. While it is to return focus to a row, focusOwed says so, so a row
// that goes meanwhile leaves focus to it.
function useFocusReturn(
  pending: boolean,
  toFallback: () => void,
  focusOwed: RefObject<boolean>,
): { press: BarActing["press"]; fromRow: BarActing["fromRow"]; pressed: () => boolean } {
  const target = useRef<Started>(undefined);
  const aim = useCallback(
    (started: Started | undefined) => {
      target.current = started;
      focusOwed.current = started !== undefined && "row" in started;
    },
    [focusOwed],
  );
  useEffect(() => {
    const moved = (event: FocusEvent) => {
      const started = target.current;
      if (
        started !== undefined &&
        event.target !== ("row" in started ? rowOf(started.row) : started.control())
      ) {
        aim(undefined);
      }
    };
    document.addEventListener("focusin", moved);
    return () => document.removeEventListener("focusin", moved);
  }, [aim]);
  useLayoutEffect(() => {
    const started = target.current;
    if (pending || started === undefined) {
      return;
    }
    aim(undefined);
    if ("row" in started) {
      const links = rowLinks();
      const row = rowOf(started.row) ?? links[started.at] ?? links.at(-1);
      if (row === undefined) {
        toFallback();
      } else {
        row.focus();
      }
      return;
    }
    const control = started.control();
    if (control instanceof HTMLButtonElement && control.isConnected && !control.disabled) {
      control.focus();
    } else {
      toFallback();
    }
  }, [pending, toFallback, aim]);
  const press = useCallback(
    (control: () => HTMLElement | null | undefined) => aim({ control }),
    [aim],
  );
  const fromRow = useCallback(
    (row: string) => {
      const link = rowOf(row);
      aim(link === undefined ? undefined : { row, at: rowLinks().indexOf(link) });
    },
    [aim],
  );
  const pressed = useCallback(() => target.current !== undefined, []);
  return { press, fromRow, pressed };
}

// A bulk mark acts on the threads shown, at most as many as one action
// takes, and says when more remain.
const remaining = (more: boolean, verb: string) =>
  more ? ` More threads remain: show more to ${verb} them too.` : "";

// ShownActions is what the bar holds while no thread is selected, acting on
// every thread shown, as Select all takes them, those under a folded header
// left out: Mark all read, marking read those holding anything unread; and
// Archive all read, while archived threads are not included and no filter
// keeps only threads with open asks, marking read and archiving those holding
// nothing unread, which keeps those holding an ask open to the operator and
// says so. Each is disabled while it would act on no thread, Archive all read
// while every thread it takes holds an ask open, and both while an action of
// the bar's is under way, which lasts until the list has tried to load
// afresh, so what they offer then is what the list holds, or, when that
// load failed, the list's own error and its retry show. The caption says how many
// threads are shown, of how many the filters keep, or what the last action
// did (said); the list's status region announces that, so the caption's copy
// is hidden from assistive technology. more says whether the list holds
// threads not loaded; say tells the list's status region what was done. The
// mark keys mark read or unread the current row's thread alone, as these
// buttons mark the threads shown, while no action of the bar's is under way;
// pressed on the row, focus goes back to it, or the row in its place should
// it leave the list.
export function ShownActions({
  view,
  threads,
  total,
  more,
  refresh,
  said,
  say,
  acting,
}: {
  view: ThreadsView;
  threads: ThreadSummary[];
  total: number;
  more: boolean;
  refresh: () => Promise<boolean>;
  said: string;
  say: (text: string) => void;
  acting: BarActing;
}) {
  const { pending, run, press, fromRow, keys } = acting;
  // act does an action to threads shown: those of a bulk mark, from its
  // button, which says when more remain, or a row's alone, from a key,
  // pressed on its row or with focus elsewhere.
  const act = async (
    name: string,
    chosen: ThreadAction,
    acted: ThreadSummary[],
    from: { pressed: HTMLButtonElement; verb: string } | { row: string | undefined },
  ) => {
    if ("pressed" in from) {
      press(() => from.pressed);
    } else if (from.row !== undefined) {
      fromRow(from.row);
    }
    say("");
    const taken = acted.slice(0, maxActionThreads);
    const done = await run(name, async (csrf) => {
      const result = await actOn(chosen, targetsOf(taken), csrf);
      await refresh();
      return result;
    });
    if (done === undefined) {
      // The server may have acted before the answer was lost, as when the
      // connection dropped, so the list shows what it holds now.
      void refresh();
    } else {
      say(
        outcome(chosen, done) +
          ("pressed" in from ? remaining(more || taken.length < acted.length, from.verb) : ""),
      );
    }
  };
  useMarkKeys(keys, (chosen, current) => {
    const thread = threads.find((each) => threadKey(each) === current);
    if (thread !== undefined && !pending) {
      void act(actionLabel[chosen], chosen, [thread], { row: withFocus(current) });
    }
  });
  const unread = threads.filter((thread) => thread.unread > 0);
  const read = threads.filter((thread) => thread.unread === 0);
  const canMark = unread.length > 0;
  const canArchive =
    !view.include_archived &&
    statusKept(view) !== "open" &&
    read.some((thread) => thread.open_asks.count === 0);
  const count = threads.length;
  return (
    <>
      {said === "" ? (
        <BarCaption>{count < total ? `${count} of ${total} shown` : `${count} shown`}</BarCaption>
      ) : (
        <BarCaption aria-hidden>{said}</BarCaption>
      )}
      <BarSlots group="Threads shown">
        <BarButton
          icon="archive"
          label="Archive all read"
          trailing
          disabled={!canArchive || pending}
          onClick={(event) =>
            void act("Archive all read", "read_and_archive", read, {
              pressed: event.currentTarget,
              verb: "archive",
            })
          }
        />
        <BarButton
          icon="read"
          label="Mark all read"
          disabled={!canMark || pending}
          onClick={(event) =>
            void act("Mark all read", "read", unread, {
              pressed: event.currentTarget,
              verb: "mark",
            })
          }
        />
      </BarSlots>
    </>
  );
}
