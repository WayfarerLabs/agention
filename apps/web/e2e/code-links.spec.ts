// Pull requests and branches in Chromium against the real server, on a
// server of these tests' own. At a phone's width: a message naming one shows
// it on its line, leading to the list filtered by it, its forge link beside
// it; one naming several folds them to a count that unfolds; the thread's
// roll-up folds in its head; and a long branch name wraps rather than
// widening the page. Then the list: narrowed to one pull request from the
// filter sheet, its chip shown, and a copied address opening the same list;
// narrowed from a message to every session's threads naming it; and its rows
// at a phone's width, one entry shown, without a forge link, and several
// counted. An edit in the web UI of a message a program wrote through the
// operator API keeps its references, pull requests and branches, and the
// thread's roll-up with them.
import type { BrowserContext, Page } from "@playwright/test";
import type { PublicKey, ThreadGetResult, WriteResult } from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { Agent, callServer } from "./agent.ts";
import { signIn, threads } from "./files.ts";
import { type Agention, approve, expect, resize, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let agent: Agent;
let server: Agention;

const pull = {
  repo: "acme/agention",
  number: 135,
  url: "https://github.com/acme/agention/pull/135",
};
const long = { repo: "acme/agention", branch: `feat_${"x".repeat(200)}` };

// The list a message's pull request 135 leads to.
const pullList = "/?pull_request=acme/agention%23135";

const phone = { width: 390, height: 844 };

const message = (seq: number) =>
  page.getByRole("article", { name: new RegExp(`^Message ${seq} `) });
const row = (title: string) =>
  page.locator("li.thread-row").filter({ has: page.getByRole("heading", { name: title }) });
const fitsTheWidth = () =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.beforeAll(async ({ browser, linksServer }) => {
  server = linksServer;
  ({ context, page, agent } = await signIn(browser, server));
});

test.afterAll(async () => {
  await context.close();
});

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

// createKey creates an API key in Settings that writes threads, and returns
// its secret.
async function createKey(): Promise<string> {
  await page.goto("/settings/api-keys");
  const section = page.getByRole("region", { name: "API keys" });
  await section.getByRole("button", { name: "Create an API key" }).click();
  await section.getByLabel("Name").fill("Program");
  await section.getByRole("checkbox", { name: "threads:write" }).check();
  await section.getByRole("button", { name: "Create key" }).click();
  const secret = await section.getByLabel("API key", { exact: true }).inputValue();
  await section.getByRole("button", { name: "Done" }).click();
  return secret;
}

test("a message's and a thread's pull requests and branches show compactly on a phone", async () => {
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "links-1",
    title: "Links",
    text: "About one pull request.",
    pull_requests: [pull],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const thread = `${threads}/${created.body.number}`;
  const sent = await agent.send<WriteResult>("POST", `${thread}/messages`, {
    request_id: "links-2",
    seen_through: 1,
    text: "About several.",
    pull_requests: [pull, { repo: "acme/agention", number: 136 }],
    branches: [long],
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);

  await resize(page, phone);
  await page.goto(thread);

  // The one entry leads to the list filtered by it, its forge link beside it.
  const one = message(1).locator(".code-links").getByRole("link");
  await expect(one).toHaveCount(2);
  await expect(one.first()).toHaveAttribute("href", pullList);
  await expect(one.nth(1)).toHaveAttribute("href", pull.url);
  await expect(one.nth(1)).toHaveAttribute("target", "_blank");
  await expect(one.nth(1)).toBeVisible();

  const fold = message(2).getByRole("button", { name: "2 pull requests, 1 branch" });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect(message(2).getByRole("listitem")).toHaveCount(3);
  await expect(message(2).getByText(`acme/agention:${long.branch}`)).toBeVisible();

  const head = page.getByRole("button", { name: "Pull requests and branches (3)" });
  await head.click();
  const region = page.getByRole("region", { name: "Pull requests and branches" });
  await expect(region.getByRole("listitem")).toHaveCount(3);

  expect(await fitsTheWidth()).toBe(true);
});

test("the list narrows to one pull request from the sheet, from a copied address, and from a message", async () => {
  // A thread of another session naming the same pull request, and one of
  // this session naming another.
  const other = new Agent(server);
  await other.send("POST", "/registrations", { agent: "reviewer", session: "side" });
  await resize(page, { width: 1280, height: 800 });
  await page.goto("/sessions");
  await approve(page, registrationCode(other.publicKey as PublicKey));
  await expect(page.getByRole("button", { name: /^Agent reviewer/ })).toBeVisible();
  const reviewed = await other.send<WriteResult>("POST", "/s/reviewer/side/threads", {
    request_id: "links-3",
    title: "Review",
    text: "Reviewing it.",
    pull_requests: [
      { repo: "Acme/Agention", number: 135, url: "https://github.com/Acme/Agention/pull/135" },
    ],
  });
  expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  const elsewhere = await agent.send<WriteResult>("POST", threads, {
    request_id: "links-4",
    title: "Elsewhere",
    text: "Another one.",
    pull_requests: [{ repo: "acme/agention", number: 200 }],
  });
  expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(200);

  // From the sheet: the chip shows it, and the list holds only the threads
  // naming it, of both sessions.
  await page.goto("/");
  await page.getByRole("button", { name: /^Filters/ }).click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await sheet.getByRole("button", { name: /^Pull request / }).click();
  await sheet.getByRole("checkbox", { name: /^Acme\/Agention#135, 2 threads$/ }).check();
  await expect(page).toHaveURL(/\/\?pull_request=Acme\/Agention%23135$/);
  await sheet.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  const chip = page.locator("button.chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("Acme/Agention#135");
  const listed = page.getByRole("heading", { level: 2 });
  await expect(listed).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Elsewhere" })).toHaveCount(0);

  // A copied address opens the same list, in a page of its own.
  const opened = await context.newPage();
  try {
    await opened.goto(page.url());
    await expect(opened.locator("button.chip")).toContainText("Acme/Agention#135");
    await expect(opened.getByRole("heading", { level: 2 })).toHaveCount(2);
  } finally {
    await opened.close();
  }

  // From a message: its entry opens the list of every session's threads
  // naming it, the list the thread was opened from giving only its order.
  await page.goto("/?agent=builder&sort=latest");
  await row("Links").locator("a.thread-link").click();
  await message(1).locator(".code-links").getByRole("link").first().click();
  await expect(page).toHaveURL(/\/\?pull_request=acme\/agention%23135&sort=latest$/);
  await expect(listed).toHaveCount(2);
  await expect(row("Review")).toBeVisible();
  await expect(row("Links")).toBeVisible();
});

test("a row shows its one pull request, or counts several, at a phone's width", async () => {
  await resize(page, phone);
  await page.goto("/");
  // Review names one pull request, shown beneath the row's link without its
  // forge link, though it has a URL.
  const review = row("Review").locator(".row-code-links");
  await expect(review.getByRole("link")).toHaveCount(1);
  await expect(review.getByRole("link")).toHaveAttribute(
    "href",
    "/?pull_request=Acme/Agention%23135",
  );
  // Links names two pull requests and a branch: one mark counting them among
  // the row's marks, within its link, and no entry.
  await expect(row("Links").locator(".row-code-links")).toHaveCount(0);
  await expect(
    row("Links").locator("a.thread-link .marks .mark").filter({ hasText: "3" }),
  ).toBeVisible();
  expect(await fitsTheWidth()).toBe(true);
  // With a mouse, beside the row's checkbox, the entry stands beneath the
  // link, lined up with the row's heading.
  await resize(page, phone, false);
  await expect(row("Review").locator(".row-select")).toBeVisible();
  const icon = await review.locator(".icon").boundingBox();
  const link = await row("Review").locator("a.thread-link").boundingBox();
  const heading = await row("Review").getByRole("heading").boundingBox();
  expect(icon!.y).toBeGreaterThanOrEqual(link!.y + link!.height - 1);
  expect(Math.abs(icon!.x - heading!.x)).toBeLessThanOrEqual(1);
  expect(await fitsTheWidth()).toBe(true);
  // Following a row's entry narrows the list on screen.
  await review.getByRole("link").click();
  await expect(page).toHaveURL(/\/\?pull_request=Acme\/Agention%23135$/);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2);
});

test("an edit in the web UI keeps the references, pull requests and branches a program wrote", async () => {
  await resize(page, { width: 1280, height: 800 });
  const secret = await createKey();
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "edits-1",
    title: "Edits",
    text: "Which branch should I watch?",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const thread = `${threads}/${created.body.number}`;
  const kept = {
    references: [{ label: "CI run", url: "https://ci.example.com/runs/7" }],
    pull_requests: [pull],
    branches: [{ repo: "acme/agention", branch: "feat/links" }],
  };
  const sent = await operatorApi<WriteResult>(secret, "POST", `${thread}/messages`, {
    request_id: "edits-2",
    seen_through: 1,
    text: "Watch this one.",
    ...kept,
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);

  await page.goto(thread);
  await page.getByRole("button", { name: "Options for message 2" }).click();
  await message(2).getByRole("button", { name: "Edit", exact: true }).click();
  const composer = page.getByRole("region", { name: "Reply" });
  const box = composer.getByRole("textbox", { name: "Message" });
  await expect(box).toHaveValue("Watch this one.");
  await box.fill("Watch this one, please.");
  await composer.getByRole("combobox", { name: "After sending" }).selectOption("stay");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(message(3).getByRole("link", { name: "CI run" })).toBeVisible();
  await expect(message(3).getByRole("button", { name: "1 pull request, 1 branch" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pull requests and branches (2)" })).toBeVisible();

  const read = await operatorApi<ThreadGetResult>(secret, "GET", thread);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const replacement = read.body.messages.find((each) => each.seq === 3);
  expect(replacement).toMatchObject({ replaces: 2, text: "Watch this one, please." });
  expect({
    references: replacement?.references,
    pull_requests: replacement?.pull_requests,
    branches: replacement?.branches,
  }).toEqual(kept);
  expect(read.body.pull_requests.links).toEqual(kept.pull_requests);
  expect(read.body.branches.links).toEqual(kept.branches);
});
