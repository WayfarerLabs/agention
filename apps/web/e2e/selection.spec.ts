// Selecting threads in the list and acting on them together, in Chromium
// against the real server, on a server of these tests' own: with a mouse, a
// checkbox beside each row and the header's, the bar marking the threads
// read, beside a thread too, and declining their asks before archiving them,
// which the agent reads; on a phone, holding a row down to select it, a tap
// selecting another in place of opening it, and the bar fitting the
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
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(message.text());
    }
  });
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
// The selection's actions in the bar at the list's foot, a group named by
// how many are selected.
const selected = () => page.getByRole("group", { name: / selected$/ });

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

test("with a mouse, checkboxes select threads, beside a thread too, and the bar marks them read and declines their asks first", async () => {
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
  await selected().getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(selected()).toBeHidden();
  await expect(rowOf("Notes")).not.toHaveClass(/unread/);
  await expect(rowOf("Logs")).not.toHaveClass(/unread/);
  await expect(rowOf("Ports")).toHaveClass(/unread/);

  // Beside a thread, the bar stays within the list's pane, and Escape
  // clears the selection.
  await rowOf("Notes").getByRole("link").click();
  await expect(page.getByRole("region", { name: "Thread", exact: true })).toBeVisible();
  await checkboxOf(2, "Ports").check();
  await expect(selected()).toBeVisible();
  await fitsWithin(selected(), list());
  await page.keyboard.press("Escape");
  await expect(selected()).toBeHidden();
  await expect(checkboxOf(2, "Ports")).not.toBeChecked();

  // The header checkbox selects every thread; declining asks first.
  await page.goto("/");
  await page.getByRole("checkbox", { name: "Select all" }).check();
  await selected().getByRole("button", { name: "Decline, mark read and archive" }).click();
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

test("on a phone, holding a row selects it, a tap selects another, and the bar's actions fit as they archive them", async () => {
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
    await expect(selected()).toBeVisible();
    await touch(rowOf("Phone two").getByRole("link"), 50);
    await expect(checkboxOf(5, "Phone two")).toBeChecked();
    // Neither opened its thread.
    expect(new URL(page.url()).pathname).toBe("/");
    await fitsWithin(selected(), page.locator("main"));

    await selected().getByRole("button", { name: "Mark read and archive", exact: true }).click();
    await expect(page.getByText("No threads to show.")).toBeVisible();
    // Focus the action left goes to the page's heading as the list empties.
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  } finally {
    await resize(page, wide);
  }
});

// The bars at the foot of the list and of a thread's page.
const listBar = () => page.getByRole("region", { name: "List actions" });
const threadBar = () => page.getByRole("region", { name: "Thread actions" });
const sendRow = () => page.locator(".composer .actions");

// boxOf is where an element is on screen.
async function boxOf(element: Locator) {
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  return box ?? { x: 0, y: 0, width: 0, height: 0 };
}

// oneRow says a bar's buttons and links stand on one row, within the
// screen's width, each a fingertip tall, with nothing to scroll sideways.
async function oneRow(bar: Locator, count: number): Promise<void> {
  const controls = bar.locator(".bar-button");
  await expect(controls).toHaveCount(count);
  const width = page.viewportSize()?.width ?? 0;
  const boxes = await Promise.all((await controls.all()).map(boxOf));
  for (const box of boxes) {
    expect(Math.abs(box.y - (boxes[0]?.y ?? 0))).toBeLessThanOrEqual(1);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  }
  await fitsWithin(bar, page.locator("main"));
}

// notCovered says the element with focus is the one on top at its middle.
async function notCovered(): Promise<void> {
  const [name, shown] = await page.evaluate(() => {
    const focused = document.activeElement as HTMLElement;
    const at = focused.getBoundingClientRect();
    const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
    return [focused.outerHTML.slice(0, 80), hit !== null && focused.contains(hit)];
  });
  expect(shown, `${name} is covered`).toBe(true);
}

test("on a phone, down to the narrowest, the list's bar holds its buttons on one row in both states, and the thread's bar its ways off the page, which work", async () => {
  test.setTimeout(120_000);
  const long = Array.from(
    { length: 12 },
    (_, index) => `Line ${index + 1} of what the agent found, long enough to wrap on a phone.`,
  ).join("\n\n");
  for (const [request, title, asks] of [
    ["bar-1", "Bar one", []],
    ["bar-2", "Bar two", ["Keep it?"]],
    ["bar-3", "Bar three", []],
  ] as const) {
    const answer = await agent.send("POST", threads, {
      request_id: request,
      title,
      text: long,
      ...(asks.length === 0 ? {} : { asks: asks.map((question) => ({ question })) }),
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  }
  const wide = page.viewportSize() ?? { width: 1280, height: 800 };
  const heading = page.getByRole("heading", { level: 1 });
  try {
    // Mark all read from the foot of a list scrolled down leaves the list
    // where it is, focus going to the page's heading as Select all is not
    // shown.
    await resize(page, { width: 390, height: 500 });
    await page.goto("/");
    await expect(rowOf("Bar two")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    const markAll = listBar().getByRole("button", { name: "Mark all read" });
    await markAll.click();
    await expect(markAll).toBeDisabled();
    await expect(heading).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

    for (const width of [390, 320]) {
      await resize(page, { width, height: 844 });
      await page.goto("/");
      await expect(rowOf("Bar two")).toBeVisible();
      await oneRow(listBar(), 2);
      await touch(rowOf("Bar one").getByRole("link"), 900);
      await expect(selected()).toBeVisible();
      await oneRow(listBar(), 5);
      await selected().getByRole("button", { name: "Clear selection" }).click();
      await expect(selected()).toBeHidden();

      // On the thread holding an ask, its bar holds four on one row, and
      // Archive all waits, saying why when pressed.
      await rowOf("Bar two").getByRole("link").click();
      await expect(heading).toHaveText(/Bar two/);
      await oneRow(threadBar(), 4);
      const archiveAll = threadBar().getByRole("button", { name: "Archive all", exact: true });
      await expect(archiveAll).toHaveAttribute("aria-disabled", "true");
      const why = threadBar().locator(".bar-caption");
      await expect(why).toBeHidden();
      await archiveAll.focus();
      await page.keyboard.press("Enter");
      await expect(why).toBeVisible();
      await expect(heading).toHaveText(/Bar two/);

      // A control in the messages focused from the keyboard is never under
      // the bar.
      await heading.focus();
      const messages = page.getByRole("region", { name: "Messages" });
      const inMessages = () =>
        messages.evaluate((region) => region.contains(document.activeElement));
      let reached = 0;
      for (let step = 0; step < 30; step += 1) {
        await page.keyboard.press("Tab");
        if (await inMessages()) {
          reached += 1;
          await notCovered();
        } else if (reached > 0) {
          break;
        }
      }
      expect(reached).toBeGreaterThan(0);

      // With the composer on screen, its Send row stands just above the
      // bar.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.getByRole("heading", { name: "Reply" }).scrollIntoViewIfNeeded();
      const [row, bar] = await Promise.all([boxOf(sendRow()), boxOf(threadBar())]);
      expect(row.y + row.height).toBeLessThanOrEqual(bar.y + 1);

      // Below, Above and Threads go where they say.
      await threadBar().getByRole("button", { name: "Thread below" }).click();
      await expect(heading).toHaveText(/Bar (one|three)/);
      await threadBar().getByRole("button", { name: "Thread above" }).click();
      await expect(heading).toHaveText(/Bar two/);
      await threadBar().getByRole("link", { name: "Back to threads" }).click();
      await expect(listBar()).toBeVisible();
    }

    // Writing on a short screen, as a phone's keyboard leaves it, the bar
    // rests under the composer, so the Send row holds the foot of the
    // screen, and floats again once the box is left.
    await resize(page, { width: 320, height: 520 });
    await rowOf("Bar three").getByRole("link").click();
    await expect(heading).toHaveText(/Bar three/);
    const box = page.getByLabel("Message", { exact: true });
    await box.focus();
    await box.evaluate((element) => element.scrollIntoView({ block: "end" }));
    await page.keyboard.type("Backfill them.");
    const row = await boxOf(sendRow());
    expect(row.y).toBeGreaterThanOrEqual(0);
    expect(row.y + row.height).toBeLessThanOrEqual(520);
    // The bar has stepped aside, below the screen, so the row stands at the
    // foot of the screen itself.
    const resting = await boxOf(threadBar());
    expect(resting.y).toBeGreaterThanOrEqual(520 - 1);
    expect(row.y + row.height).toBeGreaterThan(520 - resting.height / 2);
    await page.keyboard.press("Escape");
    await expect(threadBar()).toHaveCSS("position", "sticky");
    await box.fill("");

    // On a phone held sideways, too short for the Send row and the bar
    // together, the bar rests after the composer, and Send is never under
    // it.
    await resize(page, { width: 844, height: 390 });
    await expect(threadBar()).toHaveCSS("position", "static");
    await page.getByRole("heading", { name: "Reply" }).scrollIntoViewIfNeeded();
    const send = page.getByRole("button", { name: "Send", exact: true });
    const sendBox = await boxOf(send);
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(390);
    expect(
      await send.evaluate((button) => {
        const at = button.getBoundingClientRect();
        const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
        return hit !== null && button.contains(hit);
      }),
    ).toBe(true);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const [sideRow, sideBar] = await Promise.all([boxOf(sendRow()), boxOf(threadBar())]);
    expect(sideBar.y).toBeGreaterThanOrEqual(sideRow.y + sideRow.height - 1);
  } finally {
    await resize(page, wide);
  }
});

test("side by side, each pane's bar keeps to its pane, the list's on the screen before the page scrolls", async () => {
  await resize(page, { width: 1280, height: 800 });
  await page.goto("/");
  await rowOf("Bar one").getByRole("link").click();
  await expect(threadBar()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const [bar, pane] of [
    [listBar(), list()],
    [threadBar(), page.getByRole("region", { name: "Thread", exact: true })],
  ] as const) {
    await fitsWithin(bar, pane);
    const shown = await boxOf(bar);
    expect(shown.y + shown.height).toBeLessThanOrEqual(800 + 1);
  }
  // The list's bar covers the pane's foot, so no row shows beneath it.
  const [bar, pane] = await Promise.all([boxOf(listBar()), boxOf(list())]);
  expect(bar.y + bar.height).toBeGreaterThanOrEqual(pane.y + pane.height - 1);
});

test("the pages ran without a console error or a page error", () => {
  expect(problems).toEqual([]);
});
