import type {
  CallToolResult,
  ContentBlock,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  cursor,
  detailNeedsText,
  includeArchivedFilter,
  invalidInputBody,
  markInput,
  messageFields,
  name,
  needsAPart,
  pageLimit,
  priority,
  sequence,
  sessionUpdateInput,
  statusFilter,
  threadCreateInput,
  threadNumber,
  titleSearchFilter,
  topic,
  unreadFilter,
  waitSeconds,
} from "@wayfarerlabs/agention-api";
import { z } from "zod";
import { type AgentApi, type ApiRequest, answerTimeout } from "./agent-api.ts";
import { ApiFailure, BridgeError } from "./errors.ts";
import { registerFileTools } from "./file-tools.ts";
import { answerThatFits, maxResultBytes, trimMissed } from "./fit.ts";
import type { SessionKey } from "./key-file.ts";
import { unknownField, unknownFieldBody } from "./known-fields.ts";
import { lapseLine, maxLapseBytes, type Push } from "./push.ts";
import type { Session } from "./session.ts";
import { maxReminderBytes, type StatusReminder } from "./status-reminder.ts";

// What the tools act through: the server's API, the session, the home
// directory the bridge keeps its files under, what reminds the agent to
// report the session's status and the background wait that pushes answers,
// or why the bridge cannot reach them.
export type Connection =
  | {
      api: AgentApi;
      session: Session;
      home: string;
      statusReminder: StatusReminder;
      push: Push;
    }
  | { problem: BridgeError };
export type Connected = Exclude<Connection, { problem: BridgeError }>;

// What a tool makes its requests in the session with: the API, the key on
// disk, and the path of the session the operator granted it, below which the
// session's routes are.
export interface InSession {
  api: AgentApi;
  key: SessionKey;
  sessionPath: string;
}

// A tool's answer with content blocks after its text, such as an image the
// model can look at. Every other answer is its text alone.
export class WithContent {
  readonly answer: unknown;
  readonly content: ContentBlock[];

  constructor(answer: unknown, content: ContentBlock[]) {
    this.answer = answer;
    this.content = content;
  }
}

// DefineTool registers one tool, whose run answers with what the tool's text
// holds as JSON, or with a WithContent, which adds content blocks after it.
export type DefineTool = <Input extends z.ZodType>(
  toolName: string,
  description: string,
  input: Input,
  run: (input: z.output<Input>, signal: AbortSignal) => Promise<unknown>,
) => void;

// Every tool is truthfully annotated as neither read-only nor destructive,
// and as acting on a closed world: messages are append-only, a key is replaced
// only after the server refused it, and the bridge talks to one configured
// server. Agent hosts can then run the tools without asking each time.
export const toolAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

// Every tool declares the most its result takes, so Claude Code passes it to
// the model whole: its JSON, within the cap, and the status reminder and the
// lapse line that may follow it. How Claude Code measures a result of several
// blocks against the declaration is not documented, so it counts each.
export const toolMeta = {
  "anthropic/maxResultSizeChars": maxResultBytes + maxReminderBytes + maxLapseBytes,
};

// Inputs several tools share, in the API's own bounds.
const thread = threadNumber.describe("The thread's number in this session.");
const limit = pageLimit.describe("The most elements to return, 1 to 100; by default 50.");

const registerInput = z.object({
  agent: name.optional().describe("The agent's name, such as claude; by default AGENTWORKS_AGENT."),
  session: name
    .optional()
    .describe("This session's name, unique to the agent; by default AGENTWORKS_SESSION."),
});

const priorityText = `Priority: ${priority.description ?? ""}`;
const tooLongText =
  "if even one element is too long, its largest text fields are left out and named in " +
  "omitted, and the operator's web UI shows them in full.";
const requestIdText =
  "Give every write a new request_id; retrying a write with the same one is safe.";
const attachingText =
  "To attach a file, upload it with file_upload, then name its upload in attachments; text " +
  "and detail can link to the message's own files as [label](attachment:name), or as " +
  "[label](<attachment:name with spaces>) for a name with spaces.";

// registerTools defines the bridge's tools on the MCP server. Each thread tool
// is one request on the agent API, apart from asking again for a smaller page
// to stay within the cap.
export function registerTools(server: McpServer, connection: Connection): void {
  // reminderBlocks gives the blocks a successful answer ends with: a
  // reminder to send a status update, in plain text after the answer, when
  // one is due. Every tool but register and session_update answers only in
  // an approved session; register can answer before approval, and
  // session_update's own answer is the update. The size each tool declares
  // counts the reminder beside the answer's JSON (toolMeta).
  const reminderBlocks = (toolName: string): ContentBlock[] => {
    if ("problem" in connection || toolName === "register" || toolName === "session_update") {
      return [];
    }
    const text = connection.statusReminder.remind();
    return text === undefined ? [] : [{ type: "text", text }];
  };

  // withLapse ends an answer, failed or not, with the lapse line once the
  // background wait has given up after register said answers are pushed. It
  // comes once, on the next answer of any tool but register, whose own
  // answer says how answers reach the agent.
  const withLapse = (toolName: string, result: CallToolResult): CallToolResult => {
    if ("problem" in connection || toolName === "register" || !connection.push.takeLapse()) {
      return result;
    }
    return { ...result, content: [...result.content, { type: "text", text: lapseLine }] };
  };

  // tool registers one tool. The SDK advertises the input's JSON Schema; the
  // tool parses the arguments itself, so input outside a bound is answered
  // as the server would answer it, and refuses a field it does not know.
  const tool: DefineTool = (toolName, description, input, run) => {
    const call = async (args: unknown, signal: AbortSignal): Promise<CallToolResult> => {
      const unknown = unknownField(input, args);
      if (unknown !== undefined) {
        return failed(JSON.stringify(unknownFieldBody(unknown)));
      }
      const parsed = input.safeParse(args);
      if (!parsed.success) {
        return failed(JSON.stringify(invalidInputBody(parsed.error)));
      }
      try {
        const answer = await run(parsed.data, signal);
        const content: ContentBlock[] =
          answer instanceof WithContent
            ? [{ type: "text", text: JSON.stringify(answer.answer) }, ...answer.content]
            : [{ type: "text", text: JSON.stringify(answer) }];
        return { content: [...content, ...reminderBlocks(toolName)] };
      } catch (error) {
        if (error instanceof ApiFailure) {
          return failed(JSON.stringify(trimMissed(error.body)));
        }
        if (error instanceof BridgeError) {
          return failed(error.message);
        }
        throw error;
      }
    };
    server.registerTool(
      toolName,
      {
        description,
        inputSchema: advertised(input),
        annotations: toolAnnotations,
        _meta: toolMeta,
      },
      async (args: unknown, context): Promise<CallToolResult> =>
        withLapse(toolName, await call(args, context.mcpReq.signal)),
    );
  };

  const connected = (): Connected => {
    if ("problem" in connection) {
      throw connection.problem;
    }
    return connection;
  };

  // inSession gives what a request in the session needs: the names the
  // operator granted, and the key now on disk to sign it.
  // A bridge that learns its approved grant this way, such as one started
  // again under a session whose register said answers are pushed, resumes
  // push without a word to the agent.
  const inSession = async (signal: AbortSignal): Promise<InSession> => {
    const { api, session, push } = connected();
    const { key, granted, learned } = await session.credential(signal);
    if (learned) {
      push.resume();
    }
    return { api, key, sessionPath: `/s/${granted.agent}/${granted.session}` };
  };

  // The session_update calls under way, in the order they were made.
  let statusUpdates: Promise<unknown> = Promise.resolve();

  // onSession makes a request in the session.
  const onSession = async (
    signal: AbortSignal,
    request: (sessionPath: string) => ApiRequest,
  ): Promise<unknown> => {
    const { api, key, sessionPath } = await inSession(signal);
    return api.request(key, { ...request(sessionPath), signal });
  };

  tool(
    "register",
    "Register this agent session with Agention, or check its registration. Call it at the " +
      "start of every conversation, first without names; it is cheap and safe to repeat. If " +
      "it answers that it needs names, call it again with agent and session. The first names " +
      "this bridge uses fix its session for as long as it runs. Until the operator approves, " +
      "the answer gives a code: relay it to the operator, who approves the session by " +
      "matching it. Once approved, the answer names the agent and session the operator " +
      "granted, which every other tool acts in. If the registration can never be approved, " +
      "because the operator rejected or revoked the session's key or the registration expired " +
      "before approval, register makes a new key and registers it, and replaced says why. " +
      "message says what to do next, including the names to pass when you come back and, " +
      "once approved, how answers reach you. Once approved, pushed says whether answers are " +
      "pushed: when it is true, Agention wakes this session at its prompt when the operator " +
      "writes, with a notice naming the threads to read, so an agent with nothing else to do " +
      "ends its turn; when it is false, answers reach you only when you check.",
    registerInput,
    // register tells the agent its answers are pushed when push can work for
    // this host session, and starts the background wait, which then pushes
    // once the operator approves.
    async (input, signal) => {
      const { session, push } = connected();
      const pushed = push.available();
      const answer = await session.register(input, signal, pushed);
      if (pushed) {
        push.start();
        if (answer.status === "approved") {
          push.told();
        }
      }
      return answer;
    },
  );

  tool(
    "thread_create",
    "Start a thread with the operator about one matter, with a title and a first message that " +
      "may carry Markdown text and its detail, references, asks and a topic. Ask whenever you " +
      "want an answer: a message without asks is only read. Each ask has a question and " +
      "suggested answers, each a short label with a description, and is numbered within the " +
      "thread as it is written, in the order given. Put asks that belong together in one " +
      "message; the operator may answer them together or apart, each by its number. The " +
      "operator answers an ask with one suggested answer, or several where multiple allows; " +
      "their own words instead, or beside their picks where several are allowed; or, on an ask " +
      "without suggested answers, their own words alone. They may also decline it. The title, " +
      "questions, suggested answers, fallbacks and references are plain text. " +
      `${attachingText} ${priorityText} ${requestIdText} Answers with the thread's number and ` +
      "its first message's sequence.",
    threadCreateInput,
    (input, signal) =>
      onSession(signal, (path) => ({ method: "POST", path: `${path}/threads`, body: input })),
  );

  tool(
    "message_send",
    "Send a message to one of this session's threads: any of Markdown text and its detail, " +
      "references, asks, withdrawals, a topic, and replaces, an earlier message of yours that " +
      "it replaces, which is ignored from then on. Each ask is numbered within the thread as it " +
      "is written; put asks that belong together in one message, and the operator may answer " +
      "them together or apart. Withdraw an open ask you no longer need answered, such as one " +
      "settled elsewhere, with a withdrawal saying why; a withdrawal is never undone. Revise an " +
      "ask by replacing its message, never by asking the same thing again beside it; a " +
      "replacement's asks are asked again under new numbers, answered or not. A replacement is " +
      "a whole message: send again every part you keep, the detail included, or it is gone, " +
      "and if the message set the topic, the thread's current topic, and it carries a file of " +
      "the message it replaces only by naming it in keep. A replacement cannot drop " +
      "an open ask: it asks again, or withdraws by name and with a reason, each open ask of the " +
      "message it replaces, and it withdraws again every ask that message withdrew. " +
      "seen_through is the latest message sequence you have read: if others landed since, the " +
      "message fails as stale and lists what you missed, so read it and decide again. " +
      `${attachingText} ${priorityText} ${requestIdText} Answers with the new message's ` +
      "sequence.",
    messageFields
      .omit({ answers: true })
      .extend({ thread })
      .superRefine(detailNeedsText)
      .superRefine(needsAPart),
    ({ thread: number, ...body }, signal) =>
      onSession(signal, (path) => ({
        method: "POST",
        path: `${path}/threads/${number}/messages`,
        body,
      })),
  );

  tool(
    "thread_get",
    "Read one of this session's threads: its topic, status and open asks, a page of its " +
      "messages after after, both parties' read cursors and your own marks. A message's text " +
      "and detail are Markdown. Each message says whether it is live and what replaced it; " +
      "each of its asks its number and whether it is open, with its live answer or its " +
      "withdrawal; each of its answers the number and question of the ask it answers, and " +
      "whether that ask is still live; each of its withdrawals the ask it withdrew and why. An " +
      "answer says whether the operator declined, which suggested answers they picked, with " +
      "their labels, and in text their own words on the ask; the text and detail of the " +
      "message carrying it are any additional information. A message lists the files it " +
      "carries in attachments, which file_get fetches. " +
      "More messages follow while the last one's seq is below the thread's " +
      "last_seq. A result too long to return comes back with fewer messages; " +
      tooLongText,
    z.object({
      thread,
      after: sequence
        .default(0)
        .describe("Return the messages after this sequence; 0, the default, starts at the first."),
      limit,
    }),
    (input, signal) =>
      answerThatFits(input.limit, "messages", (pageSize) =>
        onSession(signal, (path) => ({
          method: "GET",
          path: `${path}/threads/${input.thread}`,
          query: { after: input.after, limit: pageSize },
        })),
      ),
  );

  tool(
    "thread_list",
    "List this session's threads you have not archived, your own new ones included, or with " +
      "include_archived the ones you archived too. Filters you turn on combine: search finds " +
      "titles, status keeps threads of one status, unread those with messages you have not " +
      "read, topic those on a topic. Messages you archived never count as unread. Threads with " +
      "open asks come first, most pressing first; the rest follow by latest message. Each " +
      "summary gives how far you have read as read_through, counts the messages after it you " +
      "have neither read nor archived as unread, says whether you archived it, gives its " +
      "status, with the latest withdrawal while it is withdrawn, and rolls up the thread's " +
      "open asks, listing the most pressing; summaries carry no Markdown, so read a thread " +
      "with thread_get after its read_through. Continue with cursor set to next. A result too " +
      `long to return comes back as a smaller page; ${tooLongText}`,
    z.object({
      include_archived: includeArchivedFilter,
      search: titleSearchFilter.optional(),
      status: statusFilter.optional(),
      unread: unreadFilter,
      topic: topic.optional().describe("Only threads with this topic."),
      cursor: cursor.optional().describe("The previous page's next value, to continue the list."),
      limit,
    }),
    (input, signal) =>
      answerThatFits(input.limit, "threads", (pageSize) =>
        onSession(signal, (path) => ({
          method: "GET",
          path: `${path}/threads`,
          query: {
            include_archived: input.include_archived,
            search: input.search,
            status: input.status,
            unread: input.unread,
            topic: input.topic,
            cursor: input.cursor,
            limit: pageSize,
          },
        })),
      ),
  );

  tool(
    "thread_read",
    "Mark one of this session's threads read through a message, without writing to it, so the " +
      "operator sees how far you have read. A message of your own reads through itself. " +
      "Answers with both parties' read cursors.",
    markInput.extend({ thread }),
    ({ thread: number, ...body }, signal) =>
      onSession(signal, (path) => ({
        method: "POST",
        path: `${path}/threads/${number}/read`,
        body,
      })),
  );

  tool(
    "thread_archive",
    "Archive one of this session's threads through a message once it needs nothing more from " +
      "you, so it leaves your list of threads until the operator writes to it again. Archived " +
      "messages no longer count as unread or wake message_wait, read or not, and your own later " +
      "messages keep the thread archived. Only you see your archive mark. Answers with your " +
      "marks.",
    markInput.extend({ thread }),
    ({ thread: number, ...body }, signal) =>
      onSession(signal, (path) => ({
        method: "POST",
        path: `${path}/threads/${number}/archive`,
        body,
      })),
  );

  tool(
    "message_wait",
    "Check for messages you have not read in this session's threads, waiting up to " +
      "wait_seconds for one, and answer with those threads, oldest activity first, and since. " +
      "With wait_seconds 0, the default, it answers at once, which is how you check for " +
      "answers as you work, carrying on with other work. Once that work is done, wait longer " +
      "while you have open asks or unread messages, or have a waiter of your own, such as a " +
      "subagent, do the waiting; where register said answers are pushed, end your turn " +
      "instead, since Agention wakes you when the operator writes. Pass since back to check only for messages newer than this " +
      "answer covered, so a thread you leave unread does not come back. Answers at once if " +
      "there is something to report, else when a message lands or wait_seconds pass, and " +
      "with an error other than invalid_input only once wait_seconds pass. The operator " +
      "reading or archiving writes no message, so it wakes no wait; thread_get shows how far " +
      "the operator has read. Summaries carry no Markdown: read a thread with thread_get " +
      "after its read_through. A result too long to return comes back as a smaller page; " +
      tooLongText,
    z.object({
      since: cursor
        .optional()
        .describe(
          "The previous message_wait answer's since value, to check only for newer messages.",
        ),
      wait_seconds: waitSeconds.describe(
        "How long to wait for an unread message, 0 to 25 seconds; by default 0, which checks " +
          "at once.",
      ),
      limit,
    }),
    // The whole call, its credential lookup and every request included, has
    // one budget: its wait and the time a server has to answer once, at most
    // 55 seconds, so it ends under Codex's 60-second tool timeout however
    // slow the server. Only the first request waits: a smaller page asked for
    // after it answers at once, and if another reader took the threads in
    // between, that page reports nothing, as a wait that ended would. Every
    // failure but invalid input is answered no sooner than the wait would
    // have ended, so an agent that waits again at once does not call a server
    // it cannot use in a tight loop.
    async (input, signal) => {
      const started = performance.now();
      const budget = new AbortController();
      const timer = setTimeout(
        () => budget.abort(new DOMException("The wait's budget ran out.", "TimeoutError")),
        input.wait_seconds * 1000 + answerTimeout,
      );
      const call = AbortSignal.any([signal, budget.signal]);
      let nextWait = input.wait_seconds;
      try {
        return await answerThatFits(input.limit, "threads", (pageSize) => {
          const seconds = nextWait;
          nextWait = 0;
          return onSession(call, (path) => ({
            method: "GET",
            path: `${path}/wait`,
            query: { since: input.since, wait: seconds, limit: pageSize },
            wait: seconds * 1000,
          }));
        });
      } catch (error) {
        if (!(error instanceof ApiFailure && error.body.error.code === "invalid_input")) {
          await pause(started + input.wait_seconds * 1000 - performance.now(), signal);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  );

  tool(
    "session_update",
    // What each field means, its schema says; this says how they go together.
    "Report this session's status to the operator, who sees it beside the session. A field you " +
      "leave out stays as it was. stopped needs an outcome, and an outcome needs stopped. Never " +
      "report that you wait on the operator: your open asks already tell them; name anything " +
      "else you wait on, such as CI or a review, in the note. An update that changes nothing " +
      "and has no note is not recorded. Answers with the session's status.",
    sessionUpdateInput,
    // Updates run one at a time, each request and its record together, so
    // the status the reminder last records is the one the server committed
    // last, however the answers of overlapping calls would arrive. A failed
    // update frees the next as a successful one does.
    (input, signal) => {
      const update = statusUpdates.then(async () => {
        const answer = await onSession(signal, (path) => ({
          method: "POST",
          path: `${path}/status`,
          body: input,
        }));
        connected().statusReminder.reported(input.note, answer);
        return answer;
      });
      statusUpdates = update.catch(() => undefined);
      return update;
    },
  );

  registerFileTools(tool, connected, inSession);
}

// pause resolves once the time given has passed, or at once when the call is
// cancelled.
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const end = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
      resolve();
    };
    const timer = setTimeout(end, milliseconds);
    signal.addEventListener("abort", end);
  });
}

function failed(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// advertised hands the SDK a tool's JSON Schema, generated from the shared
// schema, with a validation that accepts any arguments. The SDK would answer
// arguments its validation refused in words of its own; the bridge parses them
// itself instead, so a refusal is the API's invalid_input naming the field at
// fault, as the server would answer it.
function advertised(schema: z.ZodType): StandardSchemaWithJSON {
  return {
    "~standard": {
      version: 1,
      vendor: "agention",
      validate: (value) => ({ value }),
      jsonSchema: schema["~standard"].jsonSchema,
    },
  };
}
