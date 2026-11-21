// The web UI in Chromium against the real server: the server's name in the
// banner and titles, linking the first passkey, approving an agent, answering
// its asks, a message's detail folded under its text and the composer's
// Details box, a stale write, text written to take the page down, reading and
// marking unread from a message, archiving, the list's filters, their counts,
// its order, the order's direction and grouping, an ask the agent withdraws,
// the sessions view with a session's status and log, at a phone's width too,
// a thread the operator starts there and stranded's reason, signing in again, a second passkey that takes over from the first, and a
// second server on another port of the host signed in beside the first. CDP
// virtual authenticators stand in for the operator's devices; one page
// carries through the steps, in order.
import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import type {
  PublicKey,
  RegistrationState,
  SessionStatus,
  ThreadGetResult,
  WriteResult,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { Agent } from "./agent.ts";
import { expect, hostName, secondServerName, serverName, test } from "./fixtures.ts";

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

const showList = () => page.getByRole("link", { name: "Threads", exact: true }).click();

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
  await expect(page.locator(".empty")).toBeVisible();
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

  await page.getByRole("link", { name: "Sessions" }).click();
  const card = page.getByRole("article", { name: `Registration ${code}` });
  await expect(card.getByText(code, { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Approve" }).click();
  // The registration leaves the waiting list, approved, among the past
  // requests folded under the session that now stands under its agent.
  await expect(
    page.getByRole("region", { name: "Waiting for approval" }).getByRole("article"),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Agent builder/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^main( |$)/ })).toBeVisible();
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
  await page.keyboard.press("Space");
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(first.getByRole("heading", { name: "Rollback plan" })).toHaveCount(0);

  // Each answer is written on its ask's card, which leads with the ask's
  // number: a radio button for each suggested answer, and Other for the
  // operator's own words. Both answers go in one message, beside which the
  // box holds additional information.
  const ask = page.getByRole("region", { name: "Ask 1: Ship it today?" });
  const tag = page.getByRole("region", { name: "Ask 2: Tag the release?" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await ask.getByRole("radio", { name: "Hold" }).check();
  await ask.getByRole("radio", { name: "Other" }).check();
  await expect(ask.getByRole("radio", { name: "Hold" })).not.toBeChecked();
  await expect(send).toBeDisabled();
  await ask.getByRole("textbox", { name: "Other" }).fill("Hold until Monday.");
  await tag.getByRole("radio", { name: "Skip" }).check();
  const reply = page.getByRole("region", { name: "Reply" });
  await reply.getByRole("textbox").fill("Notes are late.");
  // The Details box folds under the message box until opened.
  await reply.getByRole("button", { name: "Details", exact: true }).click();
  await reply.getByRole("textbox", { name: "Details" }).fill("The changelog is in **review**.");
  // Sending goes back to the list unless the operator chooses to stay.
  await expect(reply.getByRole("checkbox", { name: "Go back after sending" })).toBeChecked();
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

  const read = await agent.send<ThreadGetResult>("GET", `${threads}/1`);
  expect(read.body.thread.title).toBe(title);
  expect(read.body.messages[0]).toMatchObject({ text, detail });
  expect(read.body.messages.at(-1)).toMatchObject({
    author: { kind: "person", name: "operator" },
    text: "Notes are late.",
    detail: "The changelog is in **review**.",
    answers: [
      { ask: 1, declined: false, text: "Hold until Monday." },
      { ask: 2, declined: false, picks: [1], labels: ["Skip"] },
    ],
  });
});

test("a write the agent overtakes keeps the draft and sends after one action", async () => {
  // Staying on the page after sending is a choice this browser keeps.
  const goBack = page
    .getByRole("region", { name: "Reply" })
    .getByRole("checkbox", { name: "Go back after sending" });
  await goBack.uncheck();
  await page.reload();
  await expect(goBack).not.toBeChecked();
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
  await expect(page.getByRole("status")).toBeVisible();

  const read = await agent.send<ThreadGetResult>("GET", `${threads}/1`);
  expect(read.body.messages.at(-1)).toMatchObject({ author: { kind: "person" }, text: draft });
  expect(read.body.cursors.audience).toBe(read.body.thread.last_seq);
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
  await expect(page.getByRole("link", { name: "Threads", exact: true })).toBeVisible();
});

test("opening a thread reads it, and marking it unread from a message returns it to the list", async () => {
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "create-notes",
    title: "Release notes are up",
    text: "In the usual place.",
  });
  expect(created.body).toEqual({ number: 3, seq: 1 });

  await showList();
  await page.getByRole("heading", { name: "Release notes are up" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("#3 Release notes are up");
  await expect
    .poll(async () => (await agent.send<ThreadGetResult>("GET", `${threads}/3`)).body.cursors)
    .toEqual({ requester: 1, audience: 1 });

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
  const read = await agent.send<ThreadGetResult>("GET", `${threads}/3`);
  expect(read.body.cursors.audience).toBe(0);
});

test("archiving a thread takes it off the list until archived threads are included", async () => {
  await page.getByRole("heading", { name: "Release notes are up" }).click();
  await page.getByRole("button", { name: "Archive all", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  await expect(page.getByRole("heading", { name: "Deep text" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release notes are up" })).toHaveCount(0);

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
  // The button beside it reverses it, from the keyboard as from a pointer,
  // keeping focus, and choosing another order takes that order's own
  // direction.
  const newest = page.getByRole("button", { name: "Newest first, reverse to oldest first" });
  const oldest = page.getByRole("button", { name: "Oldest first, reverse to newest first" });
  await newest.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\?sort=latest&reverse=true$/);
  await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(`#1 ${title}`);
  await expect(oldest).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/\?sort=latest$/);
  await newest.click();
  await expect(page).toHaveURL(/\?sort=latest&reverse=true$/);
  await page.getByRole("combobox", { name: "Sort" }).selectOption("Created");
  await expect(page).toHaveURL(/\?sort=created$/);
  await expect(newest).toBeVisible();
  await page.getByRole("combobox", { name: "Sort" }).selectOption("Latest message");

  await filters.click();
  await sheet.getByRole("searchbox").fill("deep");
  await expect(page).toHaveURL(/search=deep/);
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
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Release notes are up" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeVisible();

  // Grouped by session, the list folds under each session's header, which
  // collapses what it holds.
  await page.getByRole("combobox", { name: "Group" }).selectOption("Session");
  await expect(page).toHaveURL(/\/\?sort=latest&group=session$/);
  const session = page.getByRole("button", { name: /^Agent builder Session main, \d+ threads?/ });
  await expect(session).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeVisible();
  await session.click();
  await expect(session).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { name: `#1 ${title}`, exact: true })).toBeHidden();
  await session.click();
  await page.getByRole("combobox", { name: "Group" }).selectOption("Flat");
  await page.getByRole("combobox", { name: "Sort" }).selectOption("Priority");
  await expect(page).toHaveURL(/\/$/);
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

  await page.getByRole("link", { name: "Sessions" }).click();
  const fold = page.getByRole("button", { name: /^main Retire invoices 60%/ });
  const row = page.getByRole("listitem").filter({ has: fold });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(row.getByText("Idle", { exact: true })).toBeVisible();
  await expect(row.getByTitle("4 unread updates")).toBeVisible();
  await expect(row.getByText("Waiting on CI")).toBeVisible();

  // Unfolded, the log shows newest first, the two updates of progress alone
  // in one line, and reads it.
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const log = row.getByRole("list", { name: "Updates" });
  await expect(log.getByRole("listitem")).toHaveCount(3);
  await expect(log.getByRole("listitem").nth(1)).toContainText(/20%.*60%/);
  await expect(row.getByTitle("4 unread updates")).toHaveCount(0);

  // At a phone's width, the view and its sheet scroll only up and down.
  const wide = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
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
  await sheet.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Keep the archive$/);
  if (wide !== null) {
    await page.setViewportSize(wide);
  }
  const number = Number(new URL(page.url()).pathname.split("/").at(-1));

  // The agent reads the thread as the operator's own words.
  const read = await agent.send<ThreadGetResult>("GET", `${threads}/${number}`);
  expect(read.body.messages[0]?.author.kind).toBe("person");
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

test("signing in with the passkey returns to the page that needed it", async () => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.goto(`${threads}/1`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe(`${threads}/1`);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`#1 ${title}`);
  expect(new URL(page.url()).pathname).toBe(`${threads}/1`);
});

test("a passkey added on a second device signs in, and the first is removed", async () => {
  await page.getByRole("link", { name: "Passkeys" }).click();
  await expect(page.getByRole("article", { name: "Passkey Laptop" })).toBeVisible();

  // The laptop's authenticator gives way to the phone's.
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: device });
  device = await newDevice();
  await page.getByLabel("Passkey name").fill("Phone");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("article", { name: "Passkey Phone" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/passkeys");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
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
