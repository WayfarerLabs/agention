// cspell:ignore filechooser
// Attachments in Chromium against the real server, on a server of these
// tests' own: an agent's files shown in place, an image, a video and audio
// played and text read, a PDF opened in its tab and a missing file marked; every file
// downloading under its name; the operator attaching a file and pasting an
// image, which the agent reads, and the thread's files folded in its head;
// and bytes of HTML and script declared as each type shown, opened on their
// own, running nothing.
import type { BrowserContext, Page } from "@playwright/test";
import type { ThreadGetResult, WriteResult } from "@wayfarerlabs/agention-api";
import type { Agent } from "./agent.ts";
import { pdf, png, removeContents, signIn, threads, upload, webm } from "./files.ts";
import { type Agention, expect, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let agent: Agent;
let server: Agention;
const problems: string[] = [];

const log = "step 1: built\nstep 2: tested\nstep 3: shipped ✓\n";

// The agent's files on thread 1's first message, by name.
const files = ["shot.png", "clip.webm", "tone.webm", "build.log", "spec.pdf", "lost.png"];

const message = (seq: number) =>
  page.getByRole("article", { name: new RegExp(`^Message ${seq} `) });
const filesOf = (seq: number) => page.getByRole("list", { name: `Files of message ${seq}` });
const entry = (seq: number, name: string) =>
  filesOf(seq)
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });

test.beforeAll(async ({ browser, filesServer }) => {
  server = filesServer;
  ({ context, page, agent } = await signIn(browser, server));
  page.on("console", (each) => {
    if (each.type() === "error") {
      problems.push(each.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));

  const video = await webm(page);
  const sound = await webm(page, "audio");
  const refs = {
    "shot.png": await upload(agent, "shot.png", png(320, 180), "image/png"),
    "clip.webm": await upload(agent, "clip.webm", video, "video/webm"),
    "tone.webm": await upload(agent, "tone.webm", sound, "audio/webm"),
    "build.log": await upload(agent, "build.log", Buffer.from(log), "text/plain"),
    "spec.pdf": await upload(agent, "spec.pdf", pdf(), "application/pdf"),
    "lost.png": await upload(agent, "lost.png", png(16, 16), "image/png"),
  };
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "files-1",
    title: "Files to look at",
    text: "The run, and [its log](attachment:build.log).",
    attachments: files.map((name) => ({ upload: refs[name as keyof typeof refs] })),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  removeContents(server, refs["lost.png"]);
});

test.afterAll(async () => {
  await context.close();
});

test("a message shows its image, video, audio and text in place, opens its PDF in a tab, and marks a missing file", async () => {
  await page.goto(`${threads}/1`);
  await expect(filesOf(1).getByRole("listitem")).toHaveCount(files.length);

  // The image is drawn from its own URL.
  const image = entry(1, "shot.png").getByRole("img", { name: "shot.png" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(320);

  // The video loads nothing until played, then plays in the page.
  const video = entry(1, "clip.webm").locator("video");
  expect(await video.evaluate((element: HTMLVideoElement) => element.readyState)).toBe(0);
  await video.evaluate((element: HTMLVideoElement) => {
    element.muted = true;
    return element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0);

  // So does the audio, in its player.
  const audio = entry(1, "tone.webm").locator("audio");
  expect(await audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBe(0);
  await audio.evaluate((element: HTMLAudioElement) => {
    element.muted = true;
    return element.play();
  });
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(0);

  // The text's link shows it in place, and moves focus to it.
  await message(1).getByRole("link", { name: "its log" }).click();
  await expect(entry(1, "build.log").locator("pre")).toHaveText(log);
  await expect(entry(1, "build.log")).toBeFocused();

  // The PDF opens in a tab of its own, which navigates to its own URL.
  const opened = context.waitForEvent("page");
  const navigated = context.waitForEvent(
    "request",
    (request) => request.isNavigationRequest() && request.url().includes("/files/spec.pdf"),
  );
  await entry(1, "spec.pdf").getByRole("link", { name: "Open spec.pdf" }).click();
  const tab = await opened;
  const request = await navigated;
  expect(request.frame().page()).toBe(tab);
  expect(new URL(request.url()).pathname).toBe(`/api/web${threads}/1/messages/1/files/spec.pdf`);
  await tab.close();

  // The missing file is marked, with nothing to open or download.
  const lost = entry(1, "lost.png");
  await expect(lost.locator(".file-missing")).toBeVisible();
  await expect(lost.getByRole("link")).toHaveCount(0);
  await expect(lost.getByRole("img")).toHaveCount(0);
});

test("every file present downloads under its name", async () => {
  for (const name of files.filter((each) => each !== "lost.png")) {
    const downloaded = page.waitForEvent("download");
    await entry(1, name)
      .getByRole("link", { name: `Download ${name}` })
      .click();
    expect((await downloaded).suggestedFilename()).toBe(name);
  }
});

test("the operator attaches a file and pastes an image, which arrive with the message and in the thread's files", async () => {
  await page.goto(`${threads}/1`);
  const composer = page.getByRole("region", { name: "Reply" });
  // The picker shows only as Attach.
  await expect(composer.locator('input[type="file"]')).toBeHidden();
  const chooser = page.waitForEvent("filechooser");
  await composer.getByRole("button", { name: "Attach files" }).click();
  await (
    await chooser
  ).setFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Notes from the operator.\n"),
  });
  // A screenshot pasted attaches; a paste carrying text beside its picture
  // stays text.
  const box = composer.getByRole("textbox", { name: "Message" });
  const pasted = png(200, 120).toString("base64");
  for (const withText of [false, true]) {
    await box.evaluate(
      (element, { image, withText }) => {
        const bytes = Uint8Array.from(atob(image), (each) => each.charCodeAt(0));
        const data = new DataTransfer();
        if (withText) {
          data.setData("text/plain", "A1\tB1");
        }
        data.items.add(new File([bytes], "image.png", { type: "image/png" }));
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      },
      { image: pasted, withText },
    );
  }
  const attached = composer.getByRole("list", { name: "Files to send" }).getByRole("listitem");
  await expect(attached).toHaveCount(2);
  await expect(attached.getByText("Uploaded")).toHaveCount(2);
  await box.fill("Here is what I have.");
  // The page stays open after sending, to show what was sent.
  await composer.getByRole("checkbox", { name: "Go back after sending" }).uncheck();
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(filesOf(2).getByRole("listitem")).toHaveCount(2);
  const image = filesOf(2).getByRole("img");
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(200);
  // The agent reads both.
  const read = await agent.send<ThreadGetResult>("GET", `${threads}/1`);
  const names = read.body.messages
    .find((each) => each.seq === 2)
    ?.attachments?.map((each) => each.name);
  expect(names?.[0]).toBe("notes.txt");
  expect(names?.[1]).toMatch(/^pasted-\d{8}-\d{6}\.png$/);
  expect(read.body.files.count).toBe(files.length + 2);

  // The thread's head folds its files, which list once unfolded, each
  // linking to its message.
  await page.reload();
  const held = files.length + 2;
  const fold = page.getByRole("button", { name: new RegExp(`^Files \\(${held}, `) });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  const listed = page.getByRole("region", { name: "Files" }).getByRole("listitem");
  await expect(listed).toHaveCount(held);
  await listed.filter({ hasText: "shot.png" }).getByRole("link", { name: "#1" }).click();
  await expect(message(1)).toBeFocused();
});

test("bytes of HTML and script, declared as each type, run nothing in the page or on their own", async () => {
  const html = Buffer.from(
    '<!doctype html><title>file</title><script>document.title = "ran"; fetch("/ran")</script>' +
      '<img src="/ran-image">',
  );
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<script>document.title = "ran"</script><image href="/ran-image"/></svg>',
  );
  // Each declared type, the type it is served as and its disposition.
  const cases = [
    {
      name: "page.html",
      bytes: html,
      type: "text/html",
      served: "text/plain; charset=utf-8",
      inline: true,
    },
    { name: "page-image.png", bytes: html, type: "image/png", served: "image/png", inline: true },
    {
      name: "page.pdf",
      bytes: html,
      type: "application/pdf",
      served: "application/pdf",
      inline: true,
    },
    { name: "page.webm", bytes: html, type: "video/webm", served: "video/webm", inline: true },
    {
      name: "page.xhtml",
      bytes: html,
      type: "application/xhtml+xml",
      served: "application/octet-stream",
      inline: false,
    },
    {
      name: "drawing.svg",
      bytes: svg,
      type: "image/svg+xml",
      served: "image/svg+xml",
      inline: false,
    },
  ];
  const refs: string[] = [];
  for (const each of cases) {
    refs.push(await upload(agent, each.name, each.bytes, each.type));
  }
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "files-2",
    title: "Hostile files",
    text: "Nothing here should run.",
    attachments: refs.map((ref) => ({ upload: ref })),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const thread = created.body.number;

  const ran: string[] = [];
  context.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/ran")) {
      ran.push(request.url());
    }
  });

  // In the page: shown as it is served, text as text.
  await page.goto(`${threads}/${thread}`);
  await expect(filesOf(1).getByRole("listitem")).toHaveCount(cases.length);
  await entry(1, "page.html").getByRole("button", { name: "Show text" }).click();
  await expect(entry(1, "page.html").locator("pre")).toHaveText(html.toString());
  await expect(entry(1, "drawing.svg").getByRole("img")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.title()).not.toBe("ran");

  for (const [index, each] of cases.entries()) {
    const url = `/api/web${threads}/${thread}/messages/1/files/${encodeURIComponent(each.name)}?file=${refs[index]}`;
    // The headers every file response carries, read by the page, which
    // shares the browser's resolution of the server's name and its sign-in.
    const { status, headers } = await page.evaluate(async (target) => {
      const response = await fetch(target);
      return { status: response.status, headers: Object.fromEntries(response.headers) };
    }, url);
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe(each.served);
    expect(headers["content-disposition"]).toMatch(each.inline ? /^inline;/ : /^attachment;/);
    expect(headers["content-security-policy"]).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");

    // Opened on its own, it runs nothing, or it downloads.
    const alone = await context.newPage();
    const downloaded = alone.waitForEvent("download", { timeout: 5_000 }).catch(() => undefined);
    await alone.goto(url).catch(() => undefined);
    if (!each.inline) {
      expect(await downloaded).toBeDefined();
    }
    await alone.waitForTimeout(300);
    expect(await alone.title().catch(() => "")).not.toBe("ran");
    await alone.close();
  }
  expect(ran).toEqual([]);
});

test("the pages ran without a console error or a page error", () => {
  expect(problems).toEqual([]);
});
