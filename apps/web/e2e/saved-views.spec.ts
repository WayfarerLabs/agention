// Saved views in Chromium against the real server, on a server of these
// tests' own: a list with filters, an order and a grouping saved as a view
// and opened in another browser, its link, Back and a reload behaving as the
// list's address does; the view current with its values chosen in another
// order, and replaced only once asked; g v opening the sheet from a thread,
// side by side and on a phone, where its Save form and a Replace
// confirmation fit too; a view naming a tag renamed, and a group and a tag
// removed, kept narrow; and Settings' section renaming and removing views.
import type { BrowserContext, Page } from "@playwright/test";
import type {
  PublicKey,
  SavedView,
  SavedViewList,
  ThreadsView,
  WriteResult,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { Agent, callServer } from "./agent.ts";
import { signIn, threads } from "./files.ts";
import { type Agention, approve, expect, resize, test, withinTheScreen } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let agent: Agent;
let server: Agention;
// A key holding every scope but the saved views', which sets up the groups
// and tags.
let organizer: string;
const problems: string[] = [];

const wide = { width: 1280, height: 800 };
const phone = { width: 390, height: 844 };

// operatorApi calls the operator API with a key, as a program outside the
// browser does.
const operatorApi = <T>(secret: string, method: "GET" | "POST", path: string, body?: unknown) =>
  callServer<T>(
    server,
    method,
    `/api/operator/v1${path}`,
    `Bearer ${secret}`,
    body === undefined
      ? undefined
      : { type: "application/json", bytes: Buffer.from(JSON.stringify(body)) },
  );

// createKey creates an API key in Settings holding the scopes given, and
// returns its secret.
async function createKey(name: string, scopes: string[]): Promise<string> {
  await page.goto("/settings/api-keys");
  const section = page.getByRole("region", { name: "API keys" });
  await section.getByRole("button", { name: "Create an API key" }).click();
  await section.getByLabel("Name").fill(name);
  for (const scope of scopes) {
    await section.getByRole("checkbox", { name: scope }).check();
  }
  await section.getByRole("button", { name: "Create key" }).click();
  const secret = await section.getByLabel("API key", { exact: true }).inputValue();
  await section.getByRole("button", { name: "Done" }).click();
  return secret;
}

// write starts a thread as an agent, failing on anything the server refuses.
async function write(as: Agent, path: string, title: string): Promise<number> {
  const created = await as.send<WriteResult>("POST", path, {
    request_id: `r-${title.replaceAll(" ", "-")}`,
    title,
    text: title,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.number;
}

const savedViews = (on: Page = page) => on.getByRole("button", { name: /^Saved views/ });
const sheet = (on: Page = page) => on.getByRole("dialog", { name: "Saved views" });
const viewLink = (name: string, on: Page = page) =>
  sheet(on).getByRole("link", { name, exact: true });
const viewRow = (name: string) =>
  sheet()
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
// The titles of the rows the list shows.
const rowTitles = (on: Page = page) => on.locator("li.thread-row :is(h2, h3, h4, h5)");
// The headings of rows of these titles, each led by its number.
const titled = (...titles: string[]) => titles.map((title) => new RegExp(`^#\\d+ ${title}$`));
const here = (on: Page = page) => {
  const url = new URL(on.url());
  return url.pathname + url.search;
};

// saveAs saves the list on screen as a view under a name, from the sheet,
// which stays open with the view current.
async function saveAs(name: string): Promise<void> {
  await savedViews().click();
  await sheet().getByRole("button", { name: "Save as new view" }).click();
  await sheet().getByLabel("New view's name").fill(name);
  await sheet().getByRole("button", { name: "Save view" }).click();
  await expect(viewLink(name)).toHaveAttribute("aria-current", "true");
  await sheet().getByRole("button", { name: "Close" }).click();
  await expect(sheet()).toHaveCount(0);
}

// The views as a program reads them.
async function stored(): Promise<SavedView[]> {
  const answer = await operatorApi<SavedViewList>(organizer, "GET", "/saved-views");
  return answer.body.views;
}

test.beforeAll(async ({ browser, savedViewsServer }) => {
  server = savedViewsServer;
  ({ context, page, agent } = await signIn(browser, server));
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  // A second session, reviewer/side, beside builder/main.
  const reviewer = new Agent(server);
  await reviewer.send("POST", "/registrations", { agent: "reviewer", session: "side" });
  await page.goto("/sessions");
  await approve(page, registrationCode(reviewer.publicKey as PublicKey));
  await expect(page.getByRole("button", { name: /^Agent reviewer/ })).toBeVisible();
  for (const title of ["Billing totals", "Billing export"]) {
    await write(agent, threads, title);
  }
  await write(reviewer, "/s/reviewer/side/threads", "Review notes");
  // builder/main in group Work, tagged billing.
  organizer = await createKey("Organizer", ["threads:read", "sessions:write", "saved-views:read"]);
  const group = await operatorApi<{ id: number }>(organizer, "POST", "/groups", { name: "Work" });
  expect(group.status).toBe(200);
  for (const [path, body] of [
    ["/s/builder/main/group", { group: group.body.id }],
    ["/s/builder/main/tags", { tags: ["billing"] }],
  ] as const) {
    expect((await operatorApi(organizer, "POST", path, body)).status).toBe(200);
  }
});

test.afterAll(async () => {
  await context.close();
});

test("a list saved as a view opens in another browser, its link, Back and a reload behaving as the address's", async ({
  browser,
}) => {
  await resize(page, wide);
  // Filters from the address, and the order, its direction and the grouping
  // chosen in the head.
  await page.goto("/?agent=builder&unread=true");
  await page.getByRole("combobox", { name: "Sort" }).selectOption("Latest message");
  await page.locator(".list-head").getByRole("checkbox").check();
  await page.getByRole("combobox", { name: "Group" }).selectOption("Session");
  const address = "/?unread=true&agent=builder&sort=latest&reverse=true&group=session";
  await expect(page).toHaveURL(address);
  await expect(rowTitles()).toHaveText(titled("Billing totals", "Billing export"));
  await saveAs("Builder, by session");
  await expect(savedViews()).toHaveAttribute("aria-label", "Saved views, Builder, by session");

  // Another browser, signed in with the first's cookies, has no history or
  // storage of the first's.
  const elsewhere = await browser.newContext({ baseURL: server.origin, viewport: wide });
  try {
    await elsewhere.addCookies(await context.cookies());
    const other = await elsewhere.newPage();
    await other.goto("/");
    await expect(other.getByRole("heading", { level: 1 })).toHaveText("Threads");
    await expect(rowTitles(other)).toHaveCount(3);
    await savedViews(other).click();
    const link = viewLink("Builder, by session", other);
    await expect(link).toHaveAttribute("href", address);
    await link.click();
    await expect(other).toHaveURL(address);
    await expect(sheet(other)).toHaveCount(0);
    await expect(rowTitles(other)).toHaveText(titled("Billing totals", "Billing export"));
    await expect(other.getByRole("combobox", { name: "Group" })).toHaveValue("session");
    await expect(savedViews(other)).toHaveAttribute(
      "aria-label",
      "Saved views, Builder, by session",
    );
    // A reload shows the same list.
    await other.reload();
    await expect(rowTitles(other)).toHaveText(titled("Billing totals", "Billing export"));
    // One list at a time, as on a phone, Back returns to the list before, as
    // from any link to a list; side by side the list on screen is the
    // layout's own, which going back keeps (Threads.tsx, useKeptList).
    await resize(other, phone);
    await other.goto("/");
    await savedViews(other).click();
    await viewLink("Builder, by session", other).click();
    await expect(other).toHaveURL(address);
    await other.goBack();
    await expect(other).toHaveURL("/");
    await expect(rowTitles(other)).toHaveCount(3);
  } finally {
    await elsewhere.close();
  }
});

test("a view is current with its values chosen in another order, and changes only once replaced", async () => {
  await page.goto("/?agent=builder&agent=reviewer");
  await saveAs("Both agents");
  // The same filters in another order are the same list.
  await page.goto("/?agent=reviewer&agent=builder");
  await expect(savedViews()).toHaveAttribute("aria-label", "Saved views, Both agents");
  // Changing the list leaves the view as it was.
  await page.getByRole("combobox", { name: "Sort" }).selectOption("Created");
  await expect(savedViews()).toHaveAttribute("aria-label", "Saved views");
  const before = (await stored()).find((each) => each.name === "Both agents");
  await page.reload();
  expect((await stored()).find((each) => each.name === "Both agents")).toEqual(before);
  // Replacing it, once confirmed, saves the list on screen.
  await savedViews().click();
  await viewRow("Both agents").getByRole("button", { name: "Replace with this list" }).click();
  await viewRow("Both agents").getByRole("button", { name: "Cancel" }).click();
  expect((await stored()).find((each) => each.name === "Both agents")).toEqual(before);
  await viewRow("Both agents").getByRole("button", { name: "Replace with this list" }).click();
  await viewRow("Both agents").getByRole("button", { name: "Replace", exact: true }).click();
  await expect(viewLink("Both agents")).toHaveAttribute("aria-current", "true");
  const replaced = (await stored()).find((each) => each.name === "Both agents");
  expect(replaced?.view).toMatchObject({
    agent: ["reviewer", "builder"],
    sort: "created",
  } satisfies Partial<ThreadsView>);
  await sheet().getByRole("button", { name: "Close" }).click();
  await expect(savedViews()).toBeFocused();
});

test("g v opens the sheet from a thread, beside the list and on a phone, where saving and replacing fit the screen", async () => {
  await resize(page, wide);
  await page.goto(`${threads}/1`);
  await expect(page.getByRole("region", { name: "Thread", exact: true })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("v");
  await expect(viewLink("Both agents")).toBeVisible();
  await withinTheScreen(sheet());
  // Beside the list, the thread stays open.
  expect(here()).toBe(`${threads}/1`);
  await page.keyboard.press("Escape");
  await expect(sheet()).toHaveCount(0);

  await resize(page, phone);
  await page.goto(`${threads}/1`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("#1 Billing totals");
  await page.keyboard.press("g");
  await page.keyboard.press("v");
  await expect(viewLink("Both agents")).toBeVisible();
  await withinTheScreen(sheet());
  // On a phone the list comes first, the one the thread returns to.
  expect(here()).toBe("/");
  // Saving and replacing fit the phone's screen too.
  await sheet().getByRole("button", { name: "Save as new view" }).click();
  const name = sheet().getByLabel("New view's name");
  await expect(name).toBeFocused();
  for (const shown of [name, sheet().getByRole("button", { name: "Save view" })]) {
    await expect(shown).toBeInViewport({ ratio: 1 });
    await withinTheScreen(shown);
  }
  await sheet().getByRole("button", { name: "Cancel" }).click();
  await viewRow("Both agents").getByRole("button", { name: "Replace with this list" }).click();
  const confirm = viewRow("Both agents").getByRole("button", { name: "Replace", exact: true });
  await expect(confirm).toBeInViewport({ ratio: 1 });
  await withinTheScreen(viewRow("Both agents"));
  await viewRow("Both agents").getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Escape");
  await expect(sheet()).toHaveCount(0);
  await resize(page, wide);
});

test("a view naming a renamed tag keeps its threads, and one naming a removed group or tag keeps none", async () => {
  await page.goto("/?tag=billing");
  await expect(rowTitles()).toHaveCount(2);
  await saveAs("Billing");
  const groupId = (
    await operatorApi<{ groups: { id: number }[] }>(organizer, "GET", "/groups-and-tags")
  ).body.groups[0]?.id;
  await page.goto(`/?session_group=${groupId}`);
  await expect(rowTitles()).toHaveCount(2);
  await saveAs("Work");

  // Renamed, the tag is renamed in the view, which keeps its threads.
  expect(
    (await operatorApi(organizer, "POST", "/tags/billing/name", { name: "payments" })).status,
  ).toBe(200);
  await page.goto("/");
  await savedViews().click();
  await expect(viewLink("Billing")).toHaveAttribute("href", "/?tag=payments");
  await viewLink("Billing").click();
  await expect(page).toHaveURL("/?tag=payments");
  await expect(rowTitles()).toHaveCount(2);

  // Removed, the group and the tag keep the views narrow, their chips saying so.
  for (const path of [`/groups/${groupId}/remove`, "/tags/payments/remove"]) {
    expect((await operatorApi(organizer, "POST", path)).status).toBe(200);
  }
  for (const [name, chip] of [
    ["Work", "Removed group, keeping nothing"],
    ["Billing", "Removed tag payments, keeping nothing"],
  ] as const) {
    await page.goto("/");
    await savedViews().click();
    await viewLink(name).click();
    await expect(page.locator("button.chip")).toHaveAttribute(
      "aria-label",
      `Remove filter: ${chip}`,
    );
    await expect(page.getByText("No threads match these filters.")).toBeVisible();
  }
});

test("Settings' section renames and removes views, at a desktop's width and a phone's", async () => {
  for (const size of [wide, phone]) {
    await resize(page, size);
    await page.goto("/settings/saved-views");
    const section = page.getByRole("region", { name: "Saved views" });
    const row = (name: string) => section.getByRole("article", { name: `Saved view ${name}` });
    const renamed = size === wide ? "Old work" : "Older work";
    const from = size === wide ? "Work" : "Old work";
    await expect(row(from)).toBeVisible();
    await row(from).getByRole("button", { name: "Rename" }).click();
    await row(from).getByLabel("New name").fill(renamed);
    await row(from).getByRole("button", { name: "Save" }).click();
    await expect(row(renamed)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
  const section = page.getByRole("region", { name: "Saved views" });
  const row = section.getByRole("article", { name: "Saved view Older work" });
  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Remove this view" }).click();
  await expect(row).toHaveCount(0);
  expect((await stored()).map((each) => each.name)).not.toContain("Older work");
  await resize(page, wide);
});

test("the pages ran without a console error or a page error", () => {
  expect(problems).toEqual([]);
});
