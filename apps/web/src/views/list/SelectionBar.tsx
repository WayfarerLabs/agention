import {
  type MatchingThreadActionInput,
  maxActionThreads,
  statusKept,
  type ThreadAction,
  type ThreadActionInput,
  type ThreadActionResult,
  type ThreadCounts,
  threadFilters,
  type ThreadSummary,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiFailure, query, request } from "../../api.ts";
import { Confirmation, Failure, focusLeftWith, useScrollClearOf } from "../../components.tsx";
import { useAction, useFollowing } from "../../data.ts";
import { plural } from "../../format.tsx";
import { queryOf } from "../../router.tsx";
import { actOn, outcome, targetsOf } from "./actions.ts";
import type { Selection } from "./selection.tsx";

// The selection's controls: the header above the list, its checkbox
// selecting every thread shown and the offer to select every thread the
// filters keep; and the toolbar below it while anything is selected, which
// acts on what is.

// The root's property holding how tall the bar at the list's foot is, which
// the scroll padding of the page and of the list's own pane keeps clear.
const listBarHeight = "--list-bar-height";

// ListBar is the bar at the list's foot, stuck to the foot of the view, which
// acts on every thread shown or on those selected; what a key moves focus to
// scrolls into view clear of it. bar is the caller's hold on it.
export function ListBar({
  bar,
  children,
}: {
  bar: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  useScrollClearOf(bar, listBarHeight);
  return (
    <div ref={bar} className="list-bar">
      {children}
    </div>
  );
}

// SelectHead is the list's header checkbox, with a mouse or a trackpad, or
// on a touch screen while anything is selected; and, once every thread shown
// is selected while the list holds more, the offer to select all of them, or
// to go back to those shown, in a region that announces it.
export function SelectHead({
  selection,
  total,
  checkbox,
}: {
  selection: Selection;
  total: number;
  checkbox: RefObject<HTMLInputElement | null>;
}) {
  const { chosen, everything, wholePage, shown } = selection;
  const indeterminate = chosen.length > 0 && !wholePage;
  useLayoutEffect(() => {
    if (checkbox.current !== null) {
      checkbox.current.indeterminate = indeterminate;
    }
  });
  if (selection.touch && !selection.selecting) {
    return null;
  }
  return (
    <div className="select-head">
      <label className="check select-all">
        <input
          ref={checkbox}
          type="checkbox"
          checked={wholePage}
          onChange={() => selection.selectPage(!wholePage)}
        />
        Select all
      </label>
      <div className="select-banner" aria-live="polite">
        {everything ? (
          <p>
            All {plural(total, "thread")} that match are selected.{" "}
            <button
              type="button"
              className="link"
              onClick={() => selection.selectEverything(false)}
            >
              Select only the {shown} shown
            </button>
          </p>
        ) : (
          wholePage &&
          total > shown && (
            <p>
              All {plural(shown, "thread")} shown are selected.{" "}
              {total > maxActionThreads ? (
                `Narrow the filters to act on all ${total} that match: at most ${maxActionThreads} at once.`
              ) : (
                <button
                  type="button"
                  className="link"
                  onClick={() => selection.selectEverything(true)}
                >
                  Select all {plural(total, "thread")} that match
                </button>
              )}
            </p>
          )
        )}
      </div>
    </div>
  );
}

const actionLabel: Record<ThreadAction, string> = {
  read: "Mark read",
  unread: "Mark unread",
  read_and_archive: "Mark read and archive",
  decline_read_and_archive: "Decline, mark read and archive",
};

// What an action acts on: the threads selected, each through the latest
// message the list showed; or every thread the filters keep, as of the
// list's as_of.
type Acted =
  | { threads: ThreadActionInput["threads"] }
  | { matching: Omit<MatchingThreadActionInput, "action"> };

// The question an action asks before it acts, if it asks one: declining
// always does, since it answers the agents, and so does acting on every
// thread the filters keep, beyond those shown. holding is how many of those
// hold an ask open to the operator, when known.
function question(
  action: ThreadAction,
  chosen: readonly ThreadSummary[],
  everything: boolean,
  total: number,
  holding: number | undefined,
): string | undefined {
  if (everything) {
    const all = `all ${plural(total, "thread")} that match`;
    switch (action) {
      case "read":
        return `Mark ${all} read?`;
      case "unread":
        return `Mark ${all} unread?`;
      case "read_and_archive":
        return `Mark read and archive ${all}?`;
      case "decline_read_and_archive":
        return holding === undefined
          ? `Decline every ask open to you in the threads that match, then mark read and archive ${all}?`
          : `Decline every ask open to you in the ${plural(holding, "thread")} of them holding ` +
              `one, then mark read and archive ${all}?`;
    }
  }
  if (action !== "decline_read_and_archive") {
    return undefined;
  }
  const asking = chosen.filter((thread) => thread.open_asks.count > 0);
  const asks = asking.reduce((sum, thread) => sum + thread.open_asks.count, 0);
  return (
    `Decline ${plural(asks, "ask")} in ${plural(asking.length, "thread")}, ` +
    `then mark read and archive ${plural(chosen.length, "thread")}?`
  );
}

// SelectionToolbar acts on the threads selected, in one request: on those
// loaded, at most as many as one action takes; or on every thread the
// filters keep, as of the list's as_of. Declining, and acting on every thread
// that matches, ask first, and what they act on is taken as they ask, so
// what is sent is what was on screen; refused as stale, acting on every
// thread that matches loads the list afresh and asks again. Once an action is done it says what it
// did, clears the selection and refreshes the list. Focus that was in the
// toolbar as it goes moves to fallback.
export function SelectionToolbar({
  view,
  selection,
  total,
  asOf,
  refresh,
  say,
  fallback,
}: {
  view: ThreadsView;
  selection: Selection;
  total: number;
  asOf: string;
  refresh: () => Promise<unknown>;
  say: (text: string) => void;
  fallback: () => HTMLElement | null | undefined;
}) {
  const action = useAction();
  const [asking, setAsking] = useState<{
    action: ThreadAction;
    acted: Acted;
    question: string;
    submitted: number;
  }>();
  const bar = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useLayoutEffect(() => {
    const shown = bar.current;
    return () => {
      if (shown?.contains(document.activeElement) === true) {
        fallbackRef.current()?.focus();
      }
    };
  }, []);
  // Once a question is answered and the actions are back, focus returns to
  // the action that asked it, unless the operator has put it elsewhere.
  const lastAsked = useRef<ThreadAction>(undefined);
  useLayoutEffect(() => {
    const before = lastAsked.current;
    lastAsked.current = asking?.action;
    if (asking === undefined && before !== undefined && focusLeftWith(bar.current)) {
      bar.current?.querySelector<HTMLButtonElement>(`button[data-action="${before}"]`)?.focus();
    }
  }, [asking]);
  const { chosen, everything } = selection;
  const count = everything ? total : chosen.length;
  // How many threads that match hold an ask open to the operator, for the
  // question declining all of them asks: every one or none while the filters
  // keep a status, and otherwise as the list's counts give it.
  const filtersQuery = query(queryOf(view, threadFilters.shape));
  const kept = statusKept(view);
  const counts = useFollowing(filtersQuery, everything && kept === undefined, () =>
    request<ThreadCounts>("GET", `/threads/counts${filtersQuery}`),
  );
  const holding = kept === undefined ? counts?.status.open : kept === "open" ? total : 0;
  const tooMany = !everything && chosen.length > maxActionThreads;

  // An action on every thread that matches, refused as stale because they
  // number otherwise now, asks again once the list has loaded afresh.
  const [askAgain, setAskAgain] = useState<ThreadAction>();
  // submitted is the selection's revision as the action took what it acts
  // on, so one that lands after the operator chose again clears nothing.
  const perform = async (chosenAction: ThreadAction, acted: Acted, submitted: number) => {
    setAsking(undefined);
    say("");
    const done = await action.run(async (csrf) => {
      if ("threads" in acted) {
        return actOn(chosenAction, acted.threads, csrf);
      }
      try {
        return await request<ThreadActionResult>("POST", "/threads/actions/matching", {
          csrf,
          body: { action: chosenAction, ...acted.matching } satisfies MatchingThreadActionInput,
        });
      } catch (failure) {
        if (failure instanceof ApiFailure && failure.code === "stale") {
          return "stale" as const;
        }
        throw failure;
      }
    });
    if (done === "stale") {
      say("The threads that match have changed since you chose. Look again before you confirm.");
      // Asked again only from the list loaded afresh, and only while the
      // selection is as it was; a load that failed shows why instead.
      if ((await refresh()) === true && selection.revision() === submitted) {
        setAskAgain(chosenAction);
      }
      return;
    }
    if (done !== undefined) {
      say(outcome(chosenAction, done));
      selection.clearIf(submitted);
    }
    void refresh();
  };

  const choose = (chosenAction: ThreadAction) => {
    const acted: Acted = everything
      ? {
          matching: {
            filters: threadFilters.parse(queryOf(view, threadFilters.shape)),
            as_of: asOf,
            expected: total,
          },
        }
      : { threads: targetsOf(chosen) };
    const submitted = selection.revision();
    const asked = question(chosenAction, chosen, everything, total, holding);
    if (asked === undefined) {
      void perform(chosenAction, acted, submitted);
    } else {
      setAsking({ action: chosenAction, acted, question: asked, submitted });
    }
  };

  useEffect(() => {
    if (askAgain !== undefined) {
      setAskAgain(undefined);
      choose(askAgain);
    }
    // choose is this render's, with the list as it loaded afresh.
  }, [askAgain]);

  const declining = everything ? holding !== 0 : chosen.some((each) => each.open_asks.count > 0);
  const offered = (Object.keys(actionLabel) as ThreadAction[]).filter(
    (each) => each !== "decline_read_and_archive" || declining,
  );
  return (
    <ListBar bar={bar}>
      <Failure failure={action.failure} />
      {asking !== undefined ? (
        // Escape answers the question with Cancel, before it would clear the
        // selection.
        <div
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setAsking(undefined);
            }
          }}
        >
          <Confirmation
            question={asking.question}
            confirmLabel={actionLabel[asking.action]}
            disabled={action.pending}
            onConfirm={() => void perform(asking.action, asking.acted, asking.submitted)}
            onCancel={() => setAsking(undefined)}
          />
        </div>
      ) : (
        <div role="group" aria-label={`${count} selected`} className="list-bar-actions">
          <span className="selection-count" aria-hidden="true">
            {count} selected
          </span>
          {tooMany && (
            <p className="selection-note">
              Select at most {maxActionThreads} to act on them together.
            </p>
          )}
          {offered.map((each) => (
            <button
              key={each}
              type="button"
              data-action={each}
              className="secondary"
              disabled={action.pending || tooMany}
              onClick={() => choose(each)}
            >
              {actionLabel[each]}
            </button>
          ))}
          <button type="button" onClick={selection.clear}>
            Done
          </button>
        </div>
      )}
    </ListBar>
  );
}
