import type { AttachmentRead, Message, ThreadFile } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { message, operatorMessage, type Reply, threadAnswer } from "../../../test-support.tsx";
import { detailOf, path, ThreadPageTest } from "../thread-test-support.tsx";
import { inlineImageBytes, textPreviewBytes } from "./FileView.tsx";

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
});

const ref = (n: number) => String(n).padStart(22, "A");

function attached(
  name: string,
  type: string,
  overrides: Partial<AttachmentRead> = {},
): AttachmentRead {
  return { name, file: ref(name.length), size: 1000, type, ...overrides };
}

// The URL a file of message 2 is served at, below /api/web.
const served = (name: string, file: string) =>
  `${path}/messages/2/files/${encodeURIComponent(name)}?file=${file}`;

const filesOf = (seq: number) => screen.getByRole("list", { name: `Files of message ${seq}` });
const entryOf = (name: string, seq = 2) =>
  within(filesOf(seq))
    .getAllByRole("listitem")
    .find((item) => item.querySelector(".file-name")?.textContent === name)!;

function openWith(attachments: AttachmentRead[], overrides: Partial<Message> = {}) {
  return page.openWith([
    message(1, { text: "Send them" }),
    message(2, { text: "Here they are", attachments, ...overrides }),
  ]);
}

// serveFile answers a file's read with reply.
function serveFile(name: string, reply: Reply) {
  page.api.on("GET", `${path}/messages/2/files/${encodeURIComponent(name)}`, reply);
}

describe("a message's files", () => {
  it("lists each with its name, type and size, and a Download link to its URL", async () => {
    await openWith([attached("report.bin", "application/zip", { size: 2_500_000 })]);
    const entry = entryOf("report.bin");
    expect(entry.textContent).toContain("application/zip");
    expect(entry.textContent).toContain("2.5 MB");
    const download = within(entry).getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(`/api/web${served("report.bin", ref(10))}`);
    expect(download.getAttribute("download")).toBe("report.bin");
    // Anything else offers Download alone.
    expect(within(entry).getAllByRole("link")).toHaveLength(1);
    expect(within(entry).queryByRole("button")).toBeNull();
  });

  it("shows an image up to the threshold at once, from its own URL, and a larger one on demand", async () => {
    await openWith([
      attached("small.png", "image/png", { size: inlineImageBytes }),
      attached("photo.jpg", "image/jpeg", { size: inlineImageBytes + 1 }),
    ]);
    const small = entryOf("small.png").querySelector("img");
    expect(small?.getAttribute("src")).toBe(`/api/web${served("small.png", ref(9))}`);
    expect(small?.getAttribute("loading")).toBe("lazy");
    expect(small?.getAttribute("alt")).toBe("small.png");
    const photo = entryOf("photo.jpg");
    expect(photo.querySelector("img")).toBeNull();
    const show = within(photo).getByRole("button", { name: "Show image" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    show.focus();
    fireEvent.click(show);
    // The control keeps focus, now Hide.
    expect(document.activeElement).toBe(show);
    expect(show.textContent).toBe("Hide");
    expect(show.getAttribute("aria-expanded")).toBe("true");
    expect(photo.querySelector("img")?.getAttribute("src")).toBe(
      `/api/web${served("photo.jpg", ref(9))}`,
    );
    fireEvent.click(show);
    expect(photo.querySelector("img")).toBeNull();
    expect(document.activeElement).toBe(show);
  });

  it("plays video and audio in their own players, loading nothing until played", async () => {
    await openWith([attached("clip.webm", "video/webm"), attached("note.m4a", "audio/x-m4a")]);
    const video = entryOf("clip.webm").querySelector("video");
    expect(video?.getAttribute("src")).toBe(`/api/web${served("clip.webm", ref(9))}`);
    expect([video?.hasAttribute("controls"), video?.getAttribute("preload")]).toEqual([
      true,
      "none",
    ]);
    const audio = entryOf("note.m4a").querySelector("audio");
    expect([audio?.hasAttribute("controls"), audio?.getAttribute("preload")]).toEqual([
      true,
      "none",
    ]);
  });

  it("reads a text file's start on demand with a range request, decoding it as UTF-8", async () => {
    await openWith([
      attached("build.log", "text/plain", { size: 20 }),
      attached("big.json", "application/json", { size: textPreviewBytes + 1 }),
    ]);
    serveFile("build.log", { status: 206, text: "line one\nline é" });
    const log = entryOf("build.log");
    expect(log.querySelector("pre")).toBeNull();
    const show = within(log).getByRole("button", { name: "Show text" });
    show.focus();
    fireEvent.click(show);
    await waitFor(() => expect(log.querySelector("pre")?.textContent).toBe("line one\nline é"));
    expect(document.activeElement).toBe(show);
    const [read] = page.api.callsTo("GET", `${path}/messages/2/files/build.log`);
    expect(read?.headers.range).toBe(`bytes=0-${textPreviewBytes - 1}`);
    expect(read?.url.searchParams.get("file")).toBe(ref(9));
    expect(log.querySelector(".hint")).toBeNull();
    // A longer file says only its start shows.
    serveFile("big.json", { status: 206, text: "{}" });
    fireEvent.click(within(entryOf("big.json")).getByRole("button", { name: "Show text" }));
    await waitFor(() => expect(entryOf("big.json").querySelector(".hint")).not.toBeNull());
  });

  it("says why a text file could not be read", async () => {
    await openWith([attached("gone.txt", "text/plain")]);
    serveFile("gone.txt", {
      status: 404,
      body: { error: { code: "not_found", message: "this file's contents are missing" } },
    });
    fireEvent.click(within(entryOf("gone.txt")).getByRole("button", { name: "Show text" }));
    const alert = await within(entryOf("gone.txt")).findByRole("alert");
    expect(alert.textContent).toContain("This file's contents are missing.");
  });

  it("opens a PDF in a new tab", async () => {
    await openWith([attached("spec.pdf", "application/pdf")]);
    const open = within(entryOf("spec.pdf")).getByRole("link", { name: "Open" });
    expect(open.getAttribute("href")).toBe(`/api/web${served("spec.pdf", ref(8))}`);
    expect([open.getAttribute("target"), open.getAttribute("rel")]).toEqual(["_blank", "noopener"]);
  });

  it("marks a missing file, with no link or control", async () => {
    await openWith([attached("lost.png", "image/png", { missing: true })]);
    const entry = entryOf("lost.png");
    expect(entry.querySelector(".file-missing")).not.toBeNull();
    expect(entry.textContent).toContain("image/png");
    expect(within(entry).queryAllByRole("link")).toEqual([]);
    expect(within(entry).queryAllByRole("button")).toEqual([]);
    expect(entry.querySelector("img")).toBeNull();
  });

  it("loads every file from its own URL, never a blob: or data: one", async () => {
    await openWith([
      attached("a.png", "image/png"),
      attached("b.webm", "video/webm"),
      attached("c.ogg", "audio/ogg"),
      attached("d.pdf", "application/pdf"),
      attached("e.zip", "application/zip"),
    ]);
    const urls = Array.from(
      filesOf(2).querySelectorAll<HTMLElement>("img, video, audio, a"),
      (element) => element.getAttribute("src") ?? element.getAttribute("href") ?? "",
    );
    expect(urls).toHaveLength(9);
    for (const url of urls) {
      expect(url.startsWith(`/api/web${path}/messages/2/files/`)).toBe(true);
      expect(new URL(url, "https://agention.test").searchParams.get("file")).toMatch(/^A+\d+$/);
    }
  });

  it("reads a message that replaces another carrying only files as a replacement, not a retraction", async () => {
    await page.openWith([
      operatorMessage(1, { text: "First", live: false, replaced_by: 2 }),
      operatorMessage(2, { replaces: 1, attachments: [attached("a.png", "image/png")] }),
    ]);
    expect(screen.getByText("Replaces #1.")).not.toBeNull();
    expect(screen.queryByText(/Retracted/)).toBeNull();
  });
});

describe("links to a message's files", () => {
  const files = [
    attached("build log.txt", "text/plain"),
    attached("shot.png", "image/png", { size: inlineImageBytes + 1 }),
    attached("small.png", "image/png"),
    attached("spec.pdf", "application/pdf"),
    attached("data.zip", "application/zip"),
    attached("Café.png", "image/png"),
    attached("lost.png", "image/png", { missing: true }),
  ];
  const text = [
    "[log](attachment:build%20log.txt)",
    "[log again](<attachment:build log.txt>)",
    "[shot](attachment:shot.png)",
    "[small](attachment:small.png)",
    "[spec](attachment:spec.pdf)",
    "[data](attachment:data.zip)",
    "[cafe](attachment:Caf%C3%A9.png)",
    "![drawn](attachment:shot.png)",
    "[other](attachment:other.png)",
    "[lost](attachment:lost.png)",
    "[bad](attachment:%E0%A4%A)",
  ].join("\n\n");

  const body = () =>
    screen.getByRole("article", { name: /^Message 2 / }).querySelector(".markdown")!;
  const linkTo = (name: string) => within(body() as HTMLElement).queryByRole("link", { name });

  it("are live for the message's own files, by name decoded and normalized, and text otherwise", async () => {
    await openWith(files, { text });
    for (const name of ["log", "log again", "shot", "small", "spec", "data", "cafe", "drawn"]) {
      expect(linkTo(name)).not.toBeNull();
    }
    expect(linkTo("log")?.getAttribute("href")).toBe(`/api/web${served("build log.txt", ref(13))}`);
    for (const name of ["other", "lost", "bad"]) {
      expect(linkTo(name)).toBeNull();
      expect(body().textContent).toContain(name);
    }
    // A Markdown image with one is a link: it never loads.
    expect(body().querySelector("img")).toBeNull();
    expect([linkTo("spec")?.getAttribute("target"), linkTo("spec")?.getAttribute("rel")]).toEqual([
      "_blank",
      "noopener",
    ]);
    expect(linkTo("data")?.getAttribute("download")).toBe("data.zip");
  });

  it("open a file in place in the list and move focus to its entry", async () => {
    await openWith(files, { text });
    serveFile("build log.txt", { status: 206, text: "hello" });
    fireEvent.click(linkTo("log")!);
    let focused: Element | null | undefined;
    await waitFor(() => {
      expect(entryOf("build log.txt").querySelector("pre")).not.toBeNull();
      focused ??= document.activeElement;
    });
    expect(focused).toBe(entryOf("build log.txt"));
    fireEvent.click(linkTo("drawn")!);
    expect(document.activeElement).toBe(entryOf("shot.png"));
    expect(entryOf("shot.png").querySelector("img")).not.toBeNull();
    // A file shown already takes focus alone.
    fireEvent.click(linkTo("small")!);
    expect(document.activeElement).toBe(entryOf("small.png"));
  });

  it("work in a message's detail too", async () => {
    await openWith(files, { detail: "[spec](attachment:spec.pdf)" });
    fireEvent.click(detailOf(2));
    const detail = screen
      .getByRole("article", { name: /^Message 2 / })
      .querySelector(".detail-body");
    expect(
      within(detail as HTMLElement)
        .getByRole("link", { name: "spec" })
        .getAttribute("href"),
    ).toBe(`/api/web${served("spec.pdf", ref(8))}`);
  });

  it("never reach another message's files", async () => {
    await page.openWith([
      message(1, { attachments: [attached("one.png", "image/png")] }),
      message(2, { text: "[one](attachment:one.png)" }),
    ]);
    expect(screen.queryByRole("link", { name: "one" })).toBeNull();
  });
});

describe("the thread's files", () => {
  function threadFile(seq: number, name: string, overrides: Partial<ThreadFile> = {}): ThreadFile {
    return {
      seq,
      name,
      file: ref(seq),
      size: 1000,
      type: "image/png",
      author: { kind: "session", agent: "builder", session: "main" },
      created_at: "2026-10-27T12:00:00.000Z",
      ...overrides,
    };
  }

  // The thread's file totals, as its answer gives them.
  let totals = { count: 0, bytes: 0 };

  function openWithTotals(count: number, bytes: number) {
    totals = { count, bytes };
    const plain = page.threadReply.bind(page);
    page.threadReply = (state, call) => {
      const reply = plain(state, call);
      return { body: { ...(reply.body as ReturnType<typeof threadAnswer>), files: totals } };
    };
    return page.openWith([message(1, { text: "One" }), message(2, { text: "Two" })]);
  }

  const fold = () => screen.queryByRole("button", { name: /^Files \(/ });

  it("show nothing for a thread without files", async () => {
    await openWithTotals(0, 0);
    expect(fold()).toBeNull();
  });

  it("fold under the head with their count and size, and list nothing until unfolded", async () => {
    await openWithTotals(12, 340e6);
    const button = screen.getByRole("button", { name: "Files (12, 340 MB)" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(page.api.callsTo("GET", `${path}/files`)).toEqual([]);
  });

  it("list each file with who attached it, when, a link to its message and Download, a page at a time", async () => {
    await openWithTotals(51, 51_000);
    const first = Array.from({ length: 50 }, (_, index) => threadFile(2, `f${index}.png`));
    page.api.on("GET", `${path}/files`, (call) =>
      call.url.searchParams.get("cursor") === "next-1"
        ? { body: { files: [threadFile(1, "first.png", { missing: true })] } }
        : { body: { files: first, next: "next-1" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^Files \(51,/ }));
    const list = await screen.findByRole("region", { name: "Files" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(50));
    const [read] = page.api.callsTo("GET", `${path}/files`);
    expect(read?.url.searchParams.get("limit")).toBe("50");
    const entry = within(list).getAllByRole("listitem")[0]!;
    expect(entry.textContent).toContain("builder/main");
    expect(entry.querySelector("time")).not.toBeNull();
    expect(within(entry).getByRole("link", { name: "#2" }).getAttribute("href")).toBe("#message-2");
    expect(within(entry).getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
      `/api/web${path}/messages/2/files/f0.png?file=${ref(2)}`,
    );
    fireEvent.click(within(list).getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(51));
    const missing = within(list).getAllByRole("listitem").at(-1)!;
    expect(missing.querySelector(".file-missing")).not.toBeNull();
    expect(within(missing).queryByRole("link", { name: "Download" })).toBeNull();
    // A message's link moves focus to the message.
    fireEvent.click(within(missing).getByRole("link", { name: "#1" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("article", { name: /^Message 1 / })),
    );
  });

  it("read the list again as the thread's files change while it is open", async () => {
    await openWithTotals(1, 1000);
    page.api.on("GET", `${path}/files`, { body: { files: [threadFile(2, "a.png")] } });
    fireEvent.click(screen.getByRole("button", { name: /^Files \(1,/ }));
    await waitFor(() => expect(page.api.callsTo("GET", `${path}/files`)).toHaveLength(1));
    totals = { count: 2, bytes: 2000 };
    window.dispatchEvent(new Event("focus"));
    await screen.findByRole("button", { name: /^Files \(2,/ });
    await waitFor(() => expect(page.api.callsTo("GET", `${path}/files`).length).toBeGreaterThan(1));
  });
});
