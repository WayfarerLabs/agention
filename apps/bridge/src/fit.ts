import type { ErrorBody } from "@wayfarerlabs/agention-api";

// The most a tool's text may take, in bytes of UTF-8 JSON, so that every
// agent host passes it to the model whole: Codex keeps about 48,000 bytes of
// a tool's output, Claude Code keeps a result of up to 50,000 characters
// inline and about 11,000 characters of error text. Each tool declares the
// result limit, with room for the status reminder, to Claude Code, which then
// also exempts it from its token limit.
export const maxResultBytes = 40_000;
export const maxErrorBytes = 10_000;

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function fits(answer: unknown): boolean {
  return bytesOf(answer) <= maxResultBytes;
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The elements of a page, or undefined if the answer holds no such list.
function listOf(answer: unknown, field: string): unknown[] | undefined {
  const list = isJson(answer) ? answer[field] : undefined;
  return Array.isArray(list) ? list : undefined;
}

// answerThatFits asks for a page and keeps the answer within the cap. An
// answer over it first leaves out its thread's roll-up. While the answer is
// still over the cap, it asks again for half as many elements as the smaller
// of the last page size and what the answer held, down to one, so the agent
// always gets a page and its cursor always moves forward, and the asking ends
// even if a server ignores the page size. An answer still over the cap at one
// element leaves out its largest text.
export async function answerThatFits(
  limit: number,
  field: string,
  ask: (limit: number) => Promise<unknown>,
): Promise<unknown> {
  let pageSize = limit;
  let answer = withinCapFirst(await ask(pageSize));
  while (!fits(answer)) {
    const count = listOf(answer, field)?.length ?? 0;
    const smaller = Math.floor(Math.min(count, pageSize) / 2);
    if (smaller < 1) {
      return leaveOutText(answer);
    }
    pageSize = smaller;
    answer = withinCapFirst(await ask(pageSize));
  }
  return answer;
}

// The fields of a thread's answer that roll up the pull requests and branches
// its live messages name. A page of its messages matters more to the agent
// reading it, and a smaller page brings the roll-up back unless the roll-up
// alone is over the cap; the messages' own lists still name its entries.
const rollupFields = ["pull_requests", "branches"];

// withinCapFirst leaves the roll-up out of an answer over the cap, each of
// its fields that lists any entry, naming each in the answer's omitted list.
function withinCapFirst(answer: unknown): unknown {
  if (fits(answer) || !isJson(answer)) {
    return answer;
  }
  const omitted = rollupFields.filter((field) => {
    const rollup = answer[field];
    return isJson(rollup) && Array.isArray(rollup.links) && rollup.links.length > 0;
  });
  if (omitted.length === 0) {
    return answer;
  }
  const result: Json = { ...answer, omitted };
  for (const field of omitted) {
    delete result[field];
  }
  return result;
}

// Every field of a message and of a thread's summary that carries text, by
// its path within it; a "*" step takes every element of a list. What else
// they hold is bounded small, the summary's list of open asks and its counts
// of pull requests and branches included.
const messageText = [
  ["text"],
  ["detail"],
  ["references"],
  ["pull_requests"],
  ["branches"],
  ["attachments"],
  ["asks", "*", "question"],
  ["asks", "*", "suggestions"],
  ["asks", "*", "fallback"],
  ["asks", "*", "answer", "labels"],
  ["asks", "*", "answer", "text"],
  ["asks", "*", "withdrawal", "reason"],
  ["answers", "*", "question"],
  ["answers", "*", "labels"],
  ["answers", "*", "text"],
  ["withdrawals", "*", "reason"],
];
const threadText = [
  ["title"],
  ["open_asks", "lead", "question"],
  ["withdrawal", "reason"],
  ["links", "pull_request"],
  ["links", "branch"],
];

// A field that carries text: where it is in the answer, the object holding
// it, its name there, and its size as JSON.
interface TextField {
  path: string;
  holder: Json;
  field: string;
  bytes: number;
}

function textFields(prefix: string, value: unknown, paths: string[][]): TextField[] {
  return paths.flatMap((path) => fieldsAt(prefix, value, path));
}

// fieldsAt finds the text fields at one path within value, where the path
// may step into every element of a list.
function fieldsAt(prefix: string, value: unknown, path: string[]): TextField[] {
  const [step = "", ...rest] = path;
  if (step === "*") {
    return Array.isArray(value)
      ? value.flatMap((element, i) => fieldsAt(`${prefix}.${i}`, element, rest))
      : [];
  }
  if (!isJson(value) || value[step] === undefined) {
    return [];
  }
  if (rest.length > 0) {
    return fieldsAt(`${prefix}.${step}`, value[step], rest);
  }
  return [{ path: `${prefix}.${step}`, holder: value, field: step, bytes: bytesOf(value[step]) }];
}

// leaveOutText makes an answer still over the cap at one element fit by
// leaving out its largest text-bearing fields, largest first: titles, texts
// (an answer's own words included) and details, references, a message's
// lists of pull requests, branches and files, questions (an answer's
// included), suggested answers and the labels of those picked, fallback
// text, withdrawals' reasons, and the one pull request or branch a thread's
// summary gives, of its thread, messages, or threads. Each
// field it leaves out is named, as a dotted path, in the answer's omitted
// list, after any it already names.
function leaveOutText(answer: unknown): unknown {
  if (!isJson(answer)) {
    return answer;
  }
  const result: Json = structuredClone(answer);
  const fields = [
    ...textFields("thread", result.thread, threadText),
    ...(listOf(result, "messages") ?? []).flatMap((message, i) =>
      textFields(`messages.${i}`, message, messageText),
    ),
    ...(listOf(result, "threads") ?? []).flatMap((thread, i) =>
      textFields(`threads.${i}`, thread, threadText),
    ),
  ];
  // The sort is stable, so fields of equal size go in the answer's order.
  fields.sort((a, b) => b.bytes - a.bytes);
  const omitted: string[] = Array.isArray(result.omitted) ? (result.omitted as string[]) : [];
  const already = omitted.length;
  for (const { path, holder, field } of fields) {
    if (fits({ ...result, omitted })) {
      break;
    }
    delete holder[field];
    omitted.push(path);
  }
  return omitted.length === already ? answer : { ...result, omitted };
}

// trimMissed keeps a stale error within the error limit: it lists only the
// leading missed messages that fit, and its message says from which sequence
// to read the rest. The server lists a bounded number of missed messages, so
// the message counts only those it keeps.
export function trimMissed(body: ErrorBody): ErrorBody {
  const missed = body.error.missed;
  if (missed === undefined || bytesOf(body) <= maxErrorBytes) {
    return body;
  }
  const keeping = (kept: number): ErrorBody => {
    const readAfter = kept > 0 ? (missed[kept - 1]?.seq ?? 0) : (missed[0]?.seq ?? 1) - 1;
    const listed =
      kept === 0
        ? "none of the missed messages is listed"
        : kept === 1
          ? "only the first missed message is listed"
          : `only the first ${kept} missed messages are listed`;
    const message =
      `${body.error.message}; ${listed}, to keep this answer short: read ` +
      `${kept === 0 ? "them" : "the rest"} with thread_get, after ${readAfter}`;
    return { error: { ...body.error, message, missed: missed.slice(0, kept) } };
  };
  let kept = 0;
  while (kept < missed.length && bytesOf(keeping(kept + 1)) <= maxErrorBytes) {
    kept++;
  }
  return keeping(kept);
}
