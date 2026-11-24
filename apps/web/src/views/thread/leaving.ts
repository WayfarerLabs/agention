import { useEffect, useRef, useState } from "react";
import { describeFailure, PageFailure } from "../../api.ts";
import { type Action, useAction } from "../../data.ts";
import { leaveNotice } from "../../notice.ts";
import { currentListView, listHref, navigate, threadHref } from "../../router.tsx";
import type { ListedThread } from "../list/listing.ts";
import type { AfterSending } from "./Composer.tsx";
import { type AutoAdvance, type Direction, neighborIn, useAutoAdvance } from "./neighbor-thread.ts";
import type { ThreadTarget } from "./writer.ts";

// The ways a thread's page leaves for another: Thread above and Thread below,
// Archive all as Auto-advance says, and a send's way on as After sending
// says. One rule holds for them all: while a way on is under way, or a send
// that will take the page somewhere is on its way, no other way on starts,
// and a send's own way on, once it lands, waits only for the others. Each
// leaves only if the page is still open once it is ready to.

// returnToList leaves the thread page for the list it returns to, as it
// stands when called, replacing the page's history entry, so going back does
// not open the thread again.
export function returnToList(): void {
  navigate(listHref(currentListView()), { replace: true });
}

// The list's status, once a way to the thread above or below went back to it
// at the end of the list that way.
export const endOfList: Record<Direction, string> = {
  above: "No thread above this one in the list.",
  below: "No thread below this one in the list.",
};

// goToNeighbor leaves the thread page for the thread found above or below,
// carrying on the list it was found in, or, at the end that way, for that
// list, which says so. What a send that goes on so sent is said where it
// goes.
function goToNeighbor(
  thread: ListedThread | undefined,
  direction: Direction,
  from: string,
  replace: boolean,
  sent?: string,
): void {
  if (thread === undefined) {
    const end = endOfList[direction];
    leaveNotice(sent === undefined ? end : `${sent} ${end}`);
    navigate(from, { replace });
  } else {
    if (sent !== undefined) {
      leaveNotice(sent, "thread");
    }
    navigate(threadHref(thread.agent, thread.session, thread.number), {
      replace,
      state: { from },
    });
  }
}

// The actions on the thread whose failures a way on can meet.
const archivingWords = "Archiving this thread";
const findingWords = "Finding the thread to open";

// How many times a way to the thread above or below asks for it, while the
// operator keeps changing the list it is found in.
const findingTries = 3;

// failedWords says which action on the thread failed, and why.
export const failedWords = (action: string, failure: unknown) =>
  `${action} failed: ${describeFailure(failure)}`;

// An Archive all under way: where it goes once archived, what the send that
// started it sent, if one did, and the message it archives through at least,
// the one that send wrote, which can lie past the latest the page has loaded.
interface Archiving {
  to: AutoAdvance;
  sent: string | undefined;
  atLeast: number;
}

interface Leaving {
  target: ThreadTarget;
  // The thread as loaded: its latest message, and whether later messages
  // than those on screen remain to load.
  last: number;
  later: boolean;
  // Why the thread's last load failed, and a way to show a message, loading
  // what it takes.
  loadFailure: unknown;
  show: (seq: number) => void;
  // The thread's archive and unread marks, whose actions a mark from a
  // message shares; marking says the latest was one, whose failure is that
  // message's to say.
  archive: Action;
  unread: Action;
  marking: boolean;
  clearMarking: () => void;
  // Posts a mark and, once it lands with the page still open, goes onward.
  leaveWith: (
    action: Action,
    route: "/archive",
    body: { through: number },
    onward: () => void,
  ) => Promise<void>;
  stillOpen: () => boolean;
  // Whether a send is on its way, and where a send takes the page.
  sendPending: boolean;
  after: AfterSending;
}

// useLeaving gives the page's ways on, whether one holds the page, and why
// the last failed.
export function useLeaving({
  target,
  last,
  later,
  loadFailure,
  show,
  archive,
  unread,
  marking,
  clearMarking,
  leaveWith,
  stillOpen,
  sendPending,
  after,
}: Leaving) {
  const [autoAdvance] = useAutoAdvance();
  const finding = useAction();
  // Archive all first shows every message through the thread's latest,
  // loading later pages as needed, then archives through the latest, so it
  // never archives a message the page has not shown: one sent from the page
  // counts only once the page has loaded through it, with the messages before
  // it. When loading them fails, it stops and says so, until the operator
  // chooses it again. Once archived, it goes where Auto-advance says, in place
  // of this page in history, so going back does not return to the archived
  // thread: back to the list, or to the thread that was just above or below
  // it, which the server finds where the thread stands, archived or not.
  // Should finding it fail, the page stays on the thread, archived, and says
  // so.
  const [archivingAll, setArchivingAll] = useState<Archiving>();
  const [showingFailure, setShowingFailure] = useState<unknown>();
  // The failure the thread's last load had when Archive all was chosen.
  const failedBefore = useRef<unknown>(undefined);
  const moving = unread.pending || archive.pending || finding.pending || archivingAll !== undefined;
  const sendGoing = sendPending && after !== "stay";
  // moving and sendGoing as they stand now, not as this render saw them, for
  // a way on started from an action held since, as a send's once it lands:
  // each way on that starts marks moving at once, before the page renders it.
  const movingNow = useRef(moving);
  movingNow.current = moving;
  const sendGoingNow = useRef(sendGoing);
  sendGoingNow.current = sendGoing;
  // start starts a way on, unless another holds it back; one a send starts,
  // which says what it sent, waits only for the others.
  const start = (sent: string | undefined) => {
    if (movingNow.current || (sent === undefined && sendGoingNow.current)) {
      return false;
    }
    movingNow.current = true;
    finding.clear();
    archive.clear();
    setShowingFailure(undefined);
    return true;
  };
  // find asks for the thread above or below in the list the page returns to
  // as it stands now, and goes there, or to the list at its end, saying what
  // a send that went on so sent. Should the operator change that list while
  // the server answers, as the list beside the thread lets them, it asks
  // again in the list as it then stands, so the page keeps their latest
  // choice and the thread it opens is one found in the list it returns to;
  // it asks a few times at most, then stays and says so rather than go by an
  // answer for a list the operator has since left.
  const find = async (direction: Direction, replace: boolean, sent: string | undefined) => {
    const found = await finding.run(async () => {
      let view = currentListView();
      for (let asked = 1; ; asked += 1) {
        const thread = await neighborIn(view, target, direction);
        const now = currentListView();
        if (!stillOpen() || listHref(now) === listHref(view)) {
          return { thread, from: listHref(view) };
        }
        if (asked === findingTries) {
          throw new PageFailure("The list kept changing. Try again.");
        }
        view = now;
      }
    });
    if (found !== undefined && stillOpen()) {
      goToNeighbor(found.thread, direction, found.from, replace, sent);
    }
  };
  const archiveAll = (sent?: string, atLeast = 0) => {
    if (!start(sent)) {
      return;
    }
    clearMarking();
    failedBefore.current = loadFailure;
    setArchivingAll({ to: autoAdvance, sent, atLeast });
    show(Math.max(last, atLeast));
  };
  const openNeighbor = (direction: Direction, sent?: string) => {
    if (start(sent)) {
      void find(direction, false, sent);
    }
  };
  useEffect(() => {
    if (archivingAll === undefined) {
      return;
    }
    const { to, sent, atLeast } = archivingAll;
    if (loadFailure !== undefined && loadFailure !== failedBefore.current) {
      setArchivingAll(undefined);
      setShowingFailure(loadFailure);
    } else if (!later && last >= atLeast) {
      setArchivingAll(undefined);
      void leaveWith(archive, "/archive", { through: last }, () => {
        if (to !== "list") {
          void find(to, true, sent);
        } else {
          if (sent !== undefined) {
            leaveNotice(sent);
          }
          returnToList();
        }
      });
    }
  }, [archivingAll, last, later, loadFailure]);
  // A send's way on, once the server accepts the message.
  const sentOnward = (where: Exclude<AfterSending, "stay">, sent: string, written: number) => {
    if (where === "list") {
      if (start(sent)) {
        leaveNotice(sent);
        returnToList();
      }
    } else if (where === "archive") {
      // Run as Archive all is, through the message sent at least, but left
      // to the server to refuse while an ask is open, since what was just
      // sent may have answered it; a refusal shows, naming the ask.
      archiveAll(sent, written);
    } else {
      openNeighbor(where, sent);
    }
  };
  // A mark from a message says its own failure there.
  const archiveFailure = marking ? undefined : (archive.failure ?? showingFailure);
  return {
    // Whether a way on holds the page, or a send that will take it somewhere
    // is on its way.
    busy: moving || sendGoing,
    // Whether a way on is under way, which holds Send back, so a send never
    // lands to find its own way on refused.
    moving,
    archiveAll,
    openNeighbor,
    sentOnward,
    // Why the way on last failed, which the head says, and the composer too,
    // since a phone's keyboard can hide the head.
    onwardFailure:
      finding.failure !== undefined
        ? failedWords(findingWords, finding.failure)
        : archiveFailure !== undefined
          ? failedWords(archivingWords, archiveFailure)
          : undefined,
  };
}
