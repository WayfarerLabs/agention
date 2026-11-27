import type { SessionSummary } from "@wayfarerlabs/agention-server-api";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Call,
  FakeApi,
  type FakeUpload,
  failure,
  installRecorder,
  installUploads,
  operatorMessage,
  type Reply,
  renderAt,
  sessionSummary,
  threadAnswer,
  threadSummary,
  titled,
  uploadAnswer,
} from "../../test-support.tsx";
import { navigate } from "../../router.tsx";

// The new-thread sheet's files and dictation, which work as the composer's
// do (AttachList.test.tsx and Dictation.test.tsx test those at length); the
// sheet's other behavior is in Sessions.test.tsx.

let api: FakeApi;
let uploads: FakeUpload[];

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
  api = new FakeApi();
  api.on("GET", "/registrations", { body: { registrations: [] } });
  uploads = installUploads();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
  expect(api.unhandled).toEqual([]);
});

const time = "2026-10-27T12:00:00.000Z";
const ref = (n: number) => String(n).padStart(22, "A");
const sessionPath = "/s/builder/main";

async function openSheet({ strict = false } = {}) {
  const session: SessionSummary = sessionSummary({
    status: { state: "working", updated_at: time },
  });
  api.on("GET", "/sessions", {
    body: { agents: [{ agent: "builder", tags: [], sessions: [session], truncated: false }] },
  });
  renderAt("/sessions", null, { strict });
  fireEvent.click(await screen.findByRole("button", { name: "Options for builder/main" }));
  fireEvent.click(screen.getByRole("button", { name: "New thread" }));
  return screen.getByRole("dialog", { name: "New thread" });
}

const sheet = () => screen.getByRole("dialog", { name: "New thread" });
const control = (name: string) => within(sheet()).getByRole<HTMLButtonElement>("button", { name });
const box = (label: string) => within(sheet()).getByLabelText<HTMLTextAreaElement>(label);
const listed = () =>
  Array.from(
    within(sheet())
      .queryByRole("list", { name: "Files to send" })
      ?.querySelectorAll(".file-name") ?? [],
    (name) => name.textContent,
  );

function file(name: string, type = "image/png"): File {
  return new File([new Uint8Array(1000)], name, { type });
}

// choose chooses files in Attach's picker.
function choose(...files: File[]) {
  fireEvent.click(control("Attach files"));
  const picker = sheet().querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(picker, { target: { files } });
}

// The path that removes the upload ref(n).
const removal = (n: number) => `${sessionPath}/uploads/${ref(n)}/remove`;

// uploaded answers the upload uploads[index] is, as landed as ref(n), which
// the server then removes when asked.
function uploaded(index: number, n: number) {
  const upload = uploads[index]!;
  api.on("POST", removal(n), { body: {} });
  upload.respond(uploadAnswer(ref(n), upload.query.get("name") ?? "", 1000));
}

function write(title: string, text: string) {
  fireEvent.change(within(sheet()).getByLabelText("Title"), { target: { value: title } });
  fireEvent.change(box("Message"), { target: { value: text } });
}

describe("the new-thread sheet's files", () => {
  it("uploads a file chosen with Attach to the session, and Send waits for it", async () => {
    await openSheet();
    write("The plan", "Here it is.");
    choose(file("plan.png"));
    expect(listed()).toEqual(["plan.png"]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(new URL(uploads[0]!.url, "https://agention.test").pathname).toBe(
      `/api/web${sessionPath}/uploads`,
    );
    expect(control("Send").disabled).toBe(true);
    const hold = document.getElementById(control("Send").getAttribute("aria-describedby") ?? "");
    expect(hold).not.toBeNull();
    uploaded(0, 1);
    await waitFor(() => expect(control("Send").disabled).toBe(false));
    expect(control("Send").getAttribute("aria-describedby")).toBeNull();
  });

  it("attaches an image pasted into either box, inserting no text", async () => {
    await openSheet();
    const pasted = fireEvent.paste(box("Message"), {
      clipboardData: { files: [file("image.png")], types: ["Files"] },
    });
    expect(pasted).toBe(false);
    fireEvent.paste(box("Details"), {
      clipboardData: { files: [file("image.jpg", "image/jpeg")], types: ["Files"] },
    });
    expect(listed()).toHaveLength(2);
    expect(listed().every((name) => name?.startsWith("pasted-"))).toBe(true);
    expect(box("Message").value).toBe("");
  });

  it("removes a file, and its upload from the server", async () => {
    await openSheet();
    choose(file("one.png"), file("two.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await waitFor(() => expect(uploads).toHaveLength(2));
    fireEvent.click(control("Remove one.png"));
    expect(listed()).toEqual(["two.png"]);
    await waitFor(() => expect(api.callsTo("POST", removal(1))).toHaveLength(1));
    // Focus moves to the next file's Remove.
    expect(document.activeElement).toBe(control("Remove two.png"));
  });

  it("starts the thread with the files, in order, and opens it", async () => {
    await openSheet();
    write("The plan", "Here it is.");
    choose(file("one.png"), file("two.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await waitFor(() => expect(uploads).toHaveLength(2));
    uploaded(1, 2);
    api.on("POST", `${sessionPath}/threads`, { body: { number: 3, seq: 1 } });
    api.on("GET", `${sessionPath}/threads/3`, {
      body: threadAnswer(threadSummary({ number: 3, title: "The plan", unread: 0 }), [
        operatorMessage(1, { text: "Here it is." }),
      ]),
    });
    await waitFor(() => expect(control("Send").disabled).toBe(false));
    fireEvent.click(control("Send"));
    await screen.findByRole("heading", { level: 1, name: titled("The plan") });
    const [sent] = api.callsTo("POST", `${sessionPath}/threads`) as [Call];
    expect(sent.body).toMatchObject({
      title: "The plan",
      text: "Here it is.",
      attachments: [
        { upload: ref(1), name: "one.png" },
        { upload: ref(2), name: "two.png" },
      ],
    });
  });

  it("marks a file whose upload a refusal names as expired, for Upload again", async () => {
    await openSheet();
    write("The plan", "Here it is.");
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    api.on(
      "POST",
      `${sessionPath}/threads`,
      failure("invalid_input", "names no upload of yours", { field: "attachments.0.upload" }),
    );
    await waitFor(() => expect(control("Send").disabled).toBe(false));
    fireEvent.click(control("Send"));
    await within(sheet()).findByRole("button", { name: "Upload again one.png" });
    expect(control("Send").disabled).toBe(true);
  });

  it("removes its uploads when it closes without sending", async () => {
    await openSheet();
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await within(sheet()).findByText("Uploaded");
    fireEvent.click(control("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(api.callsTo("POST", removal(1))).toHaveLength(1));
  });

  it("removes its uploads when it goes without closing, as when a link leaves the page", async () => {
    await openSheet();
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await within(sheet()).findByText("Uploaded");
    act(() => navigate("/threads"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(api.callsTo("POST", removal(1))).toHaveLength(1));
  });
});

describe("dictation in the new-thread sheet", () => {
  it("is not offered while voice is off", async () => {
    installRecorder();
    await openSheet();
    await waitFor(() => expect(api.callsTo("GET", "/settings").length).toBeGreaterThan(0));
    expect(within(sheet()).queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("puts the text at the caret of the box last in, Details included", async () => {
    api.on("GET", "/settings", { body: voiceOn });
    const recorder = installRecorder();
    await openSheet();
    fireEvent.change(box("Message"), { target: { value: "Use it." } });
    box("Message").focus();
    box("Message").setSelectionRange(3, 3);
    api.on("POST", "/transcriptions", { body: { text: "SQLite" } });
    fireEvent.click(await within(sheet()).findByRole("button", { name: "Dictate" }));
    fireEvent.click(await within(sheet()).findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(box("Message").value).toBe("Use SQLite it."));
    expect(document.activeElement).toBe(box("Message"));
    expect(box("Message").selectionStart).toBe("Use SQLite".length);

    fireEvent.focus(box("Details"));
    api.on("POST", "/transcriptions", { body: { text: "The rest." } });
    fireEvent.click(control("Dictate"));
    fireEvent.click(await within(sheet()).findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(box("Details").value).toBe("The rest."));
    expect(box("Message").value).toBe("Use SQLite it.");
    expect(recorder.tracks.every((track) => track.stopped)).toBe(true);
    expect(api.callsTo("POST", `${sessionPath}/threads`)).toEqual([]);
  });

  it("holds Send while a recording, its transcription or its Retry is there", async () => {
    api.on("GET", "/settings", { body: voiceOn });
    installRecorder();
    await openSheet();
    write("The plan", "Here it is.");
    expect(control("Send").disabled).toBe(false);
    let answer: (reply: Reply) => void = () => undefined;
    api.on("POST", "/transcriptions", () => new Promise<Reply>((resolve) => (answer = resolve)));
    fireEvent.click(await within(sheet()).findByRole("button", { name: "Dictate" }));
    await within(sheet()).findByRole("button", { name: "Stop" });
    expect(control("Send").disabled).toBe(true);
    expect(control("Send").getAttribute("aria-describedby")).not.toBeNull();
    fireEvent.click(control("Stop"));
    await within(sheet()).findByRole("button", { name: "Cancel dictation" });
    expect(control("Send").disabled).toBe(true);
    answer({ body: { text: "Soon." } });
    await waitFor(() => expect(box("Message").value).toBe("Here it is. Soon."));
    expect(control("Send").disabled).toBe(false);
  });
});

describe("the new-thread sheet while its start is on its way", () => {
  it("holds still: no Cancel, no Escape, no files and no dictation", async () => {
    api.on("GET", "/settings", { body: voiceOn });
    installRecorder();
    await openSheet();
    write("The plan", "Here it is.");
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    let started: (reply: Reply) => void = () => undefined;
    api.on(
      "POST",
      `${sessionPath}/threads`,
      () => new Promise<Reply>((resolve) => (started = resolve)),
    );
    await waitFor(() => expect(control("Send").disabled).toBe(false));
    fireEvent.click(control("Send"));
    await waitFor(() => expect(control("Cancel").disabled).toBe(true));
    // Escape's cancel is refused, and the sheet stays open.
    const escape = new Event("cancel", { cancelable: true });
    sheet().dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(fireEvent.keyDown(sheet(), { key: "Escape" })).toBe(false);
    expect(control("Attach files").disabled).toBe(true);
    expect(control("Dictate").disabled).toBe(true);
    // A pasted image attaches nothing.
    fireEvent.paste(box("Message"), {
      clipboardData: { files: [file("late.png")], types: ["Files"] },
    });
    expect(listed()).toEqual(["one.png"]);
    expect(uploads).toHaveLength(1);
    // Once the start fails, the sheet works again, its file still there.
    started(failure("internal", "internal error"));
    await waitFor(() => expect(control("Cancel").disabled).toBe(false));
    expect(listed()).toEqual(["one.png"]);
    expect(api.callsTo("POST", removal(1))).toEqual([]);
  });

  it("leaves the start's uploads alone should the sheet close all the same", async () => {
    await openSheet();
    write("The plan", "Here it is.");
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    let started: (reply: Reply) => void = () => undefined;
    api.on(
      "POST",
      `${sessionPath}/threads`,
      () => new Promise<Reply>((resolve) => (started = resolve)),
    );
    await waitFor(() => expect(control("Send").disabled).toBe(false));
    fireEvent.click(control("Send"));
    await waitFor(() => expect(control("Cancel").disabled).toBe(true));
    (sheet() as HTMLDialogElement).close();
    expect(screen.queryByRole("dialog")).toBeNull();
    started({ body: { number: 3, seq: 1 } });
    await waitFor(() => expect(api.callsTo("POST", `${sessionPath}/threads`)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.calls.filter((call) => call.url.pathname.endsWith("/remove"))).toEqual([]);
  });

  it("keeps the start's uploads when it fails while the sheet stays, in StrictMode too", async () => {
    await openSheet({ strict: true });
    write("The plan", "Here it is.");
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    api.on("POST", `${sessionPath}/threads`, failure("internal", "internal error"));
    await waitFor(() => expect(control("Send").disabled).toBe(false));
    fireEvent.click(control("Send"));
    await within(sheet()).findByRole("alert");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listed()).toEqual(["one.png"]);
    expect(api.callsTo("POST", removal(1))).toEqual([]);
  });

  it("removes the start's uploads should it fail after the page was left", async () => {
    await openSheet();
    write("The plan", "Here it is.");
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    let started: (reply: Reply) => void = () => undefined;
    api.on(
      "POST",
      `${sessionPath}/threads`,
      () => new Promise<Reply>((resolve) => (started = resolve)),
    );
    await waitFor(() => expect(control("Send").disabled).toBe(false));
    fireEvent.click(control("Send"));
    await waitFor(() => expect(control("Cancel").disabled).toBe(true));
    act(() => navigate("/threads"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.callsTo("POST", removal(1))).toEqual([]);
    started(failure("internal", "internal error"));
    await waitFor(() => expect(api.callsTo("POST", removal(1))).toHaveLength(1));
  });
});
