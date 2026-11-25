import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ask,
  csrf,
  failure,
  installRecorder,
  message,
  operatorMessage,
  type Reply,
} from "../../test-support.tsx";
import { recordingByteLimit } from "../../voice/Dictation.tsx";
import {
  openDetails,
  option,
  path,
  textBox,
  ThreadPageTest,
  written,
} from "./thread-test-support.tsx";

let page: ThreadPageTest;

const voiceOn = {
  voice: {
    on: true,
    base_url: "https://api.openai.com/v1",
    model: "gpt-transcribe",
    prompt: null,
    key: "set",
    key_ending: "c3dE",
    from_environment: [],
    invalid: false,
  },
};

beforeEach(() => {
  page = new ThreadPageTest();
  page.api.on("GET", "/settings", { body: voiceOn });
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
  Reflect.deleteProperty(navigator, "mediaDevices");
});

const composer = () => screen.getByRole("region", { name: "Reply" });
const control = (name: string) => within(composer()).getByRole("button", { name });
// after says whether later comes after earlier in the page.
const after = (earlier: Element, later: Element) =>
  (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const uploads = () => page.api.callsTo("POST", "/transcriptions");
const sendButton = () =>
  within(composer()).getByRole<HTMLButtonElement>("button", { name: "Send" });

// answerTranscriptions answers each transcription with the reply given.
function answerTranscriptions(reply: Reply | (() => Reply | Promise<Reply>)) {
  page.api.on("POST", "/transcriptions", typeof reply === "function" ? reply : () => reply);
}

async function openThread() {
  await page.openWith([message(1, { text: "Which database?" })]);
  await within(composer()).findByRole("button", { name: "Dictate" });
}

// record starts a recording, and returns the recorder making it.
async function record(recorder: ReturnType<typeof installRecorder>) {
  fireEvent.click(control("Dictate"));
  await within(composer()).findByRole("button", { name: "Stop" });
  return recorder.recorders.at(-1);
}

describe("dictation in the composer", () => {
  it("shows only while voice is on and the browser can record", async () => {
    page.api.on("GET", "/settings", { body: { voice: null } });
    installRecorder();
    await page.openWith([message(1)]);
    await waitFor(() => expect(page.api.callsTo("GET", "/settings")).toHaveLength(1));
    expect(within(composer()).queryByRole("button", { name: "Dictate" })).toBeNull();
    cleanup();

    page.api.on("GET", "/settings", { body: voiceOn });
    installRecorder({ types: [] });
    await page.openWith([message(1)]);
    await waitFor(() => expect(page.api.callsTo("GET", "/settings")).toHaveLength(2));
    expect(within(composer()).queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("records at 32 kbit/s, uploads the declared type, and puts the text at the caret", async () => {
    const recorder = installRecorder({ types: ["audio/mp4", "audio/ogg;codecs=opus"] });
    await openThread();
    fireEvent.change(textBox(), { target: { value: "Use it." } });
    textBox().focus();
    textBox().setSelectionRange(3, 3);
    answerTranscriptions({ body: { text: "SQLite" } });
    const made = await record(recorder);
    expect([made?.options.mimeType, made?.options.audioBitsPerSecond, made?.timeslice]).toEqual([
      "audio/mp4",
      32_000,
      1000,
    ]);
    // A clock that runs fast makes React yield between each piece of work,
    // as on a slow machine, so the text and the caret must move together:
    // the caret is checked the moment the text shows.
    let now = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (now += 50));
    try {
      fireEvent.click(control("Stop"));
      await waitFor(() => expect(textBox().value).toBe("Use SQLite it."));
      expect(textBox().selectionStart).toBe("Use SQLite".length);
    } finally {
      clock.mockRestore();
    }
    expect(document.activeElement).toBe(textBox());
    const [upload] = uploads();
    expect([upload?.headers["content-type"], upload?.headers["x-csrf-token"]]).toEqual([
      "audio/mp4",
      csrf,
    ]);
    expect(recorder.tracks.every((track) => track.stopped)).toBe(true);
    expect(page.writes()).toEqual([]);
  });

  it("keeps focus on After sending as it moves back beside Send", async () => {
    const recorder = installRecorder();
    await openThread();
    fireEvent.change(textBox(), { target: { value: "Use it." } });
    answerTranscriptions({ body: { text: "SQLite" } });
    await record(recorder);
    const option = () => within(composer()).getByRole("combobox", { name: "After sending" });
    // While recording, it sits below the Send row.
    expect(option().closest(".actions")).toBeNull();
    option().focus();
    fireEvent.click(control("Stop"));
    await waitFor(() => {
      expect(textBox().value).toBe("Use it. SQLite");
      expect(document.activeElement).toBe(option());
    });
    expect(option().closest(".actions")).not.toBeNull();
  });

  it("puts the text in Details when that box last had focus", async () => {
    const recorder = installRecorder();
    await openThread();
    fireEvent.change(textBox(), { target: { value: "Summary" } });
    const details = openDetails();
    fireEvent.focus(details);
    answerTranscriptions({ body: { text: "The rest." } });
    await record(recorder);
    fireEvent.click(control("Stop"));
    await waitFor(() => expect(details.value).toBe("The rest."));
    expect(textBox().value).toBe("Summary");
  });

  it("says nothing was heard for an empty transcript, inserting nothing", async () => {
    const recorder = installRecorder();
    await openThread();
    fireEvent.change(textBox(), { target: { value: "Use it." } });
    answerTranscriptions({ body: { text: " " } });
    await record(recorder);
    fireEvent.click(control("Stop"));
    await within(composer()).findByRole("button", { name: "Dictate" });
    // What was heard shows after Send, where what was sent does.
    expect(after(control("Send"), within(composer()).getByRole("status"))).toBe(true);
    expect(textBox().value).toBe("Use it.");
    expect(sendButton().disabled).toBe(false);
  });

  it("says nothing was heard for a recording too short to send, sending nothing", async () => {
    const recorder = installRecorder({ finalBytes: 10 });
    await openThread();
    await record(recorder);
    fireEvent.click(control("Stop"));
    await within(composer()).findByRole("button", { name: "Dictate" });
    within(composer()).getByRole("status");
    expect(uploads()).toEqual([]);
    expect(within(composer()).queryByRole("button", { name: "Retry" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(control("Dictate")));
  });

  it("keeps the draft and the recording when transcribing fails, for Retry", async () => {
    const recorder = installRecorder();
    await openThread();
    fireEvent.change(textBox(), { target: { value: "Draft" } });
    // Node's own answer when an upload outlasts the request deadline.
    answerTranscriptions({ status: 408, text: "" });
    await record(recorder);
    fireEvent.click(control("Stop"));
    const retry = await within(composer()).findByRole("button", { name: "Retry" });
    // A failure shows before Send, as a failed send's does.
    expect(after(within(composer()).getByRole("alert"), control("Send"))).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(retry));
    expect(textBox().value).toBe("Draft");
    answerTranscriptions(failure("provider_failed", "x"));
    fireEvent.click(retry);
    await waitFor(() => expect(uploads()).toHaveLength(2));
    fireEvent.click(await within(composer()).findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(uploads()).toHaveLength(3));
    await within(composer()).findByRole("button", { name: "Retry" });
    fireEvent.click(control("Discard"));
    within(composer()).getByRole("button", { name: "Dictate" });
    expect(textBox().value).toBe("Draft");
  });

  it("moves focus through its controls, announcing the recording, and cancels", async () => {
    const recorder = installRecorder();
    await openThread();
    answerTranscriptions(() => new Promise<Reply>(() => undefined));
    control("Dictate").focus();
    await record(recorder);
    const stop = control("Stop");
    await waitFor(() => expect(document.activeElement).toBe(stop));
    within(composer()).getByRole("status");
    fireEvent.click(stop);
    const cancel = await within(composer()).findByRole("button", { name: "Cancel dictation" });
    // Cancel is an element of its own, not Stop's, and focus goes to what
    // dictation is doing, not to Cancel, so a second press of Stop cancels
    // nothing.
    expect(cancel).not.toBe(stop);
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("status"));
    fireEvent.click(cancel);
    await waitFor(() => expect(document.activeElement).toBe(control("Dictate")));
    expect(textBox().value).toBe("");
  });

  it("leaves focus where the operator put it while the microphone opened", async () => {
    let open = () => {};
    installRecorder({ opened: new Promise<void>((resolve) => (open = resolve)) });
    await openThread();
    control("Dictate").focus();
    fireEvent.click(control("Dictate"));
    textBox().focus();
    fireEvent.change(textBox(), { target: { value: "abc" } });
    open();
    await within(composer()).findByRole("button", { name: "Stop" });
    expect(document.activeElement).toBe(textBox());

    // A transcript goes in where the operator is, and focus stays there.
    answerTranscriptions({ body: { text: "SQLite" } });
    fireEvent.change(textBox(), { target: { value: "abc def" } });
    fireEvent.click(control("Stop"));
    await waitFor(() => expect(textBox().value).toBe("abc def SQLite"));
    expect(document.activeElement).toBe(textBox());
  });

  it("holds Send from the moment the microphone is asked for", async () => {
    let open = () => {};
    installRecorder({ opened: new Promise<void>((resolve) => (open = resolve)) });
    const state = await page.openWith([message(1, { text: "Which database?" })]);
    page.serveWrites(state);
    await within(composer()).findByRole("button", { name: "Dictate" });
    fireEvent.change(textBox(), { target: { value: "Use" } });
    fireEvent.click(control("Dictate"));
    // The microphone is still opening: Send and its shortcut wait.
    const send = () => within(composer()).getByRole<HTMLButtonElement>("button", { name: "Send" });
    expect(send().disabled).toBe(true);
    expect(send().getAttribute("aria-describedby")).not.toBeNull();
    fireEvent.click(send());
    fireEvent.keyDown(textBox(), { key: "Enter", ctrlKey: true });
    expect(page.writes()).toEqual([]);
    open();
    answerTranscriptions({ body: { text: "SQLite." } });
    fireEvent.click(await within(composer()).findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(textBox().value).toBe("Use SQLite."));
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(page.bodies()[0]).toMatchObject({ text: "Use SQLite." });
  });

  it("stops at its size limit", async () => {
    const recorder = installRecorder();
    await openThread();
    answerTranscriptions({ body: { text: "Long." } });
    const made = await record(recorder);
    act(() => made?.emit(recordingByteLimit));
    await waitFor(() => expect(textBox().value).toBe("Long."));
  });

  it("stops recording when the page is hidden, and transcribes what it recorded", async () => {
    const recorder = installRecorder();
    await openThread();
    answerTranscriptions({ body: { text: "Later." } });
    await record(recorder);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Reflect.deleteProperty(document, "visibilityState");
    await waitFor(() => expect(textBox().value).toBe("Later."));
    expect(recorder.tracks.every((track) => track.stopped)).toBe(true);
  });

  it("never starts recording when the page was hidden while the microphone opened", async () => {
    let open = () => {};
    const recorder = installRecorder({ opened: new Promise<void>((resolve) => (open = resolve)) });
    await openThread();
    fireEvent.change(textBox(), { target: { value: "Use it." } });
    fireEvent.click(control("Dictate"));
    try {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      open();
      await waitFor(() => expect(recorder.tracks).toHaveLength(1));
      await waitFor(() => expect(control("Dictate")).toHaveProperty("disabled", false));
      expect(recorder.recorders).toHaveLength(0);
      expect(recorder.tracks.every((track) => track.stopped)).toBe(true);
      // None left, so Send goes again.
      expect(sendButton().disabled).toBe(false);
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("says the microphone failed when it is refused", async () => {
    installRecorder({ refuse: new DOMException("denied", "NotAllowedError") });
    await openThread();
    fireEvent.change(textBox(), { target: { value: "Use it." } });
    fireEvent.click(control("Dictate"));
    await within(composer()).findByRole("alert");
    expect(control("Dictate")).toHaveProperty("disabled", false);
    expect(sendButton().disabled).toBe(false);
  });

  it("stops the microphone and offers Dictate again when the recorder cannot start", async () => {
    const recorder = installRecorder({ failStart: true });
    await openThread();
    fireEvent.change(textBox(), { target: { value: "Use it." } });
    fireEvent.click(control("Dictate"));
    await within(composer()).findByRole("alert");
    expect(recorder.tracks).toHaveLength(1);
    expect(recorder.tracks.every((track) => track.stopped)).toBe(true);
    expect(control("Dictate")).toHaveProperty("disabled", false);
    expect(sendButton().disabled).toBe(false);
  });

  it("ignores a refusal that arrives after Cancel, leaving a second opening as it is", async () => {
    installRecorder();
    // Each request for the microphone waits for the test to answer it.
    const asked: { refuse: () => void }[] = [];
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () =>
          new Promise((_, reject) =>
            asked.push({ refuse: () => reject(new DOMException("denied", "NotAllowedError")) }),
          ),
      },
      configurable: true,
    });
    await openThread();
    fireEvent.change(textBox(), { target: { value: "Use it." } });
    fireEvent.click(control("Dictate"));
    fireEvent.click(await within(composer()).findByRole("button", { name: "Cancel dictation" }));
    fireEvent.click(control("Dictate"));
    await within(composer()).findByRole("button", { name: "Cancel dictation" });
    expect(asked).toHaveLength(2);
    // The first, cancelled, is refused at last.
    act(() => asked[0]?.refuse());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(composer()).queryByRole("alert")).toBeNull();
    expect(within(composer()).getByRole("button", { name: "Cancel dictation" })).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  it("cancels a microphone that never opens, freeing Send, and closes it should it open later", async () => {
    let open = () => {};
    const recorder = installRecorder({ opened: new Promise<void>((resolve) => (open = resolve)) });
    const state = await page.openWith([message(1, { text: "Which database?" })]);
    page.serveWrites(state);
    await within(composer()).findByRole("button", { name: "Dictate" });
    fireEvent.change(textBox(), { target: { value: "Use it." } });
    control("Dictate").focus();
    fireEvent.click(control("Dictate"));
    // The prompt goes unanswered: Send waits, and Cancel takes focus.
    const cancel = await within(composer()).findByRole("button", { name: "Cancel dictation" });
    expect(document.activeElement).toBe(cancel);
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(cancel);
    expect(document.activeElement).toBe(control("Dictate"));
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    // The microphone answers at last: its tracks stop, and nothing records.
    open();
    await waitFor(() => expect(recorder.tracks).toHaveLength(1));
    await waitFor(() => expect(recorder.tracks.every((track) => track.stopped)).toBe(true));
    expect(recorder.recorders).toHaveLength(0);
    expect(within(composer()).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("holds the draft open from the start of a recording, for the stale-write check", async () => {
    const recorder = installRecorder();
    const state = await page.openWith([message(1, { text: "Which database?" })]);
    page.serveWrites(state);
    await within(composer()).findByRole("button", { name: "Dictate" });
    let answer: (reply: Reply) => void = () => undefined;
    answerTranscriptions(() => new Promise<Reply>((resolve) => (answer = resolve)));
    await record(recorder);
    fireEvent.click(control("Stop"));
    await within(composer()).findByRole("button", { name: "Cancel dictation" });
    // A message lands while the recording is transcribed.
    state.thread = { ...state.thread, last_seq: 2, unread: 1 };
    state.messages = [...state.messages, message(2, { text: "Or Postgres?" })];
    fireEvent.focus(window);
    await screen.findByText("Or Postgres?");
    answer({ body: { text: "SQLite." } });
    await waitFor(() => expect(textBox().value).toBe("SQLite."));
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(page.seenThrough()).toEqual([1]);
  });

  it("holds Send and its shortcut while a recording, its transcription or its Retry is there", async () => {
    const recorder = installRecorder();
    const state = await page.openWith([message(1)]);
    page.serveWrites(state);
    await within(composer()).findByRole("button", { name: "Dictate" });
    let answer: (reply: Reply) => void = () => undefined;
    answerTranscriptions(() => new Promise<Reply>((resolve) => (answer = resolve)));
    fireEvent.change(textBox(), { target: { value: "Use" } });
    await record(recorder);
    const send = () => within(composer()).getByRole<HTMLButtonElement>("button", { name: "Send" });
    expect(send().disabled).toBe(true);
    const why = document.getElementById(send().getAttribute("aria-describedby") ?? "");
    expect(why).not.toBeNull();
    fireEvent.click(control("Stop"));
    await within(composer()).findByRole("button", { name: "Cancel dictation" });
    expect(send().disabled).toBe(true);
    fireEvent.keyDown(textBox(), { key: "Enter", ctrlKey: true });
    expect(page.writes()).toEqual([]);
    answer({ body: { text: "SQLite." } });
    await waitFor(() => expect(textBox().value).toBe("Use SQLite."));
    expect(send().disabled).toBe(false);
    expect(send().getAttribute("aria-describedby")).toBeNull();
  });

  it("waits while a message is on its way, since the draft it would be for may be the one sent", async () => {
    installRecorder();
    await page.openWith([message(1)]);
    let land: (reply: Reply) => void = () => undefined;
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise<Reply>((resolve) => (land = resolve)),
    );
    const dictate = () =>
      within(composer()).getByRole<HTMLButtonElement>("button", { name: "Dictate" });
    await within(composer()).findByRole("button", { name: "Dictate" });
    fireEvent.change(textBox(), { target: { value: "Sent first." } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(dictate().disabled).toBe(true);
    land(written(2));
    await waitFor(() => expect(textBox().value).toBe(""));
    expect(dictate().disabled).toBe(false);
  });
});

describe("dictation into an ask's own words", () => {
  const card = () => screen.getByRole("region", { name: /^Ask 1:/ });
  const words = () => within(card()).getByRole<HTMLTextAreaElement>("textbox");

  it("puts the text at the field's caret, staging the answer", async () => {
    const recorder = installRecorder();
    const state = await page.openWith([message(1, { asks: [ask({ suggestions: [] })] })]);
    page.serveWrites(state);
    fireEvent.change(words(), { target: { value: "Use it." } });
    words().focus();
    words().setSelectionRange(3, 3);
    answerTranscriptions({ body: { text: "SQLite" } });
    fireEvent.click(await within(card()).findByRole("button", { name: "Dictate" }));
    fireEvent.click(await within(card()).findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(words().value).toBe("Use SQLite it."));
    expect(document.activeElement).toBe(words());
    expect(words().selectionStart).toBe("Use SQLite".length);
    // Dictating left the field without its words being missing.
    expect(words().getAttribute("aria-invalid")).toBeNull();
    expect(recorder.tracks.every((track) => track.stopped)).toBe(true);
    expect(textBox().value).toBe("");
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(page.bodies()[0]).toMatchObject({ answers: [{ ask: 1, text: "Use SQLite it." }] });
  });

  it("is not offered while voice is off", async () => {
    page.api.on("GET", "/settings", { body: { voice: null } });
    installRecorder();
    await page.openWith([message(1, { asks: [ask({ suggestions: [] })] })]);
    await waitFor(() => expect(page.api.callsTo("GET", "/settings")).toHaveLength(1));
    expect(within(card()).queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("holds the draft open from the start of a recording, for the stale-write check", async () => {
    const recorder = installRecorder();
    const state = await page.openWith([message(1, { asks: [ask({ suggestions: [] })] })]);
    page.serveWrites(state);
    let answer: (reply: Reply) => void = () => undefined;
    answerTranscriptions(() => new Promise<Reply>((resolve) => (answer = resolve)));
    fireEvent.click(await within(card()).findByRole("button", { name: "Dictate" }));
    await within(card()).findByRole("button", { name: "Stop" });
    expect(recorder.recorders).toHaveLength(1);
    fireEvent.click(within(card()).getByRole("button", { name: "Stop" }));
    await within(card()).findByRole("button", { name: "Cancel dictation" });
    // A message lands while the recording is transcribed.
    state.thread = { ...state.thread, last_seq: 2, unread: 1 };
    state.messages = [...state.messages, message(2, { text: "Or Postgres?" })];
    fireEvent.focus(window);
    await screen.findByText("Or Postgres?");
    answer({ body: { text: "SQLite." } });
    await waitFor(() => expect(words().value).toBe("SQLite."));
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(page.seenThrough()).toEqual([1]);
  });

  // pendingTranscription holds the next transcription until answered.
  function pendingTranscription(): (reply: Reply) => void {
    let answer: (reply: Reply) => void = () => undefined;
    answerTranscriptions(() => new Promise<Reply>((resolve) => (answer = resolve)));
    return (reply) => answer(reply);
  }

  // transcribingOnCard records on the card and stops, leaving the
  // transcription to answer.
  async function transcribingOnCard() {
    fireEvent.click(await within(card()).findByRole("button", { name: "Dictate" }));
    fireEvent.click(await within(card()).findByRole("button", { name: "Stop" }));
    await within(card()).findByRole("button", { name: "Cancel dictation" });
  }

  const staged = () => within(composer()).queryByText(/^Ask 1:/);

  it("drops a transcript whose draft was discarded meanwhile", async () => {
    installRecorder();
    await page.openWith([message(1, { asks: [ask({ suggestions: [] })] })]);
    const answer = pendingTranscription();
    fireEvent.change(textBox(), { target: { value: "A note." } });
    await transcribingOnCard();
    fireEvent.click(control("Discard draft"));
    fireEvent.click(control("Discard"));
    await waitFor(() => expect(textBox().value).toBe(""));
    answer({ body: { text: "Too late." } });
    await within(card()).findByRole("button", { name: "Dictate" });
    expect(words().value).toBe("");
    expect(staged()).toBeNull();
  });

  it("holds the composer's Send while it records, since that Send sends its answer", async () => {
    installRecorder();
    await page.openWith([message(1, { asks: [ask({ suggestions: [] })] })]);
    const answer = pendingTranscription();
    fireEvent.change(words(), { target: { value: "Use" } });
    const send = () => within(composer()).getByRole<HTMLButtonElement>("button", { name: "Send" });
    expect(send().disabled).toBe(false);
    await transcribingOnCard();
    expect(send().disabled).toBe(true);
    expect(send().getAttribute("aria-describedby")).not.toBeNull();
    answer({ body: { text: "SQLite." } });
    await waitFor(() => expect(words().value).toBe("Use SQLite."));
    expect(send().disabled).toBe(false);
  });

  it("waits while the composer's message is on its way", async () => {
    installRecorder();
    await page.openWith([message(1, { asks: [ask({ suggestions: [] })] })]);
    let land: (reply: Reply) => void = () => undefined;
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise<Reply>((resolve) => (land = resolve)),
    );
    const dictate = () =>
      within(card()).getByRole<HTMLButtonElement>("button", { name: "Dictate" });
    fireEvent.change(words(), { target: { value: "SQLite." } });
    await within(card()).findByRole("button", { name: "Dictate" });
    fireEvent.click(control("Send"));
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(dictate().disabled).toBe(true);
    land(written(2));
    await waitFor(() => expect(staged()).toBeNull());
    expect(dictate().disabled).toBe(false);
  });

  it("drops a transcript for a draft discarded while the microphone opened", async () => {
    let open = () => {};
    installRecorder({ opened: new Promise<void>((resolve) => (open = resolve)) });
    await page.openWith([message(1, { asks: [ask({ suggestions: [] })] })]);
    answerTranscriptions({ body: { text: "Too late." } });
    fireEvent.change(textBox(), { target: { value: "A note." } });
    fireEvent.click(await within(card()).findByRole("button", { name: "Dictate" }));
    fireEvent.click(control("Discard draft"));
    fireEvent.click(control("Discard"));
    await waitFor(() => expect(textBox().value).toBe(""));
    fireEvent.change(textBox(), { target: { value: "A new draft." } });
    open();
    fireEvent.click(await within(card()).findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(page.api.callsTo("POST", "/transcriptions")).toHaveLength(1));
    await within(card()).findByRole("button", { name: "Dictate" });
    expect(words().value).toBe("");
    expect(staged()).toBeNull();
    expect(textBox().value).toBe("A new draft.");
  });

  it("never starts recording once the card was held while the microphone opened", async () => {
    let open = () => {};
    const recorder = installRecorder({
      opened: new Promise<void>((resolve) => (open = resolve)),
    });
    await page.openWith([
      message(1, { asks: [ask({ suggestions: [] })] }),
      operatorMessage(2, { text: "Small data." }),
    ]);
    fireEvent.click(await within(card()).findByRole("button", { name: "Dictate" }));
    // An edit staged meanwhile holds the card.
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    open();
    await waitFor(() => expect(recorder.tracks).toHaveLength(1));
    await waitFor(() =>
      expect(within(card()).getByRole("button", { name: "Dictate" })).toHaveProperty(
        "disabled",
        true,
      ),
    );
    expect(recorder.recorders).toHaveLength(0);
    expect(recorder.tracks.every((track) => track.stopped)).toBe(true);
  });

  it("lets the draft go once the field it recorded for goes away", async () => {
    installRecorder();
    const state = await page.openWith([message(1, { asks: [ask()] })]);
    page.serveWrites(state);
    fireEvent.click(within(card()).getByRole("radio", { name: "Other" }));
    fireEvent.click(await within(card()).findByRole("button", { name: "Dictate" }));
    await within(card()).findByRole("button", { name: "Stop" });
    // Picking a suggestion keeps the field and its recording.
    fireEvent.click(within(card()).getByRole("radio", { name: /^SQLite/ }));
    expect(within(card()).getByRole("button", { name: "Stop" })).toBeTruthy();
    // Declining hides the field and drops its recording, and Clear leaves
    // nothing staged.
    fireEvent.click(within(card()).getByRole("button", { name: "Decline to answer" }));
    expect(within(card()).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(card()).getByRole("button", { name: "Clear" }));
    expect(staged()).toBeNull();
    // A message that lands now is seen before the next draft starts.
    state.thread = { ...state.thread, last_seq: 2, unread: 1 };
    state.messages = [...state.messages, message(2, { text: "Or Postgres?" })];
    fireEvent.focus(window);
    await screen.findByText("Or Postgres?");
    fireEvent.change(textBox(), { target: { value: "Thanks." } });
    fireEvent.click(control("Send"));
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(page.seenThrough()).toEqual([2]);
  });
});

describe("one recording on the page", () => {
  it("stops a recording under way, which is transcribed as its Stop would, when another starts", async () => {
    const recorder = installRecorder();
    await page.openWith([message(1, { asks: [ask({ suggestions: [] })] })]);
    const card = () => screen.getByRole("region", { name: /^Ask 1:/ });
    const texts = ["In the composer.", "On the card."];
    answerTranscriptions(() => ({ body: { text: texts.shift() ?? "" } }));
    fireEvent.click(await within(composer()).findByRole("button", { name: "Dictate" }));
    await within(composer()).findByRole("button", { name: "Stop" });
    fireEvent.click(within(card()).getByRole("button", { name: "Dictate" }));
    await within(card()).findByRole("button", { name: "Stop" });
    // The composer's stopped, its microphone closed, and its text is in.
    await waitFor(() => expect(textBox().value).toBe("In the composer."));
    expect(recorder.recorders.map((each) => each.state)).toEqual(["inactive", "recording"]);
    expect(recorder.tracks.map((track) => track.stopped)).toEqual([true, false]);
    expect(within(composer()).getByRole("button", { name: "Dictate" })).toBeTruthy();
    fireEvent.click(within(card()).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(within(card()).getByRole<HTMLTextAreaElement>("textbox").value).toBe("On the card."),
    );
    expect(textBox().value).toBe("In the composer.");
    expect(uploads()).toHaveLength(2);
  });
});
