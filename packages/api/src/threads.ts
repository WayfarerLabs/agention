import { z } from "zod";
import {
  askNumber,
  cursor,
  pageLimit,
  queryNumber,
  requestId,
  sequence,
  threadNumber,
} from "./bounds.ts";
import { attachmentList, attachmentRead, fileTotals } from "./files.ts";
import { name } from "./names.ts";
import { reference, referenceList } from "./references.ts";
import { threadPresence } from "./sessions.ts";
import { multilineText, singleLineText } from "./text.ts";
import { timestamp } from "./time.ts";

// A thread is a title and an append-only log of messages. Everything else
// about it, its topic, its open asks and its status included, derives from
// the messages no later message replaced. A message's text and its detail are
// Markdown; the title, questions, suggested answers, an answer's own words,
// fallback text, a withdrawal's reason and reference labels are plain text; a
// topic is a name, as an agent's and a session's are. All are stored and
// returned exactly as written.

export const impact = z
  .enum(["blocking", "assuming", "none"])
  .describe(
    "How the ask affects the requester's work while it is open: blocking (the work the ask is " +
      "for stops until it is answered, while the requester carries on with other work), " +
      "assuming (that work goes on under an assumption the message states) or none.",
  );
export type Impact = z.infer<typeof impact>;

// How pressing an ask is, most pressing first, the order lists rank asks in.
export const priority = z
  .enum(["urgent", "high", "normal", "low"])
  .describe(
    "Where the audience should focus, by what delay costs, independent of impact. urgent: " +
      "something is breaking, costing money or about to miss a real deadline now. high: delay " +
      "costs real work or time. normal, the default: waiting costs little. low: whenever " +
      "convenient.",
  );
export type Priority = z.infer<typeof priority>;

// How long answering an ask takes the audience, quickest first, the order
// lists rank asks in. Unstated, it is unknown.
export const effort = z
  .enum(["quick", "under_15m", "under_1h", "longer"])
  .describe(
    "How long answering takes the audience, when you can judge it: quick (a glance or a " +
      "short check, about two minutes), under_15m, under_1h, or longer (an hour or more). " +
      "Leave it out when you cannot judge it.",
  );
export type Effort = z.infer<typeof effort>;

export const threadTitle = singleLineText({ min: 1, max: 200 });

// The most a message's text and its detail hold, in code points. The text is
// a summary, read first; the detail beside it carries the rest at length.
export const maxMessageText = 1_000;
export const maxMessageDetail = 20_000;

export const messageText = multilineText({ min: 1, max: maxMessageText }).describe(
  "Markdown, read first: a summary in a few sentences of what the matter is and what is needed. " +
    "Put everything else in detail.",
);
export const messageDetail = multilineText({ min: 1, max: maxMessageDetail }).describe(
  "Markdown, shown folded under the text, which it needs beside it: everything else the reader " +
    "needs to decide on or understand the message without looking elsewhere, such as what was " +
    "found, the options and their tradeoffs, evidence, and excerpts of diffs, logs or errors. " +
    "A fenced code block marked mermaid shows as the diagram it describes. " +
    "Never point at what only your own conversation shows. Messages are never deleted, so take " +
    "keys, tokens and passwords out of any excerpt.",
);
export const question = singleLineText({ min: 1, max: 300 });
export const topic = name.describe(
  "The area of work the thread is in, as a short lowercase name such as auth or billing-api, " +
    "shared by the session's threads in that area; the operator finds a session's threads by " +
    "it. The latest live message that sets one stands; only the requester sets it.",
);
export const fallbackText = multilineText({ min: 0, max: 1_000 }).describe(
  "Plain text: what the requester intends if there is no answer by answer_by.",
);
export const answerBy = timestamp.describe(
  "An advisory time to answer by. The server never acts on it.",
);

export const suggestion = z.object({
  label: singleLineText({ min: 1, max: 100 }),
  description: singleLineText({ min: 0, max: 300 })
    .default("")
    .describe("What picking it means, when the label alone does not say."),
});
export type Suggestion = z.infer<typeof suggestion>;

// An ask, a question a requester's message puts to the audience. It never
// changes: the requester revises it by replacing its message, whose asks are
// then new asks with new numbers, or withdraws it, with a reason, in a later
// message.
export const ask = z
  .object({
    question,
    suggestions: z
      .array(suggestion)
      .max(10)
      .default([])
      .refine(
        (suggestions) =>
          new Set(suggestions.map((suggestion) => suggestion.label.normalize("NFC"))).size ===
          suggestions.length,
        "suggested answers must be distinct",
      )
      .describe(
        "Suggested answers the audience may pick; it may always answer in its own words " +
          "instead, or beside its picks where several are allowed.",
      ),
    multiple: z
      .boolean()
      .default(false)
      .describe("Whether the audience may pick several suggested answers."),
    impact: impact.default("none"),
    priority: priority.default("normal"),
    effort: effort.optional(),
    answer_by: answerBy.optional(),
    fallback: fallbackText.optional(),
  })
  .superRefine((value, context) => {
    if (value.multiple && value.suggestions.length < 2) {
      context.addIssue({
        code: "custom",
        path: ["suggestions"],
        message: "an ask that allows several picks needs at least two suggested answers",
      });
    }
  })
  .describe(
    "A question for the audience, open until a message answers it, declining included, a " +
      "message withdraws it, or its own message is replaced. Only the requester asks. An ask " +
      "never changes: revise it by replacing its message, which asks again under new numbers, " +
      "and withdraw it by a withdrawal in a later message, giving the reason.",
  );
export type Ask = z.infer<typeof ask>;

// The asks one message carries, numbered within the thread in the order
// given, each one past the thread's highest so far.
export const askList = z
  .array(ask)
  .min(1)
  .max(10)
  .describe(
    "Up to ten asks, each numbered within the thread as it is written, in the order given. Put " +
      "asks that belong together in one message; the audience may answer them together or apart.",
  );

export const answerText = multilineText({ min: 1, max: 4_000 }).describe(
  "Plain text: the audience's own words on the ask, instead of a pick or, where several are " +
    "allowed, beside its picks; the whole answer to an ask without suggested answers.",
);

// An answer, the audience's reply written on an ask and sent on a message:
// a decline, or the picked suggested answers and the audience's own words, at
// least one of them. The message's text beside it is any additional
// information.
export const answer = z
  .object({
    ask: askNumber.describe("The number of the ask this answers."),
    declined: z
      .boolean()
      .default(false)
      .describe("The audience will not answer; a decline carries no picks and no text."),
    picks: z
      .array(z.number().int().min(0).max(9))
      .min(1)
      .max(10)
      .optional()
      .describe("The picked suggested answers' indexes, counting from 0."),
    text: answerText.optional(),
  })
  .superRefine((value, context) => {
    const answered = value.picks !== undefined || value.text !== undefined;
    if (value.declined && answered) {
      context.addIssue({
        code: "custom",
        path: [value.picks === undefined ? "text" : "picks"],
        message: "a decline carries no picks and no text",
      });
    }
    if (!value.declined && !answered) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "an answer needs picks, its own words or a decline",
      });
    }
  });
export type Answer = z.infer<typeof answer>;

// The most answers one message carries, each to a different ask.
export const maxAnswers = 10;

// eachAskOnce refuses a list that names an ask twice, since a message
// answers or withdraws each ask once; message says what the second does.
function eachAskOnce(message: string) {
  return (items: { ask: number }[], context: z.RefinementCtx): void => {
    const seen = new Set<number>();
    items.forEach((each, index) => {
      if (seen.has(each.ask)) {
        context.addIssue({ code: "custom", path: [index, "ask"], message });
      }
      seen.add(each.ask);
    });
  };
}

export const answerList = z
  .array(answer)
  .min(1)
  .max(maxAnswers)
  .superRefine(eachAskOnce("answers an ask this message already answers"));

export const withdrawalReason = singleLineText({ min: 1, max: 300 }).describe(
  "Plain text: why the ask no longer needs an answer, such as what settled it.",
);

// A withdrawal, the requester's closing of an open ask it no longer needs
// answered, with its reason, sent on a later message, a replacement of the
// ask's own message included. It is never undone: a replacement of the
// message carrying it withdraws the ask again, whether or not the ask's own
// message is still live.
export const withdrawal = z.object({
  ask: askNumber.describe("The number of the open ask this withdraws."),
  reason: withdrawalReason,
});
export type Withdrawal = z.infer<typeof withdrawal>;

export const withdrawalList = z
  .array(withdrawal)
  .min(1)
  .max(10)
  .superRefine(eachAskOnce("withdraws an ask this message already withdraws"))
  .describe(
    "Up to ten of your open asks that you no longer need answered, each with why, those of " +
      "the message a replacement replaces included. A withdrawal is never undone.",
  );

// Requests.

// The parts any message may carry, its thread's first included. A replacement
// is a whole message: it carries again every part it keeps, and one carrying
// nothing retracts the message it replaces, which the store allows only while
// that message holds no open ask.
const messageParts = {
  text: messageText.optional(),
  detail: messageDetail.optional(),
  references: referenceList.optional(),
  attachments: attachmentList.optional(),
  asks: askList.optional(),
  topic: topic.optional(),
};

// detailNeedsText refuses a message carrying detail without text: the detail
// is the long form of what its text sums up, and readers see the text first.
// It holds for every message, its thread's first included.
export function detailNeedsText(
  value: { text?: string | undefined; detail?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (value.detail !== undefined && value.text === undefined) {
    context.addIssue({
      code: "custom",
      path: ["detail"],
      message: "needs text beside it, summing up what the detail says",
    });
  }
}

export const threadCreateInput = z
  .object({
    request_id: requestId,
    title: threadTitle,
    ...messageParts,
  })
  .superRefine(detailNeedsText);
export type ThreadCreateInput = z.infer<typeof threadCreateInput>;

// The fields of a message as both mounts take them: the parts any message may
// carry, the audience's answers and the requester's withdrawals, and what it
// replaces. message_send's tool takes them without the answers, and
// messageSendInput adds the rules they share, detailNeedsText and needsAPart.
export const messageFields = z.object({
  request_id: requestId,
  seen_through: sequence.describe("The latest message sequence the writer has seen."),
  ...messageParts,
  answers: answerList.optional(),
  withdrawals: withdrawalList.optional(),
  replaces: sequence
    .optional()
    .describe(
      "An earlier message of your own that this one replaces, which is ignored from then on.",
    ),
});

// needsAPart refuses a message that carries nothing. Only a thread's first
// message may, since the title speaks for it. The database stores a message's
// asks, answers and withdrawals in rows of their own, which it cannot see from
// the message's row, so this is where the rule holds. Detail is no part of its
// own, since it needs text beside it.
export function needsAPart(
  value: {
    text?: string | undefined;
    references?: unknown[] | undefined;
    attachments?: unknown[] | undefined;
    asks?: unknown[] | undefined;
    answers?: unknown[] | undefined;
    withdrawals?: unknown[] | undefined;
    topic?: string | undefined;
    replaces?: number | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.text === undefined &&
    value.references === undefined &&
    value.attachments === undefined &&
    value.asks === undefined &&
    value.answers === undefined &&
    value.withdrawals === undefined &&
    value.topic === undefined &&
    value.replaces === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: [],
      message:
        "a message needs text, references, attachments, asks, answers, withdrawals, a topic or a " +
        "message it replaces",
    });
  }
}

export const messageSendInput = messageFields.superRefine(detailNeedsText).superRefine(needsAPart);
export type MessageSendInput = z.infer<typeof messageSendInput>;
// A message as a client writes it, before the schema applies its defaults.
export type MessageSendRequest = z.input<typeof messageSendInput>;

export const markInput = z.object({
  through: sequence.describe("The message sequence to mark through."),
});
export type MarkInput = z.infer<typeof markInput>;

// Marking unread from a message lowers the caller's read mark to just before
// it, never raising it, so that message and every later one by the other
// party are unread again.
export const unreadInput = z.object({
  from: sequence.min(1).describe("The message sequence to mark unread from."),
});
export type UnreadInput = z.infer<typeof unreadInput>;

export const threadGetQuery = z.object({
  after: queryNumber(sequence.default(0)),
  limit: queryNumber(pageLimit),
});
export type ThreadGetQuery = z.infer<typeof threadGetQuery>;

// Responses.

// Who wrote a message: a session, or a person by name.
export const author = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), agent: name, session: name }),
  z.object({ kind: z.literal("person"), name: z.string() }),
]);
export type Author = z.infer<typeof author>;

// An answer as it reads: whether it declined, the picked indexes with the
// labels the ask gave them, and the audience's own words.
const answerParts = {
  declined: z.boolean(),
  picks: z.array(z.number().int()).optional(),
  labels: z.array(z.string()).optional(),
  text: z.string().optional(),
};

// An ask as it reads: its number, what it asks, whether it is open, and its
// live answer or its live withdrawal, each with the sequence of the message
// carrying it.
export const askRead = z.object({
  number: askNumber,
  question: z.string(),
  suggestions: z.array(z.object({ label: z.string(), description: z.string() })),
  multiple: z.boolean(),
  impact,
  priority,
  effort: effort.optional(),
  answer_by: z.string().optional(),
  fallback: z.string().optional(),
  open: z.boolean(),
  answer: z.object({ seq: sequence, ...answerParts }).optional(),
  withdrawal: z.object({ seq: sequence, reason: z.string() }).optional(),
});
export type AskRead = z.infer<typeof askRead>;

// An answer as it reads: the number and question of the ask it answers, the
// sequence of the message carrying that ask, and whether that ask is still
// live, so a reader knows what each answer is for without reading the asks.
export const answerRead = z.object({
  ask: askNumber,
  question: z.string(),
  ask_seq: sequence,
  ask_live: z.boolean(),
  ...answerParts,
});
export type AnswerRead = z.infer<typeof answerRead>;

// A message as it reads now. live says no later message replaced it, and
// replaced_by names the one that did. Its attachments come in the order it
// gave them; its asks, answers and withdrawals in ask number order.
export const message = z.object({
  seq: sequence,
  author,
  created_at: z.string(),
  live: z.boolean(),
  replaced_by: sequence.optional(),
  replaces: sequence.optional(),
  text: z.string().optional(),
  detail: z.string().optional(),
  references: z.array(reference).optional(),
  attachments: z.array(attachmentRead).optional(),
  topic: name.optional(),
  asks: z.array(askRead).optional(),
  answers: z.array(answerRead).optional(),
  withdrawals: z.array(withdrawal).optional(),
});
export type Message = z.infer<typeof message>;

// An open ask, as a thread's summary names the one it leads with, with the
// sequence of the message carrying it.
export const askSummary = z.object({
  number: askNumber,
  seq: sequence,
  question: z.string(),
  impact,
  priority,
  effort: effort.optional(),
  answer_by: z.string().optional(),
  overdue: z.boolean(),
});
export type AskSummary = z.infer<typeof askSummary>;

// The most open asks a thread's summary lists.
export const maxListedAsks = 50;

// An ask by its number and the sequence of the message carrying it.
const askRef = z.object({ number: askNumber, seq: sequence });

// A thread's open asks: the most pressing, at most maxListedAsks, most
// pressing first (by priority, then blocking, then earliest answer-by, then
// lowest number), and how many are open in all; the earliest, which has the
// lowest number; the one the thread leads with, which ranks first under the
// list's order among the asks its filters keep (the most pressing, where
// nothing else decides); and what they add up to. An ask is open to the
// thread's audience; to its requester it awaits an answer.
export const openAsks = z.object({
  asks: z.array(askRef).max(maxListedAsks),
  count: z.number().int().min(0),
  earliest: askRef.optional(),
  lead: askSummary.optional(),
  priority: priority.optional(),
  answer_by: z.string().optional(),
  blocking: z.boolean(),
  overdue: z.boolean(),
});
export type OpenAsks = z.infer<typeof openAsks>;

// A thread's status, rolled up from the asks on its live messages and those
// a live message withdraws: open while any is open; otherwise withdrawn when
// every one is withdrawn, and answered when there are any; none when there
// are none. A revised ask, on a replaced message that no live message
// withdraws, plays no part. It is the same whoever views it.
export const threadStatus = z.enum(["open", "answered", "withdrawn", "none"]);
export type ThreadStatus = z.infer<typeof threadStatus>;

// A thread as the viewer sees it now. updated_at is the time of its latest
// message; read_through is how far the viewer has read it, and unread counts
// the live messages by another party beyond both that and the viewer's
// archive mark, since an archived message is never unread; message_count
// counts its live messages, both parties', archived or not; archived says
// whether the viewer's archive mark reaches the latest message; status rolls
// up its asks, and while it is withdrawn, withdrawal is the latest live
// withdrawal, the first of its message's; credential_active says whether its
// session still has an approved credential. Its audience also sees its
// session's presence, with its state, and whether it is stranded: it holds a
// live message by the audience that the session has not read while the
// session is quiet, has no active credential or has stopped.
export const threadSummary = z.object({
  agent: name,
  session: name,
  number: threadNumber,
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  last_seq: sequence,
  topic: name.optional(),
  read_through: sequence,
  unread: sequence,
  message_count: sequence,
  archived: z.boolean(),
  open_asks: openAsks,
  status: threadStatus,
  withdrawal: withdrawal.extend({ seq: sequence }).optional(),
  credential_active: z.boolean(),
  presence: threadPresence.optional(),
  stranded: z.boolean().optional(),
});
export type ThreadSummary = z.infer<typeof threadSummary>;

// How far each party has read a thread.
export const cursors = z.object({ requester: sequence, audience: sequence });
export type Cursors = z.infer<typeof cursors>;

// The caller's own marks on a thread: how far it has read and archived it.
// Nothing shows one party's archive mark to the other.
export const marks = z.object({ read_through: sequence, archived_through: sequence });
export type Marks = z.infer<typeof marks>;

// What a write produced: the thread's number and the new message's sequence.
// A retry of the same request id returns exactly this, and nothing later.
export const writeResult = z.object({ number: threadNumber, seq: sequence });
export type WriteResult = z.infer<typeof writeResult>;

export const cursorsResult = z.object({ cursors });
export type CursorsResult = z.infer<typeof cursorsResult>;

export const marksResult = z.object({ marks });
export type MarksResult = z.infer<typeof marksResult>;

// The thread, a page of its messages after the requested sequence (more
// follow while the last is below the thread's last_seq), both read cursors,
// the caller's marks, and the distinct files its messages carry, replaced
// ones included.
export const threadGetResult = z.object({
  thread: threadSummary,
  messages: z.array(message),
  cursors,
  marks,
  files: fileTotals,
});
export type ThreadGetResult = z.infer<typeof threadGetResult>;

export const threadFilesQuery = z.object({
  cursor: cursor.optional(),
  limit: queryNumber(pageLimit),
});
export type ThreadFilesQuery = z.infer<typeof threadFilesQuery>;

// A file of a thread as its file list gives it, with the first message that
// carried it, which brought it: that message's sequence, author and time,
// and the name it carries the file under.
export const threadFile = attachmentRead.extend({
  seq: sequence,
  author,
  created_at: z.string(),
});
export type ThreadFile = z.infer<typeof threadFile>;

// A page of a thread's files, each listed once, newest first by the message
// that brought it and then that message's order; next, when present,
// continues the list.
export const threadFilesPage = z.object({
  files: z.array(threadFile),
  next: cursor.optional(),
});
export type ThreadFilesPage = z.infer<typeof threadFilesPage>;
