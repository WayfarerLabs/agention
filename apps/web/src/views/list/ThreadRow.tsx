import type { AskSummary, OpenAsks, ThreadSummary } from "@wayfarerlabs/agention-api";
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import {
  type FoldLevel,
  focusLanding,
  PathParts,
  placeOf,
  Tags,
  ThreadTitle,
} from "../../components.tsx";
import {
  absenceOf,
  absenceWords,
  DueTime,
  effortLabel,
  plural,
  priorityLabel,
  priorityTone,
  settledWords,
  Spoken,
  threadWhereabouts,
  Time,
} from "../../format.tsx";
import { Mark } from "../../icons.tsx";
import { readDraft } from "../../device.ts";
import { currentListView, Link, listHref, threadHref } from "../../router.tsx";
import { CodeLinksMark, RowCodeLink } from "../code-links.tsx";
import type { ListShown } from "../filter-links.tsx";
import { ListBeside } from "./beside.ts";
import { RowFocusOwed } from "./focus-owed.ts";
import { ListSelection, longPress, threadKey } from "./selection.tsx";

// What stands out about the asks open to the operator: the one the thread
// leads with; the earliest answer-by among them all, whichever ask carries
// it, overdue once the server says it has passed and never by the browser's
// clock, so the row agrees with the Overdue filter; and how many more are
// open.
function askTags(ask: AskSummary, asks: OpenAsks): { label: ReactNode; tone?: string }[] {
  const tone = priorityTone[ask.priority];
  const more = asks.count - 1;
  const due = asks.answer_by === undefined ? undefined : <DueTime value={asks.answer_by} />;
  return [
    { label: priorityLabel[ask.priority], ...(tone === undefined ? {} : { tone }) },
    ...(ask.impact === "blocking"
      ? [{ label: "Blocked on you", tone: "danger" }]
      : ask.impact === "assuming"
        ? [{ label: "Assuming" }]
        : []),
    ...(due === undefined
      ? []
      : [
          asks.overdue
            ? { label: <>Overdue since {due}</>, tone: "warning" }
            : { label: <>Due {due}</> },
        ]),
    ...(ask.effort === undefined ? [] : [{ label: <Spoken {...effortLabel[ask.effort]} /> }]),
    ...(more > 0 ? [{ label: `${more} more open`, tone: "attention" }] : []),
  ];
}

// absenceTags mark a stranded thread with why its session is not there to
// read it, as absenceOf finds: it stopped, with its outcome; it is quiet,
// with when it last checked in; its bridge is not connected; what came of
// the nudge of a session its bridge can nudge; or it has no active
// credential, which the credential's own tag says of any thread, stranded or
// not, unless the stranded mark already does. An ignored thread is marked
// so, in the same tone, with when its agent checked in without reading it.
function absenceTags(thread: ThreadSummary): { label: ReactNode; tone?: string }[] {
  const mark =
    thread.stranded === true ? "Stranded" : thread.ignored === true ? "Ignored" : undefined;
  const absence = mark === undefined ? undefined : absenceOf(threadWhereabouts(thread));
  const label = absence === undefined ? mark : `${mark} · ${absenceWords(absence)}`;
  return [
    ...(label === undefined ? [] : [{ label, tone: "warning" }]),
    ...(thread.credential_active || absence?.kind === "credential"
      ? []
      : [{ label: "No active credential" }]),
  ];
}

// The headings a row or a group's header can sit at: under the list's, or
// under one, two or three levels of groups.
const headings = { 2: "h2", 3: "h3", 4: "h4", 5: "h5" } as const;

// MessageCount says how much of a thread the operator has read: while any
// of its messages is unread, the closed envelope with the unread messages
// over all it holds ("2/5"), and otherwise the open envelope with how many
// it holds ("5").
function MessageCount({ unread, total }: { unread: number; total: number }) {
  return unread > 0 ? (
    <Mark
      icon="unread"
      label={`${unread} of ${plural(total, "message")} unread`}
      shown={`${unread}/${total}`}
      accent
    />
  ) : (
    <Mark icon="read" label={`${plural(total, "message")} read`} shown={total} />
  );
}

// ThreadRow is one thread in the list, marked unread while any message is: a
// link holding its heading, its number leading its title, beside its message
// count and archive mark; where the thread is, its agent, session and topic
// each behind its badge, and when it last changed; for a thread with asks
// open, which the operator as its audience answers, the question of the one
// it leads with: the first in the list's order among those the filters keep;
// otherwise, muted, that its asks were answered or withdrawn; whether it is
// stranded or ignored, and why; and whether this browser keeps a draft of a
// reply to it. The link records the list on screen as it is followed, so the
// thread page returns to it. While its live messages name several pull requests and
// branches, a mark among the others counts them; while they name one,
// beneath the link, that entry, which adds its filter to the list on screen.
//
// Side by side, the row of the thread open beside the list is marked current,
// and opening it again moves focus to where opening it lands, in the
// thread's pane; the row of the thread just left is where going back to the list
// lands; and a row that goes while its link has focus, as the row of a thread
// archived beside the list does once the list follows, gives focus to the
// page's heading, so it is not lost, unless the list's bar owes the rows
// focus (RowFocusOwed), as after a mark key, and places it itself.
//
// Within a list that selects (ListSelection), the row carries a checkbox
// named by its heading, with a mouse or a trackpad, and on a touch screen
// while anything is selected; there a finger held on the row selects it, and
// while anything is selected a tap selects or unselects it in place of
// opening it, or of following its pull request or branch.
export function ThreadRow({
  thread,
  level,
  list,
}: {
  thread: ThreadSummary;
  level: FoldLevel;
  // The list on screen, which the row's one pull request or branch adds to.
  list: ListShown;
}) {
  const href = threadHref(thread.agent, thread.session, thread.number);
  const beside = useContext(ListBeside);
  const current = beside?.open === href;
  const left = beside?.left === href;
  const link = useRef<HTMLAnchorElement>(null);
  const focusOwed = useContext(RowFocusOwed);
  // Whether the list was side by side as the row last showed.
  const sideBySide = useRef(false);
  useLayoutEffect(() => {
    sideBySide.current = beside !== undefined;
  });
  useLayoutEffect(() => {
    const shown = link.current;
    return () => {
      if (
        sideBySide.current &&
        shown !== null &&
        shown === document.activeElement &&
        focusOwed?.current !== true
      ) {
        shown.closest("main")?.querySelector<HTMLElement>("h1")?.focus();
      }
    };
  }, []);
  // Opening the thread already open beside the list lands in its pane.
  const openAgain = () => {
    const page = link.current?.closest("main");
    if (page !== null && page !== undefined) {
      focusLanding(page);
    }
  };
  const selection = useContext(ListSelection);
  const key = threadKey(thread);
  const selected = selection?.isSelected(key) === true;
  const press = usePress(selection === undefined ? undefined : () => selection.toggle(key));
  // On a touch screen, while anything is selected, a tap anywhere on the
  // row selects, its pull request or branch included; one on its checkbox is
  // left to the checkbox, which selects as it changes.
  const tapSelects = selection?.touch === true && selection.selecting;
  const onClickCapture = (event: MouseEvent) => {
    if (tapSelects && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      event.stopPropagation();
      selection.toggle(key);
    }
  };
  const headingId = useId();
  const { open_asks: asks } = thread;
  const ask = asks.lead;
  const Heading = headings[level];
  const status = ask === undefined ? settledWords(thread) : undefined;
  const notes = absenceTags(thread);
  const classes = ["thread-row", thread.unread > 0 ? "unread" : "", selected ? "selected" : ""];
  return (
    <li
      className={classes.filter(Boolean).join(" ")}
      onClickCapture={onClickCapture}
      {...press.handlers}
    >
      {selection !== undefined && (!selection.touch || selection.selecting) && (
        <input
          type="checkbox"
          className="row-select"
          aria-labelledby={headingId}
          checked={selected}
          onChange={() => selection.toggle(key)}
        />
      )}
      <Link
        ref={link}
        to={href}
        state={() => ({ from: listHref(currentListView()) })}
        {...(current ? { follow: openAgain } : {})}
        className="thread-link"
        aria-current={current ? "page" : undefined}
        data-landing={left ? "" : undefined}
        data-needs-you={thread.unread > 0 || asks.blocking ? "" : undefined}
        data-thread={key}
      >
        <div className="row-title">
          <Heading id={headingId}>
            <ThreadTitle thread={thread} />
          </Heading>
          <span className="marks">
            <MessageCount unread={thread.unread} total={thread.message_count} />
            {readDraft(thread) !== undefined && <Mark icon="draft" label="Draft" />}
            {thread.archived && <Mark icon="archive" label="Archived" />}
            <CodeLinksMark links={thread.links} />
          </span>
        </div>
        <p className="where">
          <span className="path">
            <PathParts place={placeOf(thread)} />
          </span>{" "}
          · <Time value={thread.updated_at} />
        </p>
        {ask !== undefined && (
          <>
            <p className="next-ask">{ask.question}</p>
            <Tags tags={askTags(ask, asks)} />
          </>
        )}
        {status !== undefined && (
          <p className="row-status" title={status}>
            {status}
          </p>
        )}
        {notes.length > 0 && <Tags tags={notes} />}
      </Link>
      <RowCodeLink links={thread.links} list={list} />
    </li>
  );
}

// How far a finger may move while held before it is taken for a scroll, in
// pixels.
const pressSlop = 10;

// How long after the finger lifts the click that may follow a press comes,
// in milliseconds; past it, no such click is coming.
const clickAfterLift = 300;

// swallowNextClick keeps the click that may follow a press that selected
// from reaching the page: the row it selected, or whichever row the list,
// changing as the selection begins, has moved under the finger, so it
// listens on the whole page. It stops listening once that click comes, a
// key is pressed or another touch starts, which mean none is coming, or
// shortly after the finger lifts.
function swallowNextClick(): void {
  let timer: number | undefined;
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  const lifted = () => {
    timer = window.setTimeout(stop, clickAfterLift);
  };
  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerdown", stop, true);
    window.removeEventListener("keydown", stop, true);
    window.removeEventListener("pointerup", lifted, true);
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("pointerdown", stop, true);
  window.addEventListener("keydown", stop, true);
  window.addEventListener("pointerup", lifted, true);
}

// usePress selects a row when a finger is held anywhere on it (longPress),
// as a phone selects, and the browser's own menu for a link, which a held
// finger opens, stays shut.
function usePress(select: (() => void) | undefined) {
  const held = useRef<{ timer: number; x: number; y: number }>(undefined);
  const fired = useRef(false);
  const cancel = () => {
    window.clearTimeout(held.current?.timer);
    held.current = undefined;
  };
  // A row that goes, as one archived does, selects nothing after.
  useEffect(() => cancel, []);
  const handlers =
    select === undefined
      ? {}
      : {
          onPointerDown: (event: PointerEvent) => {
            cancel();
            fired.current = false;
            if (event.pointerType !== "touch" || !event.isPrimary) {
              return;
            }
            const timer = window.setTimeout(() => {
              held.current = undefined;
              fired.current = true;
              swallowNextClick();
              select();
            }, longPress);
            held.current = { timer, x: event.clientX, y: event.clientY };
          },
          onPointerMove: (event: PointerEvent) => {
            const start = held.current;
            if (
              start !== undefined &&
              Math.hypot(event.clientX - start.x, event.clientY - start.y) > pressSlop
            ) {
              cancel();
            }
          },
          onPointerUp: cancel,
          onPointerCancel: cancel,
          onContextMenu: (event: MouseEvent) => {
            if (held.current !== undefined || fired.current) {
              event.preventDefault();
            }
          },
        };
  return { handlers };
}

// The links of the rows on the page, in order: a row under a folded header is
// not rendered, so not among them.
export const rowLinks = (): HTMLAnchorElement[] =>
  Array.from(document.querySelectorAll<HTMLAnchorElement>("a.thread-link"));

// needsYou says whether a row's thread is unread or blocked on the operator.
export const needsYou = (link: HTMLAnchorElement) => link.hasAttribute("data-needs-you");
