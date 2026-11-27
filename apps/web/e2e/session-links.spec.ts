// Links to a session's own page, in Chromium against the real server, on a
// server of these tests' own: the thread list's chip naming one session,
// whose link Tab reaches after its button; a session's header in the list
// grouped by session, whose link a click reaches over the header's fold;
// and, at a phone's width, a header whose long session name wraps its label,
// the link keeping to the end of the label's first row so a tap on the
// label's text lands on the label.
import type { BrowserContext, Page } from "@playwright/test";
import type { PublicKey } from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { Agent } from "./agent.ts";
import { signIn, threads } from "./files.ts";
import { approve, expect, resize, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;

// A session name as long as a name may be, 63 characters.
const longName = "release-notes-for-the-quarterly-billing-ledger-migration-launch";

const sessionHeading = () =>
  page.getByRole("region", { name: "Session", exact: true }).getByRole("heading", { level: 1 });

test.beforeAll(async ({ browser, sessionLinksServer: server }) => {
  let agent: Agent;
  ({ context, page, agent } = await signIn(browser, server));
  const started = await agent.send("POST", threads, {
    request_id: "links-main",
    title: "Main's thread",
    text: "Have a look.",
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  // The Sessions tab, opened afresh, lists the registration.
  await page.goto("/");
  const long = new Agent(server);
  const registered = await long.send("POST", "/registrations", {
    agent: "builder",
    session: longName,
  });
  expect(registered.status, JSON.stringify(registered.body)).toBeLessThan(300);
  await approve(page, registrationCode(long.publicKey as PublicKey));
  const other = await long.send("POST", `/s/builder/${longName}/threads`, {
    request_id: "links-long",
    title: "The long session's thread",
    text: "Have a look.",
  });
  expect(other.status, JSON.stringify(other.body)).toBe(200);
});

test.afterAll(async () => {
  await context.close();
});

test("the chip naming one session leads to its page from a link Tab reaches after the chip", async () => {
  await page.goto("/?session=builder/main");
  await page.getByRole("button", { name: "Remove filter: Session builder/main" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Open session builder/main" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sessions\/builder\/main$/);
  await expect(sessionHeading()).toContainText("builder/main");
});

test("a session's header leads to its page, its link reached over the header's fold", async () => {
  await page.goto("/?group=session");
  const fold = page.getByRole("button", { name: "Agent builder Session main" });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await page
    .locator(".group-head", { has: fold })
    .getByRole("link", { name: "Open session builder/main" })
    .click();
  await expect(page).toHaveURL(/\/sessions\/builder\/main$/);
  await expect(sessionHeading()).toContainText("builder/main");
});

test("at a phone's width a long session name wraps its header's label, a tap on the label's text landing on the label", async () => {
  await resize(page, { width: 390, height: 844 });
  await page.goto("/?group=session");
  const head = page.locator(".group-head", {
    has: page.getByRole("button", { name: `Agent builder Session ${longName}` }),
  });
  const name = head.locator(".group-label .path-name").filter({ hasText: longName });
  await expect(name).toBeVisible();
  // Each line of the session's name, at its middle, is the label's link,
  // never the link to the session's page.
  const hits = await name.evaluate((element) =>
    Array.from(element.getClientRects()).map((line) => {
      const hit = document.elementFromPoint(line.left + line.width / 2, line.top + line.height / 2);
      return hit?.closest("a")?.classList.contains("session-page-link") ?? null;
    }),
  );
  expect(hits.length).toBeGreaterThan(1);
  expect(hits.every((hit) => hit === false)).toBe(true);
  // The link stays on the label's first row, after it.
  const [label, link] = await Promise.all([
    name.boundingBox(),
    head.getByRole("link", { name: `Open session builder/${longName}` }).boundingBox(),
  ]);
  expect(link?.x ?? 0).toBeGreaterThanOrEqual((label?.x ?? 0) + (label?.width ?? 0) - 1);
  expect(link?.y ?? 0).toBeLessThan((label?.y ?? 0) + (label?.height ?? 0) / 2);
});
