// Settled threads in Chromium against the real server, on a server of these
// tests' own: an agent settles a thread, whose row says so in words down to
// the narrowest phone, and whose head says who settled it and when; and the
// operator filters the list to the Settled threads beside a thread, selects
// them all, and reads and archives them together, leaving the rest.
import type { BrowserContext, Page } from "@playwright/test";
import type { ThreadGetResult } from "@wayfarerlabs/agention-api";
import type { Agent } from "./agent.ts";
import { signIn, threads } from "./files.ts";
import { expect, resize, test, withinTheScreen } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let agent: Agent;
const problems: string[] = [];

// startThread starts a thread as the agent, answering its number.
async function startThread(request: string, title: string): Promise<number> {
  const answer = await agent.send<{ number: number }>("POST", threads, {
    request_id: request,
    title,
    text: "The integration test report.",
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.number;
}

// settle settles a thread as the agent, having read it to its latest
// message.
async function settle(number: number, text: string): Promise<void> {
  const read = await agent.send<ThreadGetResult>("GET", `${threads}/${number}`);
  const answer = await agent.send("POST", `${threads}/${number}/messages`, {
    request_id: `settle-${number}-${read.body.thread.last_seq}`,
    seen_through: read.body.thread.last_seq,
    text,
    settles: true,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

test.beforeAll(async ({ browser, settledServer }) => {
  ({ context, page, agent } = await signIn(browser, settledServer));
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
});

test.afterAll(async () => {
  await context.close();
  expect(problems).toEqual([]);
});

const heading = () => page.getByRole("heading", { level: 1 });
const rowOf = (title: string) =>
  page.locator("ul.threads > li").filter({ has: page.getByRole("heading", { name: title }) });
const settledLine = () => page.locator(".thread-header .thread-status.settled");

test("on a phone, down to the narrowest, a Settled thread's row and head say who settled it", async () => {
  const number = await startThread("phone-1", "Report on pull request 135, which merged today");
  await settle(number, "Pull request 135 merged, so this report is done.");
  const wide = page.viewportSize() ?? { width: 1280, height: 800 };
  try {
    for (const width of [390, 320]) {
      await resize(page, { width, height: 844 });
      await page.goto("/");
      const status = rowOf("Report on pull request 135").locator(".row-status");
      await expect(status).toBeVisible();
      await expect(status).toContainText("main");
      await withinTheScreen(status);
    }

    await rowOf("Report on pull request 135").getByRole("link").click();
    await expect(heading()).toHaveText(/Report on pull request 135/);
    await expect(settledLine()).toBeVisible();
    await expect(settledLine()).toContainText("main");
    await expect(settledLine().locator("time")).toHaveCount(1);
    await withinTheScreen(settledLine());
    await expect(page.locator(".event.settles")).toHaveCount(1);
  } finally {
    await resize(page, wide);
  }
});

test("beside a thread, the operator filters to Settled threads, selects them all, and reads and archives them together", async () => {
  const kept = await startThread("wide-1", "Still needs a look");
  for (const [request, title] of [
    ["wide-2", "Merged report"],
    ["wide-3", "Answered elsewhere"],
  ] as const) {
    await settle(await startThread(request, title), `${title}, so done.`);
  }
  const list = page.getByRole("region", { name: "Thread list" });
  const pane = page.getByRole("region", { name: "Thread", exact: true });
  await page.goto("/");
  await rowOf("Still needs a look").getByRole("link").click();
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText(/Still needs a look/);
  // The list beside the thread marks the Settled rows in words within its
  // pane.
  for (const title of ["Merged report", "Answered elsewhere"]) {
    await expect(
      list.locator("ul.threads > li", { hasText: title }).locator(".row-status"),
    ).toBeVisible();
  }

  await list.getByRole("button", { name: /^Filters/ }).click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await sheet
    .getByRole("group", { name: "Settled" })
    .getByRole("radio", { name: /^Only, 3 threads$/ })
    .check();
  await sheet.getByRole("button", { name: "Show 3 threads" }).click();
  await expect(sheet).toBeHidden();
  await expect(list.locator("button.chip")).toHaveCount(1);
  const rows = list.locator("ul.threads > li");
  // The thread the phone test settled is among them.
  await expect(rows).toHaveCount(3);

  await list.getByRole("checkbox", { name: "Select all" }).check();
  const selected = page.getByRole("group", { name: / selected$/ });
  await selected.getByRole("button", { name: "Mark read and archive", exact: true }).click();
  await expect(rows).toHaveCount(0);

  // Without the filter the list holds the thread the agent never settled,
  // and not those archived.
  await list.locator("button.chip").click();
  await expect(rowOf("Still needs a look")).toHaveCount(1);
  await expect(rowOf("Merged report")).toHaveCount(0);
  await expect(rowOf("Answered elsewhere")).toHaveCount(0);
  const read = await agent.send<ThreadGetResult>("GET", `${threads}/${kept}`);
  expect(read.body.thread).not.toHaveProperty("settled_by");
});
