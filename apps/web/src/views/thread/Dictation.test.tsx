import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrf, failure, installRecorder, message, type Reply } from "../../test-support.tsx";
import { recordingByteLimit } from "../../voice/Dictation.tsx";
import { openDetails, path, textBox, ThreadPageTest } from "./thread-test-support.tsx";

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
    answerTranscriptions({ body: { text: " " } });
    await record(recorder);
    fireEvent.click(control("Stop"));
    await within(composer()).findByRole("button", { name: "Dictate" });
    // What was heard shows after Send, where what was sent does.
    expect(after(control("Send"), within(composer()).getByRole("status"))).toBe(true);
    expect(textBox().value).toBe("");
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
    const cancel = await within(composer()).findByRole("button", { name: "Cancel" });
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
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("says the microphone failed when it is refused", async () => {
    installRecorder({ refuse: new DOMException("denied", "NotAllowedError") });
    await openThread();
    fireEvent.click(control("Dictate"));
    await within(composer()).findByRole("alert");
    expect(control("Dictate")).toHaveProperty("disabled", false);
  });

  it("stops the microphone and offers Dictate again when the recorder cannot start", async () => {
    const recorder = installRecorder({ failStart: true });
    await openThread();
    fireEvent.click(control("Dictate"));
    await within(composer()).findByRole("alert");
    expect(recorder.tracks).toHaveLength(1);
    expect(recorder.tracks.every((track) => track.stopped)).toBe(true);
    expect(control("Dictate")).toHaveProperty("disabled", false);
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
    await within(composer()).findByRole("button", { name: "Cancel" });
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

  it("drops a transcript whose draft was sent meanwhile", async () => {
    const recorder = installRecorder();
    const state = await page.openWith([message(1)]);
    page.serveWrites(state);
    await within(composer()).findByRole("button", { name: "Dictate" });
    let answer: (reply: Reply) => void = () => undefined;
    answerTranscriptions(() => new Promise<Reply>((resolve) => (answer = resolve)));
    fireEvent.change(textBox(), { target: { value: "Sent first." } });
    await record(recorder);
    fireEvent.click(control("Stop"));
    await within(composer()).findByRole("button", { name: "Cancel" });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    await waitFor(() => expect(textBox().value).toBe(""));
    answer({ body: { text: "Too late." } });
    await within(composer()).findByRole("button", { name: "Dictate" });
    expect(textBox().value).toBe("");
    expect(page.api.callsTo("POST", `${path}/messages`)).toHaveLength(1);
  });
});
