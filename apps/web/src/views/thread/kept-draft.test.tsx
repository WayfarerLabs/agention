import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  draftDays,
  forgetDrafts,
  keepDraft,
  maxDrafts,
  parseDraft,
  readDraft,
  signOutMark,
} from "../../device.ts";
import {
  ask,
  installUploads,
  message,
  operatorMessage,
  type Reply,
  threadSummary,
} from "../../test-support.tsx";
import { afterSendingChoice } from "./Composer.tsx";
import { useKeptDraft } from "./kept-draft.ts";
import {
  detailsBox,
  openDetails,
  option,
  path,
  type State,
  textBox,
  ThreadPageTest,
  written,
} from "./thread-test-support.tsx";

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
  Reflect.deleteProperty(navigator, "mediaDevices");
});

// The thread the page serves, as its draft is kept by.
const thread = { agent: "builder", session: "main", number: 1 };

const composer = () => screen.getByRole("region", { name: "Reply" });
const sendButton = () =>
  within(composer()).getByRole<HTMLButtonElement>("button", { name: "Send" });
const settleBox = () =>
  within(composer()).getByRole<HTMLInputElement>("checkbox", { name: "Settle the thread" });
const discardButton = () =>
  within(composer()).queryByRole<HTMLButtonElement>("button", { name: "Discard draft" });
// discard discards the draft, confirming it.
function discard() {
  fireEvent.click(discardButton()!);
  fireEvent.click(within(composer()).getByRole("button", { name: "Discard" }));
}
const draft = { text: "Half a reply", detail: "", basis: 1, leftBehind: false };
const dayMs = 24 * 60 * 60 * 1000;

// reopen leaves the thread, unmounting its page, and opens it again.
async function reopen(state: State): Promise<void> {
  cleanup();
  await page.open(state);
}

describe("a draft kept in the browser", () => {
  it("comes back, text and details, when the thread opens again", async () => {
    const state = await page.openLog({ last_seq: 1 });
    fireEvent.change(textBox(), { target: { value: "Half a reply" } });
    fireEvent.change(openDetails(), { target: { value: "And its reasons." } });
    await reopen(state);
    expect(textBox().value).toBe("Half a reply");
    expect(detailsBox().value).toBe("And its reasons.");
    expect(within(composer()).queryByRole("note")).toBeNull();
  });

  it("is kept as it is typed, before the thread is left", async () => {
    await page.openLog({ last_seq: 1 });
    fireEvent.change(textBox(), { target: { value: "Half a reply" } });
    expect(readDraft(thread)).toMatchObject({ text: "Half a reply" });
  });

  it("is left alone while this page has none, as another tab keeps it", async () => {
    const state = await page.openLog({ last_seq: 1 });
    keepDraft(thread, draft, signOutMark());
    state.thread = { ...state.thread, last_seq: 2, unread: 1 };
    state.messages = [...state.messages, message(2, { text: "Message 2" })];
    fireEvent.focus(window);
    await screen.findByText("Message 2");
    expect(readDraft(thread)).toMatchObject({ text: "Half a reply" });
  });

  it("counts from no later than the page shows, whatever the browser kept", async () => {
    keepDraft(thread, { ...draft, basis: 99 }, signOutMark());
    const state = await page.openLog({ last_seq: 1 });
    page.serveWrites(state);
    fireEvent.click(sendButton());
    await screen.findByRole("status");
    expect(page.seenThrough()).toEqual([1]);
  });

  it("keeps where it started, so a message that landed while it was away was missed", async () => {
    const state = await page.openLog({ last_seq: 1 });
    fireEvent.change(textBox(), { target: { value: "Noted." } });
    cleanup();
    state.thread = { ...state.thread, last_seq: 2, unread: 1 };
    state.messages = [...state.messages, message(2, { text: "Message 2" })];
    await page.open(state);
    await screen.findByText("Message 2");
    page.serveWrites(state);
    fireEvent.click(sendButton());
    await screen.findByRole("alert");
    expect(page.seenThrough()).toEqual([1]);
    expect(textBox().value).toBe("Noted.");
  });

  it("is forgotten by Discard draft, which empties the composer", async () => {
    const state = await page.openLog({ last_seq: 1 });
    expect(discardButton()).toBeNull();
    fireEvent.change(textBox(), { target: { value: "Never mind" } });
    fireEvent.change(openDetails(), { target: { value: "At length." } });
    // Settling is not kept with the draft, which says so once it opens again.
    fireEvent.click(settleBox());
    expect(readDraft(thread)?.leftBehind).toBe(true);
    discard();
    expect(textBox().value).toBe("");
    expect(settleBox().checked).toBe(false);
    expect(discardButton()).toBeNull();
    // Settle the thread alone is a draft to discard.
    fireEvent.click(settleBox());
    discard();
    expect(settleBox().checked).toBe(false);
    await reopen(state);
    expect(textBox().value).toBe("");
    expect(readDraft(thread)).toBeUndefined();
  });

  it("is forgotten once the write sending it lands", async () => {
    const state = await page.openLog({ last_seq: 1 });
    page.serveWrites(state);
    fireEvent.change(textBox(), { target: { value: "Done." } });
    fireEvent.click(sendButton());
    await screen.findByRole("status");
    await reopen(state);
    expect(textBox().value).toBe("");
  });

  it("keeps only what was typed while a write was under way, when the page goes back as it lands", async () => {
    window.localStorage.setItem(afterSendingChoice, "list");
    await page.open(
      { thread: threadSummary({ unread: 0 }), messages: [message(1)] },
      { from: "/" },
    );
    let answer: (reply: Reply) => void = () => {};
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise<Reply>((resolve) => (answer = resolve)),
    );
    fireEvent.change(textBox(), { target: { value: "First." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.change(textBox(), { target: { value: "First. And second." } });
    answer(written(2));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(readDraft(thread)).toMatchObject({ text: "First. And second.", basis: 2 });
  });

  it("stays as edited since when a write sent before the thread was left lands", async () => {
    const state = await page.openLog({ last_seq: 1 });
    let answer: (reply: Reply) => void = () => {};
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise<Reply>((resolve) => (answer = resolve)),
    );
    fireEvent.change(textBox(), { target: { value: "First." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.change(textBox(), { target: { value: "First. And second." } });
    await reopen(state);
    fireEvent.change(textBox(), { target: { value: "First. And a newer second." } });
    await act(async () => answer(written(2)));
    await reopen(state);
    expect(textBox().value).toBe("First. And a newer second.");
  });

  it("is forgotten when the page goes back as the write sending it lands", async () => {
    window.localStorage.setItem(afterSendingChoice, "list");
    const state = await page.open(
      { thread: threadSummary({ unread: 0 }), messages: [message(1)] },
      { from: "/" },
    );
    page.serveWrites(state);
    fireEvent.change(textBox(), { target: { value: "Done." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(readDraft(thread)).toBeUndefined();
  });

  it("stays when the write sending it was stale", async () => {
    const state = await page.openLog({ last_seq: 1 });
    page.serveWrites(state);
    // The agent wrote meanwhile, and the page has not shown it.
    state.thread = { ...state.thread, last_seq: 2 };
    state.messages = [...state.messages, message(2, { text: "Message 2" })];
    fireEvent.change(textBox(), { target: { value: "Go ahead." } });
    fireEvent.click(sendButton());
    await screen.findByRole("alert");
    await reopen(state);
    expect(textBox().value).toBe("Go ahead.");
  });

  it("says it left something behind on every visit, as it is typed on, until emptied", async () => {
    keepDraft(thread, { ...draft, leftBehind: true }, signOutMark());
    const state = await page.openLog({ last_seq: 1 });
    expect(within(composer()).getByRole("note")).toBeTruthy();
    fireEvent.change(textBox(), { target: { value: "Half a reply, and more" } });
    await reopen(state);
    expect(textBox().value).toBe("Half a reply, and more");
    expect(within(composer()).getByRole("note")).toBeTruthy();
    fireEvent.change(textBox(), { target: { value: "" } });
    fireEvent.change(textBox(), { target: { value: "A new draft" } });
    await reopen(state);
    expect(within(composer()).queryByRole("note")).toBeNull();
  });

  it.each([
    ["stays", false],
    ["goes back", true],
  ])(
    "starts afresh, leaving nothing behind, with what was typed while a restored draft was sent, as the page %s",
    async (_, goBack) => {
      keepDraft(thread, { ...draft, leftBehind: true }, signOutMark());
      window.localStorage.setItem(afterSendingChoice, goBack ? "list" : "stay");
      const state = await page.open(
        { thread: threadSummary({ unread: 0 }), messages: [message(1)] },
        { from: "/" },
      );
      expect(within(composer()).getByRole("note")).toBeTruthy();
      let answer: (reply: Reply) => void = () => {};
      page.api.on(
        "POST",
        `${path}/messages`,
        () => new Promise<Reply>((resolve) => (answer = resolve)),
      );
      fireEvent.click(sendButton());
      await waitFor(() => expect(page.writes()).toHaveLength(1));
      fireEvent.change(textBox(), { target: { value: "Half a reply, and another" } });
      answer(written(2));
      if (goBack) {
        await waitFor(() => expect(window.location.pathname).toBe("/"));
      } else {
        await screen.findByRole("status");
        expect(within(composer()).queryByRole("note")).toBeNull();
      }
      expect(readDraft(thread)).toMatchObject({
        text: "Half a reply, and another",
        leftBehind: false,
      });
      await reopen(state);
      expect(textBox().value).toBe("Half a reply, and another");
      expect(within(composer()).queryByRole("note")).toBeNull();
    },
  );

  it("still leaves behind a file attached while a restored draft was sent, with what was typed meanwhile, as the page goes back", async () => {
    keepDraft(thread, { ...draft, leftBehind: true }, signOutMark());
    // Going back as the write lands, the page never shows what is left, so
    // only what the landing keeps is kept.
    window.localStorage.setItem(afterSendingChoice, "list");
    await page.open(
      { thread: threadSummary({ unread: 0 }), messages: [message(1)] },
      { from: "/" },
    );
    let answer: (reply: Reply) => void = () => {};
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise<Reply>((resolve) => (answer = resolve)),
    );
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.change(textBox(), { target: { value: "Half a reply, and another" } });
    // A file added while the write is on its way stays behind it. This checks
    // what the landing keeps, not the order of a render and its effects: the
    // file comes by a discrete event, whose effects run before the write can
    // land, and no change outside such an event reaches the composer while a
    // write is on its way, since dictation waits for it.
    installUploads();
    const picker = composer().querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(picker, {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });
    answer(written(2));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(readDraft(thread)).toMatchObject({
      text: "Half a reply, and another",
      leftBehind: true,
    });
  });

  it("comes back without what was staged", async () => {
    const state = await page.openWith([message(1, { asks: [ask()] })], {
      open_asks: {
        asks: [{ number: 1, seq: 1 }],
        count: 1,
        blocking: true,
        overdue: false,
      },
    });
    fireEvent.click(screen.getByRole("radio", { name: /^SQLite/ }));
    fireEvent.change(textBox(), { target: { value: "Small data." } });
    await reopen(state);
    expect(textBox().value).toBe("Small data.");
    expect(document.querySelector(".staged")).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /^SQLite/ }).checked).toBe(false);
    // The composer says what it left behind, until it is emptied.
    expect(within(composer()).getByRole("note")).toBeTruthy();
    fireEvent.change(textBox(), { target: { value: "" } });
    expect(within(composer()).queryByRole("note")).toBeNull();
  });

  it("keeps the text an edit loads only once it is changed, and it comes back as a new message", async () => {
    const state = await page.openWith([operatorMessage(1, { text: "Draft." })]);
    fireEvent.click(option(1, "Edit"));
    expect(textBox().value).toBe("Draft.");
    expect(readDraft(thread)).toBeUndefined();
    fireEvent.change(textBox(), { target: { value: "Draft, edited." } });
    expect(readDraft(thread)).toMatchObject({ text: "Draft, edited." });
    // Changed back as it was loaded, there is nothing to keep.
    fireEvent.change(textBox(), { target: { value: "Draft." } });
    expect(readDraft(thread)).toBeUndefined();
    fireEvent.change(textBox(), { target: { value: "Draft, edited." } });
    await reopen(state);
    expect(textBox().value).toBe("Draft, edited.");
    expect(within(composer()).getByRole("note")).toBeTruthy();
    page.serveWrites(state);
    fireEvent.click(sendButton());
    await screen.findByRole("status");
    expect(page.bodies()[0]).toMatchObject({ text: "Draft, edited." });
    expect(page.bodies()[0]).not.toHaveProperty("replaces");
  });

  it("is not kept, and the composer still sends, while the browser refuses storage", async () => {
    for (const method of ["getItem", "setItem", "removeItem", "key"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("Storage is disabled.", "SecurityError");
      });
    }
    const state = await page.openLog({ last_seq: 1 });
    page.serveWrites(state);
    fireEvent.change(textBox(), { target: { value: "Never mind" } });
    discard();
    expect(textBox().value).toBe("");
    fireEvent.change(textBox(), { target: { value: "Done." } });
    fireEvent.click(sendButton());
    // With no choice kept, the page goes back once the write lands.
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(page.bodies()[0]).toMatchObject({ text: "Done." });
    await reopen(state);
    expect(textBox().value).toBe("");
  });
});

describe("the drafts the browser keeps", () => {
  it("leave out a draft last kept too long ago", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - (draftDays + 1) * dayMs);
    keepDraft(thread, draft, signOutMark());
    vi.mocked(Date.now).mockRestore();
    expect(readDraft(thread)).toBeUndefined();
  });

  it("hold the latest ones, which caps the storage they take, forgetting the oldest", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (let number = 1; number <= maxDrafts + 1; number++) {
      clock.mockReturnValue(now - (maxDrafts + 1 - number));
      keepDraft({ ...thread, number }, draft, signOutMark());
    }
    clock.mockRestore();
    expect(readDraft({ ...thread, number: 1 })).toBeUndefined();
    expect(readDraft({ ...thread, number: 2 })).toBeDefined();
    expect(readDraft({ ...thread, number: maxDrafts + 1 })).toBeDefined();
  });

  it("are kept by no page open from before the browser signed out", () => {
    const before = signOutMark();
    forgetDrafts();
    expect(keepDraft(thread, draft, before)).toBeUndefined();
    expect(readDraft(thread)).toBeUndefined();
    expect(keepDraft(thread, draft, signOutMark())).toBeDefined();
    expect(readDraft(thread)).toBeDefined();
  });

  it("are kept by no page open from before a sign-out, whatever mark the browser held", () => {
    window.localStorage.setItem("agention.sign-out", "not a number");
    const before = signOutMark();
    forgetDrafts();
    expect(keepDraft(thread, draft, before)).toBeUndefined();
    const again = signOutMark();
    forgetDrafts();
    expect(signOutMark()).not.toBe(again);
  });

  it("are forgotten before the sign-out is marked, so storage they fill takes the mark", () => {
    const before = signOutMark();
    keepDraft(thread, draft, before);
    // Storage refuses any value while a draft fills it.
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      for (let index = 0; index < this.length; index++) {
        if (this.key(index)?.startsWith("agention.draft.") === true) {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        }
      }
      setItem.call(this, key, value);
    });
    forgetDrafts();
    expect(readDraft(thread)).toBeUndefined();
    expect(keepDraft(thread, draft, before)).toBeUndefined();
  });

  it("forget the one kept before when the browser refuses to keep a newer one", () => {
    keepDraft(thread, draft, signOutMark());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    expect(keepDraft(thread, { ...draft, text: "More" }, signOutMark())).toBeUndefined();
    expect(readDraft(thread)).toBeUndefined();
  });

  it("forget, as a new one is kept, those that count as none", () => {
    const other = { ...thread, number: 2 };
    keepDraft(other, draft, signOutMark());
    const key = Object.keys(window.localStorage).find((each) =>
      each.startsWith("agention.draft."),
    )!;
    window.localStorage.setItem(key, "{");
    keepDraft({ ...thread, number: 3 }, draft, signOutMark());
    expect(window.localStorage.getItem(key)).toBeNull();
    // One kept after now, as by a clock set wrong, is none, and goes too.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 365 * dayMs);
    keepDraft(other, draft, signOutMark());
    vi.mocked(Date.now).mockRestore();
    expect(readDraft(other)).toBeUndefined();
    keepDraft(thread, draft, signOutMark());
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  const now = 1_000 * dayMs;
  const record = (overrides: Record<string, unknown>) =>
    JSON.stringify({ ...draft, kept: now, ...overrides });

  it.each([
    ["no JSON", "{"],
    ["null", "null"],
    ["text that is not a string", record({ text: 1 })],
    ["no detail", record({ detail: undefined })],
    ["a basis that is not a whole number", record({ basis: 1.5 })],
    ["a negative basis", record({ basis: -1 })],
    ["leftBehind that is not a boolean", record({ leftBehind: "yes" })],
    ["no time kept", record({ kept: undefined })],
    ["a time kept too long ago", record({ kept: now - (draftDays + 1) * dayMs })],
    ["a time kept after now", record({ kept: now + 1 })],
  ])("count a record with %s as none", (_, value) => {
    expect(parseDraft(value, now)).toBeUndefined();
  });
});

describe("two pages keeping a thread's draft", () => {
  type Typed = { text: string; basis?: number };
  const typing = (text: string) =>
    renderHook(
      ({ text: typed, basis = draft.basis }: Typed) =>
        useKeptDraft(thread, { ...draft, text: typed, basis }, typed !== ""),
      { initialProps: { text } as Typed },
    );

  it("keep the draft typed last, which emptying the other leaves alone", () => {
    const first = typing("From the first");
    const second = typing("From the second");
    first.rerender({ text: "" });
    expect(readDraft(thread)).toMatchObject({ text: "From the second" });
    second.rerender({ text: "" });
    expect(readDraft(thread)).toBeUndefined();
  });

  it("keep the draft typed last when the other's write lands with nothing left", () => {
    const first = typing("From the first");
    typing("From the second");
    first.result.current("", "", 2, false);
    expect(readDraft(thread)).toMatchObject({ text: "From the second" });
  });

  it("keep the draft typed last when the other's write lands with some left, until it is typed on", () => {
    const first = typing("Left of the first");
    typing("From the second");
    first.result.current("Left of the first", "", 2, false);
    // The page then counts from the message written, which changes its draft.
    first.rerender({ text: "Left of the first", basis: 2 });
    expect(readDraft(thread)).toMatchObject({ text: "From the second" });
    first.rerender({ text: "Left of the first, typed on", basis: 2 });
    expect(readDraft(thread)).toMatchObject({ text: "Left of the first, typed on", basis: 2 });
  });
});
