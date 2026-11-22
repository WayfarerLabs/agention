// API keys in Chromium against the real server, on a server of these tests'
// own: a key created in Settings shows its secret once, which copies, and
// the secret calls the operator API from outside the browser within the
// key's scopes until the key is revoked; and the section, its form and a new
// secret fit a phone's width.
import type { BrowserContext, Page } from "@playwright/test";
import { apiKeySecret } from "@wayfarerlabs/agention-api";
import { type Answer, callServer } from "./agent.ts";
import { type Agention, expect, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let server: Agention;
const problems: string[] = [];

const wide = { width: 1280, height: 800 };
const phone = { width: 390, height: 844 };

test.beforeAll(async ({ browser, keysServer }) => {
  server = keysServer;
  context = await browser.newContext({ baseURL: server.origin, viewport: wide });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
  page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  // The operator signs in, so the sign-in is recent.
  await page.goto(server.passkeyLink());
  await page.getByLabel("Passkey name").fill("Laptop");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
});

test.afterAll(async () => {
  await context.close();
});

const section = () => page.getByRole("region", { name: "API keys" });

// operatorApi calls the operator API with a key, as a client outside the
// browser does.
const operatorApi = (secret: string, path: string): Promise<Answer> =>
  callServer(server, "GET", `/api/operator/v1${path}`, `Bearer ${secret}`);

// expectNoOverflow says nothing runs off the side of the page.
async function expectNoOverflow() {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("a key created in Settings shows its secret once, reads within its scope, and is refused once revoked", async () => {
  await page.goto("/settings/api-keys");
  await section().getByRole("button", { name: "Create an API key" }).click();
  await section().getByLabel("Name").fill("Reader");
  await section().getByRole("checkbox", { name: "sessions:read" }).check();
  await section().getByLabel("Expiry", { exact: true }).selectOption("7");
  await section().getByRole("button", { name: "Create key" }).click();

  const field = section().getByLabel("API key", { exact: true });
  await expect(field).toBeFocused();
  const secret = await field.inputValue();
  expect(apiKeySecret.safeParse(secret).success).toBe(true);
  await section().getByRole("button", { name: "Copy" }).click();
  await expect(section().getByRole("status")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(page.url()).not.toContain(secret);

  // Dismissed, the secret is gone from the page, and focus is on the new key.
  await section().getByRole("button", { name: "Done" }).click();
  const key = section().getByRole("article", { name: "API key Reader" });
  await expect(key.getByRole("heading")).toBeFocused();
  expect(await page.content()).not.toContain(secret);
  await expect(key.getByRole("list", { name: "Scopes" }).getByRole("listitem")).toHaveText([
    "sessions:read",
  ]);

  // The key reads the sessions, and nothing its scope does not grant.
  const sessions = await operatorApi(secret, "/sessions");
  expect(sessions.status).toBe(200);
  expect(sessions.body).toHaveProperty("agents");
  expect((await operatorApi(secret, "/threads")).status).toBe(404);
  // The list shows when it was last used: a third time beside created and
  // expires.
  await page.reload();
  await expect(key.locator(".where time")).toHaveCount(3);

  await key.getByRole("button", { name: "Revoke" }).click();
  await key.getByRole("button", { name: "Revoke this key" }).click();
  await expect(key.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  await expect(key.getByRole("heading")).toBeFocused();
  const refused = await operatorApi(secret, "/sessions");
  expect([refused.status, refused.body]).toEqual([
    401,
    { error: expect.objectContaining({ code: "unauthenticated" }) },
  ]);
});

test("the keys, the form and a new secret fit a phone's width", async () => {
  await page.setViewportSize(phone);
  try {
    await page.goto("/settings/api-keys");
    await expect(section().getByRole("article", { name: "API key Reader" })).toBeVisible();
    await expectNoOverflow();

    await section().getByRole("button", { name: "Create an API key" }).click();
    await section().getByLabel("Name").fill("Phone");
    await expect(section().getByRole("checkbox")).toHaveCount(5);
    await section().getByRole("checkbox", { name: "threads:write" }).check();
    await expect(section().getByRole("checkbox", { name: "threads:read" })).toBeChecked();
    await expect(section().getByRole("checkbox", { name: "threads:read" })).toBeDisabled();
    const expiry = section().getByLabel("Expiry", { exact: true });
    await expiry.selectOption("date");
    await expect(section().getByLabel("Expiry date")).toBeVisible();
    await expectNoOverflow();
    await expiry.selectOption("none");
    await expect(section().locator("form .notice.warning")).toBeVisible();
    await expectNoOverflow();
    await section().getByRole("button", { name: "Create key" }).click();

    const field = section().getByLabel("API key", { exact: true });
    await expect(field).toBeInViewport();
    await expect(section().getByRole("button", { name: "Copy" })).toBeInViewport();
    await expect(section().getByRole("button", { name: "Done" })).toBeInViewport();
    await expectNoOverflow();
    const secret = await field.inputValue();
    expect((await operatorApi(secret, "/threads")).status).toBe(200);
    await section().getByRole("button", { name: "Done" }).click();
    await expect(
      section().getByRole("article", { name: "API key Phone" }).getByRole("heading"),
    ).toBeFocused();
    await expectNoOverflow();
  } finally {
    await page.setViewportSize(wide);
  }
});

test("the pages ran without a console error or a page error", () => {
  expect(problems).toEqual([]);
});
