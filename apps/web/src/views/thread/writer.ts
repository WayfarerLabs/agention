import {
  type Attachment,
  codePointLength,
  type CursorsResult,
  type Message,
  type MessageSendRequest,
  maxMessageDetail,
  maxMessageText,
  type WriteResult,
} from "@wayfarerlabs/agention-api";
import { useCallback, useRef, useState } from "react";
import { ApiFailure, describeFailure, request, threadPath } from "../../api.ts";
import { newRequestId, useUnauthenticatedCheck } from "../../data.ts";
import { useSession } from "../../session.tsx";

export interface ThreadTarget {
  agent: string;
  session: string;
  number: number;
}

// An answer as the operator writes it on an ask's card: the suggested answers
// picked, whether the Other choice is checked instead, the words in the
// Notes field, and whether the answer is set aside to decline the ask
// instead. Beside picks the words are notes; with Other, or on an ask
// without suggested answers, they are the whole answer. On an ask with
// suggested answers, words with nothing chosen keep the answer staged but
// incomplete until something is chosen or they are cleared. Declining keeps
// the rest, so undoing it brings the choices back as they were.
export interface AnswerDraft {
  picks: number[];
  other: boolean;
  words: string;
  declined: boolean;
}

// What the composer sends besides its text: answers written on asks' cards,
// which change the answers of an earlier message when they replace it, or an
// edit of one of the operator's own messages.
export type Staged = StagedAnswers | { kind: "edit"; replaces: number };
export interface StagedAnswers {
  kind: "answers";
  // In ask number order, at most as many as one message carries, and at
  // least one. A change holds one for each live ask its message answered.
  answers: StagedAnswer[];
  replaces?: number;
  // The asks, by number, whose answers the message being changed carries
  // though their requester since revised or retracted them: those answers go
  // with that message.
  dropped?: number[];
}

// An answer on one ask's card: the ask's number, the message carrying it, and
// its suggested answers' labels, to say what is staged; an ask with no labels
// suggests no answers.
export interface StagedAnswer {
  ask: number;
  seq: number;
  labels: string[];
  answer: AnswerDraft;
}

export const blank = (text: string) => text.trim() === "";

// wordsNeeded says whether a staged answer needs words, being them whole:
// while Other is checked, or on an ask without suggested answers. Beside
// picks alone they are optional notes.
const wordsNeeded = ({ answer, labels }: StagedAnswer) => answer.other || labels.length === 0;

// holdsAnswer says whether a draft holds anything of an answer: a decline,
// something chosen, or words. A new answer that holds nothing stages nothing.
export function holdsAnswer(answer: AnswerDraft): boolean {
  return answer.declined || answer.picks.length > 0 || answer.other || answer.words !== "";
}

// ownWords gives the words a staged answer sends, unless they are blank. An
// answer is sent only once complete, so they go beside its picks or as the
// whole answer.
export function ownWords(staged: StagedAnswer): string | undefined {
  return blank(staged.answer.words) ? undefined : staged.answer.words;
}

// wordsMissing says whether a staged answer, new or changed, cannot be sent
// for want of words: they are needed, and are blank.
export function wordsMissing(staged: StagedAnswer): boolean {
  return !staged.answer.declined && wordsNeeded(staged) && ownWords(staged) === undefined;
}

// complete says whether a staged answer can be sent: it is a decline, or has
// words where they are needed and else picks.
function complete(staged: StagedAnswer): boolean {
  return (
    staged.answer.declined ||
    (wordsNeeded(staged) ? ownWords(staged) !== undefined : staged.answer.picks.length > 0)
  );
}

// What the operator writes in the composer's boxes: the message's text, a
// summary, and its detail, which the thread shows folded under the text; and
// the files it carries, once each is ready to send.
export interface Draft {
  text: string;
  detail: string;
  attachments: Attachment[];
}

// Why each of the composer's boxes cannot be sent as it stands, if it cannot.
export interface DraftProblems {
  text?: string;
  detail?: string;
}

const count = (value: number) => value.toLocaleString("en");

// overBy says how far text is over a bound, counted in code points as the
// server counts it, or undefined when it is within it.
function overBy(text: string, max: number): string | undefined {
  const length = codePointLength(text);
  return length > max
    ? `${count(length)} characters, ${count(length - max)} over the ${count(max)}`
    : undefined;
}

// draftProblems says why a draft cannot be sent: a box over its bound, or
// detail without text, which it goes under. Neither box cuts what is typed or
// pasted into it, so the operator sees what is over and moves it; the
// message box, a summary, says where the rest belongs.
export function draftProblems({ text, detail }: Pick<Draft, "text" | "detail">): DraftProblems {
  const textOver = overBy(text, maxMessageText);
  const detailOver = overBy(detail, maxMessageDetail);
  return {
    ...(textOver === undefined
      ? {}
      : {
          text: `${textOver} a message holds: keep it to a summary, and put the rest in Details.`,
        }),
    ...(detailOver !== undefined
      ? { detail: `${detailOver} Details hold.` }
      : !blank(detail) && blank(text)
        ? { detail: "Details go under a message: write one above." }
        : {}),
  };
}

// sendable says whether the composer holds something complete to send, each
// box within its bound: answers, each complete, with text or files or
// without; or text or files alone. An edit replaces a message, so it needs
// text or files: the page never sends a bare withdrawal.
export function sendable(draft: Draft, staged: Staged | undefined): boolean {
  const problems = draftProblems(draft);
  if (problems.text !== undefined || problems.detail !== undefined) {
    return false;
  }
  if (staged?.kind === "answers") {
    return staged.answers.length > 0 && staged.answers.every(complete);
  }
  return !blank(draft.text) || draft.attachments.length > 0;
}

// withAnswer stages the answer on one ask's card, beside the others staged.
export function withAnswer(staged: Staged | undefined, answer: StagedAnswer): Staged | undefined {
  if (staged?.kind === "edit") {
    return staged;
  }
  const others = (staged?.answers ?? []).filter((each) => each.ask !== answer.ask);
  return {
    ...staged,
    kind: "answers",
    answers: [...others, answer].sort((a, b) => a.ask - b.ask),
  };
}

// withoutAnswer drops the answer on one ask's card, and with the last answer
// what is staged.
export function withoutAnswer(staged: Staged | undefined, ask: number): Staged | undefined {
  if (staged?.kind !== "answers") {
    return staged;
  }
  const answers = staged.answers.filter((each) => each.ask !== ask);
  return answers.length === 0 ? undefined : { ...staged, answers };
}

// What a write says, without the fields the writer adds.
export type WriteContent = Omit<MessageSendRequest, "request_id" | "seen_through">;

function answerOf(staged: StagedAnswer): NonNullable<WriteContent["answers"]>[number] {
  const { answer } = staged;
  if (answer.declined) {
    return { ask: staged.ask, declined: true };
  }
  const words = ownWords(staged);
  return {
    ask: staged.ask,
    ...(answer.picks.length === 0 ? {} : { picks: answer.picks }),
    ...(words === undefined ? {} : { text: words }),
  };
}

// contentOf builds the message the composer sends: its text, its detail and
// its files, each when it has any, and what is staged. A replacement is a
// whole message, so an edit carries the text, detail and files it keeps
// again, and a change of answers its text, detail and files, if any, and
// every answer.
export function contentOf(
  { text, detail, attachments }: Draft,
  staged: Staged | undefined,
): WriteContent {
  const written = {
    ...(blank(text) ? {} : { text }),
    ...(blank(detail) ? {} : { detail }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
  if (staged === undefined) {
    return written;
  }
  if (staged.kind === "edit") {
    return { ...written, replaces: staged.replaces };
  }
  return {
    ...written,
    answers: staged.answers.map(answerOf),
    ...(staged.replaces === undefined ? {} : { replaces: staged.replaces }),
  };
}

// failureAt says why a write failed when the server's refusal names a field
// at or within the given one.
export function failureAt(failure: unknown, field: string): string | undefined {
  return failure instanceof ApiFailure &&
    (failure.field === field || failure.field?.startsWith(`${field}.`) === true)
    ? describeFailure(failure)
    : undefined;
}

// wordsRefused says whether the server refused the own words of an answer,
// which show at their field on the ask's card.
export function wordsRefused(failure: unknown): boolean {
  return failure instanceof ApiFailure && /^answers\.\d+\.text$/.test(failure.field ?? "");
}

// wordsFailure says why the server refused the own words of the answer to an
// ask, as staged when it was sent: the refusal names that answer by its place
// among those sent.
export function wordsFailure(
  failure: unknown,
  staged: Staged | undefined,
  ask: number,
): string | undefined {
  const index =
    staged?.kind === "answers" ? staged.answers.findIndex((each) => each.ask === ask) : -1;
  return index < 0 ? undefined : failureAt(failure, `answers.${index}.text`);
}

// staleChange says how messages that landed, those a stale write missed or
// the one a write just wrote, change what is staged, and what of it can still
// be sent. A new answer goes when its ask was revised, withdrawn or answered,
// and the rest stay. A replacement goes whole when the message it replaces
// was replaced; a change of answers drops only the answers whose asks were
// revised or retracted, by replacing their message, which go with the
// message it changes. A withdrawal needs an open ask, so it never reaches an
// answered one and changes no change of answers.
export function staleChange(
  staged: Staged | undefined,
  landed: readonly Pick<WriteContent, "replaces" | "answers" | "withdrawals">[],
): { change: string; left: Staged | undefined } | undefined {
  if (staged === undefined) {
    return undefined;
  }
  const replaced = (seq: number) => landed.some((message) => message.replaces === seq);
  if (staged.kind === "edit") {
    return replaced(staged.replaces)
      ? { change: "The message you were editing was replaced.", left: undefined }
      : undefined;
  }
  if (staged.replaces !== undefined) {
    if (replaced(staged.replaces)) {
      return { change: "The answers you were changing were changed.", left: undefined };
    }
    // An answer to an ask revised or retracted meanwhile goes with the
    // message being changed; the change answers again the rest.
    const gone = staged.answers.filter((each) => replaced(each.seq)).map((each) => each.ask);
    if (gone.length === 0) {
      return undefined;
    }
    const answers = staged.answers.filter((each) => !gone.includes(each.ask));
    return {
      change:
        `${gone.map((ask) => `Ask ${ask} was revised or retracted.`).join(" ")} ` +
        `${gone.length === 1 ? "Its answer goes" : "Their answers go"} with the message you were changing.`,
      // With no live ask left to answer again, the change is an edit of the
      // message's text.
      left:
        answers.length === 0
          ? { kind: "edit", replaces: staged.replaces }
          : {
              ...staged,
              answers,
              dropped: [...(staged.dropped ?? []), ...gone].sort((a, b) => a - b),
            },
    };
  }
  const answered = (ask: number) =>
    landed.some((message) => message.answers?.some((each) => each.ask === ask) === true);
  const withdrawn = (ask: number) =>
    landed.some((message) => message.withdrawals?.some((each) => each.ask === ask) === true);
  // An open ask closes when it is withdrawn or answered, or when its message
  // is replaced, by asks that revise it. One a replacement of its message
  // withdraws by name reads as withdrawn, not revised.
  const changes = staged.answers.flatMap((each) =>
    withdrawn(each.ask)
      ? [`Ask ${each.ask} was withdrawn.`]
      : answered(each.ask)
        ? [`Ask ${each.ask} was answered.`]
        : replaced(each.seq)
          ? [`Ask ${each.ask} was revised.`]
          : [],
  );
  if (changes.length === 0) {
    return undefined;
  }
  const answers = staged.answers.filter(
    (each) => !replaced(each.seq) && !answered(each.ask) && !withdrawn(each.ask),
  );
  return {
    change: `${changes.join(" ")} ${changes.length === 1 ? "Its answer was" : "Their answers were"} removed.`,
    left: answers.length === 0 ? undefined : { ...staged, answers },
  };
}

// How a write ended: the message written, the messages it missed when it was
// stale, why it failed otherwise, as a refusal, no answer or a lost sign-in,
// or undefined when it was not sent: marking the missed messages read first
// failed, or there were none to mark.
export type Outcome = { written: number } | { missed: Message[] } | { failed: unknown } | undefined;

export interface Writer {
  pending: boolean;
  // Why the last write failed, unless it was stale.
  failure: unknown;
  // The messages the last write missed, while it is stale.
  missed: Message[] | undefined;
  // missedNow gives them as they stand, for a caller that reads them after a
  // wait of its own, before the page shows them.
  missedNow(): Message[] | undefined;
  // write sends content as seen through seenThrough, the message the draft
  // was started from; shown is the last message on screen now. Stale, the
  // missed messages are kept; the draft is the composer's, so it is never
  // lost.
  write(content: WriteContent, seenThrough: number, shown: number): Promise<Outcome>;
  // readAndWrite marks the missed messages read, then writes again as seen
  // through the last of them.
  readAndWrite(content: WriteContent): Promise<Outcome>;
  // readMissed marks the missed messages read and writes nothing, for a draft
  // that does not fit them. It resolves to the last of them, or undefined when
  // that failed.
  readMissed(): Promise<number | undefined>;
}

// useWriter writes messages to one thread, and calls onWritten whenever the
// thread's view should catch up: after a write lands or goes stale, and after
// missed messages are marked read. reached is the latest message the operator
// has now seen, read or written, when the action moved it: every message up
// to it was on screen, among the missed messages shown, or the operator's own.
//
// A write's request id lets the server recognize a retry of a write that
// landed though its answer was lost. A retry keeps the id only while its
// content is unchanged and the thread shows no message beyond what the failed
// attempt had seen: otherwise a write that did land would be replayed in place
// of an answer to something newer. A stale write was refused and recorded
// nowhere, so its resend keeps the id.
export function useWriter(target: ThreadTarget, onWritten: (reached?: number) => void): Writer {
  const { csrf } = useSession();
  const onFailure = useUnauthenticatedCheck();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [missed, setMissedState] = useState<Message[] | undefined>(undefined);
  const missedNow = useRef<Message[] | undefined>(undefined);
  const setMissed = useCallback((value: Message[] | undefined) => {
    missedNow.current = value;
    setMissedState(value);
  }, []);
  const attempt = useRef<{ content: string; requestId: string; seenThrough: number }>(undefined);
  const { agent, session, number } = target;

  // run runs one request, keeping why it failed: the missed messages when it
  // was stale, the failure otherwise.
  const run = useCallback(
    async <T>(
      change: () => Promise<T>,
    ): Promise<
      { done: T } | { failed: "stale"; missed: Message[] } | { failed: "other"; failure: unknown }
    > => {
      setPending(true);
      setFailure(undefined);
      try {
        return { done: await change() };
      } catch (error) {
        if (error instanceof ApiFailure && error.code === "stale") {
          const missed = error.missed ?? [];
          setMissed(missed);
          return { failed: "stale", missed };
        }
        setFailure(error);
        onFailure(error);
        return { failed: "other", failure: error };
      } finally {
        setPending(false);
      }
    },
    [onFailure],
  );

  const markRead = useCallback(
    (through: number) =>
      run(() =>
        request<CursorsResult>("POST", threadPath(agent, session, number, "/read"), {
          csrf,
          body: { through },
        }),
      ),
    [agent, session, number, csrf, run],
  );

  const send = useCallback(
    async (
      content: WriteContent,
      seenThrough: number,
      keepId: boolean,
      readFirst: boolean,
    ): Promise<Outcome> => {
      const text = JSON.stringify(content);
      if (!keepId || attempt.current?.content !== text) {
        attempt.current = { content: text, requestId: newRequestId(), seenThrough };
      }
      attempt.current.seenThrough = seenThrough;
      const { requestId } = attempt.current;
      if (readFirst && "failed" in (await markRead(seenThrough))) {
        return undefined;
      }
      const result = await run(() =>
        request<WriteResult>("POST", threadPath(agent, session, number, "/messages"), {
          csrf,
          body: { ...content, request_id: requestId, seen_through: seenThrough },
        }),
      );
      if ("failed" in result) {
        if (readFirst || result.failed === "stale") {
          onWritten(readFirst ? seenThrough : undefined);
        }
        return result.failed === "stale" ? { missed: result.missed } : { failed: result.failure };
      }
      attempt.current = undefined;
      setMissed(undefined);
      onWritten(result.done.seq);
      return { written: result.done.seq };
    },
    [agent, session, number, csrf, run, markRead, onWritten],
  );

  const write = useCallback(
    (content: WriteContent, seenThrough: number, shown: number) =>
      send(
        content,
        seenThrough,
        attempt.current !== undefined && shown <= attempt.current.seenThrough,
        false,
      ),
    [send],
  );
  const readAndWrite = useCallback(
    (content: WriteContent) => {
      const through = missed?.at(-1)?.seq;
      return through === undefined
        ? Promise.resolve(undefined)
        : send(content, through, true, true);
    },
    [send, missed],
  );
  const readMissed = useCallback(async () => {
    const through = missed?.at(-1)?.seq;
    if (through === undefined || "failed" in (await markRead(through))) {
      return undefined;
    }
    attempt.current = undefined;
    setMissed(undefined);
    onWritten(through);
    return through;
  }, [missed, markRead, onWritten]);
  return {
    pending,
    failure,
    missed,
    missedNow: () => missedNow.current,
    write,
    readAndWrite,
    readMissed,
  };
}
