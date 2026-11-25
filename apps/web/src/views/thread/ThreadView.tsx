import type {
  CursorsResult,
  MarkInput,
  Marks,
  MarksResult,
  Message,
  ThreadGetResult,
  ThreadSummary,
  ThreadsView,
  UnreadInput,
} from "@wayfarerlabs/agention-api";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { describeFailure, query, request, threadPath } from "../../api.ts";
import { useDraftFiles } from "../../attach/attach.ts";
import {
  Loadable,
  PageHeading,
  PathPart,
  Tags,
  ThreadTitle,
  usePageTitle,
} from "../../components.tsx";
import {
  type Reading,
  useAction,
  useFresh,
  useReading,
  useResource,
  useStillOpen,
} from "../../data.ts";
import { readDraft } from "../../device.ts";
import {
  AbsenceReason,
  absenceOf,
  plural,
  settledWords,
  Spoken,
  threadWhereabouts,
  Time,
} from "../../format.tsx";
import { Icon, Mark } from "../../icons.tsx";
import { useShortcuts } from "../../keyboard.tsx";
import { takeNotice } from "../../notice.ts";
import { Link, listHref, navigate, threadPathParts, useListView } from "../../router.tsx";
import { useVoiceOn } from "../../voice/Dictation.tsx";
import { Composer, useAfterSending } from "./Composer.tsx";
import { ThreadCodeLinks } from "./CodeLinks.tsx";
import { ThreadFiles } from "./files/FileList.tsx";
import { type MessageContext, MessageList, mine, suggestionChoices } from "./Messages.tsx";
import { returnToList, useLeaving } from "./leaving.ts";
import {
  blank,
  keptParts,
  type Staged,
  type StagedAnswer,
  staleChange,
  type ThreadTarget,
  useWriter,
  wordsFailure,
} from "./writer.ts";

// The thread page follows email: what is on screen is read, actions on the
// thread as a whole sit in its head, and answering happens on the message
// that asked, sent by the composer at the foot, with the way back to the
// list under it as well as in the head.

// The messages the page shows at first, and adds each time it shows more.
const pageSize = 50;
// The most messages one request reads.
const requestLimit = 100;

// The messages on screen: from start through end, or through the latest.
interface Span {
  start: number;
  end: number | "latest";
}

// readThrough is how far the operator has read a thread: through the greater
// of their read and archive marks, since an archived message is never
// unread.
const readThrough = (marks: Marks) => Math.max(marks.read_through, marks.archived_through);

// isUnread says whether a message is unread: a live message of the agent's
// beyond how far the operator has read, as the thread's unread count counts
// them.
const isUnread = (message: Message, marks: Marks) =>
  message.seq > readThrough(marks) && message.live && !mine(message);

// openingSpan picks the page the view opens on: the newest page, unless the
// operator's first unread message after those they archived comes before
// it, when the page starts there.
function openingSpan(answer: ThreadGetResult): Span {
  const { last_seq: last } = answer.thread;
  const newest = Math.max(1, last - pageSize + 1);
  const firstUnread = readThrough(answer.marks) + 1;
  const start = firstUnread <= last ? Math.min(newest, firstUnread) : newest;
  const end = start + pageSize - 1;
  return { start, end: end >= last ? "latest" : end };
}

interface LoadedThread extends ThreadGetResult {
  // Whether messages come before or after the ones on screen.
  earlier: boolean;
  later: boolean;
}

// useThread loads the thread and the span of its messages on screen. The
// first load chooses the span; each refresh reloads it, following the latest
// messages when the span reaches them. reach extends the span through a
// message the operator has seen elsewhere, among a stale write's missed
// messages or as their own write, so the log never stops short of what was
// read; show extends it to hold a message, such as an open ask, and says
// whether it had to.
function useThread(target: ThreadTarget) {
  const path = threadPath(target.agent, target.session, target.number);
  const span = useRef<Span>(undefined);
  // The thread's latest message, as loaded.
  const latest = useRef(0);
  // The latest message the operator has seen outside the log, which a load
  // shows only once it finishes.
  const [reached, setReached] = useState(0);
  const resource = useResource<LoadedThread>(async (signal) => {
    if (span.current === undefined) {
      span.current = openingSpan(
        await request<ThreadGetResult>("GET", `${path}${query({ limit: 1 })}`, { signal }),
      );
    }
    const { start, end } = span.current;
    const through = end === "latest" ? Number.MAX_SAFE_INTEGER : end;
    const messages: Message[] = [];
    let after = start - 1;
    let answer: ThreadGetResult;
    do {
      const limit = Math.min(requestLimit, through - after);
      answer = await request<ThreadGetResult>("GET", `${path}${query({ after, limit })}`, {
        signal,
      });
      messages.push(...answer.messages);
      after = messages.at(-1)?.seq ?? after;
    } while (answer.messages.length > 0 && after < Math.min(through, answer.thread.last_seq));
    latest.current = Math.max(latest.current, answer.thread.last_seq);
    return { ...answer, messages, earlier: start > 1, later: after < answer.thread.last_seq };
  });
  const { refresh } = resource;
  const extend = useCallback(
    (seq: number): boolean => {
      const current = span.current;
      if (current === undefined) {
        return false;
      }
      const start = Math.min(current.start, Math.max(1, seq));
      const end =
        current.end === "latest" || seq <= current.end
          ? current.end
          : seq >= latest.current
            ? "latest"
            : seq;
      if (start === current.start && end === current.end) {
        return false;
      }
      span.current = { start, end };
      refresh();
      return true;
    },
    [refresh],
  );
  const earlier = useCallback(() => {
    if (span.current !== undefined) {
      extend(span.current.start - pageSize);
    }
  }, [extend]);
  const later = useCallback(() => {
    const current = span.current;
    if (current !== undefined && current.end !== "latest") {
      extend(current.end + pageSize);
    }
  }, [extend]);
  const reach = useCallback((seq: number) => {
    setReached((current) => Math.max(current, seq));
    const current = span.current;
    if (current !== undefined && current.end !== "latest" && seq > current.end) {
      span.current = { ...current, end: seq >= latest.current ? "latest" : seq };
    }
  }, []);
  return { ...resource, earlier, later, reach, show: extend, reached };
}

// A place the page moves focus to: a message, or the card of an ask on it.
interface Place {
  seq: number;
  ask?: number;
}

// A stop of the jump to unread: a place, or, where messages the page has not
// loaded hold unread ones, the first of those messages, which the jump shows
// through load before it looks again.
interface Stop extends Place {
  load?: number;
}

// threadOrder orders places as the thread does: by message, and on one
// message, a card after the message and by ask number.
const threadOrder = (a: Place, b: Place) => a.seq - b.seq || (a.ask ?? 0) - (b.ask ?? 0);

// jumpStops lists the stops of the jump to unread in thread order, and counts
// the unread messages, those the page marks unread (unreadHere) and those it
// has not loaded, and the open asks it goes to. Its stops are each unread message and
// each ask the thread's summary lists, the 50 most pressing open to the
// operator, read or not, the card standing for its message.
function jumpStops(
  data: LoadedThread,
  unreadHere: ReadonlySet<number>,
): { stops: Stop[]; unread: number; asks: number } {
  const { thread, messages, marks } = data;
  const asks: Stop[] = thread.open_asks.asks.map((ask) => ({ seq: ask.seq, ask: ask.number }));
  const asking = new Set(asks.map((ask) => ask.seq));
  const marked = messages.filter((message) => message.live && unreadHere.has(message.seq));
  const unread: Stop[] = marked
    .filter((message) => !asking.has(message.seq))
    .map((message) => ({ seq: message.seq }));
  // The thread counts the unread messages; those the page has not loaded lie
  // before the first message it has, where the jump shows them all from the
  // first, since the page shows one run of messages, or after the last, where
  // it shows the next page.
  const hidden = Math.max(
    0,
    thread.unread - messages.filter((message) => isUnread(message, marks)).length,
  );
  const read = readThrough(marks);
  const first = messages[0]?.seq ?? 1;
  const after = Math.max(read, messages.at(-1)?.seq ?? 0);
  const unseen: Stop[] =
    hidden === 0
      ? []
      : [
          ...(read + 1 < first ? [{ seq: read + 1, load: read + 1 }] : []),
          ...(after < thread.last_seq ? [{ seq: after + 1, load: after + pageSize }] : []),
        ];
  return {
    stops: [...asks, ...unread, ...unseen].sort(threadOrder),
    unread: marked.length + hidden,
    asks: asks.length,
  };
}

export function ThreadView({
  agent,
  session,
  thread: number,
}: {
  agent: string;
  session: string;
  thread: number;
}) {
  const target = useMemo(() => ({ agent, session, number }), [agent, session, number]);
  // The list the page returns to, which the list beside it side by side can
  // change while it is open.
  const origin = useListView();
  // What the thread page that opened this one after sending left to say: what
  // it sent, which the composer says beside Send. It is taken at once, before
  // the thread loads, so none is left for a later page.
  const [arrived, setArrived] = useState<string>();
  useEffect(() => {
    const notice = takeNotice("thread");
    if (notice !== undefined) {
      setArrived(notice);
    }
  }, []);
  const loaded = useThread(target);
  // Whether the messages the operator archived are unfolded.
  const [unfolded, setUnfolded] = useState(false);
  // The page never claims to have seen what it has not shown: every write
  // states the last message loaded, or a later one the operator read or wrote
  // before the log caught up with it, those folded away included, since the
  // operator archived them. Marking read states it only once it is on
  // screen, so the page never reads archived messages while they are folded.
  const shown = Math.max(loaded.data?.messages.at(-1)?.seq ?? 0, loaded.reached);
  const onScreen = unfolded || shown > (loaded.data?.marks.archived_through ?? 0) ? shown : 0;
  const { data } = loaded;
  const reading = useReading(
    useMemo(
      () => (data === undefined ? undefined : { through: onScreen, read: data.marks.read_through }),
      [data, onScreen],
    ),
    (through, csrf) =>
      request<CursorsResult>("POST", threadPath(agent, session, number, "/read"), {
        csrf,
        body: { through },
      }),
    loaded.refresh,
  );
  // The agent's messages that were unread when the page showed them stay
  // marked new and unread until the operator leaves the page.
  const fresh = useFresh(
    useMemo(
      () =>
        data?.messages
          .filter((message) => isUnread(message, data.marks))
          .map((message) => message.seq),
      [data],
    ),
  );
  usePageTitle(loaded.data?.thread.title ?? `Thread ${number}`);
  return (
    <Loadable data={loaded.data} failure={loaded.failure} retry={loaded.refresh}>
      {(data) => (
        <ThreadPage
          data={data}
          target={target}
          origin={origin}
          shown={shown}
          reading={reading}
          fresh={fresh}
          loaded={loaded}
          unfolded={unfolded}
          setUnfolded={setUnfolded}
          arrived={arrived}
        />
      )}
    </Loadable>
  );
}

function ThreadPage({
  data,
  target,
  origin,
  shown,
  reading,
  fresh,
  loaded,
  unfolded,
  setUnfolded,
  arrived,
}: {
  data: LoadedThread;
  target: ThreadTarget;
  origin: ThreadsView;
  shown: number;
  reading: Reading;
  fresh: ReadonlySet<number>;
  loaded: ReturnType<typeof useThread>;
  unfolded: boolean;
  setUnfolded: (unfolded: boolean) => void;
  arrived: string | undefined;
}) {
  const { thread, messages, cursors, marks } = data;
  const { reach, refresh, show } = loaded;
  const written = useCallback(
    (through?: number) => {
      if (through !== undefined) {
        reach(through);
      }
      refresh();
    },
    [reach, refresh],
  );
  const writer = useWriter(target, written);
  // Where a message the server accepts takes the operator.
  const [after, setAfter] = useAfterSending();
  // The messages the page shows as they stand, which a change judges once its
  // asks load, with those a stale write missed, which the writer gives exactly
  // (missedNow). It is set as the page renders, as the composer's own is,
  // since the change reads it after a wait that a refresh can end; a refresh
  // can still land one render too late to count.
  const shownNow = useRef(messages);
  shownNow.current = messages;
  const unread = useAction();
  const archive = useAction();
  // The draft this browser kept for the thread, which the composer opens
  // with.
  const [restored] = useState(() => readDraft(target));
  const [text, setText] = useState(restored?.text ?? "");
  const [detail, setDetail] = useState(restored?.detail ?? "");
  // Whether the composer's Details box shows: once opened, or once a change
  // or an edit loads a detail into it, it stays while it is in use, emptied
  // or not, until a write empties it or the change or edit is removed.
  const [detailsShown, setDetailsShown] = useState(
    restored !== undefined && !blank(restored.detail),
  );
  const [staged, setStaged] = useState<Staged | undefined>(undefined);
  // The asks whose cards are recording their own words.
  const [answersRecording, setAnswersRecording] = useState<ReadonlySet<number>>(new Set());
  const voiceOn = useVoiceOn();
  // How many drafts have ended, sent or discarded, which the composer counts.
  const draftsEnded = useRef(0);
  const files = useDraftFiles(target);
  // Kept files belong to the replacement staged, which loaded them, so they
  // go once none is staged: removed, sent, or dropped by what landed since.
  // They go before the page paints, so it never shows them unstaged.
  const { dropKept } = files;
  useLayoutEffect(() => {
    if (staged?.replaces === undefined) {
      dropKept();
    }
  }, [staged, dropKept]);
  // A refusal of an answer's own words belongs to the answers sent: it shows
  // while they stay staged as they were sent, and goes once they change.
  const [sentStaged, setSentStaged] = useState<Staged>();
  // The messages the operator wrote on this page.
  const [writtenHere, setWrittenHere] = useState<ReadonlySet<number>>(new Set());
  const archiveAllHint = useId();
  // The operator is every thread's audience, so its open asks are open to
  // them.
  const openCount = thread.open_asks.count;
  // archiveHint says which ask to answer or decline before archiving through
  // a message: the earliest open to the operator, when it is in that message
  // or before it.
  const archiveHint = (seq: number) => {
    const earliest = thread.open_asks.earliest;
    return earliest !== undefined && earliest.seq <= seq
      ? `Answer or decline ask ${earliest.number} first.`
      : undefined;
  };

  // Marking unread from a message returns to the list, and archiving all of
  // the thread goes where Auto-advance says, as email does, so the page does
  // not read the thread again at once; the page they leave is replaced, so
  // going back does not either. One that lands after the operator moved on to
  // another page leaves them there. Archiving through a message stays on the
  // page. Going to the list goes to it as it stands once the change lands
  // (returnToList), which side by side the list beside the thread may have
  // changed meanwhile.
  const stillOpen = useStillOpen();
  // The message the latest mark from a message was made from, and the mark.
  const [markedFrom, setMarkedFrom] = useState<{ seq: number; mark: "unread" | "archive" }>();
  const leaveWith = async (
    action: ReturnType<typeof useAction>,
    route: "/unread" | "/archive",
    body: UnreadInput | MarkInput,
    onward: () => void = returnToList,
  ) => {
    const done = await action.run((csrf) =>
      request<CursorsResult | MarksResult>(
        "POST",
        threadPath(target.agent, target.session, target.number, route),
        { csrf, body },
      ),
    );
    if (done !== undefined && stillOpen()) {
      onward();
    }
  };
  // Thread above and Thread below, Archive all and a send's way on
  // (useLeaving).
  const ways = useLeaving({
    target,
    last: data.thread.last_seq,
    later: data.later,
    loadFailure: loaded.failure,
    show,
    archive,
    unread,
    marking: markedFrom !== undefined,
    clearMarking: () => setMarkedFrom(undefined),
    archiveAndLeave: (through, onward) => leaveWith(archive, "/archive", { through }, onward),
    stillOpen,
    sendPending: writer.pending,
    after,
  });
  const { busy, archiveAll, openNeighbor, onwardFailure: failedOnward } = ways;
  const leaving = busy || reading.pending;
  // Archiving through a message stays on the page, where the messages
  // archived fold away, and focus moves to the fold.
  const fold = useRef<HTMLButtonElement>(null);
  const [toFold, setToFold] = useState(false);
  const archiveThrough = async (message: Message) => {
    setMarkedFrom({ seq: message.seq, mark: "archive" });
    const done = await archive.run((csrf) =>
      request<MarksResult>(
        "POST",
        threadPath(target.agent, target.session, target.number, "/archive"),
        {
          csrf,
          body: { through: message.seq } satisfies MarkInput,
        },
      ),
    );
    if (done !== undefined) {
      setUnfolded(false);
      setToFold(true);
      refresh();
    }
  };
  // Why the latest mark from a message failed.
  const markFailure =
    markedFrom === undefined
      ? undefined
      : markedFrom.mark === "archive"
        ? archive.failure
        : unread.failure;
  const archivedThrough = marks.archived_through;
  // A message the operator writes while the thread is archived for them is
  // archived with the rest, but stays in view until they leave the page.
  const keptInView = [...writtenHere].filter((seq) => seq <= archivedThrough);
  // The page marks unread the messages that were unread when it showed them,
  // until the archive mark covers them: a message archived since folds away.
  const unreadHere = useMemo(
    () => new Set([...fresh].filter((seq) => seq > archivedThrough)),
    [fresh, archivedThrough],
  );
  // The messages archived fold into one line at the top, once the earliest
  // message loaded is one of them or follows them.
  const folding = archivedThrough > 0 && (messages[0]?.seq ?? 1) <= archivedThrough + 1;
  useLayoutEffect(() => {
    if (toFold && folding) {
      fold.current?.focus();
      setToFold(false);
    }
  }, [toFold, folding]);
  const listed =
    folding && !unfolded
      ? messages.filter(
          (message) => message.seq > archivedThrough || keptInView.includes(message.seq),
        )
      : messages;
  // The archived divider leads the first message listed after the archive
  // mark while the messages archived are unfolded; folded, their fold marks
  // where they end. It shows only where the mark meets the messages loaded,
  // which is when they fold, and never while nothing listed follows it.
  const firstAfterArchived =
    unfolded && folding ? listed.find((message) => message.seq > archivedThrough)?.seq : undefined;

  // focusOn shows a message, loading its page when needed, then moves focus
  // to it, or to an ask's card on it. When that load fails, focus stays
  // where it is, and a later load never moves it.
  const [focusing, setFocusing] = useState<{ place: Place; failedBefore: unknown }>();
  const focusOn = useCallback(
    (place: Place) => {
      setFocusing({ place, failedBefore: loaded.failure });
      show(place.seq);
    },
    [show, loaded.failure],
  );
  useLayoutEffect(() => {
    if (focusing === undefined) {
      return;
    }
    const { place, failedBefore } = focusing;
    if (loaded.failure !== undefined && loaded.failure !== failedBefore) {
      setFocusing(undefined);
    } else if (messages.some((message) => message.seq === place.seq)) {
      document
        .getElementById(place.ask === undefined ? `message-${place.seq}` : `ask-${place.ask}`)
        ?.focus();
      setFocusing(undefined);
    }
  }, [focusing, messages, loaded.failure]);

  // The jump to unread goes to its next stop after the last it went to,
  // starting after what the operator had read when the page opened and
  // wrapping round. Reaching messages not loaded, it shows them and looks
  // again once they load; when that load fails, or would load nothing, the
  // press ends there.
  const jump = useMemo(() => jumpStops(data, unreadHere), [data, unreadHere]);
  const [openedThrough] = useState(() => readThrough(data.marks));
  const jumped = useRef<Place>(undefined);
  const [seeking, setSeeking] = useState<{ failedBefore: unknown }>();
  useEffect(() => {
    if (seeking === undefined) {
      return;
    }
    if (loaded.failure !== undefined && loaded.failure !== seeking.failedBefore) {
      setSeeking(undefined);
      return;
    }
    const from = jumped.current;
    const next =
      jump.stops.find((stop) =>
        from === undefined ? stop.seq > openedThrough : threadOrder(stop, from) > 0,
      ) ?? jump.stops[0];
    if (next?.load !== undefined) {
      if (!show(next.load) && !loaded.loading) {
        setSeeking(undefined);
      }
      return;
    }
    setSeeking(undefined);
    if (next !== undefined) {
      jumped.current = next;
      focusOn(next);
    }
  }, [seeking, jump, openedThrough, show, focusOn, loaded.failure, loaded.loading]);
  // Its label says where it goes, and how many there are: unread messages
  // while there are any, otherwise the open asks it goes round.
  const jumpTo =
    jump.unread > 0
      ? { label: "Jump to unread", count: jump.unread, one: "unread message" }
      : jump.asks > 0
        ? { label: "Jump to open ask", count: jump.asks, one: "open ask" }
        : undefined;

  const find = useCallback(
    (seq: number) => messages.find((message) => message.seq === seq),
    [messages],
  );
  // A change or an edit is a whole message, so it starts only from an empty
  // composer, loading the text, detail and files of the message it replaces,
  // before anything is staged, and stages the parts it carries again
  // unchanged. A change also needs the asks its message
  // answered, from the page or from the server; a message that fails to load
  // stages nothing.
  const drafting = staged !== undefined || !blank(text) || !blank(detail) || files.files.length > 0;
  const loading = useAction();
  const messagesAt = async (seqs: number[]): Promise<Message[] | undefined> => {
    const onPage = seqs.flatMap((seq) => find(seq) ?? []);
    const missing = seqs.filter((seq) => find(seq) === undefined);
    if (missing.length === 0) {
      return onPage;
    }
    const fetched = await loading.run(() =>
      Promise.all(
        missing.map(async (seq) => {
          const answer = await request<ThreadGetResult>(
            "GET",
            `${threadPath(target.agent, target.session, target.number)}${query({ after: seq - 1, limit: 1 })}`,
          );
          const [message] = answer.messages;
          if (message?.seq !== seq) {
            throw new Error(`message #${seq} is not in this thread`);
          }
          return message;
        }),
      ),
    );
    return fetched === undefined ? undefined : [...onPage, ...fetched];
  };
  const replace = (message: Message, staging: Staged) => {
    setText(message.text ?? "");
    setDetail(message.detail ?? "");
    if (message.detail !== undefined) {
      setDetailsShown(true);
    }
    files.keep(message);
    setStaged(staging);
  };
  // changeAnswers turns the card of every live ask a message answered back
  // into choices with its answers loaded, and moves focus to the first.
  const changeAnswers = async (message: Message) => {
    // An answer to an ask its requester since revised or retracted goes with
    // the message; the change answers again the rest.
    const answers = (message.answers ?? []).filter((answer) => answer.ask_live);
    const dropped = (message.answers ?? [])
      .filter((answer) => !answer.ask_live)
      .map((answer) => answer.ask);
    const asking = await messagesAt([...new Set(answers.map((answer) => answer.ask_seq))]);
    if (asking === undefined) {
      return;
    }
    const staging = answers.flatMap((answer): StagedAnswer[] => {
      const ask = asking
        .find((each) => each.seq === answer.ask_seq)
        ?.asks?.find((each) => each.number === answer.ask);
      if (ask === undefined) {
        return [];
      }
      const labels = ask.suggestions.map((suggestion) => suggestion.label);
      return [
        {
          ask: answer.ask,
          seq: answer.ask_seq,
          labels,
          answer: {
            picks: answer.picks ?? [],
            // Words beside picks are notes; without them, they are Other's.
            other: labels.length > 0 && answer.picks === undefined && answer.text !== undefined,
            words: answer.text ?? "",
            declined: answer.declined,
          },
        },
      ];
    });
    if (staging.length === 0) {
      return;
    }
    // What the page learned while the asks loaded, as the page refreshed, a
    // stale write missed it or the asks arrived, judges the change as it
    // would one staged then: a message that replaced this one drops it, and
    // one that revised an ask drops its answer. A message no longer live was
    // replaced, by a message the page may not hold, since a page shows only
    // part of the thread, so it counts as replaced too.
    const change: Staged = {
      kind: "answers",
      answers: staging,
      replaces: message.seq,
      kept: keptParts(message),
      ...(dropped.length === 0 ? {} : { dropped }),
    };
    const learned = [...shownNow.current, ...(writer.missedNow() ?? []), ...asking];
    const judged = staleChange(change, [
      ...learned,
      ...learned.filter((each) => !each.live).map((each) => ({ replaces: each.seq })),
    ]);
    const left = judged === undefined ? change : judged.left;
    if (left === undefined) {
      return;
    }
    replace(message, left);
    // With no live ask left, the change is an edit of the message's text.
    const cards = left.kind === "answers" ? left.answers : [];
    const [first] = cards;
    if (first === undefined) {
      return;
    }
    // A card among the archived messages shows once they unfold.
    if (cards.some((each) => each.seq <= marks.archived_through)) {
      setUnfolded(true);
    }
    focusOn({ seq: first.seq, ask: first.ask });
  };
  // unstage drops what is staged; a change or an edit takes the text,
  // detail and files it loaded with it, and folds the Details box. Files
  // added meanwhile stay.
  const unstage = () => {
    if (staged?.replaces !== undefined) {
      setText("");
      setDetail("");
      setDetailsShown(false);
    }
    setStaged(undefined);
  };
  const context: MessageContext = {
    target,
    find,
    actions: {
      staged,
      stage: setStaged,
      drafting,
      loading: loading.pending,
      wordsFailure: (ask) =>
        staged !== undefined && staged === sentStaged
          ? wordsFailure(writer.failure, staged, ask)
          : undefined,
      voiceOn,
      writing: writer.pending,
      draftsEnded: () => draftsEnded.current,
      recording: (ask, active) =>
        setAnswersRecording((current) => {
          if (current.has(ask) === active) {
            return current;
          }
          const next = new Set(current);
          if (active) {
            next.add(ask);
          } else {
            next.delete(ask);
          }
          return next;
        }),
      changeAnswers: (message) => void changeAnswers(message),
      edit: (message) =>
        replace(message, { kind: "edit", replaces: message.seq, kept: keptParts(message) }),
      markUnread: (message) => {
        reading.stop();
        setMarkedFrom({ seq: message.seq, mark: "unread" });
        void leaveWith(unread, "/unread", { from: message.seq });
      },
      archiveThrough: (message) => void archiveThrough(message),
      archiveHint: (message) => archiveHint(message.seq),
      archivedThrough,
      markingHeld: leaving,
      markFailure:
        markedFrom === undefined || markFailure === undefined
          ? undefined
          : {
              seq: markedFrom.seq,
              action: markedFrom.mark === "archive" ? "Archiving" : "Marking unread",
              failure: markFailure,
            },
    },
    agentRead: cursors.requester,
  };

  // The thread page's shortcuts each do what a control on it does, and only
  // while that control could; choosing a suggestion picks it as a press of
  // its control does, and moves focus there.
  const canArchiveAll = !leaving && openCount === 0;
  const composerBox = useRef<HTMLTextAreaElement>(null);
  useShortcuts("Thread", {
    backToList: () => navigate(listHref(origin)),
    reply: () => composerBox.current?.focus(),
    archive: () => {
      if (canArchiveAll) {
        archiveAll();
      }
    },
    openAbove: () => void openNeighbor("above"),
    openBelow: () => void openNeighbor("below"),
    jump: () => {
      if (jumpTo !== undefined) {
        setSeeking({ failedBefore: loaded.failure });
      }
    },
    choose: (key) => {
      const choice = suggestionChoices()[Number(key) - 1];
      choice?.click();
      choice?.focus();
    },
  });

  const tags = thread.credential_active ? [] : [{ label: "No active credential" }];
  return (
    <article>
      <header className="thread-header">
        <div className="thread-bar">
          <div className="thread-nav">
            <BackToThreads origin={origin} />
            <button
              type="button"
              className="secondary icon-button"
              aria-label="Thread above"
              title="Thread above"
              disabled={busy}
              onClick={() => void openNeighbor("above")}
            >
              <Icon name="arrow-up" />
            </button>
            <button
              type="button"
              className="secondary icon-button"
              aria-label="Thread below"
              title="Thread below"
              disabled={busy}
              onClick={() => void openNeighbor("below")}
            >
              <Icon name="arrow-down" />
            </button>
          </div>
          <div className="thread-actions">
            {thread.archived && <Mark icon="archive" label="Archived" />}
            <button
              type="button"
              className="secondary"
              disabled={!canArchiveAll}
              aria-describedby={openCount > 0 ? archiveAllHint : undefined}
              onClick={archiveAll}
            >
              Archive all
            </button>
          </div>
        </div>
        {openCount > 0 && (
          <p id={archiveAllHint} className="hint">
            Archive all is available once every ask open to you is answered or declined.
          </p>
        )}
        <PageHeading>
          <ThreadTitle thread={thread} />
        </PageHeading>
        <p className="where">
          {threadPathParts(thread, origin).map((part) => (
            <Fragment key={part.kind}>
              <Link to={part.href}>
                <PathPart kind={part.kind}>{part.label}</PathPart>
              </Link>{" "}
            </Fragment>
          ))}
          · started <Time value={thread.created_at} />
        </p>
        {settledWords(thread) !== undefined && (
          <p className="muted thread-status">{settledWords(thread)}</p>
        )}
        {thread.stranded === true && <Stranded thread={thread} />}
        {tags.length > 0 && <Tags tags={tags} />}
        {jumpTo !== undefined && (
          <div className="actions">
            <button type="button" onClick={() => setSeeking({ failedBefore: loaded.failure })}>
              <Spoken
                shown={`${jumpTo.label} (${jumpTo.count})`}
                spoken={`${jumpTo.label}, ${plural(jumpTo.count, jumpTo.one)}`}
              />
            </button>
          </div>
        )}
        {failedOnward !== undefined && <HeadFailure {...failedOnward} />}
        <HeadFailure action="Reading this thread" failure={reading.failure} />
      </header>

      <ThreadFiles target={target} totals={data.files} showMessage={(seq) => focusOn({ seq })} />
      <ThreadCodeLinks pullRequests={data.pull_requests} branches={data.branches} />

      {!thread.credential_active && (
        <p className="notice">
          {thread.agent}/{thread.session} has no active credential, so the agent cannot read what
          you write until a registration for this session is approved.
        </p>
      )}

      <section aria-label="Messages">
        {folding && (
          <button
            ref={fold}
            type="button"
            className="fold"
            aria-expanded={unfolded}
            onClick={() => setUnfolded(!unfolded)}
          >
            <Icon name="archive" />
            <span className="fold-label">
              {plural(archivedThrough - keptInView.length, "archived message")}
            </span>
            <Icon name="expand" />
          </button>
        )}
        {data.earlier && (!folding || unfolded) && (
          <button type="button" className="secondary more" onClick={loaded.earlier}>
            Show earlier messages
          </button>
        )}
        <MessageList
          messages={listed}
          unread={unreadHere}
          context={context}
          firstAfterArchived={firstAfterArchived}
        />
        <HeadFailure action="Loading that message" failure={loading.failure} />
        {data.later && (
          <button type="button" className="secondary more" onClick={loaded.later}>
            Show later messages
          </button>
        )}
      </section>

      <Composer
        writer={writer}
        sending={setSentStaged}
        wrote={(seq) => setWrittenHere((current) => new Set([...current, seq]))}
        arrived={arrived}
        after={after}
        setAfter={setAfter}
        onward={ways.sentOnward}
        moving={ways.moving}
        onwardFailure={failedOnward && failedWords(failedOnward.action, failedOnward.failure)}
        shown={shown}
        text={text}
        setText={setText}
        detail={detail}
        setDetail={setDetail}
        detailsShown={detailsShown}
        setDetailsShown={setDetailsShown}
        staged={staged}
        stage={setStaged}
        unstage={unstage}
        loading={loading.pending}
        context={{ target, find }}
        files={files}
        restored={restored}
        box={composerBox}
        recordingAnswer={answersRecording.size > 0}
        voiceOn={voiceOn}
        draftsEnded={draftsEnded}
      />
      <div className="thread-foot">
        <BackToThreads origin={origin} />
      </div>
    </article>
  );
}

// BackToThreads is the back button to the thread list as the operator left
// it, leading the thread's head and again under its composer, so leaving
// without replying needs no scrolling back up.
function BackToThreads({ origin }: { origin: ThreadsView }) {
  return (
    <Link to={listHref(origin)} className="back" aria-label="Back to threads">
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
        <path d="M20 12H5M11 5l-7 7 7 7" />
      </svg>
      Threads
    </Link>
  );
}

// Stranded says, on a stranded thread, why its session has not read the
// operator's latest messages: it stopped, with its outcome, or it is quiet,
// with when it was last seen. A session with no active credential is
// explained by the notice under the head.
function Stranded({ thread }: { thread: ThreadSummary }) {
  const absence = absenceOf(threadWhereabouts(thread));
  if (absence === undefined || absence.kind === "credential") {
    return null;
  }
  return (
    <p className="muted stranded">
      Its session has not read your latest messages: <AbsenceReason absence={absence} />.
    </p>
  );
}

// failedWords says which action on the thread failed, and why.
const failedWords = (action: string, failure: unknown) =>
  `${action} failed: ${describeFailure(failure)}`;

// HeadFailure says which action on the thread failed, and why.
function HeadFailure({ action, failure }: { action: string; failure: unknown }) {
  return failure === undefined ? null : (
    <div className="notice danger" role="alert">
      <p>{failedWords(action, failure)}</p>
    </div>
  );
}
