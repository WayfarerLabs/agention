// Pull requests and branches in Chromium against the real server, on a server
// of these tests' own: at a phone's width, a message naming one shows it on
// its line, linked; one naming several folds them to a count that unfolds;
// the thread's roll-up folds in its head; and a long branch name wraps rather
// than widening the page. An edit in the web UI of a message a program wrote
// through the operator API keeps its references, pull requests and branches,
// and the thread's roll-up with them.
import type { BrowserContext, Page } from "@playwright/test";
import type { ThreadGetResult, WriteResult } from "@wayfarerlabs/agention-api";
import { type Agent, callServer } from "./agent.ts";
import { signIn, threads } from "./files.ts";
import { type Agention, expect, resize, test } from "./fixtures.ts";

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

const message = (seq: number) =>
  page.getByRole("article", { name: new RegExp(`^Message ${seq} `) });

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

  await resize(page, { width: 390, height: 844 });
  await page.goto(thread);

  const one = message(1).getByRole("link", { name: "acme/agention#135" });
  await expect(one).toBeVisible();
  await expect(one).toHaveAttribute("href", pull.url);

  const fold = message(2).getByRole("button", { name: "2 pull requests, 1 branch" });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect(message(2).getByRole("listitem")).toHaveCount(3);
  await expect(message(2).getByText(`acme/agention:${long.branch}`)).toBeVisible();

  const head = page.getByRole("button", { name: "Pull requests and branches (3)" });
  await head.click();
  const region = page.getByRole("region", { name: "Pull requests and branches" });
  await expect(region.getByRole("listitem")).toHaveCount(3);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
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
