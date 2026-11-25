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
import { actOn, outcome, targetsOf } from "./actions.ts";

// The root's property holding how tall the bar at the list's foot is, which
// the scroll padding of the page and of the list's own pane keeps clear.
const listBarHeight = "--list-bar-height";

// What the bar gives what it holds: the bar itself; whether its one action
// is under way, whichever of its states started it, so neither starts
// another meanwhile; run, which runs it, named as it fails; press, which a
// button calls as it starts the action, naming where focus goes back once it
// is done; and leave, which a control in the bar calls as it goes, so focus
// it held goes where it goes from the bar.
export interface BarActing {
  bar: RefObject<HTMLElement | null>;
  pending: boolean;
  run: <T>(
    name: string,
    change: (csrf: string | undefined) => Promise<T>,
  ) => Promise<T | undefined>;
  press: (target: () => HTMLElement | null | undefined) => void;
  leave: () => void;
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
export function ListBar({
  fallback,
  children,
}: {
  fallback: () => HTMLElement | null | undefined;
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
  const { press, pressed } = useFocusReturn(action.pending, toFallback);
  // As the bar goes, as when an action empties the list: focus in it, or
  // that the action under way left on nothing, as a browser leaves it once
  // the button pressed is disabled.
  useLayoutEffect(() => {
    const shown = bar.current;
    return () => {
      if (shown?.contains(document.activeElement) === true || (pressed() && focusLeftWith())) {
        leave();
      }
    };
  }, [leave, pressed]);
  return (
    <ActionBar label="List actions" height={listBarHeight} bar={bar}>
      <Failure failure={action.failure} action={running} />
      {children({ bar, pending: action.pending, run, press, leave })}
    </ActionBar>
  );
}

// useFocusReturn returns focus to where an action was started from once it
// is done: press names the control, as a function, since a question asked
// first may have replaced it meanwhile, and pressed says whether one is
// named and focus has stayed where the action left it. Once the action is
// no longer pending, focus goes back to the control while it can act, and
// otherwise to toFallback, unless the operator put focus anywhere else
// meanwhile, even for a moment, where it stays.
function useFocusReturn(
  pending: boolean,
  toFallback: () => void,
): { press: BarActing["press"]; pressed: () => boolean } {
  const target = useRef<() => HTMLElement | null | undefined>(undefined);
  useEffect(() => {
    const moved = (event: FocusEvent) => {
      if (target.current !== undefined && event.target !== target.current()) {
        target.current = undefined;
      }
    };
    document.addEventListener("focusin", moved);
    return () => document.removeEventListener("focusin", moved);
  }, []);
  useLayoutEffect(() => {
    const chosen = target.current;
    if (pending || chosen === undefined) {
      return;
    }
    target.current = undefined;
    const control = chosen();
    if (control instanceof HTMLButtonElement && control.isConnected && !control.disabled) {
      control.focus();
    } else {
      toFallback();
    }
  }, [pending, toFallback]);
  const press = useCallback((next: () => HTMLElement | null | undefined) => {
    target.current = next;
  }, []);
  const pressed = useCallback(() => target.current !== undefined, []);
  return { press, pressed };
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
// threads not loaded; say tells the list's status region what was done.
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
  const { pending, run, press } = acting;
  const act = async (
    pressed: HTMLButtonElement,
    name: string,
    chosen: ThreadAction,
    acted: ThreadSummary[],
    verb: string,
  ) => {
    press(() => pressed);
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
      say(outcome(chosen, done) + remaining(more || taken.length < acted.length, verb));
    }
  };
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
            void act(event.currentTarget, "Archive all read", "read_and_archive", read, "archive")
          }
        />
        <BarButton
          icon="read"
          label="Mark all read"
          disabled={!canMark || pending}
          onClick={(event) =>
            void act(event.currentTarget, "Mark all read", "read", unread, "mark")
          }
        />
      </BarSlots>
    </>
  );
}
