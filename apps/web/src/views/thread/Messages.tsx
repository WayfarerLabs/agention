import { type Message, maxAnswers, type Reference } from "@wayfarerlabs/agention-api";
import {
  type Dispatch,
  Fragment,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
} from "react";
import { describeFailure } from "../../api.ts";
import { MenuItem, OptionsMenu, Status } from "../../components.tsx";
import { Icon, Mark } from "../../icons.tsx";
import {
  absoluteTime,
  authorName,
  effortLabel,
  impactLabel,
  otherLabel,
  priorityLabel,
  quoted,
  Spoken,
  Time,
} from "../../format.tsx";
import { ExternalLink, type FileLinks, liveUrl, Markdown } from "../../markdown/Markdown.tsx";
import { ThreadLink } from "../../router.tsx";
import {
  speak,
  speechSupported,
  stopSpeaking,
  useSpeaking,
  useSpeechFailed,
  wordsOf,
} from "../../voice/speech.ts";
import { useMessageFiles } from "./files/FileList.tsx";
import {
  type AnswerDraft,
  holdsAnswer,
  type Staged,
  type ThreadTarget,
  withAnswer,
  withoutAnswer,
  wordsMissing,
} from "./writer.ts";

// A thread's messages, each as it reads now: a replaced message collapses to
// a line naming its replacement, each ask is a card with its number and
// state, and each answer and withdrawal names the ask it answers or
// withdraws.

// What the operator, the audience, can do from a message: write answers on
// its asks, change the answers a message of theirs carries, edit a message of
// their own, mark the thread unread from it, or archive through it. Answers on
// several asks' cards go together, up to what one message carries. A change
// or an edit loads the whole message it replaces, so it needs an empty
// composer, and while one is staged nothing else can be started. The missed
// messages a stale write shows offer none of it.
export interface MessageActions {
  staged: Staged | undefined;
  stage: Dispatch<SetStateAction<Staged | undefined>>;
  // Whether the composer holds a draft: text, or something staged.
  drafting: boolean;
  // Whether a change or an edit is loading the messages it needs.
  loading: boolean;
  // Why the server refused the own words of the answer to an ask last sent.
  wordsFailure(ask: number): string | undefined;
  // changeAnswers turns every card a message of the operator's answered back
  // into choices, as a replacement of that message.
  changeAnswers(message: Message): void;
  edit(message: Message): void;
  // markUnread marks the thread unread from a message, and leaves the page.
  markUnread(message: Message): void;
  // archiveThrough archives a message and every earlier one, staying on the
  // page.
  archiveThrough(message: Message): void;
  // Why archiving through a message must wait, while it must: an ask open to
  // the operator in it or before it.
  archiveHint(message: Message): string | undefined;
  // How far the operator has archived the thread.
  archivedThrough: number;
  // Whether marking unread or archiving waits: on reading, or on another
  // mark.
  markingHeld: boolean;
  // Which mark from a message failed, and why, shown by that message.
  markFailure?: { seq: number; action: string; failure: unknown } | undefined;
}

const replacementHint =
  "Available when the message box and Details are empty, and nothing is attached or staged.";

// mine says whether the operator wrote a message: they are the one person.
export const mine = (message: Message) => message.author.kind === "person";

export interface MessageContext {
  target: ThreadTarget;
  // A message on screen, by its sequence.
  find(seq: number): Message | undefined;
  actions?: MessageActions | undefined;
  // The latest message the agent has read, when known.
  agentRead?: number | undefined;
}

// MessageDetail is a message's detail, folded into one Details line under
// its text that opens it in place. Folded, the detail is not parsed: a
// detail at its bound can take seconds to parse, so the page parses only the
// details the operator opens. The list keeps each message's place by its
// sequence, so a refresh keeps an opened detail open. Its links may name the
// message's own files.
function MessageDetail({
  seq,
  detail,
  files,
}: {
  seq: number;
  detail: string;
  files: FileLinks | undefined;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="detail">
      <button
        type="button"
        className="quiet detail-fold"
        aria-label={`Details of message ${seq}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="expand" />
        Details
      </button>
      {open && (
        <div id={id} className="detail-body">
          <Markdown text={detail} files={files} />
        </div>
      )}
    </div>
  );
}

// References lists links to things outside Agention and to other threads of
// the session. Only a URL that passes the link rule is live.
export function References({
  references,
  target,
}: {
  references: Reference[];
  target: ThreadTarget;
}) {
  return (
    <ul className="references">
      {references.map((reference, index) => {
        const url = reference.url === undefined ? undefined : liveUrl(reference.url);
        return (
          <li key={index}>
            {url !== undefined ? (
              <ExternalLink url={url} text={reference.label}>
                {reference.label}
              </ExternalLink>
            ) : reference.thread !== undefined ? (
              <ThreadLink agent={target.agent} session={target.session} thread={reference.thread}>
                {reference.label}
              </ThreadLink>
            ) : (
              reference.label
            )}
            {reference.identifier !== undefined && (
              <>
                {" "}
                <code>{reference.identifier}</code>
              </>
            )}
            {url !== undefined && reference.thread !== undefined && (
              <>
                {" "}
                <ThreadLink agent={target.agent} session={target.session} thread={reference.thread}>
                  #{reference.thread}
                </ThreadLink>
              </>
            )}
            {url === undefined && reference.url !== undefined && <> {reference.url}</>}
          </li>
        );
      })}
    </ul>
  );
}

// carriesNothing says whether a message carries no part of its own, so that,
// replacing another, it retracts it.
function carriesNothing(message: Message): boolean {
  return (
    message.text === undefined &&
    message.references === undefined &&
    message.attachments === undefined &&
    message.asks === undefined &&
    message.answers === undefined &&
    message.withdrawals === undefined &&
    message.topic === undefined
  );
}

// An answer as a message carries it, and an ask as its message carries it.
type AnswerRead = NonNullable<Message["answers"]>[number];
type Ask = NonNullable<Message["asks"]>[number];

// AnswerWords shows an answer's own words, plain text with its line breaks.
function AnswerWords({ text }: { text: string }) {
  return <p className="plain own-words">{text}</p>;
}

// answered says what an answer chose in the card's terms, after the message
// that carries it: the suggestions it picked, and Other when its words go
// beside or instead of them; the words follow beneath. On an ask without
// suggestions, the words follow alone.
function answered(answer: Pick<AnswerRead, "labels" | "text">, suggested: boolean): string {
  const chosen = [
    ...(answer.labels === undefined ? [] : [quoted(answer.labels)]),
    ...(suggested && answer.text !== undefined ? [otherLabel] : []),
  ];
  return chosen.length === 0
    ? ":"
    : `: ${chosen.join(", ")}${answer.text === undefined ? "." : ""}`;
}

// Picked marks a choice as picked: a check to see, drawn so that it shows
// whatever the font, and words for assistive technology.
function Picked() {
  return (
    <>
      <svg className="check" aria-hidden="true" focusable="false" viewBox="0 0 16 16">
        <path d="M3 8.5 6.5 12 13 4.5" />
      </svg>
      <span className="visually-hidden">Picked: </span>
    </>
  );
}

// Suggestions lists an ask's suggested answers. Under an answer, the ones it
// picked are marked and the rest set apart, and its own words follow as
// Other.
function Suggestions({ ask }: { ask: Ask }) {
  const answer = ask.answer?.declined === false ? ask.answer : undefined;
  const marked = (picked: boolean) =>
    answer === undefined ? undefined : picked ? "picked" : "unpicked";
  return (
    <ul className="suggestions">
      {ask.suggestions.map((suggestion, index) => {
        const picked = answer?.picks?.includes(index) === true;
        return (
          <li key={index} className={marked(picked)}>
            {picked && <Picked />}
            {suggestion.label}
            {suggestion.description !== "" && (
              <span className="choice-description">{suggestion.description}</span>
            )}
          </li>
        );
      })}
      {answer?.text !== undefined && (
        <li className="picked">
          <Picked />
          {otherLabel}
          <AnswerWords text={answer.text} />
        </li>
      )}
    </ul>
  );
}

const emptyDraft: AnswerDraft = { picks: [], other: false, words: "", declined: false };

// suggestionChoices gives the controls choosing an ask's suggested answers,
// in order: on the ask card that holds focus, alone, whatever it offers; or,
// while focus is on no card, on the first card of an open ask where answers
// can be chosen.
export function suggestionChoices(): HTMLInputElement[] {
  const choices = (card: Element | null | undefined) =>
    Array.from(card?.querySelectorAll<HTMLInputElement>("input[data-suggestion]") ?? []);
  const focused = document.activeElement?.closest("section.ask");
  if (focused !== null && focused !== undefined) {
    return choices(focused);
  }
  const open = Array.from(document.querySelectorAll("section.ask.open"));
  return choices(open.find((card) => choices(card).length > 0));
}

function AskCard({
  message,
  ask,
  context,
}: {
  message: Message;
  ask: Ask;
  context: MessageContext;
}) {
  const id = useId();
  // Whether the operator left the own-words field incomplete, which is when
  // it says so: never as it opens.
  const [wordsLeft, setWordsLeft] = useState(false);
  // Declining and undoing it replace the control that was used, so focus
  // moves to the one that takes its place; choosing Other moves it to Other's
  // field, to write in; clearing the card moves it to the card.
  const targets = {
    card: useRef<HTMLElement>(null),
    decline: useRef<HTMLButtonElement>(null),
    undo: useRef<HTMLButtonElement>(null),
    words: useRef<HTMLTextAreaElement>(null),
  };
  const focusNext = useRef<keyof typeof targets>(undefined);
  useLayoutEffect(() => {
    const next = focusNext.current;
    focusNext.current = undefined;
    if (next !== undefined) {
      targets[next].current?.focus();
    }
  });
  const { actions } = context;
  const others = actions?.staged;
  const staged =
    others?.kind === "answers" ? others.answers.find((each) => each.ask === ask.number) : undefined;
  const choosing = actions !== undefined && message.live && (ask.open || staged !== undefined);
  // Answers on several cards go together, up to what one message carries; a
  // change or an edit staged elsewhere holds the composer until it is sent or
  // removed; and nothing starts while a change or an edit loads.
  const full = others?.kind === "answers" && others.answers.length >= maxAnswers;
  const held =
    actions !== undefined &&
    (actions.loading ||
      (staged === undefined &&
        others !== undefined &&
        (others.kind === "edit" || others.replaces !== undefined || full)));
  const replacement =
    message.replaced_by === undefined ? undefined : context.find(message.replaced_by);
  const details: ReactNode[] = [
    priorityLabel[ask.priority],
    impactLabel[ask.impact],
    ...(ask.effort === undefined ? [] : [<Spoken {...effortLabel[ask.effort]} />]),
  ];
  const draft = staged?.answer ?? emptyDraft;
  const suggested = ask.suggestions.length > 0;
  // What is wrong with the own words: the server's refusal of them, or, once
  // the field is left, that they are missing.
  const wordsError =
    (staged === undefined ? undefined : actions?.wordsFailure(ask.number)) ??
    (wordsLeft && staged !== undefined && wordsMissing(staged)
      ? suggested
        ? "Write your answer, or choose another."
        : "Write your answer."
      : undefined);

  // write stages the answer as the card now holds it, beside any others. A
  // new answer that holds nothing stages nothing; a change of answers stays
  // staged, with the text it loaded, until it is removed.
  const write = (change: Partial<AnswerDraft>) => {
    const answer = { ...draft, ...change };
    if (!holdsAnswer(answer) && others?.replaces === undefined) {
      actions?.stage((current) => withoutAnswer(current, ask.number));
      return;
    }
    const labels = ask.suggestions.map((suggestion) => suggestion.label);
    actions?.stage((current) =>
      withAnswer(current, { ask: ask.number, seq: message.seq, labels, answer }),
    );
  };
  // pick chooses a suggested answer: the one answer, or on an ask that allows
  // several, one more or one fewer.
  const pick = (index: number) =>
    write(
      ask.multiple
        ? {
            picks: draft.picks.includes(index)
              ? draft.picks.filter((each) => each !== index)
              : [...draft.picks, index].sort((a, b) => a - b),
          }
        : { picks: [index], other: false },
    );
  // chooseOther checks Other, opening its field afresh, or where several may
  // be picked unchecks it; its words stay in the card either way.
  const chooseOther = () => {
    const other = !ask.multiple || !draft.other;
    setWordsLeft(false);
    if (other) {
      focusNext.current = "words";
    }
    write(ask.multiple ? { other } : { picks: [], other });
  };
  const decline = (declined: boolean) => {
    focusNext.current = declined ? "undo" : "decline";
    write({ declined });
  };
  // A new answer staged on the card, picks, words or a decline, clears from
  // it as the composer's Remove removes it. A change of answers holds an
  // answer on every card it opened, so it is removed whole, in the composer.
  const clearable = staged !== undefined && others?.replaces === undefined;
  const clear = () => {
    setWordsLeft(false);
    focusNext.current = "card";
    actions?.stage((current) => withoutAnswer(current, ask.number));
  };

  // A withdrawn ask says where and why first, whatever became of its message
  // since; then one whose message was replaced says whether the replacement
  // revised it, retracted the message, or replaced it otherwise.
  const state =
    ask.withdrawal !== undefined
      ? `Withdrawn in #${ask.withdrawal.seq}: ${ask.withdrawal.reason}`
      : !message.live
        ? replacement?.asks !== undefined
          ? `Revised in #${message.replaced_by}.`
          : replacement !== undefined && carriesNothing(replacement)
            ? `Retracted in #${message.replaced_by}.`
            : `Replaced by #${message.replaced_by}.`
        : ask.open
          ? "Open."
          : ask.answer === undefined
            ? "Answered."
            : ask.answer.declined
              ? `Declined in #${ask.answer.seq}.`
              : `Answered in #${ask.answer.seq}.`;
  const facts = (
    <>
      <p className="ask-state">{state}</p>
      <p className="ask-details">
        {details.map((detail, index) => (
          <Fragment key={index}>
            {index > 0 && " · "}
            {detail}
          </Fragment>
        ))}
      </p>
      {ask.answer_by !== undefined && (
        <p>
          Answer by {absoluteTime(ask.answer_by)} (<Time value={ask.answer_by} />
          ).
        </p>
      )}
      {ask.fallback !== undefined && ask.fallback !== "" && (
        <div className="fallback">
          <p>
            {ask.answer_by === undefined
              ? "If there is no answer:"
              : `If there is no answer by ${absoluteTime(ask.answer_by)}:`}
          </p>
          <p className="plain">{ask.fallback}</p>
        </div>
      )}
    </>
  );

  const words = (labelledBy: string) => (
    <>
      <textarea
        ref={targets.words}
        id={`${id}-words`}
        rows={2}
        maxLength={4_000}
        value={draft.words}
        disabled={held}
        aria-labelledby={labelledBy}
        aria-invalid={wordsError === undefined ? undefined : true}
        aria-describedby={wordsError === undefined ? undefined : `${id}-words-error`}
        onChange={(event) => write({ words: event.target.value })}
        onBlur={() => setWordsLeft(staged !== undefined && wordsMissing(staged))}
      />
      {wordsError !== undefined && (
        <p id={`${id}-words-error`} className="field-error">
          {wordsError}
        </p>
      )}
    </>
  );

  // The ask's number leads the card, before its question.
  const number = (
    <>
      <span className="ask-number">Ask {ask.number}</span>{" "}
    </>
  );
  return (
    <section
      ref={targets.card}
      id={`ask-${ask.number}`}
      tabIndex={-1}
      className={`ask${ask.open ? " open" : ""}`}
      aria-label={`Ask ${ask.number}: ${ask.question}`}
    >
      {choosing ? (
        <fieldset
          className="answer-form"
          aria-describedby={
            [
              ...(suggested && !draft.declined ? [`${id}-how`] : []),
              ...(held ? [`${id}-held`] : []),
            ].join(" ") || undefined
          }
        >
          <legend>
            {number}
            {ask.question}
          </legend>
          {facts}
          {draft.declined ? (
            <div className="declining">
              <p id={`${id}-declining`} role="status">
                You are declining to answer this ask.
              </p>
              <button
                ref={targets.undo}
                type="button"
                className="link"
                aria-describedby={`${id}-declining`}
                onClick={() => decline(false)}
              >
                Undo
              </button>
            </div>
          ) : suggested ? (
            <>
              <p id={`${id}-how`} className="hint">
                {ask.multiple ? "Choose any that apply" : "Choose one"}
              </p>
              <ul className="choices">
                {ask.suggestions.map((suggestion, index) => (
                  <li key={index}>
                    <label>
                      <input
                        type={ask.multiple ? "checkbox" : "radio"}
                        name={`${id}-answer`}
                        data-suggestion=""
                        checked={draft.picks.includes(index)}
                        disabled={held}
                        onChange={() => pick(index)}
                      />
                      <span>
                        <span className="choice-label">{suggestion.label}</span>
                        {suggestion.description !== "" && (
                          <span className="choice-description">{suggestion.description}</span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
                <li>
                  <label>
                    <input
                      type={ask.multiple ? "checkbox" : "radio"}
                      name={`${id}-answer`}
                      checked={draft.other}
                      disabled={held}
                      onChange={chooseOther}
                    />
                    <span id={`${id}-other`} className="choice-label">
                      {otherLabel}
                    </span>
                  </label>
                  {draft.other && <div className="other-words">{words(`${id}-other`)}</div>}
                </li>
              </ul>
            </>
          ) : (
            <>
              <label id={`${id}-words-label`} htmlFor={`${id}-words`}>
                Your answer
              </label>
              {words(`${id}-words-label`)}
            </>
          )}
          {(!draft.declined || clearable) && (
            <div className="ask-actions">
              {!draft.declined && (
                <button
                  ref={targets.decline}
                  type="button"
                  className="link"
                  disabled={held}
                  onClick={() => decline(true)}
                >
                  Decline to answer
                </button>
              )}
              {clearable && (
                <button type="button" className="link" disabled={held} onClick={clear}>
                  Clear
                </button>
              )}
            </div>
          )}
          {held && (
            <p id={`${id}-held`} className="hint">
              {full && others?.replaces === undefined
                ? `One message carries up to ${maxAnswers} answers: send these first.`
                : "Send or remove what you are writing first."}
            </p>
          )}
        </fieldset>
      ) : (
        <>
          <h3>
            {number}
            {ask.question}
          </h3>
          {facts}
          {suggested ? (
            <Suggestions ask={ask} />
          ) : (
            ask.answer?.text !== undefined && <AnswerWords text={ask.answer.text} />
          )}
        </>
      )}
    </section>
  );
}

// One answer a message carries: which ask it answers, and what it chose in
// the card's terms, with its own words beneath. The ask, when the page holds
// it, says whether it suggested answers; an answer that picked one shows that
// it did.
function AnswerEvent({
  answer,
  find,
}: {
  answer: AnswerRead;
  find: (seq: number) => Message | undefined;
}) {
  const asked = find(answer.ask_seq)?.asks?.find((each) => each.number === answer.ask);
  const suggested = answer.labels !== undefined || (asked?.suggestions.length ?? 0) > 0;
  return (
    <>
      <p className="event">
        {answer.declined
          ? `Declined ask ${answer.ask}.`
          : `Answered ask ${answer.ask}${answered(answer, suggested)}`}
      </p>
      {answer.text !== undefined && <AnswerWords text={answer.text} />}
      {!answer.ask_live && (
        <p className="event">Ask {answer.ask} has since been revised or retracted.</p>
      )}
    </>
  );
}

// What a message does besides its text: replace or retract another, answer
// asks, withdraw asks, set the topic.
function Events({
  message,
  find,
}: {
  message: Message;
  find: (seq: number) => Message | undefined;
}) {
  return (
    <>
      {message.replaces !== undefined && (
        <p className="event">
          {carriesNothing(message)
            ? `Retracted #${message.replaces}.`
            : `Replaces #${message.replaces}.`}
        </p>
      )}
      {message.answers?.map((answer) => (
        <AnswerEvent key={answer.ask} answer={answer} find={find} />
      ))}
      {message.withdrawals?.map((withdrawal) => (
        <p key={withdrawal.ask} className="event">
          Withdrew ask {withdrawal.ask}: {withdrawal.reason}
        </p>
      ))}
      {message.topic !== undefined && <p className="event">Set the topic to “{message.topic}”.</p>}
    </>
  );
}

// Which message's options menu is open, of the messages shown, so only one
// is open at a time.
export interface OpenMenu {
  open: number | undefined;
  set(update: (open: number | undefined) => number | undefined): void;
}

interface Option {
  label: string;
  disabled: boolean;
  // Whether it replaces the message, and so waits for an empty composer.
  replaces: boolean;
  // Why it must wait for something else, while it must.
  hint?: string | undefined;
  choose(): void;
}

// optionsOf lists what the operator can do from a live message: mark the
// thread unread from it and archive through it, until the archive mark
// reaches it; change the answers it carries while any ask they answer is
// live and they are not already being changed; and edit any other message of
// theirs, which drops answers to asks since revised or retracted.
function optionsOf(message: Message, actions: MessageActions): Option[] {
  const held = actions.drafting || actions.loading;
  const changing = actions.staged?.kind === "answers" && actions.staged.replaces === message.seq;
  const answersLive = message.answers?.some((answer) => answer.ask_live) === true;
  const changeable = answersLive && mine(message) && !changing;
  const archiveHint = actions.archiveHint(message);
  const archived = message.seq <= actions.archivedThrough;
  return [
    ...(archived
      ? []
      : [
          {
            label: "Mark unread from here",
            disabled: actions.markingHeld,
            replaces: false,
            choose: () => actions.markUnread(message),
          },
          {
            label: "Archive through here",
            disabled: actions.markingHeld || archiveHint !== undefined,
            replaces: false,
            hint: archiveHint,
            choose: () => actions.archiveThrough(message),
          },
        ]),
    ...(mine(message) && !answersLive
      ? [{ label: "Edit", disabled: held, replaces: true, choose: () => actions.edit(message) }]
      : []),
    ...(changeable
      ? [
          {
            label: "Change answer",
            disabled: held,
            replaces: true,
            choose: () => actions.changeAnswers(message),
          },
        ]
      : []),
  ];
}

// useReadAloud gives a message's Read aloud option where the browser can
// speak, which reads Stop while that message is being read, and whether the
// device could not read it.
function useReadAloud(
  message: Message,
  target: ThreadTarget,
): { options: Option[]; failed: boolean } {
  const speaking = useSpeaking();
  const failed = useSpeechFailed();
  if (!speechSupported()) {
    return { options: [], failed: false };
  }
  const key = `${target.agent}/${target.session}/${target.number}#${message.seq}`;
  const options: Option[] = [
    speaking === key
      ? { label: "Stop", disabled: false, replaces: false, choose: stopSpeaking }
      : {
          label: "Read aloud",
          disabled: false,
          replaces: false,
          choose: () => speak(key, wordsOf(message)),
        },
  ];
  return { options, failed: failed === key };
}

// MessageOptions is a message's options menu, on a message that offers any,
// each option saying why it waits while it must.
function MessageOptions({
  message,
  options,
  drafting,
  menu,
}: {
  message: Message;
  options: Option[];
  // Whether the composer holds a draft, which options that replace the
  // message wait on.
  drafting: boolean;
  menu: OpenMenu;
}) {
  const id = useId();
  const { seq } = message;
  const { set } = menu;
  const waiting = drafting && options.some((option) => option.replaces);
  return (
    <OptionsMenu
      label={`Options for message ${seq}`}
      open={menu.open === seq}
      setOpen={(open) => set((current) => (open ? seq : current === seq ? undefined : current))}
      notes={
        <>
          {options.map(
            (option, index) =>
              option.hint !== undefined && (
                <p key={option.label} id={`${id}-hint-${index}`} className="hint">
                  {option.hint}
                </p>
              ),
          )}
          {waiting && (
            <p id={`${id}-hint`} className="hint">
              {replacementHint}
            </p>
          )}
        </>
      }
    >
      {options.map((option, index) => (
        <MenuItem
          key={option.label}
          disabled={option.disabled}
          describedBy={
            option.hint !== undefined
              ? `${id}-hint-${index}`
              : option.replaces && waiting
                ? `${id}-hint`
                : undefined
          }
          onChoose={option.choose}
        >
          {option.label}
        </MenuItem>
      ))}
    </OptionsMenu>
  );
}

// MessageReadMark says, in the head of a live message of the agent's,
// whether the operator had read it when the page first showed it: the closed
// envelope, accented, if not. It says nothing where the page does not know.
function MessageReadMark({ message, unread }: { message: Message; unread: boolean | undefined }) {
  if (!message.live || mine(message) || unread === undefined) {
    return null;
  }
  return unread ? <Mark icon="unread" label="Unread" accent /> : <Mark icon="read" label="Read" />;
}

// AgentReadMark says, at the foot of a live message of the operator's,
// whether the agent has read it: the envelope, closed and in the accent color
// until it has, beside the word agent, muted either way. It says nothing where
// the page does not know how far the agent has read.
function AgentReadMark({
  message,
  agentRead,
}: {
  message: Message;
  agentRead: number | undefined;
}) {
  if (!message.live || !mine(message) || agentRead === undefined) {
    return null;
  }
  const unread = message.seq > agentRead;
  return (
    <p className={unread ? "agent-read unread" : "agent-read"}>
      <Mark
        icon={unread ? "unread" : "read"}
        label={unread ? "Unread by agent" : "Read by agent"}
        shown="agent"
      />
    </p>
  );
}

function MessageBody({
  message,
  context,
  unread,
  menu,
}: {
  message: Message;
  context: MessageContext;
  unread?: boolean | undefined;
  menu?: OpenMenu | undefined;
}) {
  const { actions, agentRead } = context;
  const failure = actions?.markFailure?.seq === message.seq ? actions.markFailure : undefined;
  const readAloud = useReadAloud(message, context.target);
  const files = useMessageFiles(message, context.target);
  const options = [
    ...(actions !== undefined && message.live ? optionsOf(message, actions) : []),
    ...readAloud.options,
  ];
  return (
    <>
      <div className="message-head">
        <p>
          <MessageReadMark message={message} unread={unread} />{" "}
          <span className="author">{authorName(message.author)}</span> ·{" "}
          <Time value={message.created_at} /> · #{message.seq}
          {actions !== undefined && message.seq <= actions.archivedThrough && (
            <>
              {" "}
              <Mark icon="archive" label="Archived" />
            </>
          )}
        </p>
        {menu !== undefined && options.length > 0 && (
          <MessageOptions
            message={message}
            options={options}
            drafting={actions?.drafting === true}
            menu={menu}
          />
        )}
      </div>
      {failure !== undefined && (
        <div className="notice danger" role="alert">
          <p>
            {failure.action} failed: {describeFailure(failure.failure)}
          </p>
        </div>
      )}
      {readAloud.failed && <Status>This device could not read this message aloud.</Status>}
      {message.seq === 1 && <p className="event">Started this thread.</p>}
      <Events message={message} find={context.find} />
      {message.text !== undefined && <Markdown text={message.text} files={files.links} />}
      {message.detail !== undefined && (
        <MessageDetail seq={message.seq} detail={message.detail} files={files.links} />
      )}
      {message.references !== undefined && (
        <References references={message.references} target={context.target} />
      )}
      {files.list}
      {message.asks?.map((ask) => (
        <AskCard key={ask.number} message={message} ask={ask} context={context} />
      ))}
      <AgentReadMark message={message} agentRead={agentRead} />
    </>
  );
}

export function MessageView({
  message,
  context,
  unread,
  menu,
}: {
  message: Message;
  context: MessageContext;
  // Whether the message was unread when the page showed it.
  unread?: boolean | undefined;
  menu?: OpenMenu | undefined;
}) {
  const label = `Message ${message.seq} by ${authorName(message.author)}`;
  if (!message.live) {
    // A replacement carrying nothing retracts the message.
    const replacement =
      message.replaced_by === undefined ? undefined : context.find(message.replaced_by);
    const retracted = replacement !== undefined && carriesNothing(replacement);
    return (
      <article id={`message-${message.seq}`} className="message replaced" aria-label={label}>
        <details>
          <summary>
            #{message.seq} by {authorName(message.author)},{" "}
            {retracted ? "retracted in" : "replaced by"} #{message.replaced_by}
            {context.actions !== undefined && message.seq <= context.actions.archivedThrough && (
              <>
                {" "}
                <Mark icon="archive" label="Archived" />
              </>
            )}
          </summary>
          <MessageBody message={message} context={{ ...context, actions: undefined }} menu={menu} />
        </details>
      </article>
    );
  }
  // A live message takes focus from script, as the jump to unread moves it.
  return (
    <article
      id={`message-${message.seq}`}
      tabIndex={-1}
      className={unread ? "message unread" : "message"}
      aria-label={label}
    >
      <MessageBody message={message} context={context} unread={unread} menu={menu} />
    </article>
  );
}

// MessageList lists messages in order, marking whether each was read: those
// unread when the page first showed them are marked unread. Each live message
// has its options menu, one open at a time.
export function MessageList({
  messages,
  fresh,
  context,
}: {
  messages: Message[];
  fresh: ReadonlySet<number>;
  context: MessageContext;
}) {
  const [open, setOpen] = useState<number>();
  const menu: OpenMenu = { open, set: setOpen };
  // Leaving the thread stops reading aloud.
  useEffect(() => stopSpeaking, []);
  return (
    <ol className="messages">
      {messages.map((message) => (
        <li key={message.seq}>
          <MessageView
            message={message}
            context={context}
            unread={fresh.has(message.seq)}
            menu={menu}
          />
        </li>
      ))}
    </ol>
  );
}
