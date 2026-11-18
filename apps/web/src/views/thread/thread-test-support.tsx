// Test support for the thread page's component tests: a thread served from
// state a test can change, as the server pages it and marks it read.
import type { Message, ThreadSummary, WriteResult } from "@wayfarerlabs/agention-api";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  type Call,
  FakeApi,
  failure,
  message,
  operatorMessage,
  type Reply,
  renderAt,
  threadAnswer,
  threadSummary,
} from "../../test-support.tsx";
import { goBackChoice } from "./Composer.tsx";
import { mine } from "./Messages.tsx";

export const path = "/s/builder/main/threads/1";

export interface State {
  thread: ThreadSummary;
  messages: Message[];
  // How far the agent has read; the operator's cursor follows the thread's
  // unread count.
  requester?: number;
  // How far the operator has archived.
  archived?: number;
}

export const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

// written answers a write as landed at seq.
export const written = (seq: number): Reply => ({
  body: { number: 1, seq } satisfies WriteResult,
});

// The composer's message box, whatever it is labelled.
export const textBox = () =>
  within(screen.getByRole("region", { name: "Reply" })).getByRole<HTMLTextAreaElement>("textbox", {
    name: /^(Message|Additional information)$/,
  });

// The composer's Details box, once it shows, and the line that opens it while
// it is folded.
export const detailsBox = () =>
  within(screen.getByRole("region", { name: "Reply" })).getByRole<HTMLTextAreaElement>("textbox", {
    name: "Details",
  });
export const detailsFold = () =>
  within(screen.getByRole("region", { name: "Reply" })).queryByRole<HTMLButtonElement>("button", {
    name: "Details",
  });
// openDetails opens the composer's Details box, unless it shows already.
export function openDetails(): HTMLTextAreaElement {
  const fold = detailsFold();
  if (fold !== null) {
    fireEvent.click(fold);
  }
  return detailsBox();
}

// detailOf finds the line that folds a message's detail.
export const detailOf = (seq: number) =>
  screen.getByRole<HTMLButtonElement>("button", { name: `Details of message ${seq}` });

// optionsButton finds the button of a message's options menu.
export const optionsButton = (seq: number) =>
  screen.getByRole<HTMLButtonElement>("button", { name: `Options for message ${seq}` });

// optionsMenu opens a message's options menu, unless it is open already.
export function optionsMenu(seq: number): HTMLElement {
  const button = optionsButton(seq);
  if (button.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(button);
  }
  const menu = document.getElementById(button.getAttribute("aria-controls") ?? "");
  if (menu === null) {
    throw new Error(`the options of message ${seq} did not open`);
  }
  return menu;
}

// option finds an option of a message, opening its menu.
export const option = (seq: number, name: string) =>
  within(optionsMenu(seq)).getByRole<HTMLButtonElement>("button", { name });

// optionNames lists the options of a message, opening its menu.
export const optionNames = (seq: number) =>
  within(optionsMenu(seq))
    .getAllByRole("button")
    .map((button) => button.textContent);

// shownMessages lists the numbered messages shown, by default in the log.
export const shownMessages = (
  within: HTMLElement = screen.getByRole("region", { name: "Messages" }),
) =>
  Array.from(within.querySelectorAll("p"))
    .map((element) => /^Message (\d+)$/.exec(element.textContent ?? "")?.[1])
    .filter((text) => text !== undefined)
    .map(Number);

// ThreadPageTest serves one thread, builder/main #1, to the thread page,
// which stays open after sending, to show what sending did, unless a test
// chooses otherwise.
export class ThreadPageTest {
  readonly api = new FakeApi();

  constructor() {
    window.localStorage.setItem(goBackChoice, "false");
  }

  // serve answers the thread's GET from state, paging the messages as the
  // server does, marking it read by moving the operator's cursor forward, and
  // archiving it by moving their archive mark.
  serve(state: State): State {
    this.api.on("GET", path, (call) => this.threadReply(state, call));
    this.api.on("POST", `${path}/read`, (call) => {
      const { through } = call.body as { through: number };
      const cursor = Math.max(state.thread.last_seq - state.thread.unread, through);
      state.thread = { ...state.thread, unread: state.thread.last_seq - cursor };
      return { body: { cursors: { requester: state.thread.last_seq, audience: cursor } } };
    });
    this.api.on("POST", `${path}/archive`, (call) => {
      const { through } = call.body as { through: number };
      // The mark carries on over the operator's own messages right after it,
      // and the thread is archived once it reaches the latest.
      const next = state.messages.find((m) => m.seq > through && !mine(m));
      const carried = next === undefined ? state.thread.last_seq : next.seq - 1;
      state.archived = Math.max(state.archived ?? 0, carried);
      state.thread = { ...state.thread, archived: state.archived === state.thread.last_seq };
      const read = state.thread.last_seq - state.thread.unread;
      return { body: { marks: { read_through: read, archived_through: state.archived } } };
    });
    return state;
  }

  threadReply(state: State, call: Call): Reply {
    const after = Number(call.url.searchParams.get("after") ?? "0");
    const limit = Number(call.url.searchParams.get("limit") ?? "50");
    const messages = state.messages.filter((m) => m.seq > after).slice(0, limit);
    const answer = threadAnswer(state.thread, messages);
    return {
      body: {
        ...answer,
        cursors: { ...answer.cursors, requester: state.requester ?? state.thread.last_seq },
        marks: { ...answer.marks, archived_through: state.archived ?? 0 },
      },
    };
  }

  // serveWrites answers writes as the server does: a write that has not seen
  // the latest message is stale, with up to 50 of the messages it missed, and
  // any other lands as the next message, which the operator has then read,
  // keeping the thread archived for them when it was.
  serveWrites(state: State): void {
    this.api.on("POST", `${path}/messages`, (call) => {
      const body = call.body as { seen_through: number; text?: string };
      if (body.seen_through < state.thread.last_seq) {
        const missed = state.messages.filter((m) => m.seq > body.seen_through).slice(0, 50);
        return failure("stale", "other messages landed after the latest one you saw", {
          missed,
        });
      }
      const seq = state.thread.last_seq + 1;
      if (state.archived === state.thread.last_seq) {
        state.archived = seq;
      }
      state.thread = {
        ...state.thread,
        last_seq: seq,
        message_count: state.thread.message_count + 1,
        unread: 0,
      };
      state.messages = [
        ...state.messages,
        operatorMessage(seq, body.text === undefined ? {} : { text: body.text }),
      ];
      return written(seq);
    });
  }

  writes(): Call[] {
    return this.api.callsTo("POST", `${path}/messages`);
  }

  bodies(): Record<string, unknown>[] {
    return this.writes().map((call) => call.body as Record<string, unknown>);
  }

  seenThrough(): number[] {
    return this.bodies().map((body) => body.seen_through as number);
  }

  // reads lists what each mark read was through.
  reads(): number[] {
    return this.api
      .callsTo("POST", `${path}/read`)
      .map((call) => (call.body as { through: number }).through);
  }

  async open(state: State, historyState: unknown = null): Promise<State> {
    this.serve(state);
    renderAt(path, historyState);
    await screen.findByRole("heading", { level: 1 });
    return state;
  }

  // openLog opens a thread of numbered messages from the agent.
  openLog(overrides: Partial<ThreadSummary> & { last_seq: number }): Promise<State> {
    return this.open({
      thread: threadSummary(overrides),
      messages: range(1, overrides.last_seq).map((seq) => message(seq, { text: `Message ${seq}` })),
    });
  }

  // openWith opens a thread of the given messages, which the operator has
  // read unless the overrides say otherwise.
  openWith(messages: Message[], overrides: Partial<ThreadSummary> = {}): Promise<State> {
    return this.open({
      thread: threadSummary({
        last_seq: messages.at(-1)?.seq ?? 1,
        unread: 0,
        ...overrides,
      }),
      messages,
    });
  }
}
