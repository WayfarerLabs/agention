// Selecting threads in the list and acting on them together, in Chromium
// against the real server, on a server of these tests' own: with a mouse, a
// checkbox beside each row and the header's, the toolbar marking the threads
// read, beside a thread too, and declining their asks before archiving them,
// which the agent reads; on a phone, holding a row down to select it, a tap
// selecting another in place of opening it, and the toolbar fitting the
// screen as it archives them.
import type { BrowserContext, CDPSession, Locator, Page } from "@playwright/test";
import type { ThreadGetResult } from "@wayfarerlabs/agention-api";
import type { Agent } from "./agent.ts";
import { signIn, threads } from "./files.ts";
import { expect, resize, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let agent: Agent;
let cdp: CDPSession;
const problems: string[] = [];

// startThread starts a thread as the agent, with asks if given.
async function startThread(request: string, title: string, asks: string[] = []) {
  const answer = await agent.send("POST", threads, {
    request_id: request,
    title,
    text: "Have a look.",
    ...(asks.length === 0 ? {} : { asks: asks.map((question) => ({ question })) }),
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

test.beforeAll(async ({ browser, selectionServer }) => {
  ({ context, page, agent } = await signIn(browser, selectionServer));
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  cdp = await context.newCDPSession(page);
  await startThread("select-1", "Notes");
  await startThread("select-2", "Ports", ["Open 8080?", "Or 8443?"]);
  await startThread("select-3", "Logs");
});

test.afterAll(async () => {
  await context.close();
});

const list = () => page.getByRole("region", { name: "Thread list" });
const rowOf = (title: string) =>
  page.locator("ul.threads > li").filter({ has: page.getByRole("heading", { name: title }) });
const checkboxOf = (number: number, title: string) =>
  page.getByRole("checkbox", { name: `#${number} ${title}`, exact: true });
// The toolbar, a group named by how many are selected.
const toolbar = () => page.getByRole("group", { name: / selected$/ });

// fitsWithin says an element lies within an area's width, and the page has
// nothing to scroll sideways.
async function fitsWithin(element: Locator, area: Locator): Promise<void> {
  const [shown, around] = await Promise.all([element.boundingBox(), area.boundingBox()]);
  expect(shown).not.toBeNull();
  expect(shown?.x ?? -1).toBeGreaterThanOrEqual((around?.x ?? 0) - 1);
  expect((shown?.x ?? 0) + (shown?.width ?? 0)).toBeLessThanOrEqual(
    (around?.x ?? 0) + (around?.width ?? 0) + 1,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

// touch puts a finger on the middle of an element for hold milliseconds,
// then lifts it, as Chromium's touch emulation takes it.
async function touch(element: Locator, hold: number): Promise<void> {
  const box = await element.boundingBox();
  const point = { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + 24 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(hold);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("with a mouse, checkboxes select threads, beside a thread too, and the toolbar marks them read and declines their asks first", async () => {
  await page.goto("/");
  await expect(page.locator("input.row-select")).toHaveCount(3);
  // Each checkbox stands at the start of its row, beside its link.
  const [box, link] = await Promise.all([
    checkboxOf(1, "Notes").boundingBox(),
    rowOf("Notes").getByRole("link").boundingBox(),
  ]);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(link?.x ?? 0);

  await checkboxOf(1, "Notes").check();
  await checkboxOf(3, "Logs").check();
  await toolbar().getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(toolbar()).toBeHidden();
  await expect(rowOf("Notes")).not.toHaveClass(/unread/);
  await expect(rowOf("Logs")).not.toHaveClass(/unread/);
  await expect(rowOf("Ports")).toHaveClass(/unread/);

  // Beside a thread, the toolbar stays within the list's pane, and Escape
  // clears the selection.
  await rowOf("Notes").getByRole("link").click();
  await expect(page.getByRole("region", { name: "Thread", exact: true })).toBeVisible();
  await checkboxOf(2, "Ports").check();
  await expect(toolbar()).toBeVisible();
  await fitsWithin(toolbar(), list());
  await page.keyboard.press("Escape");
  await expect(toolbar()).toBeHidden();
  await expect(checkboxOf(2, "Ports")).not.toBeChecked();

  // The header checkbox selects every thread; declining asks first.
  await page.goto("/");
  await page.getByRole("checkbox", { name: "Select all" }).check();
  await toolbar().getByRole("button", { name: "Decline, mark read and archive" }).click();
  await page.getByRole("button", { name: "Decline, mark read and archive" }).click();
  await expect(page.getByText("No threads to show.")).toBeVisible();
  const read = await agent.send<ThreadGetResult>("GET", `${threads}/2`);
  expect(read.body.messages.at(-1)).toMatchObject({
    author: { kind: "person" },
    answers: [
      { ask: 1, declined: true },
      { ask: 2, declined: true },
    ],
  });
});

test("on a phone, holding a row selects it, a tap selects another, and the toolbar fits as it archives them", async () => {
  await startThread("select-4", "Phone one");
  await startThread("select-5", "Phone two");
  const wide = page.viewportSize() ?? { width: 1280, height: 800 };
  await resize(page, { width: 390, height: 844 });
  try {
    await page.goto("/");
    await expect(rowOf("Phone one")).toBeVisible();
    await expect(page.locator("input.row-select")).toHaveCount(0);

    await touch(rowOf("Phone one").getByRole("link"), 900);
    await expect(checkboxOf(4, "Phone one")).toBeChecked();
    await expect(toolbar()).toBeVisible();
    await touch(rowOf("Phone two").getByRole("link"), 50);
    await expect(checkboxOf(5, "Phone two")).toBeChecked();
    // Neither opened its thread.
    expect(new URL(page.url()).pathname).toBe("/");
    await fitsWithin(toolbar(), page.locator("main"));

    await toolbar().getByRole("button", { name: "Mark read and archive" }).click();
    await expect(page.getByText("No threads to show.")).toBeVisible();
  } finally {
    await resize(page, wide);
  }
});

test("the pages ran without a page error", () => {
  expect(problems).toEqual([]);
});
