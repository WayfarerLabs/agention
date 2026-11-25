// cspell:ignore filechooser
// The web UI in Chromium against the real server: the server's name in the
// banner and titles, linking the first passkey, approving an agent and the
// Sessions tab's count of registrations waiting, their section a line once
// none waits, at a phone's width too, answering its asks, a
// message's detail folded under its text and the message copied with it,
// the composer's Details box, a stale write, a draft kept across the
// Sessions tab and a reload until discarded,
// Send kept on a short phone's screen, text written to take the page down,
// the divider after messages archived and unfolded, at a phone's width too,
// reading and marking unread from a message and the Threads tab's
// count of unread threads, archiving, the list's filters, their counts, its
// search box, fitting beside a thread and on a phone, with its text still
// pending dropped when a thread's link replaces the list, its order, the
// order's direction and grouping, moving through the list, opening
// a thread and returning from the keyboard, the list and the thread side by
// side at a desktop's width and one at a time on a phone, the threads above
// and below and where archiving goes, alike in both, an ask the agent withdraws and the
// way back under the composer, the sessions view with a session's status and
// log, at a phone's width too, a thread the operator starts there with a file
// and stranded's reason, a session's options menu over the next agent's header and
// the picker it opens beside it on a wide screen and as a sheet on a phone,
// the sessions view folded by group, a group created and tags picked in the
// pickers, its headers folding by a click on their bars but for their chips,
// which link to their threads, as a group's, a tag's and the stranded threads'
// do, and a tag as tall in a header as in a row, at a phone's width too, its
// groups moved in their manual order and its grouping and sort chosen, kept
// in the address through a reload and Back, the
// last session's options menu over the folds below it, grouped or not,
// Settings' groups ordered by their buttons and by dragging, signing out from
// Settings and in again, a second passkey that takes
// over from the first in Settings' passkeys, which /passkeys leads to, and a
// second server on another port of the host signed in beside the first. CDP
// virtual authenticators stand in for the operator's devices; one page carries
// through the steps, in order.
import type {
  BrowserContext,
  CDPSession,
  Locator,
  Page,
  Request,
  Response,
} from "@playwright/test";
import type {
  PublicKey,
  RegistrationState,
  SessionStatus,
  ThreadGetResult,
  WriteResult,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-server-api/registration-code";
import { Agent } from "./agent.ts";
import { expect, hostName, resize, secondServerName, serverName, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let cdp: CDPSession;
// The device that holds the operator's passkey.
let device: string;
let agent: Agent;
const consoleMessages: string[] = [];
const requestedHosts = new Set<string>();

test.beforeAll(async ({ browser, agention }) => {
  context = await browser.newContext({ baseURL: agention.origin });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: agention.origin,
  });
  page = await context.newPage();
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("pageerror", (error) => consoleMessages.push(`page error: ${error.message}`));
  page.on("request", (request) => requestedHosts.add(new URL(request.url()).host));
  cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  device = await newDevice();
  agent = new Agent(agention);
});

// newDevice adds a virtual platform authenticator that verifies the user.
async function newDevice(): Promise<string> {
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

test.afterAll(async () => {
  await context.close();
});

// The hand check's thread: a title holding Markdown syntax, and a first
// message with every construct the renderer must handle.
const title = "Ship **v2** `now`?";
const text = [
  "```",
  "npm run build",
  "```",
  "",
  "| Check | Result |",
  "| --- | --- |",
  "| tests | pass |",
  "",
  "- [x] built",
  "- [ ] deployed",
  "",
  "~~Friday~~ Today.",
  "",
  "See [the pull request](https://example.com/pull/7) or [the old notes](http://example.com/notes).",
  "",
  "<b>not bold</b>",
  "",
  "![deploy graph](https://images.example/graph.png)",
].join("\n");
// Its detail, the long form folded under the text.
const detail = ["## Rollback plan", "", "Revert the tag and redeploy the previous build."].join(
  "\n",
);

const threads = "/s/builder/main/threads";

// The navigation's tabs, each named by its label and then its count, while
// it shows one, such as "Threads 1 unread thread".
const tab = (label: string) =>
  page.getByRole("navigation", { name: "Views" }).getByRole("link", {
    name: new RegExp(`^${label}`),
  });

const showList = () => tab("Threads").click();
// Settings' navigation of its sections.
const settings = () => page.getByRole("navigation", { name: "Settings" });

test("a passkey link registers the first operator", async ({ agention }) => {
  const link = agention.passkeyLink();
  expect(link.startsWith(`${agention.origin}/link#token=`)).toBe(true);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Register a passkey" })).toBeVisible();
  // The server's name, as the server wrote it into the page, brands the
  // banner and follows each page's own name in its title.
  await expect(page.getByRole("banner").getByRole("link").first()).toHaveText(serverName);
  await expect(page).toHaveTitle(`Register a passkey · ${serverName}`);
  // The token is read once and removed from the address bar.
  expect(new URL(page.url()).hash).toBe("");
  await page.getByLabel("Passkey name").fill("Laptop");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  await expect(page).toHaveTitle(`Threads · ${serverName}`);
  // The list loads and holds no thread.
  await expect(page.getByRole("region", { name: "Thread list" }).locator(".empty")).toBeVisible();
});

test("the operator approves an agent's registration by its code", async () => {
  const submitted = await agent.send<RegistrationState>("POST", "/registrations", {
    agent: "builder",
    session: "main",
  });
  expect(submitted.body.status).toBe("pending");
  // The code the agent relays is the one it computes from its own key.
  const code = registrationCode(agent.publicKey as PublicKey);
  expect(submitted.body.code).toBe(code);

  // Going to the sessions view, its tab counts the registration waiting,
  // until it is approved.
  await tab("Sessions").click();
  await expect(tab("Sessions")).toHaveAccessibleName(/^Sessions\s*1\b/);
  const card = page.getByRole("article", { name: `Registration ${code}` });
  await expect(card.getByText(code, { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Approve" }).click();
  // The registration leaves the waiting list, approved, among the past
  // requests folded under the session that now stands under its agent.
  await expect(
    page.getByRole("region", { name: "Waiting for approval" }).getByRole("article"),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Agent builder/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Session main" })).toBeVisible();
  await expect(tab("Sessions")).toHaveAccessibleName("Sessions");
  // With none waiting, the section takes one line on the narrowest phone,
  // in whatever font the machine running the tests has for the system's,
  // and in Arial. The widest of them is DejaVu Sans, the usual system font
  // on Linux, which sets the limit on the line's words.
  const wide = page.viewportSize();
  const waiting = page.getByRole("region", { name: "Waiting for approval" });
  await resize(page, { width: 320, height: 844 });
  for (const font of [undefined, "Arial"]) {
    const { height, line } = await waiting.evaluate((section, family) => {
      const root = document.documentElement.style;
      if (family === undefined) {
        root.removeProperty("--font-body");
      } else {
        root.setProperty("--font-body", family);
      }
      return {
        height: section.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(section.querySelector("p") as Element).lineHeight),
      };
    }, font);
    expect(height).toBeLessThanOrEqual(line);
  }
  await page.evaluate(() => document.documentElement.style.removeProperty("--font-body"));
  if (wide !== null) {
    await resize(page, wide);
  }
  await page.getByRole("button", { name: "Credentials and past requests" }).click();
  await expect(card.locator(".state")).toHaveText("approved");

  const state = await agent.send<RegistrationState>("POST", "/registrations", {
    agent: "builder",
    session: "main",
  });
  expect(state.body).toMatchObject({ status: "approved", agent: "builder", session: "main" });
});

test("the operator answers two asks in one message, and the agent reads the answers", async () => {
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "create-1",
    title,
    text,
    detail,
    asks: [
      {
        question: "Ship it today?",
        suggestions: [{ label: "Ship it" }, { label: "Hold" }],
        impact: "blocking",
        priority: "high",
      },
      { question: "Tag the release?", suggestions: [{ label: "Tag it" }, { label: "Skip" }] },
    ],
  });
  expect(created.body).toEqual({ number: 1, seq: 1 });

  await showList();
  await page.getByRole("heading", { name: `#1 ${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`#1 ${title}`);

  // The Markdown hand check: formatting renders, only the https link is live,
  // the tag shows literally, and the image is a link the browser never loads.
  const first = page.getByRole("article", { name: "Message 1 by builder/main" });
  await expect(first.locator("pre code")).toHaveText("npm run build");
  await expect(first.locator("td")).toHaveText(["tests", "pass"]);
  await expect(first.locator("li.task input")).toHaveCount(2);
  for (const box of await first.locator("li.task input").all()) {
    await expect(box).toBeDisabled();
  }
  await expect(first.locator("del")).toHaveText("Friday");
  await expect(first.getByRole("link")).toHaveText(["the pull request", "deploy graph"]);
  await expect(first.getByRole("link", { name: "the pull request" })).toHaveAttribute(
    "href",
    "https://example.com/pull/7",
  );
  await expect(first.getByText("the old notes")).toBeVisible();
  await expect(first.getByText("<b>not bold</b>")).toBeVisible();
  expect(requestedHosts.has("images.example")).toBe(false);

  // The detail folds into one line under the text, which opens and folds it
  // in place from the keyboard.
  const details = first.getByRole("button", { name: "Details of message 1" });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(first.getByRole("heading", { name: "Rollback plan" })).toHaveCount(0);
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(first.getByRole("heading", { name: "Rollback plan" })).toBeVisible();
  // Copy, beside the message's options, copies its Markdown as written, with
  // the detail while it is open.
  await first.getByRole("button", { name: "Copy message 1" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${text}\n\n${detail}`);
  await details.focus();
  await page.keyboard.press("Space");
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(first.getByRole("heading", { name: "Rollback plan" })).toHaveCount(0);

  // Each answer is written on its ask's card, which leads with the ask's
  // number: a radio button for each suggested answer, and Other for the
  // operator's own words, written in Notes, which also go beside a pick.
  // Both answers go in one message, beside which the box holds additional
  // information.
  const ask = page.getByRole("region", { name: "Ask 1: Ship it today?" });
  const tag = page.getByRole("region", { name: "Ask 2: Tag the release?" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await ask.getByRole("radio", { name: "Hold" }).check();
  await ask.getByRole("radio", { name: "Other" }).check();
  await expect(ask.getByRole("radio", { name: "Hold" })).not.toBeChecked();
  await expect(send).toBeDisabled();
  await ask.getByRole("textbox", { name: "Notes" }).fill("Hold until Monday.");
  await tag.getByRole("radio", { name: "Skip" }).check();
  await tag.getByRole("textbox", { name: "Notes" }).fill("Tag with the next one.");
  const reply = page.getByRole("region", { name: "Reply" });
  await reply.getByRole("textbox").fill("Notes are late.");
  // The Details box folds under the message box until opened.
  await reply.getByRole("button", { name: "Details", exact: true }).click();
  await reply.getByRole("textbox", { name: "Details" }).fill("The changelog is in **review**.");
  // Sending goes back to the list unless the operator chooses otherwise.
  await expect(reply.getByRole("combobox", { name: "After sending" })).toHaveValue("list");
  await send.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  // The list says what was sent.
  await expect(page.getByRole("status")).not.toBeEmpty();
  await page.getByRole("heading", { name: `#1 ${title}`, exact: true }).click();
  await expect(ask.getByText("Hold until Monday.")).toBeVisible();
  const answered = page.getByRole("article", { name: /^Message 2 by/ });
  await expect(answered.locator(".event")).toHaveCount(2);
  await expect(answered.locator(".event").first()).toContainText("Other");
  await expect(answered.locator(".event").last()).toContainText("Skip");
  await expect(answered.locator(".event").last()).not.toContainText("Other");
  await expect(tag.getByText("Tag with the next one.")).toBeVisible();

  const read = await agent.send<ThreadGetResult>("GET", `${threads}/1`);
  expect(read.body.thread.title).toBe(title);
  expect(read.body.messages[0]).toMatchObject({ text, detail });
  expect(read.body.messages.at(-1)).toMatchObject({
    author: { kind: "person", name: "operator" },
    text: "Notes are late.",
    detail: "The changelog is in **review**.",
    answers: [
      { ask: 1, declined: false, text: "Hold until Monday." },
      { ask: 2, declined: false, picks: [1], labels: ["Skip"], text: "Tag with the next one." },
    ],
  });
});

test("a write the agent overtakes keeps the draft and sends after one action", async () => {
  // Staying on the page after sending is a choice this browser keeps.
  const after = page
    .getByRole("region", { name: "Reply" })
    .getByRole("combobox", { name: "After sending" });
  await after.selectOption("stay");
  await page.reload();
  await expect(after).toHaveValue("stay");
  const draft = "Thanks; holding until Monday.";
  await page.getByLabel("Message", { exact: true }).fill(draft);

  const before = await agent.send<ThreadGetResult>("GET", `${threads}/1`);
  const overtaking = await agent.send<WriteResult>("POST", `${threads}/1/messages`, {
    request_id: "agent-note-1",
    seen_through: before.body.thread.last_seq,
    text: "Holding the release.",
  });
  expect(overtaking.status).toBe(200);

  await page.getByRole("button", { name: "Send", exact: true }).click();
  const stale = page.getByRole("alert").filter({ hasText: "added while you were writing" });
  await expect(stale.getByText("Holding the release.")).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(draft);
  await stale.getByRole("button", { name: "Mark these read and send again" }).click();
  await expect(stale).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Reply" }).getByRole("status")).toBeVisible();

  const read = await agent.send<ThreadGetResult>("GET", `${threads}/1`);
  expect(read.body.messages.at(-1)).toMatchObject({ author: { kind: "person" }, text: draft });
  expect(read.body.cursors.audience).toBe(read.body.thread.last_seq);
});

test("a draft comes back after the Sessions tab and a reload, until Discard draft forgets it", async () => {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("Half a reply");
  await tab("Sessions").click();
  await expect(page).toHaveURL(/\/sessions$/);
  await page.goBack();
  await expect(box).toHaveValue("Half a reply");
  await page.reload();
  await expect(box).toHaveValue("Half a reply");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(box).toHaveValue("");
  await page.reload();
  await expect(box).toHaveValue("");
});

test("Send stays on a short phone's screen while the message box is at its foot, within the composer", async () => {
  const wide = page.viewportSize();
  await resize(page, { width: 390, height: 500 });
  // The thread, side by side at the width before, shows alone.
  await expect(page.getByRole("region", { name: "Thread list" })).toHaveCount(0);
  const box = page.getByLabel("Message", { exact: true });
  const send = page.getByRole("button", { name: "Send", exact: true });
  const row = page.locator(".composer .actions");
  const boxOf = async (what: Locator) => {
    const box_ = await what.boundingBox();
    expect(box_).not.toBeNull();
    return box_ ?? { x: 0, y: 0, width: 0, height: 0 };
  };
  // The box focused at the foot of the screen, as a phone's keyboard leaves
  // it once the page shrinks for it: Send, below it, stays on screen.
  await box.focus();
  await box.evaluate((element) => element.scrollIntoView({ block: "end" }));
  const shown = await boxOf(send);
  expect(shown.y).toBeGreaterThanOrEqual(0);
  expect(shown.y + shown.height).toBeLessThanOrEqual(500);
  // What is typed stays above the row: the page scrolls the box clear of it.
  for (const line of ["One", "Two", "Three", "Four", "Five"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  const typed = await boxOf(box);
  expect(typed.y + typed.height).toBeLessThanOrEqual((await boxOf(row)).y + 1);
  // A control focused from the keyboard below the box is not under it either.
  await page.keyboard.press("Tab");
  const covered = await page.evaluate(() => {
    const focused = document.activeElement as HTMLElement;
    const at = focused.getBoundingClientRect();
    const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
    return [focused.textContent, hit !== null && focused.contains(hit)];
  });
  expect(covered[1], `${covered[0]} is covered`).toBe(true);
  // A send that fails says so beside Send, on screen.
  await page.route("**/threads/1/messages", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 500 }) : route.fallback(),
  );
  await send.click();
  const failed = page.locator(".composer .actions").getByRole("alert");
  await expect(failed).toBeVisible();
  const notice = await boxOf(failed);
  expect(notice.y).toBeGreaterThanOrEqual(0);
  expect(notice.y + notice.height).toBeLessThanOrEqual(500);
  await page.unroute("**/threads/1/messages");
  await box.fill("");
  // It never lies over the messages: at the top of the thread it stays in
  // the composer, below its heading.
  await page.evaluate(() => window.scrollTo(0, 0));
  const heading = await boxOf(page.getByRole("heading", { name: "Reply" }));
  expect((await boxOf(send)).y).toBeGreaterThanOrEqual(heading.y + heading.height);
  // At the composer's end, the thread's bar follows it, out of its row.
  const back = page
    .getByRole("region", { name: "Thread actions" })
    .getByRole("link", { name: "Back to threads" });
  await back.scrollIntoViewIfNeeded();
  const bar = await boxOf(row);
  expect((await boxOf(back)).y).toBeGreaterThanOrEqual(bar.y + bar.height);
  if (wide !== null) {
    await resize(page, wide);
  }
  await expect(page.getByRole("region", { name: "Thread list" })).toBeVisible();
});

test("text written to take the page down shows as text, and the page stays up", async () => {
  // A text whose one line opens hundreds of block quotes, and a detail nested
  // a thousand emphases deep.
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "create-deep",
    title: "Deep text",
    text: `${">".repeat(980)} quoted too deep`,
  });
  expect(created.body).toEqual({ number: 2, seq: 1 });
  const deep = await agent.send<WriteResult>("POST", `${threads}/2/messages`, {
    request_id: "deep-message",
    seen_through: 1,
    text: "Nested emphasis.",
    detail: `${"*".repeat(1000)}emphasized too deep${"*".repeat(1000)}`,
  });
  expect(deep.status).toBe(200);

  await page.goto(`${threads}/2`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("#2 Deep text");
  const first = page.getByRole("article", { name: "Message 1 by builder/main" });
  await expect(first.locator(".plain")).toContainText("quoted too deep");
  await expect(first.locator("blockquote")).toHaveCount(0);
  await page.getByRole("button", { name: "Details of message 2" }).click();
  await expect(page.getByText("emphasized too deep")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reply" })).toBeVisible();
  await expect(tab("Threads")).toBeVisible();
});

test("archiving through a message sets the later ones apart by a divider once unfolded, at a phone's width too", async () => {
  // Deep text, open from the step before, archived through its first message.
  await page.getByRole("button", { name: "Options for message 1" }).click();
  await page.getByRole("button", { name: "Archive through here" }).click();
  const fold = page.getByRole("button", { name: /archived message/ });
  await expect(fold).toBeFocused();
  const divider = page.getByRole("region", { name: "Messages" }).getByRole("separator");
  const first = page.getByRole("article", { name: "Message 1 by builder/main" });
  const second = page.getByRole("article", { name: "Message 2 by builder/main" });
  // between checks that the one divider, named, lies between the archived
  // message and the next, within the screen's width. It measures all three at
  // once, and again until they agree, since a change of width moves the page
  // as it settles.
  const between = async () => {
    await expect(divider).toHaveCount(1);
    await expect(divider).toHaveAccessibleName(/\S/);
    const width = page.viewportSize()?.width ?? 0;
    await expect
      .poll(async () => {
        const rect = (what: Locator) =>
          what.evaluate((element) => {
            const { x, y, width: across, height } = element.getBoundingClientRect();
            return { x, y, across, height };
          });
        const [line, above, below] = await Promise.all([rect(divider), rect(first), rect(second)]);
        return (
          line.y >= above.y + above.height &&
          line.y + line.height <= below.y &&
          line.x >= 0 &&
          line.x + line.across <= width
        );
      })
      .toBe(true);
  };
  // Folded, the fold alone marks where the archived messages end.
  await expect(divider).toHaveCount(0);
  await fold.click();
  await between();
  const wide = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await between();
  await fold.click();
  await expect(divider).toHaveCount(0);
  if (wide !== null) {
    await page.setViewportSize(wide);
  }
});

test("opening a thread reads it, and marking it unread from a message returns it to the list", async () => {
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "create-notes",
    title: "Release notes are up",
    text: "In the usual place.",
  });
  expect(created.body).toEqual({ number: 3, seq: 1 });

  // The Threads tab counts the one thread unread, until it is read.
  await showList();
  await expect(tab("Threads")).toHaveAccessibleName(/^Threads\s*1\b/);
  await page.getByRole("heading", { name: "Release notes are up" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("#3 Release notes are up");
  await expect
    .poll(async () => (await agent.send<ThreadGetResult>("GET", `${threads}/3`)).body.cursors)
    .toEqual({ requester: 1, audience: 1 });
  await expect(tab("Threads")).toHaveAccessibleName("Threads");

  // The message's options open below their button; a tap on the text beside
  // them closes them, and Escape does too, each returning focus to the
  // button.
  const options = page.getByRole("button", { name: "Options for message 1" });
  await options.click();
  await expect(options).toHaveAttribute("aria-expanded", "true");
  await page.getByText("In the usual place.").click();
  await expect(options).toHaveAttribute("aria-expanded", "false");
  await expect(options).toBeFocused();
  await options.click();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Mark unread from here" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(options).toHaveAttribute("aria-expanded", "false");
  await expect(options).toBeFocused();

  await options.click();
  await page.getByRole("button", { name: "Mark unread from here" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  const row = page.getByRole("link", { name: /Release notes are up/ });
  await expect(row.getByTitle("1 of 1 message unread")).toBeVisible();
  await expect(tab("Threads")).toHaveAccessibleName(/^Threads\s*1\b/);
  const read = await agent.send<ThreadGetResult>("GET", `${threads}/3`);
  expect(read.body.cursors.audience).toBe(0);
});

test("archiving a thread takes it off the list until archived threads are included", async () => {
  await page.getByRole("heading", { name: "Release notes are up" }).click();
  await page.getByRole("button", { name: "Archive all", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  await expect(page.getByRole("heading", { name: "Deep text" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release notes are up" })).toHaveCount(0);
  await expect(tab("Threads")).toHaveAccessibleName("Threads");

  // The filter sheet opens over the list, which follows its filters, and
  // Escape closes it, returning focus to the Filters button.
  const filters = page.getByRole("button", { name: /^Filters/ });
  await filters.click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await expect(sheet).toBeVisible();
  // Focus lands on the sheet's heading, so no keyboard rises over it.
  await expect(sheet.getByRole("heading", { name: "Filters" })).toBeFocused();
  await sheet.getByRole("group", { name: "Archived" }).getByRole("radio", { name: "Show" }).check();
  const archived = page.getByRole("link", { name: /Release notes are up/ });
  await expect(archived.getByTitle("Archived")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  await expect(filters).toHaveAccessibleName("Filters, 1 on");
  await expect(page.getByRole("button", { name: "Remove filter: Archived shown" })).toBeVisible();
});

test("the list narrows by its filters and search, counts them, orders by its sort, and resets the filters at once", async () => {
  const written = await agent.send<WriteResult>("POST", `${threads}/2/messages`, {
    request_id: "deep-follow-up",
    seen_through: 2,
    text: "One more thing.",
  });
  expect(written.status).toBe(200);
  await page.getByRole("button", { name: "Remove filter: Archived shown" }).click();
  const filters = page.getByRole("button", { name: /^Filters/ });
  await expect(filters).toBeFocused();

  await filters.click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await sheet
    .getByRole("group", { name: "Read", exact: true })
    .getByRole("radio", { name: "Unread" })
    .check();
  await expect(page).toHaveURL(/\?unread=true$/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Deep text" })).toBeVisible();
  await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove filter: Unread" }).click();
  await expect(filters).toBeFocused();
  await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeVisible();

  // The order is the address's too, and stays when the filters go.
  await page.getByRole("combobox", { name: "Sort" }).selectOption("Latest message");
  await expect(page).toHaveURL(/\?sort=latest$/);
  await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText("#2 Deep text");
  // The checkbox beside it reverses it, from the keyboard as from a pointer,
  // keeping focus, on while the order is reversed, and choosing another
  // order takes that order's own direction.
  const direction = page.locator(".list-head").getByRole("checkbox");
  await expect(direction).not.toBeChecked();
  await direction.focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/\?sort=latest&reverse=true$/);
  await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(`#1 ${title}`);
  await expect(direction).toBeFocused();
  await expect(direction).toBeChecked();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/\?sort=latest$/);
  await direction.click();
  await expect(page).toHaveURL(/\?sort=latest&reverse=true$/);
  await page.getByRole("combobox", { name: "Sort" }).selectOption("Created");
  await expect(page).toHaveURL(/\?sort=created$/);
  await expect(direction).not.toBeChecked();
  await page.getByRole("combobox", { name: "Sort" }).selectOption("Latest message");

  // Search opens the search field in place of the head's row, which
  // searches, Enter applying it and closing the field, and the sheet's box
  // shows the same search.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search threads" });
  await expect(search).toBeFocused();
  await expect(filters).toHaveCount(0);
  await search.fill("deep");
  await search.press("Enter");
  await expect(page).toHaveURL(/search=deep/);
  await expect(search).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Release notes are up" })).toHaveCount(0);
  await filters.click();
  await expect(sheet.getByRole("searchbox")).toHaveValue("deep");
  await sheet.getByRole("button", { name: /^Show 1 thread$/ }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("heading", { name: "Deep text" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release notes are up" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Remove filter: Search/ })).toBeVisible();

  // The sheet counts what each value keeps; Agent offers each agent with its
  // count, and Reset filters turns them all off, keeping the order.
  await filters.click();
  await expect(
    sheet.getByRole("group", { name: "Read", exact: true }).getByRole("radio", {
      name: /^Unread, \d+ threads?$/,
    }),
  ).toBeAttached();
  await sheet.getByRole("button", { name: /^Agent / }).click();
  await sheet.getByRole("checkbox", { name: /^builder, \d+ threads?$/ }).check();
  await expect(page).toHaveURL(/search=deep&agent=builder&sort=latest$/);
  await sheet.getByRole("button", { name: "Done" }).click();
  await sheet.getByRole("button", { name: /^Reset filters/ }).click();
  await expect(page).toHaveURL(/\/\?sort=latest$/);
  await expect(sheet.getByRole("searchbox")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Remove filter: Search/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Release notes are up" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeVisible();

  // Grouped by session, the list folds under each session's header, which
  // collapses what it holds, by its chevron or a click on the rest of its
  // bar.
  await page.getByRole("combobox", { name: "Group" }).selectOption("Session");
  await expect(page).toHaveURL(/\/\?sort=latest&group=session$/);
  const session = page.getByRole("button", { name: "Agent builder Session main" });
  const sessionBar = page.locator(".group-head").filter({ has: session });
  await expect(session).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeVisible();
  await session.click();
  await expect(session).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeHidden();
  await sessionBar.click({ position: { x: 2, y: 2 } });
  await expect(session).toHaveAttribute("aria-expanded", "true");
  // Its label is a link that adds the session to the list's filters,
  // keeping its order and grouping, and folds nothing. The link reaches
  // across the bar's height, so a tap at its edge, clear of its text, lands
  // on it rather than on the fold beneath.
  const label = await sessionBar
    .getByRole("link", { name: "Threads of Agent builder Session main", exact: true })
    .boundingBox();
  const labelText = await sessionBar.locator(".group-label .path-name").first().boundingBox();
  expect(label).not.toBeNull();
  expect(labelText).not.toBeNull();
  if (label !== null && labelText !== null) {
    expect(label.y + 2).toBeLessThan(labelText.y);
    await page.mouse.click(labelText.x + labelText.width / 2, label.y + 2);
  }
  await expect(page).toHaveURL(/\/\?session=builder\/main&sort=latest&group=session$/);
  await expect(
    page.getByRole("button", { name: "Remove filter: Session builder/main" }),
  ).toBeVisible();
  await expect(session).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove filter: Session builder/main" }).click();
  await expect(page).toHaveURL(/\/\?sort=latest&group=session$/);
  // Grouped by topic, the sessions head the list as they do by session.
  await page.getByRole("combobox", { name: "Group" }).selectOption("Topic");
  await expect(page).toHaveURL(/\/\?sort=latest&group=topic$/);
  await expect(page.getByRole("button", { name: "Agent builder Session main" })).toBeVisible();
  await page.getByRole("combobox", { name: "Group" }).selectOption("Flat");
  await page.getByRole("combobox", { name: "Sort" }).selectOption("Priority");
  await expect(page).toHaveURL(/\/$/);
});

test("the keyboard moves through the list with j and k, its focus ring showing, opens a thread with Enter, closes a menu alone with Escape and returns with u", async () => {
  await showList();
  const rows = page.locator("ul.threads").getByRole("link");
  await page.keyboard.press("j");
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("k");
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveCSS("outline-style", "solid");
  const title = (await rows.nth(1).getByRole("heading").textContent()) ?? "";
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  // Escape closing a message's options menu closes only the menu.
  const options = page.getByRole("button", { name: /^Options for message / }).first();
  await options.click();
  await expect(options).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(options).toHaveAttribute("aria-expanded", "false");
  await expect(options).toBeFocused();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await page.keyboard.press("u");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
});

// fitsAcross checks that a box takes its area's whole content width, and
// that neither the area nor the page scrolls sideways.
async function fitsAcross(box: Locator, area: Locator): Promise<void> {
  const shown = await box.boundingBox();
  expect(shown).not.toBeNull();
  const content = await area.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  expect(Math.abs((shown?.width ?? 0) - content)).toBeLessThanOrEqual(2);
  expect(await area.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

// onOneRow checks that the controls a head holds stand on one row.
async function onOneRow(head: Locator): Promise<void> {
  const tops = await head
    .locator(".icon-control")
    .evaluateAll((controls) => controls.map((each) => each.getBoundingClientRect().top));
  expect(tops.length).toBeGreaterThan(0);
  expect(new Set(tops).size).toBe(1);
}

test("at a phone's width, down to the narrowest, the list's head holds its icons on one row, with nothing to scroll sideways, as the search field does, and the bar at the list's foot clears its last row", async () => {
  const wide = page.viewportSize();
  // Every control set, so each shows its mark, and Filters its count.
  await page.goto("/?search=deep&unread=true&sort=latest&reverse=true&group=session");
  const head = page.locator(".list-head");
  for (const width of [390, 320]) {
    await resize(page, { width, height: 844 });
    await expect(page.getByRole("button", { name: /^Filters, 2 on$/ })).toBeVisible();
    await fitsAcross(head, page.locator("main"));
    await onOneRow(head);
    await expect(head.locator(".set-mark")).toHaveCount(3);
    // Each choice's select, unseen, takes a tap anywhere on its control, out
    // to its corners.
    for (const name of ["Sort", "Group"]) {
      expect(
        await page.getByRole("combobox", { name }).evaluate((select) => {
          const control = select.parentElement?.getBoundingClientRect();
          if (control === undefined) {
            return false;
          }
          const inset = 3;
          return [
            [control.left + inset, control.top + inset],
            [control.right - inset, control.top + inset],
            [control.left + inset, control.bottom - inset],
            [control.right - inset, control.bottom - inset],
          ].every(([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0) === select);
        }),
      ).toBe(true);
    }
    await page.getByRole("button", { name: 'Search, "deep"' }).click();
    await fitsAcross(
      page.getByRole("searchbox", { name: "Search threads" }).locator(".."),
      page.locator("main"),
    );
    await page.getByRole("button", { name: "Close search" }).click();
  }
  // With threads listed, the bar at the list's foot acting on them follows
  // the last row, which it never covers once scrolled to, on the narrowest
  // phone and in the list beside a thread, with nothing to scroll sideways.
  await page.goto("/");
  await clearOfTheBar(page.locator("main"));
  await fitsAcross(head, page.locator("main"));
  await onOneRow(head);
  // A row j moves focus to scrolls into view clear of the bar too, on a
  // phone and beside a thread, on screens short enough for the list to
  // scroll.
  await focusClearOfTheBar(page.locator("main"), 390);
  const list = page.getByRole("region", { name: "Thread list" });
  await focusClearOfTheBar(list, 1280);
  await clearOfTheBar(list);
  await fitsAcross(list.locator(".list-head"), list);
  if (wide !== null) {
    await resize(page, wide);
  }
  await page.goto("/");
});

// focusClearOfTheBar sizes the window at a width so the list's last row
// ends at the foot of the screen, under the bar at the list's foot, then
// moves focus down the rows with j from the top, and checks that each row
// focused stands clear of the bar.
async function focusClearOfTheBar(area: Locator, width: number): Promise<void> {
  const bar = area.getByRole("region", { name: "List actions" });
  const rows = area.locator("ul.threads").getByRole("link");
  const toTop = () =>
    area.evaluate((element) => {
      element.scrollTop = 0;
      window.scrollTo(0, 0);
    });
  await resize(page, { width, height: 1200 });
  await toTop();
  const end = await rows.last().boundingBox();
  await resize(page, { width, height: Math.ceil((end?.y ?? 0) + (end?.height ?? 0)) });
  await expect(bar).toBeVisible();
  await toTop();
  // From no row, so j starts at the first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const count = await rows.count();
  const [last, before] = await Promise.all([rows.last().boundingBox(), bar.boundingBox()]);
  // The last row starts out under the bar or below it, so moving to it
  // scrolls.
  expect((last?.y ?? 0) + (last?.height ?? 0)).toBeGreaterThan(before?.y ?? 0);
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("j");
    await expect(rows.nth(index)).toBeFocused();
    const [row, shown] = await Promise.all([rows.nth(index).boundingBox(), bar.boundingBox()]);
    expect((row?.y ?? 0) + (row?.height ?? 0)).toBeLessThanOrEqual((shown?.y ?? 0) + 1);
  }
}

// clearOfTheBar scrolls the list's area, and the page, to their ends, and
// checks that the bar at the list's foot stands below the last row.
async function clearOfTheBar(area: Locator): Promise<void> {
  const bar = area.getByRole("region", { name: "List actions" });
  await expect(bar).toBeVisible();
  await area.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const [row, shown] = await Promise.all([
    area.locator("ul.threads > li").last().boundingBox(),
    bar.boundingBox(),
  ]);
  expect(row).not.toBeNull();
  expect(shown).not.toBeNull();
  expect((row?.y ?? 0) + (row?.height ?? 0)).toBeLessThanOrEqual((shown?.y ?? 0) + 1);
}

test("from 41rem across, and only from there, the list's head shows every control's words on one row, its widest by touch with every control set, in the system's font and in Arial", async () => {
  const wide = page.viewportSize();
  // Twelve filters on, for a count of two digits, and the order and
  // grouping whose words run longest.
  await page.goto(
    "/?search=deep&status=open&priority=high&impact=assuming&overdue=true&effort=under_1h" +
      "&unread=true&agent_read=stranded&agent=builder&session=builder/main" +
      "&topic=builder/main/auth&include_archived=true&sort=latest&group=session",
  );
  const head = page.locator(".list-head");
  await expect(page.getByRole("button", { name: /^Filters, 12 on$/ })).toBeVisible();
  // By touch, as on a tablet, at the largest sizes.
  const first = 700;
  await resize(page, { width: first, height: 844 }, true);
  const [width, rem] = await head.evaluate((element) => [
    element.clientWidth,
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  ]);
  const tier = 41 * (rem ?? 16);
  await resize(page, { width: first + tier - (width ?? 0), height: 844 }, true);
  expect(await head.evaluate((element) => element.clientWidth)).toBe(tier);
  // In whatever font the machine running the tests has for the system's,
  // and in Arial, whose widths are the web's most common.
  for (const font of [undefined, "Arial"]) {
    await page.evaluate((family) => {
      const root = document.documentElement.style;
      if (family === undefined) {
        root.removeProperty("--font-body");
      } else {
        root.setProperty("--font-body", family);
      }
    }, font);
    for (const label of await head.locator(".control-label").all()) {
      await expect(label).toBeVisible();
    }
    await onOneRow(head);
    await fitsAcross(head, page.locator("main"));
  }
  // A pixel narrower, the buttons show their icons alone, so 41rem is the
  // narrowest the row shows every word at.
  await resize(page, { width: first + tier - (width ?? 0) - 1, height: 844 }, true);
  expect(await head.evaluate((element) => element.clientWidth)).toBe(tier - 1);
  await expect(
    page.getByRole("button", { name: /^Filters/ }).locator(".control-label"),
  ).toBeHidden();
  if (wide !== null) {
    await resize(page, wide);
  }
  await page.goto("/");
});

test("at a desktop's width the list stands beside the thread open, kept as chosen and marking it, each thread at its own address, and one at a time on a phone", async () => {
  await showList();
  const list = page.getByRole("region", { name: "Thread list" });
  const pane = page.getByRole("region", { name: "Thread", exact: true });
  const sort = list.getByRole("combobox", { name: "Sort" });
  await sort.selectOption("Latest message");
  await expect(page).toHaveURL(/\/\?sort=latest$/);
  const rows = list.locator("ul.threads").getByRole("link");
  const [first, second] = [rows.nth(0), rows.nth(1)];
  const titles = await Promise.all(
    [first, second].map(async (row) => (await row.getByRole("heading").textContent()) ?? ""),
  );

  // Opening a thread shows it beside the list, which stays as chosen, its
  // row marked current, in the thread's pane to the right.
  await first.click();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[0] ?? "");
  const opened = page.url();
  await expect(first).toHaveAttribute("aria-current", "page");
  await expect(list.locator("ul.threads > li").nth(0)).toHaveCSS("outline-style", "solid");
  await expect(sort).toHaveValue("latest");
  const [listBox, paneBox] = await Promise.all([list.boundingBox(), pane.boundingBox()]);
  expect((listBox?.x ?? 0) + (listBox?.width ?? 0)).toBeLessThanOrEqual(paneBox?.x ?? 0);
  // The thread scrolls with the page; the list stays in view, scrolling on
  // its own.
  await expect(list).toHaveCSS("position", "sticky");
  await expect(list).toHaveCSS("overflow-y", "auto");
  await expect(pane).toHaveCSS("overflow-y", "visible");

  // Moving through the list opens nothing until asked.
  await page.keyboard.press("j");
  await expect(second).toBeFocused();
  expect(page.url()).toBe(opened);
  await page.keyboard.press("o");
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[1] ?? "");
  await expect(second).toHaveAttribute("aria-current", "page");
  await expect(first).not.toHaveAttribute("aria-current");

  // Back returns to the thread before, at its own address, and u to the
  // list, landing on the row of the thread it left.
  await page.goBack();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[0] ?? "");
  expect(page.url()).toBe(opened);
  await page.keyboard.press("u");
  await expect(page).toHaveURL(/\/\?sort=latest$/);
  await expect(first).toBeFocused();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");

  // The list's head fits its pane with nothing to scroll sideways, down to
  // the narrowest width side by side, its controls on one row, and so does
  // the search field / opens in the row's place, with focus in it.
  const head = list.locator(".list-head");
  const searchBox = list.getByRole("searchbox", { name: "Search threads" });
  const sideBySide = page.viewportSize();
  for (const width of [1024, sideBySide?.width ?? 1280]) {
    await resize(page, { width, height: sideBySide?.height ?? 720 });
    await expect(pane).toBeVisible();
    await fitsAcross(head, list);
    await onOneRow(head);
  }
  await page.keyboard.press("/");
  await expect(searchBox).toBeFocused();
  await fitsAcross(searchBox.locator(".."), list);
  await page.keyboard.press("Escape");
  await expect(list.getByRole("button", { name: "Search", exact: true })).toBeFocused();
  // f opens the filters, as Filters does, and s and b give the order and the
  // grouping focus, whether or not the browser opens their pickers; focus
  // then moves on to a row, as the operator would move it.
  await page.keyboard.press("f");
  await expect(page.getByRole("dialog", { name: "Filters" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list.getByRole("button", { name: "Filters", exact: true })).toBeFocused();
  await page.keyboard.press("s");
  await expect(sort).toBeFocused();
  await first.focus();
  await page.keyboard.press("b");
  await expect(list.getByRole("combobox", { name: "Group" })).toBeFocused();
  await first.focus();

  // Back keeps the list as set: an order chosen beside the second thread
  // stays on going back to the first, whose entry then returns to it, and on
  // going back onto the list's own entry, with no thread open; the list
  // stays mounted, and asks for no other list.
  await first.click();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[0] ?? "");
  await second.click();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[1] ?? "");
  const listsAsked: string[] = [];
  const askedFor = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/web/threads") {
      listsAsked.push(url.search);
    }
  };
  const created = page.waitForResponse(
    (response) => new URL(response.url()).search === "?sort=created",
  );
  await sort.selectOption("Created");
  await created;
  const shown = await list.locator("ul.threads").elementHandle();
  page.on("request", askedFor);
  await page.goBack();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[0] ?? "");
  await expect(sort).toHaveValue("created");
  expect(await page.evaluate(() => window.history.state as unknown)).toEqual({
    from: "/?sort=created",
  });
  await page.goBack();
  await expect(page).toHaveURL(/\/\?sort=created$/);
  await expect(pane.locator(".empty")).toBeVisible();
  await expect(sort).toHaveValue("created");
  expect(await shown?.evaluate((element) => element.isConnected)).toBe(true);
  page.off("request", askedFor);
  expect(listsAsked.filter((search) => search !== "?sort=created")).toEqual([]);
  await sort.selectOption("Latest message");
  await expect(page).toHaveURL(/\/\?sort=latest$/);

  // Crossing to a phone's width with the thread's pane itself focused keeps
  // focus on the page, and the thread shows alone, as before; on a phone the
  // list shows alone too.
  await first.click();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[0] ?? "");
  await pane.focus();
  const wide = page.viewportSize();
  await resize(page, { width: 390, height: 844 });
  await expect(list).toHaveCount(0);
  await expect(page.locator("ul.threads")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(titles[0] ?? "");
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await page.keyboard.press("u");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  await fitsAcross(page.locator(".list-head"), page.locator("main"));
  await page.locator("ul.threads").getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(titles[0] ?? "");
  await expect(page.locator("ul.threads")).toHaveCount(0);
  await page.keyboard.press("u");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  if (wide !== null) {
    await resize(page, wide);
  }
  await sort.selectOption("Priority");
  await expect(page).toHaveURL(/\/$/);
});

test("at a desktop's width, a search still pending applies only to the list it was typed on, not to one a thread's link puts in its place", async () => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "Thread list" });
  const pane = page.getByRole("region", { name: "Thread", exact: true });
  await list.locator("ul.threads").getByRole("link").first().click();
  await expect(pane.getByRole("heading", { level: 1 })).toBeVisible();
  await list.getByRole("button", { name: "Search", exact: true }).click();
  const box = list.getByRole("searchbox", { name: "Search threads" });
  // Within the pause, the thread's agent opens the list of that agent's
  // threads, which drops the text typed on the list it replaces.
  await box.fill("deep");
  await pane.locator(".where").getByRole("link").first().click();
  await expect(page).toHaveURL(/\/\?agent=[^&]+$/);
  await expect(box).toHaveValue("");
  await page.waitForTimeout(600);
  expect(new URL(page.url()).searchParams.has("search")).toBe(false);
  await list.getByRole("button", { name: "Close search" }).click();
  await page.goto("/");
});

test("an ask the agent withdraws reads as withdrawn with its reason, on the list and its thread", async () => {
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "create-withdrawn",
    title: "Merge the release branch",
    asks: [{ question: "Merge it now?", suggestions: [{ label: "Merge" }, { label: "Wait" }] }],
  });
  const { number } = created.body;
  const reason = "The release job merged it.";
  const withdrawn = await agent.send<WriteResult>("POST", `${threads}/${number}/messages`, {
    request_id: "withdraw-merge",
    seen_through: 1,
    withdrawals: [{ ask: 1, reason }],
  });
  expect(withdrawn.status).toBe(200);

  await filtersShowing("Withdrawn");
  const row = page.getByRole("link", { name: /Merge the release branch/ });
  await expect(row.locator(".row-status")).toHaveText(`Withdrawn: ${reason}`);
  await row.click();
  const card = page.getByRole("region", { name: "Ask 1: Merge it now?" });
  await expect(card.locator(".ask-state")).toHaveText(`Withdrawn in #2: ${reason}`);
  await expect(card.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("article", { name: /^Message 2 by/ }).locator(".event")).toHaveText([
    `Withdrew ask 1: ${reason}`,
  ]);
  // The way back in the thread's bar keeps the list's filter.
  await page.getByRole("link", { name: "Back to threads" }).click();
  await page.getByRole("button", { name: "Remove filter: Status: Withdrawn" }).click();
  await expect(page).toHaveURL(/\/$/);
});

// filtersShowing chooses a status in the filter sheet, and closes it.
async function filtersShowing(status: string): Promise<void> {
  await page.getByRole("button", { name: /^Filters/ }).click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await sheet
    .getByRole("group", { name: "Status", exact: true })
    .getByRole("radio", { name: new RegExp(`^${status}(, \\d+ threads?)?$`) })
    .check();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
}

test("the sessions view shows a session's status and log, and starts a thread the agent reads", async () => {
  for (const update of [
    { state: "working", title: "Retire invoices", goal: "Drop the table" },
    { percent: 20 },
    { percent: 60 },
    { state: "idle", note: "Waiting on CI" },
  ]) {
    const reported = await agent.send<SessionStatus>("POST", "/s/builder/main/status", update);
    expect(reported.status).toBe(200);
  }

  await tab("Sessions").click();
  const fold = page.getByRole("button", { name: "Session main" });
  const row = page.getByRole("listitem").filter({ has: fold });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(row.getByText("Idle", { exact: true })).toBeVisible();
  // It was seen just now, on the line under its head, so it is not quiet,
  // and the line says how old its status is too.
  await expect(row.locator(".session-seen:not(.warning) > time")).toBeVisible();
  await expect(row.locator(".session-seen .session-status-age time")).toBeVisible();
  await expect(row.getByText("4 new updates")).toBeVisible();
  await expect(row.getByText("Waiting on CI")).toBeVisible();

  // Unfolded by a click on its title, as anywhere on the row but its links
  // and controls, the log shows newest first, the two updates of progress
  // alone in one line, and reads it.
  const titled = await row.getByText("Retire invoices", { exact: true }).boundingBox();
  expect(titled).not.toBeNull();
  if (titled !== null) {
    await page.mouse.click(titled.x + titled.width / 2, titled.y + titled.height / 2);
  }
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const log = row.getByRole("list", { name: "Updates" });
  await expect(log.getByRole("listitem")).toHaveCount(3);
  await expect(log.getByRole("listitem").nth(1)).toContainText(/20%.*60%/);
  await expect(row.getByText("4 new updates")).toHaveCount(0);

  // At a phone's width, the view and its sheet scroll only up and down.
  const wide = page.viewportSize();
  await resize(page, { width: 390, height: 844 });
  const scrollsSideways = () =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(await scrollsSideways()).toBe(false);

  const options = page.getByRole("button", { name: "Options for builder/main" });
  await options.click();
  await page.getByRole("button", { name: "New thread" }).click();
  const sheet = page.getByRole("dialog", { name: "New thread" });
  await expect(sheet).toBeVisible();
  expect(await scrollsSideways()).toBe(false);
  await sheet.getByLabel("Title").fill("Keep the archive");
  await sheet.getByLabel("Message").fill("Keep the nightly archive a week longer.");
  // Attach, a menu at a phone's width, opens above itself within the sheet,
  // and the file it adds goes with the thread's first message.
  const attach = sheet.getByRole("button", { name: "Attach files" });
  await attach.click();
  const menu = sheet.locator(".options-menu");
  const placed = await menu.boundingBox();
  expect(placed).not.toBeNull();
  expect(placed!.y).toBeGreaterThanOrEqual(0);
  expect(placed!.y + placed!.height).toBeLessThanOrEqual((await attach.boundingBox())!.y);
  // Escape closes the menu alone, leaving the sheet open.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await expect(attach).toBeFocused();
  await attach.click();
  const chooser = page.waitForEvent("filechooser");
  await menu.getByRole("button", { name: "Other files" }).click();
  await (
    await chooser
  ).setFiles({ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("A week.\n") });
  const attached = sheet.getByRole("list", { name: "Files to send" }).getByRole("listitem");
  await expect(attached.getByText("Uploaded")).toHaveCount(1);
  expect(await scrollsSideways()).toBe(false);
  await sheet.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Keep the archive$/);
  if (wide !== null) {
    await resize(page, wide);
  }
  const number = Number(new URL(page.url()).pathname.split("/").at(-1));

  // The agent reads the thread as the operator's own words.
  const read = await agent.send<ThreadGetResult>("GET", `${threads}/${number}`);
  expect(read.body.messages[0]?.author.kind).toBe("person");
  expect(read.body.messages[0]?.attachments?.map((each) => each.name)).toEqual(["plan.txt"]);
  expect(read.body.thread.title).toBe("Keep the archive");

  // Once the session stops, the thread it has not read is stranded, saying
  // why.
  await agent.send("POST", "/s/builder/main/status", { state: "stopped", outcome: "completed" });
  await showList();
  await expect(page.getByRole("link", { name: /Keep the archive/ })).toContainText(
    /Stranded.*completed/,
  );
  await agent.send("POST", "/s/builder/main/status", { state: "working" });
});

test("a session's options menu lies over the next agent's header, at a phone's width too", async ({
  agention,
}) => {
  // A second agent, whose header follows builder's one session and,
  // with builder folded, its header.
  const deployer = new Agent(agention);
  await deployer.send("POST", "/registrations", { agent: "deployer", session: "main" });
  await page.getByRole("link", { name: "Sessions" }).click();
  const code = registrationCode(deployer.publicKey as PublicKey);
  await page
    .getByRole("article", { name: `Registration ${code}` })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(page.getByRole("button", { name: /^Agent deployer/ })).toBeVisible();

  const wide = page.viewportSize();
  for (const size of [wide, { width: 390, height: 844 }]) {
    if (size !== null) {
      await resize(page, size);
    }
    const options = page.getByRole("button", { name: "Options for builder/main" });
    await options.click();
    // The click lands on the menu's item, not on the header beneath it.
    await page.getByRole("button", { name: /^Group: / }).click();
    const sheet = page.getByRole("dialog", { name: "Group for builder/main" });
    await expect(sheet).toBeVisible();
    // The picker lies beside the options it was opened from on a wide
    // screen, and rises from the bottom as a sheet on a phone.
    const [at, box] = await Promise.all([options.boundingBox(), sheet.boundingBox()]);
    expect(at).not.toBeNull();
    expect(box).not.toBeNull();
    if (at !== null && box !== null && size !== null) {
      if (size.width >= 640) {
        expect(Math.abs(box.y - (at.y + at.height))).toBeLessThan(16);
        expect(Math.abs(box.x + box.width - (at.x + at.width))).toBeLessThan(16);
      } else {
        expect(Math.abs(box.y + box.height - size.height)).toBeLessThan(2);
      }
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(options).toBeFocused();
  }
  // So does the agent's own menu, in its header, with the agent folded.
  const builder = page.getByRole("button", { name: /^Agent builder/ });
  await builder.click();
  await expect(builder).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Options for builder" }).click();
  await page.getByRole("button", { name: /^Tags: / }).click();
  const tags = page.getByRole("dialog", { name: "Tags for builder" });
  await expect(tags).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tags).toBeHidden();
  await builder.click();
  if (wide !== null) {
    await resize(page, wide);
  }
});

test("the sessions view folds by group, each group's head linking to its threads, and links stranded threads, at a phone's width too", async () => {
  // builder/main stops, stranding the threads holding a message of the
  // operator's it has not read, such as Keep the archive.
  await agent.send("POST", "/s/builder/main/status", { state: "stopped", outcome: "completed" });
  // builder/main goes into a new group, Work; deployer/main stays in none.
  await page.getByRole("button", { name: "Options for builder/main" }).click();
  await page.getByRole("button", { name: /^Group: / }).click();
  // The picker creates a group named as typed, and puts the session in it
  // at once, with no Save.
  const sheet = page.getByRole("dialog", { name: "Group for builder/main" });
  await sheet.getByRole("combobox").fill("Work");
  await sheet.getByRole("option", { name: "Create group “Work”" }).click();
  await expect(sheet).toBeHidden();
  const work = page.getByRole("button", { name: "Group Work" });
  const none = page.getByRole("button", { name: "No group" });
  await expect(work).toBeVisible();
  await expect(none).toBeVisible();
  const builder = page.getByRole("button", { name: /^Agent builder/ });
  await expect(builder).toHaveCount(1);
  // builder takes a new tag, example, typed and created by the keys, and
  // builder/main the same tag, picked; each pick applies at once.
  for (const path of ["builder", "builder/main"]) {
    await page.getByRole("button", { name: `Options for ${path}`, exact: true }).click();
    await page.getByRole("button", { name: /^Tags: / }).click();
    const tags = page.getByRole("dialog", { name: `Tags for ${path}` });
    const search = tags.getByRole("combobox", { name: "Search or create tags" });
    if (path === "builder") {
      await expect(search).toBeFocused();
      await search.fill("example");
      await page.keyboard.press("Enter");
      await expect(search).toHaveValue("");
    } else {
      await tags.getByRole("option", { name: "example" }).click();
    }
    await expect(tags.getByRole("option", { name: "example" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await tags.getByRole("button", { name: "Done" }).click();
    await expect(tags).toBeHidden();
  }
  // The tag shows on the agent's header in its color.
  await expect(page.locator(".fold-head .tag-chip", { hasText: "example" })).toHaveClass(
    /\btone-[a-z]+\b/,
  );

  const wide = page.viewportSize();
  const scrollsSideways = () =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const height = (chips: string) =>
    page
      .locator(chips, { hasText: "example" })
      .evaluate((chip) => chip.getBoundingClientRect().height);
  for (const size of [wide, { width: 390, height: 844 }]) {
    if (size !== null) {
      await resize(page, size);
    }
    expect(await scrollsSideways()).toBe(false);
    // A tag is one chip, as tall in its agent's header as in its session's
    // row.
    expect(await height(".fold-head .tag-chip")).toBe(await height(".session-facts .tag-chip"));
    // The agent's options keep the right end of its header's first row,
    // however its marks wrap, and no two links on a header reach over each
    // other, so a tap lands on the one it is nearest.
    const layout = await page
      .locator(".subgroup-head")
      .filter({ has: builder })
      .evaluate((bar) => {
        const box = bar.getBoundingClientRect();
        const options = bar.querySelector(".options-button")?.getBoundingClientRect();
        const links = Array.from(bar.querySelectorAll("a"), (link) => link.getBoundingClientRect());
        const overlapping = links.some((one, index) =>
          links.slice(index + 1).some(
            (other) =>
              // Boxes that only meet, to within rounding, do not overlap.
              one.left < other.right - 0.5 &&
              other.left < one.right - 0.5 &&
              one.top < other.bottom - 0.5 &&
              other.top < one.bottom - 0.5,
          ),
        );
        return {
          right: box.right - (options?.right ?? 0),
          top: (options?.top ?? 0) - box.top,
          overlapping,
        };
      });
    expect(layout.right).toBeLessThan(16);
    expect(layout.top).toBeLessThan(8);
    expect(layout.overlapping).toBe(false);
    // The group's head folds what it holds, and unfolds it again, by its
    // chevron or a click on the rest of its bar, but for its links.
    const workBar = page.locator(".group-head").filter({ has: work });
    await work.click();
    await expect(work).toHaveAttribute("aria-expanded", "false");
    await expect(builder).toBeHidden();
    await workBar.click({ position: { x: 2, y: 2 } });
    await expect(builder).toBeVisible();
    // Its name links to its threads alone, as its count does, folding
    // nothing.
    await workBar.getByRole("link", { name: "Threads in group Work", exact: true }).click();
    await expect(page).toHaveURL(/\/\?session_group=\d+$/);
    await page.getByRole("link", { name: /^Sessions/ }).click();
    await expect(work).toHaveAttribute("aria-expanded", "true");
    // A tag on the agent's header links to the threads carrying it.
    await page.locator(".fold-head .tag-chip", { hasText: "example" }).click();
    await expect(page).toHaveURL(/\/\?tag=example$/);
    await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeVisible();
    await page.getByRole("link", { name: /^Sessions/ }).click();
    await expect(builder).toHaveAttribute("aria-expanded", "true");
    // Its link lands on the thread list filtered to the group alone.
    await page.getByRole("link", { name: /^\d+ threads? of Work$/ }).click();
    await expect(page).toHaveURL(/\/\?session_group=\d+$/);
    await expect(page.getByRole("button", { name: /^Remove filter: Group:? Work/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeVisible();
    expect(await scrollsSideways()).toBe(false);
    await page.getByRole("link", { name: /^Sessions/ }).click();
    await expect(work).toBeVisible();
    // The session's stranded threads, and its agent's in Work, land on the
    // thread list filtered to exactly those: as many as the link says, each
    // stranded.
    for (const owner of ["builder/main", "builder"]) {
      const stranded = page.getByRole("link", {
        name: new RegExp(`^\\d+ stranded threads? of ${owner}$`),
      });
      const count = Number((await stranded.textContent())?.match(/^\d+/)?.[0]);
      expect(count).toBeGreaterThan(0);
      await stranded.click();
      await expect(page).toHaveURL(/\/\?agent_read=stranded&/);
      await expect(page.getByRole("button", { name: "Remove filter: Stranded" })).toBeVisible();
      const rows = page.locator(".thread-row");
      await expect(rows).toHaveCount(count);
      for (const row of await rows.all()) {
        await expect(row).toContainText("Stranded");
      }
      await expect(rows.filter({ hasText: "Keep the archive" })).toHaveCount(1);
      expect(await scrollsSideways()).toBe(false);
      await page.getByRole("link", { name: /^Sessions/ }).click();
      await expect(work).toBeVisible();
    }
  }
  if (wide !== null) {
    await resize(page, wide);
  }
  await agent.send("POST", "/s/builder/main/status", { state: "working" });
});

test("the sessions view moves its groups in their manual order, and groups and sorts as chosen, in the address", async () => {
  // deployer/main goes into a new group, Ops, which goes last in the order.
  await page.getByRole("button", { name: "Options for deployer/main" }).click();
  await page.getByRole("button", { name: /^Group: / }).click();
  const sheet = page.getByRole("dialog", { name: "Group for deployer/main" });
  await sheet.getByRole("combobox").fill("Ops");
  await sheet.getByRole("option", { name: "Create group “Ops”" }).click();
  await expect(sheet).toBeHidden();
  const heads = () =>
    page
      .locator(".group-head > .fold-main > h3 > .fold-toggle")
      .evaluateAll((buttons) =>
        buttons
          .map((button) => button.getAttribute("aria-label") ?? "")
          .filter((label) => label.startsWith("Group ")),
      );
  await expect.poll(heads).toEqual(["Group Work", "Group Ops"]);
  // Move up moves it at the top, where focus goes on to its Move down, and
  // the order holds once the page loads again.
  await page.getByRole("button", { name: "Move Ops up" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(heads).toEqual(["Group Ops", "Group Work"]);
  await expect(page.getByRole("button", { name: "Move Ops down" })).toBeFocused();
  await page.reload();
  await expect.poll(heads).toEqual(["Group Ops", "Group Work"]);
  // With a mouse, a group dragged by its handle onto another takes its place.
  await page
    .locator(".group")
    .filter({ has: page.getByRole("button", { name: "Group Ops" }) })
    .locator(".drag-handle")
    .dragTo(page.getByRole("button", { name: "Group Work" }));
  await expect.poll(heads).toEqual(["Group Work", "Group Ops"]);
  // Sorted by name, either way, the address keeping it.
  await page.getByRole("combobox", { name: "Sort" }).selectOption("alphabetic");
  await expect.poll(heads).toEqual(["Group Ops", "Group Work"]);
  await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
  await page.locator(".list-head").getByRole("checkbox").click();
  await expect.poll(heads).toEqual(["Group Work", "Group Ops"]);
  await expect(page).toHaveURL(/\/sessions\?sort=alphabetic&reverse=true$/);
  // Grouped by session, the sessions stand alone, the sort held, through a
  // reload and back from the thread list.
  await page.getByRole("combobox", { name: "Group" }).selectOption("session");
  await expect(page).toHaveURL(/\/sessions\?group=session&reverse=true$/);
  await expect(page.getByRole("button", { name: "Session deployer/main" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Agent / })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Session deployer/main" })).toBeVisible();
  await page.getByRole("link", { name: "Threads of session builder/main" }).click();
  await expect(page).toHaveURL(/\/\?session=builder\/main$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/sessions\?group=session&reverse=true$/);
  await expect(page.getByRole("combobox", { name: "Group" })).toHaveValue("session");
  // Ops goes again, in Settings, leaving deployer/main in no group, and the
  // Sessions tab opens on its default arrangement.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Groups and tags" }).click();
  const ops = page.getByRole("article", { name: "Group Ops" });
  await ops.getByRole("button", { name: "Remove" }).click();
  await ops.getByRole("button", { name: "Remove this group" }).click();
  await expect(ops).toHaveCount(0);
  await page.getByRole("link", { name: /^Sessions/ }).click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(page.getByRole("button", { name: /^No group/ })).toBeVisible();
});

// menuLiesOnTop opens a session's options menu, brings each of its items
// into view and checks that the item is what lies at its own center, so
// nothing on the page, such as the head of a fold below, covers it, then
// closes the menu.
async function menuLiesOnTop(path: string): Promise<void> {
  const options = page.getByRole("button", { name: `Options for ${path}` });
  await options.click();
  const items = page.locator(".options.open .options-menu button");
  expect(await items.count()).toBeGreaterThan(0);
  for (const item of await items.all()) {
    const onTop = await item.evaluate((element) => {
      element.scrollIntoView({ block: "nearest" });
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && element.contains(hit);
    });
    expect([path, await item.textContent(), onTop]).toEqual([path, await item.textContent(), true]);
  }
  await page.keyboard.press("Escape");
  await expect(items).toHaveCount(0);
}

test("the last session's options menu lies over the folds below it, grouped or not, at a phone's width too", async () => {
  // deployer/main is the last session of the last agent, and grouped, of the
  // last agent in the last group, No group; Credentials and past requests
  // folds beneath it.
  const pastRequests = page.getByRole("button", { name: /^Credentials and past requests/ });
  const wide = page.viewportSize();
  const check = async () => {
    for (const size of [wide, { width: 390, height: 844 }]) {
      if (size !== null) {
        await resize(page, size);
      }
      for (const expanded of ["false", "true"]) {
        if ((await pastRequests.getAttribute("aria-expanded")) !== expanded) {
          await pastRequests.click();
        }
        await expect(pastRequests).toHaveAttribute("aria-expanded", expanded);
        await menuLiesOnTop("deployer/main");
      }
    }
    if ((await pastRequests.getAttribute("aria-expanded")) === "true") {
      await pastRequests.click();
    }
  };
  await expect(page.getByRole("button", { name: /^No group/ })).toBeVisible();
  await check();
  // With builder/main back in no group, the view folds by agent alone.
  if (wide !== null) {
    await resize(page, wide);
  }
  await page.getByRole("button", { name: "Options for builder/main" }).click();
  await page.getByRole("button", { name: /^Group: / }).click();
  const sheet = page.getByRole("dialog", { name: "Group for builder/main" });
  await sheet.getByRole("option", { name: "Clear group" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: /^No group/ })).toHaveCount(0);
  await check();
  if (wide !== null) {
    await resize(page, wide);
  }
});

test("Settings orders the groups by their buttons and by dragging, keeping the order", async () => {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Groups and tags" }).click();
  const groups = page.getByRole("region", { name: "Groups", exact: true });
  const names = () =>
    groups
      .getByRole("article")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")));
  await expect(groups.getByRole("article", { name: "Group Work" })).toBeVisible();
  // A new group goes last.
  await groups.getByRole("button", { name: "New group" }).click();
  await groups.getByLabel("New group's name").fill("Alpha");
  await groups.getByRole("button", { name: "Create group" }).click();
  await expect(groups.getByRole("article", { name: "Group Alpha" })).toBeVisible();
  expect(await names()).toEqual(["Group Work", "Group Alpha"]);
  // Move up moves it, and the order holds once the page loads again. At the
  // top, it can go no further up, so focus goes to its Move down.
  const up = groups.getByRole("button", { name: "Move Alpha up" });
  await up.focus();
  await page.keyboard.press("Enter");
  await expect.poll(names).toEqual(["Group Alpha", "Group Work"]);
  await expect(groups.getByRole("button", { name: "Move Alpha down" })).toBeFocused();
  // A color chosen by keyboard applies, focus staying on it.
  const color = groups.getByRole("combobox", { name: "Color of Alpha" });
  const before = await color.inputValue();
  await color.focus();
  await page.keyboard.press("ArrowDown");
  await expect(color).not.toHaveValue(before);
  await expect(color).not.toHaveAttribute("aria-disabled", "true");
  await expect(color).toBeFocused();
  await page.reload();
  await expect.poll(names).toEqual(["Group Alpha", "Group Work"]);
  // With a mouse, dragging a group by its handle onto another puts it in
  // that one's place.
  await groups
    .getByRole("article", { name: "Group Alpha" })
    .locator(".drag-handle")
    .dragTo(groups.getByRole("article", { name: "Group Work" }));
  await expect.poll(names).toEqual(["Group Work", "Group Alpha"]);
  await page.reload();
  await expect.poll(names).toEqual(["Group Work", "Group Alpha"]);
  // Remove asks first, then takes the group away.
  const alpha = groups.getByRole("article", { name: "Group Alpha" });
  await alpha.getByRole("button", { name: "Remove" }).click();
  await alpha.getByRole("button", { name: "Remove this group" }).click();
  await expect(alpha).toHaveCount(0);
});

test("the threads above and below, and archiving, move the same way beside the list and on a phone, from a list or a link", async () => {
  for (const name of ["one", "two", "three", "four"]) {
    await agent.send<WriteResult>("POST", threads, {
      request_id: `create-hopscotch-${name}`,
      title: `Hopscotch ${name}`,
      text: "On to the next square.",
    });
  }
  const wide = page.viewportSize() ?? { width: 1280, height: 720 };
  const search = "/?search=Hopscotch&sort=created";
  // A short window, so the list beside the thread scrolls.
  await resize(page, { width: wide.width, height: 320 });
  await page.goto(search);
  const list = page.getByRole("region", { name: "Thread list" });
  const pane = page.getByRole("region", { name: "Thread", exact: true });
  const rows = page.locator("ul.threads").getByRole("link");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(rows).toHaveCount(4);
  const titles = await Promise.all(
    [0, 1, 2, 3].map(
      async (index) => (await rows.nth(index).getByRole("heading").textContent()) ?? "",
    ),
  );
  const head = page.getByRole("region", { name: "Thread actions" });
  const above = head.getByRole("button", { name: "Thread above" });
  const below = head.getByRole("button", { name: "Thread below" });
  const archiveAll = head.getByRole("button", { name: "Archive all", exact: true });
  const entries = () => page.evaluate(() => window.history.length);

  // Beside the list, ] and [ and the bar's buttons open the threads below
  // and above, and the list keeps its scroll, the open thread's row marked.
  await rows.nth(1).click();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[1] ?? "");
  // Reading the thread refreshes the list beside it. Scroll once the list
  // shows the thread read, so the scroll measured is the list's own.
  await expect(list.locator("li.thread-row").nth(1)).not.toHaveClass(/\bunread\b/);
  const shown = await list.locator("ul.threads").elementHandle();
  const scrolled = await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await page.keyboard.press("]");
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[2] ?? "");
  // Focus lands on the heading of the thread opened, once it has loaded.
  await expect(pane.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(rows.nth(2)).toHaveAttribute("aria-current", "page");
  expect(await shown?.evaluate((element) => element.isConnected)).toBe(true);
  expect(await list.evaluate((element) => element.scrollTop)).toBe(scrolled);
  await page.keyboard.press("[");
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[1] ?? "");
  await below.click();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[2] ?? "");

  // Archive all archives the thread and, as Auto-advance says unless chosen
  // otherwise, opens the thread above in its place.
  const before = await entries();
  await archiveAll.click();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(titles[1] ?? "");
  await expect(pane.getByRole("heading", { level: 1 })).toBeFocused();
  expect(await entries()).toBe(before);
  await expect(rows).toHaveCount(3);

  // On a phone the thread's bar holds the same controls within its width.
  await resize(page, { width: 390, height: 844 });
  await expect(list).toHaveCount(0);
  await expect(heading).toHaveText(titles[1] ?? "");
  for (const control of [
    head.getByRole("link", { name: "Back to threads" }),
    above,
    below,
    archiveAll,
  ]) {
    const box = await control.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await below.click();
  await expect(heading).toHaveText(titles[3] ?? "");
  await expect(heading).toBeFocused();
  await above.click();
  await expect(heading).toHaveText(titles[1] ?? "");

  const reply = page.getByRole("region", { name: "Reply" });
  const after = reply.getByRole("combobox", { name: "After sending" });
  const archives = reply.getByRole("checkbox", { name: "Archive after sending" });

  // A reply sent with After sending set to archive archives the thread once
  // it lands, then goes where After sending says, in its place.
  const chosenBefore = await after.inputValue();
  await after.selectOption("above");
  await archives.check();
  const sending = await entries();
  await reply.getByRole("textbox", { name: "Message" }).fill("Hopped.");
  await reply.getByRole("button", { name: "Send", exact: true }).click();
  await expect(heading).toHaveText(titles[0] ?? "");
  await expect(heading).toBeFocused();
  expect(await entries()).toBe(sending);
  // This browser keeps both choices, for the thread it opened too.
  await expect(archives).toBeChecked();
  await archives.uncheck();
  await after.selectOption(chosenBefore);

  // At the top of the list, Thread above goes back to it, which says so.
  await above.click();
  await expect(heading).toHaveText("Threads");
  await expect(page).toHaveURL(new RegExp(`${search.replace(/[?]/g, "\\?")}$`));
  await expect(page.getByRole("status")).not.toBeEmpty();

  // A thread opened from a link, with no list behind it, moves through the
  // list Back to threads goes to, the one with no filters.
  await page.goto("/");
  await expect(rows.nth(2)).toBeVisible();
  const links = await Promise.all([0, 1, 2].map((index) => rows.nth(index).getAttribute("href")));
  await page.goto(links[1] ?? "");
  await below.click();
  await expect(page).toHaveURL(new RegExp(`${links[2] ?? ""}$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${links[1] ?? ""}$`));
  await above.click();
  await expect(page).toHaveURL(new RegExp(`${links[0] ?? ""}$`));

  // Archiving the top thread has none above it to go to, so it goes back to
  // the list, until the list is empty.
  await page.goto(search);
  for (const remaining of [2, 1]) {
    await expect(rows).toHaveCount(remaining);
    await rows.first().click();
    await archiveAll.click();
    await expect(heading).toHaveText("Threads");
  }
  await expect(rows).toHaveCount(0);
  await resize(page, wide);
  await page.goto("/");
});

test("signing in with the passkey returns to the page that needed it", async () => {
  await page.getByRole("link", { name: "Settings" }).click();
  await settings().getByRole("link", { name: "Sign out" }).click();
  // Once the operator signs out, the page asks nothing that needs the session:
  // from the sign-out request the click sends until the Sign in page, it reads
  // the tabs' counts no more, and nothing it asks is answered unauthenticated,
  // though the server may sign the browser out before anything sent meanwhile
  // arrives. The window regains focus as the click lands, which sets off every
  // poll the page has at once, rather than leaving them to an interval that
  // rarely falls in that window.
  await page.evaluate(() => {
    window.addEventListener("click", () => window.dispatchEvent(new Event("focus")), {
      once: true,
    });
  });
  const strays: string[] = [];
  let out = false;
  const asked = new Set<Request>();
  const counted = (request: Request) => {
    if (new URL(request.url()).pathname === "/api/web/auth/signout") {
      out = true;
      return;
    }
    if (!out) {
      return;
    }
    asked.add(request);
    if (new URL(request.url()).pathname === "/api/web/attention") {
      strays.push(`read ${request.url()}`);
    }
  };
  const refused = (response: Response) => {
    if (asked.has(response.request()) && response.status() === 401) {
      strays.push(`401 ${response.url()}`);
    }
  };
  page.on("request", counted);
  page.on("response", refused);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  page.off("request", counted);
  page.off("response", refused);
  expect(strays).toEqual([]);

  await page.goto(`${threads}/1`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe(`${threads}/1`);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`#1 ${title}`);
  expect(new URL(page.url()).pathname).toBe(`${threads}/1`);
});

test("a passkey added on a second device signs in, and the first is removed", async () => {
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("article", { name: "Passkey Laptop" })).toBeVisible();

  // The laptop's authenticator gives way to the phone's.
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: device });
  device = await newDevice();
  await page.getByLabel("Passkey name").fill("Phone");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("article", { name: "Passkey Phone" })).toBeVisible();

  await settings().getByRole("link", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  // The passkeys' own page of old leads to Settings' passkeys.
  await page.goto("/passkeys");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Passkeys");
  expect(new URL(page.url()).pathname).toBe("/settings/passkeys");
  const phone = page.getByRole("article", { name: "Passkey Phone" });
  await expect(phone.getByText("Signed in this browser")).toBeVisible();

  const laptop = page.getByRole("article", { name: "Passkey Laptop" });
  await laptop.getByRole("button", { name: "Remove" }).click();
  await laptop.getByRole("button", { name: "Remove this passkey" }).click();
  await expect(laptop).toHaveCount(0);
  await expect(phone.getByRole("button", { name: "Remove" })).toBeDisabled();
});

test("a second server on another port of the host keeps its own sign-in beside the first's", async ({
  secondServer,
}) => {
  await page.goto(secondServer.passkeyLink());
  await page.getByLabel("Passkey name").fill("Phone");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  await expect(page.getByRole("banner").getByRole("link").first()).toHaveText(secondServerName);
  await expect(page).toHaveTitle(`Threads · ${secondServerName}`);

  // Signing in to the second left the browser signed in to the first.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  await expect(page.getByRole("banner").getByRole("link").first()).toHaveText(serverName);

  // Both passkeys belong to the host; each one's user name says its server.
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId: device });
  expect(credentials.map((credential) => credential.rpId)).toEqual([hostName, hostName]);
  expect(credentials.map((credential) => credential.userName).sort()).toEqual(
    [`${serverName} · operator`, `${secondServerName} · operator`].sort(),
  );
});

test("the pages ran within the content security policy, without a page error", () => {
  expect(
    consoleMessages.filter((text) => /content security policy|page error/i.test(text)),
  ).toEqual([]);
});
