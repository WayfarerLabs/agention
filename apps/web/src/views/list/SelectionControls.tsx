import { type ThreadSummary } from "@wayfarerlabs/agention-api";
import {
  type MatchingThreadActionInput,
  maxActionThreads,
  statusKept,
  type ThreadAction,
  type ThreadActionInput,
  type ThreadActionResult,
  type ThreadCounts,
  threadFilters,
  type ThreadsView,
} from "@wayfarerlabs/agention-server-api";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiFailure, query, request } from "../../api.ts";
import { BarButton, BarCaption, BarSlots } from "../../action-bar.tsx";
import { Confirmation, focusLeftWith } from "../../components.tsx";
import type { IconName } from "../../icons.tsx";
import { useFollowing } from "../../data.ts";
import { plural } from "../../format.tsx";
import { queryOf } from "../../router.tsx";
import { actionLabel, actOn, outcome, targetsOf } from "./actions.ts";
import { type BarActing, rowOf, useMarkKeys, withFocus } from "./ListBar.tsx";
import type { Selection } from "./selection.tsx";

// The selection's controls: the header above the list, its checkbox
// selecting every thread shown and the offer to select every thread the
// filters keep; and the actions the bar at the list's foot holds while
// anything is selected, which act on what is.

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

// Each action's button in the bar: its icon, and the short label it shows
// in place of its full name.
const actionFace: Record<ThreadAction, { icon: IconName; label: string }> = {
  read: { icon: "read", label: "Read" },
  unread: { icon: "unread", label: "Unread" },
  read_and_archive: { icon: "archive", label: "Archive" },
  decline_read_and_archive: { icon: "decline", label: "Decline" },
};

// What started an action: its button, or a mark key, pressed on a row, named
// by its thread's key, or with focus elsewhere.
type Started = "button" | { row: string | undefined };

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

// SelectionActions is what the bar at the list's foot holds while threads
// are selected: Clear, leading, then the actions on the threads selected,
// each in its fixed place, Decline among them, disabled while no thread
// selected holds an ask open to the operator. An action acts in one request:
// on the threads loaded, at most as many as one action takes; or on every
// thread the filters keep, as of the list's as_of. Declining, and acting on
// every thread that matches, ask first, in the bar's place, and what they act
// on is taken as they ask, so what is sent is what was on screen; refused as
// stale, acting on every thread that matches loads the list afresh and asks
// again. An action stays under way until the list has tried to load
// afresh; once it is done it says what it did and clears the selection, so
// what the bar offers then is what the list holds, or, when that load
// failed, the list's own error and its retry show. Focus it left goes back to its button
// while the selection stays, as when it failed. Focus in the bar as the
// selection clears, as Clear clears it, goes where the bar sends it. The mark
// keys choose Mark read or Mark unread, as their buttons do, while those
// could. Pressed on a row, focus goes back to it, or the row in its place
// should it leave the list, where it would go back to the button: once the
// action is done, and once its question is answered with Cancel. Pressed
// with focus elsewhere, as in the thread beside the list, focus stays there
// unless a question takes it.
export function SelectionActions({
  view,
  selection,
  total,
  asOf,
  refresh,
  say,
  acting,
}: {
  view: ThreadsView;
  selection: Selection;
  total: number;
  asOf: string;
  refresh: () => Promise<boolean>;
  say: (text: string) => void;
  acting: BarActing;
}) {
  const { bar, pending, run, press, fromRow, leave, keys } = acting;
  // Focus is still in the bar as these actions go, before they leave it.
  useLayoutEffect(() => {
    const shown = bar.current;
    return () => {
      if (shown?.contains(document.activeElement) === true) {
        leave();
      }
    };
  }, [bar, leave]);
  const [asking, setAsking] = useState<{
    action: ThreadAction;
    acted: Acted;
    question: string;
    submitted: number;
    started: Started;
  }>();
  // The button of an action, which a question asked first stands in place
  // of.
  const buttonOf = (chosen: ThreadAction) =>
    bar.current?.querySelector<HTMLButtonElement>(`button[data-action="${chosen}"]`);
  // Once a question is answered with Cancel and the actions are back, focus
  // returns to the action that asked it, or the row its key was pressed on,
  // unless the operator has put it elsewhere; answered with the action, it
  // returns once that is done.
  const lastAsked = useRef<{ action: ThreadAction; started: Started }>(undefined);
  useLayoutEffect(() => {
    const before = lastAsked.current;
    lastAsked.current = asking;
    if (asking === undefined && before !== undefined && !pending && focusLeftWith(bar.current)) {
      const row = before.started === "button" ? undefined : rowOf(before.started.row);
      (row ?? buttonOf(before.action))?.focus();
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
  const [askAgain, setAskAgain] = useState<{ action: ThreadAction; started: Started }>();
  // submitted is the selection's revision as the action took what it acts
  // on, so one that lands after the operator chose again clears nothing;
  // started, what started it, where focus then goes back.
  const perform = async (
    chosenAction: ThreadAction,
    acted: Acted,
    submitted: number,
    started: Started,
  ) => {
    if (started === "button") {
      press(() => buttonOf(chosenAction));
    } else if (started.row !== undefined) {
      fromRow(started.row);
    } else if (asking !== undefined) {
      // A key pressed away from any row asked first, so focus is on the
      // question's answer, which goes as the actions come back: it returns
      // to the action, as a Cancel does.
      press(() => buttonOf(chosenAction));
    }
    setAsking(undefined);
    say("");
    const send = async (csrf: string | undefined) => {
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
    };
    const done = await run(actionLabel[chosenAction], async (csrf) => {
      const result = await send(csrf);
      return { result, loaded: await refresh() };
    });
    if (done === undefined) {
      // The server may have acted before the answer was lost, as when the
      // connection dropped, so the list shows what it holds now.
      void refresh();
      return;
    }
    if (done.result === "stale") {
      say("The threads that match have changed since you chose. Look again before you confirm.");
      // Asked again only from the list loaded afresh, and only while the
      // selection is as it was; a load that failed shows why instead.
      if (done.loaded && selection.revision() === submitted) {
        setAskAgain({ action: chosenAction, started });
      }
      return;
    }
    say(outcome(chosenAction, done.result));
    selection.clearIf(submitted);
  };

  const choose = (chosenAction: ThreadAction, started: Started) => {
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
      void perform(chosenAction, acted, submitted, started);
    } else {
      setAsking({ action: chosenAction, acted, question: asked, submitted, started });
    }
  };

  useEffect(() => {
    if (askAgain !== undefined) {
      setAskAgain(undefined);
      choose(askAgain.action, askAgain.started);
    }
    // choose is this render's, with the list as it loaded afresh.
  }, [askAgain]);

  useMarkKeys(keys, (chosenAction, current) => {
    if (asking === undefined && !pending && !tooMany) {
      choose(chosenAction, { row: withFocus(current) });
    }
  });

  const declining = everything ? holding !== 0 : chosen.some((each) => each.open_asks.count > 0);
  return (
    <>
      {asking !== undefined ? (
        // Escape answers the question with Cancel, before it would clear the
        // selection.
        <div
          className="bar-confirm"
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
            disabled={pending}
            onConfirm={() =>
              void perform(asking.action, asking.acted, asking.submitted, asking.started)
            }
            onCancel={() => setAsking(undefined)}
          />
        </div>
      ) : (
        <>
          {/* The group of actions is named by the count, so the caption's
              copy of it is hidden from assistive technology. */}
          <BarCaption ownLine aria-hidden>
            {count} selected
          </BarCaption>
          {tooMany && (
            <BarCaption ownLine reason>
              Select at most {maxActionThreads} to act on them together.
            </BarCaption>
          )}
          <BarSlots group={`${count} selected`}>
            <BarButton
              icon="close"
              label="Clear"
              name="Clear selection"
              onClick={() => selection.clear()}
            />
            {(Object.keys(actionLabel) as ThreadAction[]).map((each, index) => (
              <BarButton
                key={each}
                {...actionFace[each]}
                name={actionLabel[each]}
                trailing={index === 0}
                action={each}
                disabled={pending || tooMany || (each === "decline_read_and_archive" && !declining)}
                onClick={() => choose(each, "button")}
              />
            ))}
          </BarSlots>
        </>
      )}
    </>
  );
}
