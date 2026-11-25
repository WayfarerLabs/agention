import {
  maxActionThreads,
  statusKept,
  type ThreadAction,
  type ThreadSummary,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import { useLayoutEffect, useRef } from "react";
import { Failure, focusLeftWith } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { actOn, outcome, targetsOf } from "./actions.ts";
import { ListBar } from "./SelectionBar.tsx";

// A bulk mark acts on the threads shown, at most as many as one action
// takes, and says when more remain.
const remaining = (more: boolean, verb: string) =>
  more ? ` More threads remain: show more to ${verb} them too.` : "";

// BulkActions is the bar at the list's foot while no thread is selected,
// where the selection's toolbar stands while any is, acting on every thread
// shown, as Select all takes them, those under a folded header left out:
// Mark all read, marking read those holding anything unread; and Archive all
// read, while archived threads are not included and no filter keeps only
// threads with open asks, marking read and archiving those holding nothing
// unread, which keeps those holding an ask open to the operator and says so.
// Each shows only while it would act on a thread, Archive all read while a
// thread it takes holds no ask open; the first of them is the primary
// button, so marking everything read leaves Archive all read the one to
// press next. With neither to do, there is no bar, but for why an action
// failed. As the action pressed goes, focus that it left moves to the
// primary button, or, as the bar goes, to fallback. more says whether the
// list holds threads not loaded; say tells the list's status region what was
// done.
export function BulkActions({
  view,
  threads,
  more,
  refresh,
  say,
  fallback,
}: {
  view: ThreadsView;
  threads: ThreadSummary[];
  more: boolean;
  refresh: () => void;
  say: (text: string) => void;
  fallback: () => HTMLElement | null | undefined;
}) {
  const action = useAction();
  const bar = useRef<HTMLDivElement>(null);
  const primaryButton = useRef<HTMLButtonElement>(null);
  // The action last pressed, until it goes from the bar or focus moves on.
  const pressed = useRef<string>(undefined);

  const act = async (chosen: ThreadAction, acted: ThreadSummary[], verb: string) => {
    say("");
    const taken = acted.slice(0, maxActionThreads);
    const done = await action.run((csrf) => actOn(chosen, targetsOf(taken), csrf));
    if (done !== undefined) {
      say(outcome(chosen, done) + remaining(more || taken.length < acted.length, verb));
    }
    refresh();
  };
  const unread = threads.filter((thread) => thread.unread > 0);
  const read = threads.filter((thread) => thread.unread === 0);
  const useful = [
    ...(unread.length > 0
      ? [{ label: "Mark all read", run: () => act("read", unread, "mark") }]
      : []),
    ...(!view.include_archived &&
    statusKept(view) !== "open" &&
    read.some((thread) => thread.open_asks.count === 0)
      ? [{ label: "Archive all read", run: () => act("read_and_archive", read, "archive") }]
      : []),
  ];
  useLayoutEffect(() => {
    const label = pressed.current;
    if (label === undefined) {
      return;
    }
    if (!focusLeftWith(bar.current)) {
      pressed.current = undefined;
    } else if (!useful.some((each) => each.label === label)) {
      pressed.current = undefined;
      (primaryButton.current ?? fallback())?.focus();
    }
  });
  if (useful.length === 0 && action.failure === undefined) {
    return null;
  }
  // The primary action last, at the bar's end, where the selection's Done
  // stands.
  const [primary, ...others] = useful;
  const button = (each: (typeof useful)[number], primary: boolean) => (
    <button
      key={each.label}
      ref={primary ? primaryButton : undefined}
      type="button"
      className={primary ? undefined : "secondary"}
      disabled={action.pending}
      onClick={() => {
        pressed.current = each.label;
        void each.run();
      }}
    >
      {each.label}
    </button>
  );
  return (
    <ListBar bar={bar}>
      <Failure failure={action.failure} />
      {primary !== undefined && (
        <div role="group" aria-label="Threads shown" className="list-bar-actions">
          {others.map((each) => button(each, false))}
          {button(primary, true)}
        </div>
      )}
    </ListBar>
  );
}
