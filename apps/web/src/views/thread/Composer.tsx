import {
  type ClipboardEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiFailure, describeFailure } from "../../api.ts";
import { ConfirmButton, Status } from "../../components.tsx";
import { useStillOpen } from "../../data.ts";
import { type KeptDraft, useDeviceChoice } from "../../device.ts";
import { otherLabel, quoted } from "../../format.tsx";
import { Icon } from "../../icons.tsx";
import { useFieldShortcuts } from "../../keyboard.tsx";
import { useDictation, useVoiceOn } from "../../voice/Dictation.tsx";
import {
  attachmentsOf,
  type DraftFiles,
  filesHold,
  holdWords,
  pastedImages,
  pastedName,
} from "./files/attach.ts";
import { AttachButton } from "./files/AttachButton.tsx";
import { AttachList } from "./files/AttachList.tsx";
import { useKeptDraft } from "./kept-draft.ts";
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
// detail, folded under it until opened, the files it carries, and one Send
// button, with Attach beside it, and dictation while voice is on. Choosing
// files or pasting images into either box attaches them, and Send waits for
// their uploads. What the message
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

// The place of the file a refusal of a write names as not uploaded, among
// the files the write sent.
function refusedUpload(failure: unknown): number | undefined {
  const match =
    failure instanceof ApiFailure ? /^attachments\.(\d+)\.upload$/.exec(failure.field ?? "") : null;
  return match === null ? undefined : Number(match[1]);
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
  files,
  restored,
  box,
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
  // The files the draft carries, which the page holds beside the text, since
  // an edit loads the files of the message it replaces.
  files: DraftFiles;
  // The draft this browser kept for the thread, which the page opened with.
  restored: KeptDraft | undefined;
  // The message box, which the page's reply shortcut puts focus in.
  box: RefObject<HTMLTextAreaElement | null>;
}) {
  // The message the draft was started from: the last one on screen when the
  // operator started typing, staging or recording, so a message that lands
  // meanwhile, or one the page has not shown, makes the write stale instead
  // of being answered unseen. Emptying the composer ends the draft, unless a
  // recording is still to become its text. A draft still in the composer when
  // a write lands counts from at least the message it wrote, and one this
  // browser kept from before counts from where it started, or from what the
  // page shows when that is earlier.
  const [basis, setBasis] = useState(() =>
    restored === undefined ? undefined : Math.min(restored.basis, shown),
  );
  const empty = blank(text) && blank(detail) && files.files.length === 0;
  const [dictating, setDictating] = useState(false);
  useEffect(() => {
    setBasis((current) =>
      staged === undefined && empty && !dictating ? undefined : (current ?? shown),
    );
  }, [staged, empty, dictating, shown]);
  // This browser keeps the draft's text and details as they change, and
  // where it started; not what is staged, attached or being recorded, which
  // may be gone by the time the draft comes back. A change or an edit loads
  // the text and details of the message it replaces, which are kept only once
  // the operator changes them: as they were, they would come back as a new
  // message the operator never wrote.
  const replaced = staged?.replaces === undefined ? undefined : context.find(staged.replaces);
  const asLoaded =
    replaced !== undefined && text === (replaced.text ?? "") && detail === (replaced.detail ?? "");
  const keepNow = useKeptDraft(
    context.target,
    {
      text,
      detail,
      basis: basis ?? shown,
      leftBehind: staged !== undefined || files.files.length > 0 || dictating,
    },
    !(blank(text) && blank(detail)) && !asLoaded,
  );
  // Whether the draft the page opened with left something behind, which the
  // composer says until it is emptied.
  const [leftBehind, setLeftBehind] = useState(restored?.leftBehind === true);
  useEffect(() => {
    if (empty) {
      setLeftBehind(false);
    }
  }, [empty]);
  const voiceOn = useVoiceOn();
  // How many messages the composer has sent, so a transcript that arrives
  // after its draft was sent is dropped rather than starting a new one.
  const sends = useRef(0);
  const sendsAtRecording = useRef(0);
  // The box that last had focus, where a transcript goes.
  const lastBox = useRef<"text" | "detail">("text");
  // Where to put the caret once a transcript is in, and in which box.
  const caret = useRef<{ box: "text" | "detail"; at: number }>(undefined);
  const [changed, setChanged] = useState<string>();
  const [status, setStatus] = useState("");
  const actions = useRef<HTMLDivElement>(null);
  useScrollClearOf(actions);
  // Whether a message the server accepts returns to the list: most operators
  // want to, so it does unless they choose otherwise on this device. A write
  // goes back by the choice as it stands when the write lands, and only
  // while the page that sent it is still open.
  const [goBack, setGoBack] = useDeviceChoice(goBackChoice, true);
  // Whether Go back after sending had focus as dictation moved it.
  const goBackHadFocus = useRef(false);
  const goBackNow = useRef(goBack);
  const stillOpen = useStillOpen();
  useEffect(() => {
    goBackNow.current = goBack;
  }, [goBack]);
  const id = useId();
  const { attachments, ids: fileIds } = attachmentsOf(files.files);
  const draft = { text, detail, attachments };
  const hold = filesHold(files.files);
  const ready = sendable(draft, staged) && hold === undefined;
  const attach = useRef<HTMLButtonElement>(null);
  // The detail as it stands, for a write that lands after the operator
  // typed on.
  const detailNow = useRef(detail);
  const textNow = useRef(text);
  useEffect(() => {
    detailNow.current = detail;
    textNow.current = text;
  }, [detail, text]);
  // What is staged as it stands, for a write whose answer comes after the
  // operator changed it.
  const stagedNow = useRef(staged);
  useEffect(() => {
    stagedNow.current = staged;
  }, [staged]);
  const detailBox = useRef<HTMLTextAreaElement>(null);
  // Opening the Details box moves focus into it, in place of the control
  // that opened it.
  const focusDetail = useRef(false);
  useLayoutEffect(() => {
    if (focusDetail.current && detailsShown) {
      focusDetail.current = false;
      detailBox.current?.focus();
    }
  });

  // restage judges what is staged now, which sends next, by what landed since
  // it was staged: a stale write's missed messages, or the write that landed.
  // What they made impossible to send goes; anything staged since the page
  // last showed what is staged stays. It says what changed, if anything.
  const restage = (landed: Parameters<typeof staleChange>[1]): string | undefined => {
    const now = stagedNow.current;
    const change = staleChange(now, landed);
    if (change !== undefined) {
      stage((current) => (current === now ? change.left : current));
    }
    return change?.change;
  };

  const write = async (content: WriteContent) => {
    const sentText = text;
    const sentDetail = detail;
    const sentStaged = staged;
    const sentFiles = fileIds;
    const outcome =
      writer.missed === undefined
        ? await writer.write(content, basis ?? shown, shown)
        : await writer.readAndWrite(content);
    if (outcome === undefined) {
      return;
    }
    if ("failed" in outcome) {
      // An upload the server no longer holds has expired, to upload again.
      const place = refusedUpload(outcome.failed);
      const id = place === undefined ? undefined : sentFiles[place];
      if (id !== undefined) {
        files.expire(id);
      }
      return;
    }
    if ("missed" in outcome) {
      // What the missed messages made impossible to send goes, and the page
      // says what; the rest, the text, the detail and the files stay. What is
      // staged may be what was sent, with answers picked again since, or what
      // replaced it.
      const change = restage(outcome.missed);
      if (change !== undefined) {
        setChanged(change);
      }
      return;
    }
    wrote(outcome.written);
    sends.current += 1;
    // Clear only what was sent: text typed meanwhile is a new draft, and so
    // are files added meanwhile.
    const unsent = (current: string, sent: string) => (current === sent ? "" : current);
    setText((current) => unsent(current, sentText));
    setDetail((current) => unsent(current, sentDetail));
    keepNow(
      unsent(textNow.current, sentText),
      unsent(detailNow.current, sentDetail),
      outcome.written,
    );
    files.sent(sentFiles);
    // The Details box folds with the detail it sent; one typed meanwhile
    // stays in sight.
    if (detailNow.current === sentDetail) {
      setDetailsShown(false);
    }
    // What the write did judges what is staged now as missed messages do,
    // without a word: an answer picked again since to an ask it answered goes.
    restage([content]);
    setBasis((current) => (current === undefined ? undefined : Math.max(current, outcome.written)));
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

  // Its shortcuts, within its fields: Send, while Send can, and one to leave
  // it, for its heading, where the page's own shortcuts act again.
  const heading = useRef<HTMLHeadingElement>(null);
  const fieldKeys = useFieldShortcuts("Composer", {
    send: () => {
      if (!writer.pending && !loading && ready) {
        send();
      }
    },
    leaveComposer: () => heading.current?.focus(),
  });

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

  // discard empties the composer, which forgets the draft this browser kept:
  // what is staged, with what it loaded, the text, the details and the files.
  const discard = () => {
    unstage();
    setText("");
    setDetail("");
    setDetailsShown(false);
    for (const file of files.files) {
      files.remove(file.id);
    }
    setStatus("");
    removed();
  };

  // A paste holding images attaches them, named by when they were pasted,
  // and inserts nothing; any other paste is the browser's own.
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = pastedImages(event.clipboardData);
    if (images.length === 0) {
      return;
    }
    event.preventDefault();
    const at = new Date();
    files.add(images.map((file) => ({ file, name: pastedName(file.type, at) })));
  };

  // insert puts a transcript at the caret of the box that last had focus,
  // with a space on each side where it meets other text, and moves focus
  // there, to after it, unless the operator has put focus somewhere else
  // meanwhile.
  const insert = (words: string, focusFree: boolean) => {
    if (sends.current !== sendsAtRecording.current) {
      return;
    }
    const which = lastBox.current === "detail" && detailBox.current !== null ? "detail" : "text";
    const element = which === "detail" ? detailBox.current : box.current;
    if (element === null) {
      return;
    }
    const { value } = element;
    const start = element.selectionStart ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(element.selectionEnd ?? start);
    const lead = before !== "" && !/\s$/.test(before) ? " " : "";
    const trail = after !== "" && !/^\s/.test(after) ? " " : "";
    const placed = `${before}${lead}${words}`;
    (which === "detail" ? setDetail : setText)(`${placed}${trail}${after}`);
    if (focusFree || document.activeElement === element) {
      caret.current = { box: which, at: placed.length };
    }
  };
  // The caret moves in the same commit as the text it follows, before the
  // browser paints or handles another key, so a key typed as a transcript
  // arrives lands after it, never at the end of the box.
  useLayoutEffect(() => {
    const placed = caret.current;
    if (placed === undefined) {
      return;
    }
    caret.current = undefined;
    const element = placed.box === "detail" ? detailBox.current : box.current;
    element?.focus();
    element?.setSelectionRange(placed.at, placed.at);
  });
  const dictation = useDictation({
    disabled: loading,
    onText: insert,
    onActive: (active) => {
      if (active) {
        sendsAtRecording.current = sends.current;
      }
      setDictating(active);
    },
  });
  // Go back after sending sits beside Send, and drops below the row while
  // dictation has controls there, so the row stays short at the foot of a
  // phone's screen.
  const goBackOption = (
    <GoBackOption checked={goBack} onChange={setGoBack} hadFocus={goBackHadFocus} />
  );
  return (
    <section className="composer" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>
        Reply
      </h2>
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
      <form onSubmit={(event) => event.preventDefault()} onKeyDown={fieldKeys} noValidate>
        {leftBehind && (
          <p className="hint" role="note">
            This browser kept only your draft's text and details, not what it had staged, attached
            or was recording, so sending posts them as a new message.
          </p>
        )}
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
          onFocus={() => (lastBox.current = "text")}
          onChange={(event) => setText(event.target.value)}
          onPaste={paste}
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
              onFocus={() => (lastBox.current = "detail")}
              onChange={(event) => setDetail(event.target.value)}
              onPaste={paste}
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
        <AttachList draft={files} attach={attach} disabled={loading} />
        {/* A recording has its own Discard, so this one waits until the
            recording is done with. */}
        {(!empty || staged !== undefined) && !dictating && (
          <ConfirmButton
            label="Discard draft"
            confirmLabel="Discard"
            question="Discard this draft, with what it stages and its files?"
            disabled={writer.pending || loading}
            onConfirm={discard}
          />
        )}
        {/* What answers Send and dictation show beside them, as the row stays
            at the foot of the screen: a failure above them, and what was
            sent or heard after them. */}
        <div ref={actions} className="actions">
          {otherFailure !== undefined && (
            <div className="notice danger" role="alert">
              <p>{describeFailure(otherFailure)}</p>
            </div>
          )}
          {voiceOn && dictation.problem}
          <button
            type="button"
            disabled={writer.pending || loading || !ready}
            aria-describedby={hold === undefined ? undefined : `${id}-hold`}
            onClick={send}
          >
            Send
          </button>
          <AttachButton draft={files} attach={attach} disabled={loading} />
          {voiceOn && dictation.controls}
          {!dictating && goBackOption}
          {hold !== undefined && (
            <p id={`${id}-hold`} className="hint hold">
              {holdWords(hold)}
            </p>
          )}
          {status !== "" && <Status>{status}</Status>}
          {voiceOn && dictation.said}
        </div>
        {dictating && goBackOption}
      </form>
    </section>
  );
}

// GoBackOption is Go back after sending. It sits in the Send row, which stays
// at the foot of the screen, and below it while dictating; no style can move a
// control out of that row, so moving it mounts it afresh. The one leaving
// records, in its layout cleanup, whether it had focus, before React removes
// it from the page; the one arriving takes focus back in the same commit's
// layout effects, before dictation's own focus moves run.
function GoBackOption({
  checked,
  onChange,
  hadFocus,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  hadFocus: RefObject<boolean>;
}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (hadFocus.current) {
      hadFocus.current = false;
      input.current?.focus();
    }
    const element = input.current;
    return () => {
      hadFocus.current = element !== null && document.activeElement === element;
    };
  }, [hadFocus]);
  return (
    <label className="check">
      <input
        ref={input}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      Go back after sending
    </label>
  );
}
