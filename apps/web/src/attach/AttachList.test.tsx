import { maxAttachments, maxFileBytes } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerTo,
  ask,
  csrf,
  type FakeUpload,
  failure,
  installUploads,
  message,
  operatorMessage,
  type Reply,
  uploadAnswer,
} from "../test-support.tsx";
import {
  option,
  path,
  textBox,
  ThreadPageTest,
  written,
} from "../views/thread/thread-test-support.tsx";

let page: ThreadPageTest;
let uploads: FakeUpload[];

beforeEach(() => {
  page = new ThreadPageTest();
  uploads = installUploads();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(page.api.unhandled).toEqual([]);
});

// A file reference, as an upload answers with one.
const ref = (n: number) => String(n).padStart(22, "A");

const composer = () => screen.getByRole("region", { name: "Reply" });
const control = (name: string) =>
  within(composer()).getByRole<HTMLButtonElement>("button", { name });
const attachButton = () => control("Attach files");
const sendButton = () => control("Send");
const picker = () => composer().querySelector<HTMLInputElement>('input[type="file"]')!;
const fileList = () => within(composer()).queryByRole("list", { name: "Files to send" });
const listed = () =>
  within(fileList() ?? document.createElement("ul"))
    .queryAllByRole("listitem")
    .map((item) => item.querySelector(".file-name")?.textContent);
const entry = (name: string) =>
  within(fileList()!)
    .getAllByRole("listitem")
    .find((item) => item.querySelector(".file-name")?.textContent === name)!;

function file(name: string, type = "image/png", size = 1000): File {
  const made = new File([new Uint8Array(Math.min(size, 1000))], name, { type });
  if (size > 1000) {
    Object.defineProperty(made, "size", { value: size });
  }
  return made;
}

// choose chooses files in the picker, from Attach.
function choose(...files: File[]) {
  attachButton().focus();
  fireEvent.click(attachButton());
  fireEvent.change(picker(), { target: { files } });
}

// The path that removes the upload ref(n).
const removal = (n: number) => `/s/builder/main/uploads/${ref(n)}/remove`;

// uploaded answers the upload under way, which uploads[index] is, as landed
// as ref(n), which the server then removes when asked.
function uploaded(index: number, n: number) {
  const upload = uploads[index]!;
  const name = upload.query.get("name") ?? "";
  page.api.on("POST", removal(n), { body: {} });
  upload.respond(uploadAnswer(ref(n), name, 1000));
}

// removals gives the paths of the uploads the page asked the server to
// remove, in order.
const removals = () =>
  page.api.calls
    .filter((call) => /\/uploads\/[^/]+\/remove$/.test(call.url.pathname))
    .map((call) => call.path);

async function opened() {
  await page.openWith([message(1, { text: "Hello" })]);
  page.api.on("POST", `${path}/messages`, written(2));
}

describe("attaching", () => {
  it("uploads the files chosen one at a time, in order, to the session, leaving focus on Attach", async () => {
    await opened();
    const picked = [file("one.png"), file("two.txt", "")];
    choose(...picked);
    expect(document.activeElement).toBe(attachButton());
    expect(listed()).toEqual(["one.png", "two.txt"]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    const [first] = uploads;
    expect(first?.method).toBe("POST");
    expect(new URL(first!.url, "https://agention.test").pathname).toBe(
      "/api/web/s/builder/main/uploads",
    );
    expect(first?.query.get("name")).toBe("one.png");
    expect(first?.headers["content-type"]).toBe("image/png");
    expect(first?.headers["x-csrf-token"]).toBe(csrf);
    expect(first?.body).toBe(picked[0]);
    // The second waits for the first.
    first?.progress(400);
    const bar = await within(entry("one.png")).findByRole<HTMLProgressElement>("progressbar");
    expect([bar.value, bar.max]).toEqual([400, 1000]);
    expect(uploads).toHaveLength(1);
    uploaded(0, 1);
    await waitFor(() => expect(uploads).toHaveLength(2));
    // A file without a type declares its name's.
    expect(uploads[1]?.headers["content-type"]).toBe("text/plain");
  });

  it("holds Send until every upload finishes, saying so, then sends the files alone in order", async () => {
    await opened();
    choose(file("one.png"), file("two.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(sendButton().disabled).toBe(true);
    const hold = document.getElementById(sendButton().getAttribute("aria-describedby") ?? "");
    expect(hold).not.toBeNull();
    uploaded(0, 1);
    await waitFor(() => expect(uploads).toHaveLength(2));
    expect(sendButton().disabled).toBe(true);
    uploaded(1, 2);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(sendButton().getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(page.bodies()[0]).toMatchObject({
      attachments: [
        { upload: ref(1), name: "one.png" },
        { upload: ref(2), name: "two.png" },
      ],
    });
    expect(page.bodies()[0]).not.toHaveProperty("text");
    // A write that lands clears the files it sent.
    await waitFor(() => expect(fileList()).toBeNull());
  });

  it("keeps files added while a write is under way", async () => {
    await page.openWith([message(1, { text: "Hello" })]);
    let land: (() => void) | undefined;
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise((resolve) => (land = () => resolve(written(2)))),
    );
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(land).toBeDefined());
    choose(file("two.png"));
    land?.();
    await waitFor(() => expect(listed()).toEqual(["two.png"]));
  });

  it("names a file again with -2 and so on when the draft has its name", async () => {
    await opened();
    choose(file("shot.png"), file("shot.png"), file("notes"));
    choose(file("shot.png"), file("notes"));
    expect(listed()).toEqual(["shot.png", "shot-2.png", "notes", "shot-3.png", "notes-2"]);
  });

  it("refuses a file over the limit, or past the most a message carries, without uploading it", async () => {
    await opened();
    const big = file("big.mp4", "video/mp4", maxFileBytes + 1);
    const names = Array.from({ length: maxAttachments + 1 }, (_, index) => `${index}.png`);
    choose(big, ...names.map((name) => file(name)));
    expect(listed()).toHaveLength(maxAttachments + 2);
    // The large one and the eleventh are refused, saying why; ten wait their
    // turn.
    const eleventh = names.at(-1)!;
    for (const each of [entry("big.mp4"), entry(eleventh)]) {
      expect(each.querySelector(".field-error")).not.toBeNull();
    }
    for (let index = 0; index < maxAttachments; index++) {
      await waitFor(() => expect(uploads).toHaveLength(index + 1));
      uploaded(index, index + 1);
    }
    await waitFor(() => expect(within(entry(names[0]!)).queryByText("Uploaded")).not.toBeNull());
    expect(uploads.map((each) => each.query.get("name"))).toEqual(names.slice(0, -1));
    // A refused file holds Send until it is removed.
    await waitFor(() =>
      expect(within(entry(names.at(-2)!)).queryByText("Uploaded")).not.toBeNull(),
    );
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(control("Remove big.mp4"));
    fireEvent.click(control(`Remove ${eleventh}`));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  it("says why an upload failed, keeping the draft, and Retry sends it again with focus on its Remove", async () => {
    await opened();
    fireEvent.change(textBox(), { target: { value: "See this" } });
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0]?.respond(failure("storage_full", "the server's disk is too full"));
    const retry = await within(composer()).findByRole("button", { name: "Retry one.png" });
    within(entry("one.png")).getByRole("alert");
    expect(sendButton().disabled).toBe(true);
    expect(textBox().value).toBe("See this");
    retry.focus();
    fireEvent.click(retry);
    let focused: Element | null | undefined;
    await waitFor(() => {
      expect(uploads).toHaveLength(2);
      focused ??= document.activeElement;
    });
    expect(focused).toBe(control("Remove one.png"));
    expect(uploads[1]?.body).toBe(uploads[0]?.body);
    uploads[1]?.fail();
    await within(composer()).findByRole("button", { name: "Retry one.png" });
  });

  it("gives up on an upload that makes no progress for a minute, as a network failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await opened();
      choose(file("one.png"));
      await vi.waitFor(() => expect(uploads).toHaveLength(1));
      uploads[0]?.progress(10);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(uploads[0]?.aborted).toBe(false);
      uploads[0]?.progress(20);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(uploads[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(uploads[0]?.aborted).toBe(true);
      await vi.waitFor(() => control("Retry one.png"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("leaving the page", () => {
  it("removes the uploads never sent and stops the one under way", async () => {
    await opened();
    choose(file("a.png"), file("b.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await waitFor(() => expect(uploads).toHaveLength(2));
    uploads[1]?.progress(999);
    await within(entry("b.png")).findByRole("progressbar");
    cleanup();
    expect(uploads[1]?.aborted).toBe(true);
    await waitFor(() => expect(removals()).toEqual([removal(1)]));
  });

  it("removes an upload whose answer arrives in the same tick as the page is left", async () => {
    await opened();
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    cleanup();
    await waitFor(() => expect(removals()).toEqual([removal(1)]));
  });

  it("removes an upload whose answer the page handled, but the list does not show yet, as it is left", async () => {
    await opened();
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(entry("a.png").textContent).not.toContain("Uploaded");
    cleanup();
    await waitFor(() => expect(removals()).toEqual([removal(1)]));
  });

  it("lets an upload whose every byte has gone finish, then removes it", async () => {
    await opened();
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0]?.progress(1000);
    const bar = await within(entry("a.png")).findByRole<HTMLProgressElement>("progressbar");
    await waitFor(() => expect(bar.value).toBe(1000));
    cleanup();
    expect(uploads[0]?.aborted).toBe(false);
    uploaded(0, 1);
    await waitFor(() => expect(removals()).toEqual([removal(1)]));
  });

  it("lets an upload whose last byte went in the same tick as the page is left finish, then removes it", async () => {
    await opened();
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0]?.progress(1000);
    cleanup();
    expect(uploads[0]?.aborted).toBe(false);
    uploaded(0, 1);
    await waitFor(() => expect(removals()).toEqual([removal(1)]));
  });

  it("leaves a write's uploads alone while it is on its way, and once it lands", async () => {
    await page.openWith([message(1, { text: "Hello" })]);
    let land: (() => void) | undefined;
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise((resolve) => (land = () => resolve(written(2)))),
    );
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(land).toBeDefined());
    // A file added while the write is on its way is not the write's.
    choose(file("b.png"));
    await waitFor(() => expect(uploads).toHaveLength(2));
    uploaded(1, 2);
    await within(entry("b.png")).findByText("Uploaded");
    cleanup();
    await waitFor(() => expect(removals()).toEqual([removal(2)]));
    land?.();
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removals()).toEqual([removal(2)]);
  });

  it("holds Remove for a file a write on its way carries, but not for one added since", async () => {
    await page.openWith([message(1, { text: "Hello" })]);
    let land: (() => void) | undefined;
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise((resolve) => (land = () => resolve(written(2)))),
    );
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(control("Remove a.png").disabled).toBe(true));
    choose(file("b.png"));
    expect(control("Remove b.png").disabled).toBe(false);
    fireEvent.click(control("Remove a.png"));
    expect(listed()).toEqual(["a.png", "b.png"]);
    land?.();
    await waitFor(() => expect(listed()).toEqual(["b.png"]));
    expect(removals()).toEqual([]);
  });

  it("removes a write's uploads once it fails after the page was left", async () => {
    await page.openWith([message(1, { text: "Hello" })]);
    let refuse: (() => void) | undefined;
    page.api.on(
      "POST",
      `${path}/messages`,
      () =>
        new Promise((resolve) => (refuse = () => resolve(failure("internal", "internal error")))),
    );
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(refuse).toBeDefined());
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removals()).toEqual([]);
    refuse?.();
    await waitFor(() => expect(removals()).toEqual([removal(1)]));
  });

  it("leaves an upload whose removal is refused to expire, without troubling the page", async () => {
    await opened();
    const checks = page.api.callsTo("GET", "/session").length;
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    page.api.on("POST", removal(1), failure("not_found", "no such upload"));
    await within(entry("a.png")).findByText("Uploaded");
    cleanup();
    await waitFor(() => expect(removals()).toEqual([removal(1)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.api.callsTo("GET", "/session")).toHaveLength(checks);
  });
});

describe("an upload under way", () => {
  it("sends a lost sign-in to be checked when it fails for one", async () => {
    await opened();
    const checks = page.api.callsTo("GET", "/session").length;
    choose(file("one.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0]?.respond(failure("unauthenticated", "sign in"));
    await waitFor(() => expect(page.api.callsTo("GET", "/session").length).toBeGreaterThan(checks));
  });
});

describe("Remove", () => {
  it("drops a file in each state, stopping the one under way, and the next upload starts", async () => {
    await opened();
    choose(file("a.png"), file("b.png"), file("c.png"), file("d.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await waitFor(() => expect(uploads).toHaveLength(2));
    // Uploaded: dropped, and removed from the server.
    fireEvent.click(control("Remove a.png"));
    await waitFor(() => expect(page.api.callsTo("POST", removal(1))).toHaveLength(1));
    expect(page.api.callsTo("POST", removal(1))[0]?.headers["x-csrf-token"]).toBe(csrf);
    // Waiting: never sent.
    fireEvent.click(control("Remove c.png"));
    // Under way: stopped.
    fireEvent.click(control("Remove b.png"));
    expect(uploads[1]?.aborted).toBe(true);
    await waitFor(() => expect(uploads).toHaveLength(3));
    expect(uploads[2]?.query.get("name")).toBe("d.png");
    uploads[2]?.respond(failure("invalid_input", "the file stopped arriving"));
    // Failed: dropped.
    fireEvent.click(await within(composer()).findByRole("button", { name: "Remove d.png" }));
    expect(fileList()).toBeNull();
    expect(uploads).toHaveLength(3);
    expect(page.writes()).toEqual([]);
    // Only the finished upload was removed from the server.
    expect(removals()).toEqual([removal(1)]);
  });

  it("lets an upload whose every byte has gone finish, then removes it from the server", async () => {
    await opened();
    choose(file("a.png"), file("b.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0]?.progress(1000);
    const bar = await within(entry("a.png")).findByRole<HTMLProgressElement>("progressbar");
    await waitFor(() => expect(bar.value).toBe(1000));
    fireEvent.click(control("Remove a.png"));
    expect(uploads[0]?.aborted).toBe(false);
    expect(listed()).toEqual(["b.png"]);
    // The next upload need not wait for the answer.
    await waitFor(() => expect(uploads).toHaveLength(2));
    uploaded(0, 1);
    await waitFor(() => expect(page.api.callsTo("POST", removal(1))).toHaveLength(1));
    expect(page.api.callsTo("POST", removal(1))[0]?.headers["x-csrf-token"]).toBe(csrf);
    expect(listed()).toEqual(["b.png"]);
  });

  it("stops an upload while bytes remain, so the server keeps none of it", async () => {
    await opened();
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0]?.progress(999);
    const bar = await within(entry("a.png")).findByRole<HTMLProgressElement>("progressbar");
    await waitFor(() => expect(bar.value).toBe(999));
    fireEvent.click(control("Remove a.png"));
    expect(uploads[0]?.aborted).toBe(true);
    expect(fileList()).toBeNull();
    expect(removals()).toEqual([]);
  });

  it("moves focus to the next file's Remove, else the previous one's, else Attach", async () => {
    await opened();
    choose(file("a.png"), file("b.png"), file("c.png"));
    const removeOf = (name: string) => control(`Remove ${name}`);
    const removing = async (name: string) => {
      removeOf(name).focus();
      fireEvent.click(removeOf(name));
      let focused: Element | null | undefined;
      await waitFor(() => {
        expect(listed()).not.toContain(name);
        focused ??= document.activeElement;
      });
      return focused;
    };
    expect(await removing("a.png")).toBe(removeOf("b.png"));
    expect(await removing("c.png")).toBe(removeOf("b.png"));
    expect(await removing("b.png")).toBe(attachButton());
  });
});

describe("pasting", () => {
  it("attaches the images a paste holds, named by when they were pasted, and inserts no text", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 22, 9, 5, 7));
    try {
      await opened();
      const images = [file("image.png"), file("image.png", "image/jpeg")];
      const inserted = fireEvent.paste(textBox(), {
        clipboardData: { files: images, types: ["Files"] },
      });
      expect(inserted).toBe(false);
      expect(listed()).toEqual(["pasted-20261122-090507.png", "pasted-20261122-090507.jpg"]);
      fireEvent.paste(textBox(), { clipboardData: { files: [images[0]], types: ["Files"] } });
      expect(listed().at(-1)).toBe("pasted-20261122-090507-2.png");
      await waitFor(() => expect(uploads).toHaveLength(1));
      expect(uploads[0]?.query.get("name")).toBe("pasted-20261122-090507.png");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a paste of text, or of files other than images, to the browser", async () => {
    await opened();
    // Text beside a picture of it, as a spreadsheet's cells paste, stays text.
    expect(
      fireEvent.paste(textBox(), {
        clipboardData: { files: [file("image.png")], types: ["Files", "text/plain", "text/html"] },
      }),
    ).toBe(true);
    expect(
      fireEvent.paste(textBox(), { clipboardData: { files: [], types: ["text/plain"] } }),
    ).toBe(true);
    expect(
      fireEvent.paste(textBox(), {
        clipboardData: { files: [file("notes.pdf", "application/pdf")], types: ["Files"] },
      }),
    ).toBe(true);
    expect(fileList()).toBeNull();
  });

  it("attaches images pasted into the Details box too", async () => {
    await opened();
    fireEvent.click(within(composer()).getByRole("button", { name: "Details" }));
    const details = within(composer()).getByRole("textbox", { name: "Details" });
    fireEvent.paste(details, {
      clipboardData: { files: [file("a.webp", "image/webp")], types: ["Files"] },
    });
    expect(listed()).toHaveLength(1);
  });
});

describe("a refused write", () => {
  it("marks the file whose upload it names as expired, for Upload again", async () => {
    await page.openWith([message(1, { text: "Hello" })]);
    page.api.on(
      "POST",
      `${path}/messages`,
      failure("invalid_input", "names no upload of yours waiting to be attached", {
        field: "attachments.1.upload",
      }),
    );
    choose(file("a.png"), file("b.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    await waitFor(() => expect(uploads).toHaveLength(2));
    uploaded(1, 2);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    const again = await within(composer()).findByRole("button", { name: "Upload again b.png" });
    expect(within(entry("a.png")).queryByRole("button", { name: /Upload again/ })).toBeNull();
    expect(sendButton().disabled).toBe(true);
    again.focus();
    fireEvent.click(again);
    let focused: Element | null | undefined;
    await waitFor(() => {
      expect(uploads).toHaveLength(3);
      focused ??= document.activeElement;
    });
    expect(focused).toBe(control("Remove b.png"));
    expect(uploads[2]?.query.get("name")).toBe("b.png");
  });

  it("keeps the files with the draft when stale", async () => {
    const state = await page.openWith([message(1, { text: "Hello" })]);
    page.serveWrites(state);
    choose(file("a.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 1);
    state.messages = [...state.messages, message(2, { text: "Meanwhile" })];
    state.thread = { ...state.thread, last_seq: 2, message_count: 2 };
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await within(composer()).findByRole("alert");
    expect(listed()).toEqual(["a.png"]);
    fireEvent.click(within(composer()).getByRole("button", { name: /send again/ }));
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({ attachments: [{ upload: ref(1), name: "a.png" }] });
  });
});

describe("editing", () => {
  const withFiles = () =>
    page.openWith([
      message(1, { text: "Send me the logs" }),
      operatorMessage(2, {
        text: "Here",
        attachments: [
          { name: "a.log", file: ref(1), size: 10, type: "text/plain" },
          { name: "b.png", file: ref(2), size: 10, type: "image/png" },
        ],
      }),
    ]);

  it("carries the message's files forward as kept, unless removed", async () => {
    await withFiles();
    page.api.on("POST", `${path}/messages`, written(3));
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["a.log", "b.png"]));
    expect(uploads).toEqual([]);
    fireEvent.click(control("Remove a.log"));
    choose(file("c.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 3);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(page.bodies()[0]).toMatchObject({
      replaces: 2,
      attachments: [{ keep: "b.png" }, { upload: ref(3), name: "c.png" }],
    });
  });

  it("leaves the kept files alone when the page is left, removing only new uploads", async () => {
    await withFiles();
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["a.log", "b.png"]));
    choose(file("c.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 3);
    await within(entry("c.png")).findByText("Uploaded");
    cleanup();
    await waitFor(() => expect(removals()).toEqual([removal(3)]));
  });

  it("drops the kept files with what is staged, keeping new uploads", async () => {
    await withFiles();
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["a.log", "b.png"]));
    // A new file named as a kept one is named again.
    choose(file("b.png"));
    expect(listed()).toEqual(["a.log", "b.png", "b-2.png"]);
    fireEvent.click(within(composer()).getByRole("button", { name: "Remove" }));
    expect(listed()).toEqual(["b-2.png"]);
  });

  it("sends an edit that keeps only files, without its text", async () => {
    await withFiles();
    page.api.on("POST", `${path}/messages`, written(3));
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(listed()).toHaveLength(2));
    fireEvent.change(textBox(), { target: { value: "" } });
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(page.bodies()[0]).toMatchObject({
      replaces: 2,
      attachments: [{ keep: "a.log" }, { keep: "b.png" }],
    });
    expect(page.bodies()[0]).not.toHaveProperty("text");
  });

  it("carries the files forward on a change of answers too", async () => {
    await page.openWith([
      message(1, { asks: [ask({ open: false })] }),
      operatorMessage(2, {
        answers: [answerTo({ picks: [0], labels: ["SQLite"] })],
        attachments: [{ name: "why.md", file: ref(1), size: 10, type: "text/markdown" }],
      }),
    ]);
    page.api.on("POST", `${path}/messages`, written(3));
    fireEvent.click(option(2, "Change answer"));
    await waitFor(() => expect(listed()).toEqual(["why.md"]));
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    expect(page.bodies()[0]).toMatchObject({ replaces: 2, attachments: [{ keep: "why.md" }] });
  });

  it("drops the kept files when a stale write finds the message it replaces replaced, keeping new uploads", async () => {
    const state = await withFiles();
    page.serveWrites(state);
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["a.log", "b.png"]));
    choose(file("c.png"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploaded(0, 3);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    // Another device replaced message 2 meanwhile.
    state.messages = [
      ...state.messages.map((each) =>
        each.seq === 2 ? { ...each, live: false, replaced_by: 3 } : each,
      ),
      operatorMessage(3, { text: "Elsewhere", replaces: 2 }),
    ];
    state.thread = { ...state.thread, last_seq: 3, message_count: 3 };
    fireEvent.click(sendButton());
    await within(composer()).findByRole("alert");
    expect(listed()).toEqual(["c.png"]);
    // What is left sends on its own, keeping nothing.
    fireEvent.click(within(composer()).getByRole("button", { name: "Mark these read" }));
    await waitFor(() => expect(within(composer()).queryByRole("alert")).toBeNull());
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({ attachments: [{ upload: ref(3), name: "c.png" }] });
    expect(page.bodies()[1]).not.toHaveProperty("replaces");
  });

  it("keeps the files of an edit staged while a replacement found stale was under way", async () => {
    const state = await page.openWith([
      operatorMessage(1, {
        text: "First",
        attachments: [{ name: "a.log", file: ref(1), size: 10, type: "text/plain" }],
      }),
      operatorMessage(2, {
        text: "Second",
        attachments: [{ name: "b.png", file: ref(2), size: 10, type: "image/png" }],
      }),
    ]);
    let answer: (reply: Reply) => void = () => {};
    page.api.on("POST", `${path}/messages`, () =>
      page.writes().length === 1
        ? new Promise<Reply>((resolve) => (answer = resolve))
        : written(state.thread.last_seq + 1),
    );
    fireEvent.click(option(1, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["a.log"]));
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    // The operator sets that edit aside while it is under way, and edits
    // message 2 instead.
    fireEvent.click(within(composer()).getByRole("button", { name: "Remove" }));
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["b.png"]));
    // Another device replaced message 1 meanwhile, so the first edit is stale.
    const elsewhere = operatorMessage(3, { text: "Elsewhere", replaces: 1 });
    state.messages = [
      ...state.messages.map((each) =>
        each.seq === 1 ? { ...each, live: false, replaced_by: 3 } : each,
      ),
      elsewhere,
    ];
    state.thread = { ...state.thread, last_seq: 3, message_count: 3 };
    answer(
      failure("stale", "other messages landed after the latest one you saw", {
        missed: [elsewhere],
      }),
    );
    await within(composer()).findByRole("alert");
    expect(listed()).toEqual(["b.png"]);
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({ replaces: 2, attachments: [{ keep: "b.png" }] });
  });

  it("drops the files of an edit staged while a replacement was under way, when both messages were replaced", async () => {
    const state = await page.openWith([
      operatorMessage(1, {
        text: "First",
        attachments: [{ name: "a.log", file: ref(1), size: 10, type: "text/plain" }],
      }),
      operatorMessage(2, {
        text: "Second",
        attachments: [{ name: "b.png", file: ref(2), size: 10, type: "image/png" }],
      }),
    ]);
    let answer: (reply: Reply) => void = () => {};
    page.api.on("POST", `${path}/messages`, () =>
      page.writes().length === 1
        ? new Promise<Reply>((resolve) => (answer = resolve))
        : written(state.thread.last_seq + 1),
    );
    fireEvent.click(option(1, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["a.log"]));
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.click(within(composer()).getByRole("button", { name: "Remove" }));
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["b.png"]));
    // Another device replaced both messages meanwhile.
    const elsewhere = [
      operatorMessage(3, { text: "Elsewhere", replaces: 1 }),
      operatorMessage(4, { text: "Elsewhere too", replaces: 2 }),
    ];
    state.messages = [...state.messages, ...elsewhere];
    state.thread = { ...state.thread, last_seq: 4, message_count: 4 };
    answer(
      failure("stale", "other messages landed after the latest one you saw", {
        missed: elsewhere,
      }),
    );
    await within(composer()).findByRole("alert");
    expect(listed()).toEqual([]);
    fireEvent.click(within(composer()).getByRole("button", { name: "Mark these read" }));
    await waitFor(() => expect(within(composer()).queryByRole("alert")).toBeNull());
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({ text: "Second", seen_through: 4 });
    expect(page.bodies()[1]).not.toHaveProperty("replaces");
    expect(page.bodies()[1]).not.toHaveProperty("attachments");
  });

  it("drops the files of an edit of the message a landed write replaced, staged again while it was under way", async () => {
    await withFiles();
    let answer: (reply: Reply) => void = () => {};
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise<Reply>((resolve) => (answer = resolve)),
    );
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["a.log", "b.png"]));
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    // The operator sets the edit aside and starts it again.
    fireEvent.click(within(composer()).getByRole("button", { name: "Remove" }));
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(listed()).toEqual(["a.log", "b.png"]));
    answer(written(3));
    await within(composer()).findByRole("status");
    expect(listed()).toEqual([]);
  });

  it("waits while files are attached, as for any draft", async () => {
    await withFiles();
    choose(file("c.png"));
    expect(option(2, "Edit").disabled).toBe(true);
  });
});
