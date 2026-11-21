import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { describeFailure } from "../../api.ts";
import { Status } from "../../components.tsx";
import { useStillOpen } from "../../data.ts";
import { useDeviceChoice } from "../../device.ts";
import { otherLabel, quoted } from "../../format.tsx";
import { Icon } from "../../icons.tsx";
import { type MessageContext, MessageView } from "./Messages.tsx";
import {
  blank,
  contentOf,
  draftProblems,
  failureAt,
  ownWords,
  type Staged,
  type StagedAnswer,
  sendable,
  staleChange,
  withoutAnswer,
  type WriteContent,
  type Writer,
  wordsRefused,
} from "./writer.ts";

// The composer: a Markdown box for the message's text, a Details box for its
// detail, folded under it until opened, and one Send button. What the message
// does besides its text comes from the thread's messages: answers written on
// asks' cards, a change of the answers a message of the operator's carries,
// or an edit of one of their messages. A line above the box names each answer
// by its ask's number, or the change or edit. Beside answers the box holds
// additional information; Send sends the answers, the text or both as one
// message, once there is something complete to send and each box is within
// its bound.

// describeAnswer names a staged answer by its ask's number, in the card's
// terms: declined, the suggestions picked and Other, or on an ask without
// suggestions, the answer written.
function describeAnswer(staged: StagedAnswer): string {
  const { answer, labels } = staged;
  const chosen = [
    ...answer.picks.map((pick) => quoted([labels[pick] ?? `#${pick + 1}`])),
    ...(answer.other ? [otherLabel] : []),
  ];
  const what = answer.declined
    ? "Declined"
    : labels.length === 0
      ? ownWords(staged) === undefined
        ? "nothing written"
        : "your answer"
      : chosen.length === 0
        ? "nothing chosen"
        : chosen.join(", ");
  return `Ask ${staged.ask}: ${what}`;
}

// describeReplacement names a change of answers or an edit, which is removed
// whole.
function describeReplacement(staged: Staged): string {
  if (staged.kind === "edit") {
    return `Editing message #${staged.replaces}`;
  }
  const several = staged.answers.length > 1;
  return `Changing your ${several ? "answers" : "answer"}: ${staged.answers.map(describeAnswer).join(" · ")}`;
}

// describeDropped says which answers a change leaves with the message it
// changes, because their asks were since revised or retracted.
function describeDropped(dropped: number[]): string {
  const asks = dropped.map((ask) => `ask ${ask}`);
  const named = asks.length === 1 ? asks[0] : `${asks.slice(0, -1).join(", ")} and ${asks.at(-1)}`;
  return asks.length === 1
    ? `Your answer to ${named} stays with that message: the agent since revised or retracted it.`
    : `Your answers to ${named} stay with that message: the agent since revised or retracted those asks.`;
}

// Where this device keeps whether to go back after sending.
export const goBackChoice = "agention.go-back-after-sending";

function sentStatus(staged: Staged | undefined): string {
  if (staged?.kind === "edit") {
    return "Message replaced.";
  }
  if (staged?.kind === "answers") {
    const several = staged.answers.length > 1;
    return staged.replaces !== undefined
      ? several
        ? "Answers changed."
        : "Answer changed."
      : several
        ? "Answers sent."
        : staged.answers[0]?.answer.declined === true
          ? "Declined."
          : "Answer sent.";
  }
  return "Message sent.";
}

// The root's property holding how tall the Send row is, which the page's
// scroll padding keeps clear.
const sendRowHeight = "--send-row-height";

// useScrollClearOf keeps what the page scrolls into view, as the caret while
// typing or a control focused from the keyboard, clear of the Send row stuck
// at the foot of the screen, however tall what it holds makes it: it gives
// the root the row's height while the composer is open.
function useScrollClearOf(row: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = row.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty(sendRowHeight, `${element.offsetHeight}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(sendRowHeight);
    };
  }, [row]);
}

export function Composer({
  writer,
  sending,
  wrote,
  back,
  shown,
  text,
  setText,
  detail,
  setDetail,
  detailsShown,
  setDetailsShown,
  staged,
  stage,
  unstage,
  loading,
  context,
}: {
  // Writes to the thread; the page holds it, so a refusal that names an
  // answer's own words shows at their field on the ask's card.
  writer: Writer;
  // Told what is staged as it is sent, which a refusal belongs to.
  sending: (staged: Staged | undefined) => void;
  // Told the sequence of each message the server accepts.
  wrote: (seq: number) => void;
  // Returns to the list the page came from, in place of the page in history
  // as Archive does, and has the list say what was sent.
  back: (notice: string) => void;
  // The last message the operator has seen: on screen, or read or written
  // since the page last loaded.
  shown: number;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  detail: string;
  setDetail: Dispatch<SetStateAction<string>>;
  // Whether the Details box shows, which the page holds beside the detail,
  // since a change or an edit that loads one shows it.
  detailsShown: boolean;
  setDetailsShown: Dispatch<SetStateAction<boolean>>;
  staged: Staged | undefined;
  stage: Dispatch<SetStateAction<Staged | undefined>>;
  // Drops what is staged, with the text and detail a change or an edit
  // loaded.
  unstage: () => void;
  // Whether a change or an edit is loading the messages it needs, which holds
  // the composer until they arrive.
  loading: boolean;
  // How the missed messages of a stale write read, without actions.
  context: MessageContext;
}) {
  // The message the draft was started from: the last one on screen when the
  // operator started typing or staging, so a message that lands meanwhile,
  // or one the page has not shown, makes the write stale instead of being
  // answered unseen. Emptying the composer ends the draft.
  const [basis, setBasis] = useState<number | undefined>(undefined);
  const empty = blank(text) && blank(detail);
  useEffect(() => {
    setBasis((current) => (staged === undefined && empty ? undefined : (current ?? shown)));
  }, [staged, empty, shown]);
  const [changed, setChanged] = useState<string>();
  const [status, setStatus] = useState("");
  const actions = useRef<HTMLDivElement>(null);
  useScrollClearOf(actions);
  // Whether a message the server accepts returns to the list: most operators
  // want to, so it does unless they choose otherwise on this device. A write
  // goes back by the choice as it stands when the write lands, and only
  // while the page that sent it is still open.
  const [goBack, setGoBack] = useDeviceChoice(goBackChoice, true);
  const goBackNow = useRef(goBack);
  const stillOpen = useStillOpen();
  useEffect(() => {
    goBackNow.current = goBack;
  }, [goBack]);
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const draft = { text, detail };
  const ready = sendable(draft, staged);
  // The detail as it stands, for a write that lands after the operator
  // typed on.
  const detailNow = useRef(detail);
  useEffect(() => {
    detailNow.current = detail;
  }, [detail]);
  const detailBox = useRef<HTMLTextAreaElement>(null);
  // Opening the Details box moves focus into it, in place of the control
  // that opened it.
  const focusDetail = useRef(false);
  useEffect(() => {
    if (focusDetail.current && detailsShown) {
      focusDetail.current = false;
      detailBox.current?.focus();
    }
  });

  const write = async (content: WriteContent) => {
    const sentText = text;
    const sentDetail = detail;
    const sentStaged = staged;
    const outcome =
      writer.missed === undefined
        ? await writer.write(content, basis ?? shown, shown)
        : await writer.readAndWrite(content);
    if (outcome === undefined) {
      return;
    }
    if ("missed" in outcome) {
      // What the missed messages made impossible to send goes; the rest, the
      // text and the detail stay.
      const stale = staleChange(sentStaged, outcome.missed);
      if (stale !== undefined) {
        setChanged(stale.change);
        stage((current) => (current === sentStaged ? stale.left : current));
      }
      return;
    }
    wrote(outcome.written);
    // Clear only what was sent: text typed meanwhile is a new draft.
    setText((current) => (current === sentText ? "" : current));
    setDetail((current) => (current === sentDetail ? "" : current));
    // The Details box folds with the detail it sent; one typed meanwhile
    // stays in sight.
    if (detailNow.current === sentDetail) {
      setDetailsShown(false);
    }
    stage((current) => (current === sentStaged ? undefined : current));
    setBasis(undefined);
    const sent = sentStatus(sentStaged);
    setStatus(sent);
    if (stillOpen() && goBackNow.current) {
      back(sent);
    }
  };

  // send sends the draft as it stands, after a stale write too, so what the
  // operator changed since goes with it.
  const send = () => {
    setStatus("");
    setChanged(undefined);
    sending(staged);
    void write(contentOf(draft, staged));
  };

  // After a stale write, a draft left to send goes again once the missed
  // messages are read; otherwise they are only marked read.
  const resend = changed === undefined && ready;

  const readMissed = async () => {
    const through = await writer.readMissed();
    if (through !== undefined) {
      setBasis(through);
    }
  };

  // Why a box keeps Send unavailable shows at that box, and so does a refusal
  // that names it; one that names an answer's own words shows at their field,
  // and any other here.
  const problems = draftProblems(draft);
  const textRefused = failureAt(writer.failure, "text");
  const detailRefused = failureAt(writer.failure, "detail");
  const textError = problems.text ?? textRefused;
  const detailError = problems.detail ?? detailRefused;
  const otherFailure =
    writer.failure !== undefined &&
    textRefused === undefined &&
    detailRefused === undefined &&
    !wordsRefused(writer.failure)
      ? writer.failure
      : undefined;
  const removed = () => box.current?.focus();
  return (
    <section className="composer" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Reply</h2>
      {writer.missed !== undefined && (
        <div className="notice warning stale" role="alert">
          <p>
            {writer.missed.length === 1 ? "A message was" : `${writer.missed.length} messages were`}{" "}
            added while you were writing. Your draft is kept.
            {changed !== undefined && ` ${changed} Choose again once you have read them.`}
          </p>
          <ol className="messages">
            {writer.missed.map((message) => (
              <li key={message.seq}>
                <MessageView message={message} context={context} />
              </li>
            ))}
          </ol>
          <button
            type="button"
            disabled={writer.pending}
            onClick={resend ? send : () => void readMissed()}
          >
            {resend ? "Mark these read and send again" : "Mark these read"}
          </button>
        </div>
      )}
      <form onSubmit={(event) => event.preventDefault()} noValidate>
        {staged?.kind === "answers" && staged.replaces === undefined ? (
          <ul className="staged">
            {staged.answers.map((each) => (
              <li key={each.ask}>
                <p>{describeAnswer(each)}</p>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Remove the answer to ask ${each.ask}`}
                  onClick={() => {
                    stage((current) => withoutAnswer(current, each.ask));
                    removed();
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          staged !== undefined && (
            <div className="staged">
              <p>{describeReplacement(staged)}</p>
              {staged.kind === "answers" && staged.dropped !== undefined && (
                <p className="dropped">{describeDropped(staged.dropped)}</p>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  unstage();
                  removed();
                }}
              >
                Remove
              </button>
            </div>
          )
        )}
        <label htmlFor={`${id}-text`}>
          {staged?.kind === "answers" ? "Additional information" : "Message"}
        </label>
        <p className="hint" id={`${id}-hint`}>
          Markdown.
        </p>
        <textarea
          ref={box}
          id={`${id}-text`}
          rows={4}
          disabled={loading}
          value={text}
          aria-invalid={textError === undefined ? undefined : true}
          aria-describedby={`${id}-hint${textError === undefined ? "" : ` ${id}-error`}`}
          onChange={(event) => setText(event.target.value)}
        />
        {textError !== undefined && (
          <p id={`${id}-error`} className="field-error">
            {textError}
          </p>
        )}
        {detailsShown ? (
          <>
            <label htmlFor={`${id}-detail`}>Details</label>
            <p className="hint" id={`${id}-detail-hint`}>
              Markdown, shown folded under the message.
            </p>
            <textarea
              ref={detailBox}
              id={`${id}-detail`}
              rows={8}
              disabled={loading}
              value={detail}
              aria-invalid={detailError === undefined ? undefined : true}
              aria-describedby={`${id}-detail-hint${detailError === undefined ? "" : ` ${id}-detail-error`}`}
              onChange={(event) => setDetail(event.target.value)}
            />
            {detailError !== undefined && (
              <p id={`${id}-detail-error`} className="field-error">
                {detailError}
              </p>
            )}
          </>
        ) : (
          <button
            type="button"
            className="quiet detail-fold"
            aria-expanded={false}
            disabled={loading}
            onClick={() => {
              focusDetail.current = true;
              setDetailsShown(true);
            }}
          >
            <Icon name="expand" />
            Details
          </button>
        )}
        {/* What answers Send shows beside it, as it stays at the foot of the
            screen: a failure above it, and what was sent after it. */}
        <div ref={actions} className="actions">
          {otherFailure !== undefined && (
            <div className="notice danger" role="alert">
              <p>{describeFailure(otherFailure)}</p>
            </div>
          )}
          <button type="button" disabled={writer.pending || loading || !ready} onClick={send}>
            Send
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={goBack}
              onChange={(event) => setGoBack(event.target.checked)}
            />
            Go back after sending
          </label>
          {status !== "" && <Status>{status}</Status>}
        </div>
      </form>
    </section>
  );
}
