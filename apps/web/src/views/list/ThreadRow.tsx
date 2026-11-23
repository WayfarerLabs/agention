import type { AskSummary, OpenAsks, ThreadSummary } from "@wayfarerlabs/agention-api";
import { type ReactNode, useContext, useLayoutEffect, useRef } from "react";
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
import { ListBeside } from "./beside.ts";

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

// strandedTags mark a stranded thread with why its session is not there to
// read it: it stopped, with its outcome; it is quiet, with when it was last
// seen; or it has no active credential, which the credential's own tag says
// of any thread, stranded or not, unless the stranded mark already does.
function strandedTags(thread: ThreadSummary): { label: ReactNode; tone?: string }[] {
  const absence = thread.stranded === true ? absenceOf(threadWhereabouts(thread)) : undefined;
  const stranded = absence === undefined ? "Stranded" : `Stranded · ${absenceWords(absence)}`;
  return [
    ...(thread.stranded === true ? [{ label: stranded, tone: "warning" }] : []),
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
// otherwise, muted, that its asks were answered or withdrawn; and whether it
// is stranded, and why; and whether this browser keeps a draft of a reply to
// it. The link records the list on screen as it is followed, so the thread
// page returns to it.
//
// Side by side, the row of the thread open beside the list is marked current,
// and opening it again moves focus to where opening it lands, the thread's
// pane; the row of the thread just left is where going back to the list
// lands; and a row that goes while its link has focus, as the row of a thread
// archived beside the list does once the list follows, gives focus to the
// page's heading, so it is not lost.
export function ThreadRow({ thread, level }: { thread: ThreadSummary; level: FoldLevel }) {
  const href = threadHref(thread.agent, thread.session, thread.number);
  const beside = useContext(ListBeside);
  const current = beside?.open === href;
  const left = beside?.left === href;
  const link = useRef<HTMLAnchorElement>(null);
  // Whether the list was side by side as the row last showed.
  const sideBySide = useRef(false);
  useLayoutEffect(() => {
    sideBySide.current = beside !== undefined;
  });
  useLayoutEffect(() => {
    const shown = link.current;
    return () => {
      if (sideBySide.current && shown !== null && shown === document.activeElement) {
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
  const { open_asks: asks } = thread;
  const ask = asks.lead;
  const Heading = headings[level];
  const status = ask === undefined ? settledWords(thread) : undefined;
  const notes = strandedTags(thread);
  return (
    <li className={thread.unread > 0 ? "thread-row unread" : "thread-row"}>
      <Link
        ref={link}
        to={href}
        state={() => ({ from: listHref(currentListView()) })}
        {...(current ? { follow: openAgain } : {})}
        className="thread-link"
        aria-current={current ? "page" : undefined}
        data-landing={left ? "" : undefined}
        data-needs-you={thread.unread > 0 || asks.blocking ? "" : undefined}
      >
        <div className="row-title">
          <Heading>
            <ThreadTitle thread={thread} />
          </Heading>
          <span className="marks">
            <MessageCount unread={thread.unread} total={thread.message_count} />
            {readDraft(thread) !== undefined && <Mark icon="draft" label="Draft" />}
            {thread.archived && <Mark icon="archive" label="Archived" />}
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
    </li>
  );
}

// The links of the rows on the page, in order: a row under a folded header is
// not rendered, so not among them.
export const rowLinks = (): HTMLAnchorElement[] =>
  Array.from(document.querySelectorAll<HTMLAnchorElement>("a.thread-link"));

// needsYou says whether a row's thread is unread or blocked on the operator.
export const needsYou = (link: HTMLAnchorElement) => link.hasAttribute("data-needs-you");
