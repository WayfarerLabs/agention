// Notifications in Chromium against the real server, on a server of these
// tests' own. Headless Chromium has no push service, its headless shell
// grants a worker no permission to show a notification, and Playwright
// cannot click one, so: the page's pushManager is stubbed with subscriptions
// the server accepts (an endpoint of a known push service and real P-256
// keys); a push is delivered to the real worker through Chromium's DevTools
// protocol, and what the worker asks showNotification to show is recorded;
// and a click is dispatched in the worker with the notification it showed,
// its focus() and openWindow(), which a click from script may not run, being
// recorded too. The message the worker posts to a window, and the page's
// handling of it, are real. Settings' switch and device list, the Notify
// switch in Saved views, and the questions of Replace and Remove for a view
// that notifies run as they are.
// cspell:ignore serviceworker

import type { BrowserContext, Page, Worker } from "@playwright/test";
import type { NotificationsState, WriteResult } from "@wayfarerlabs/agention-api";
import { Agent } from "./agent.ts";
import { signIn, threads } from "./files.ts";
import { type Agention, expect, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let agent: Agent;
let server: Agention;
const problems: string[] = [];

// The stubbed pushManager keeps the browser's one subscription in the
// page's storage, so each page of the context holds the same.
const subscriptionKey = "e2e.push-subscription";

// stubPushManager has every page of a context subscribe without a push
// service: a subscription under the key the page gives, at an endpoint of
// Google's push service, with a P-256 public key the server accepts.
async function stubPushManager(on: BrowserContext): Promise<void> {
  await on.addInitScript((store) => {
    const encode = (bytes: ArrayBuffer | Uint8Array) =>
      btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const decode = (text: string) =>
      Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (each) =>
        each.charCodeAt(0),
      );
    interface Held {
      endpoint: string;
      key: string;
      p256dh: string;
      auth: string;
    }
    const subscriptionOf = (held: Held) =>
      ({
        endpoint: held.endpoint,
        options: { userVisibleOnly: true, applicationServerKey: decode(held.key).buffer },
        toJSON: () => ({
          endpoint: held.endpoint,
          expirationTime: null,
          keys: { p256dh: held.p256dh, auth: held.auth },
        }),
        unsubscribe: () => {
          localStorage.removeItem(store);
          return Promise.resolve(true);
        },
      }) as unknown as PushSubscription;
    const held = (): Held | undefined => {
      const value = localStorage.getItem(store);
      return value === null ? undefined : (JSON.parse(value) as Held);
    };
    PushManager.prototype.getSubscription = function () {
      const each = held();
      return Promise.resolve(each === undefined ? null : subscriptionOf(each));
    };
    PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
      const key = encode(options?.applicationServerKey as Uint8Array);
      const existing = held();
      if (existing !== undefined) {
        if (existing.key !== key) {
          throw new DOMException("subscribed under another key", "InvalidStateError");
        }
        return subscriptionOf(existing);
      }
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ]);
      const made: Held = {
        endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`,
        key,
        p256dh: encode(await crypto.subtle.exportKey("raw", pair.publicKey)),
        auth: encode(crypto.getRandomValues(new Uint8Array(16))),
      };
      localStorage.setItem(store, JSON.stringify(made));
      return subscriptionOf(made);
    };
  }, subscriptionKey);
}

// write starts a thread as an agent, failing on anything the server refuses.
// The stubbed subscriptions' endpoints are a real push service's, so an
// agent writes only while no device receives notifications: then no send
// can leave the machine, whichever test writes and whenever.
async function write(title: string): Promise<number> {
  const devices = await page.evaluate(async () => {
    const response = await fetch("/api/web/notifications");
    return ((await response.json()) as NotificationsState).devices.length;
  });
  expect(devices, "an agent wrote while a device receives notifications").toBe(0);
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: `r-${title.replaceAll(" ", "-")}`,
    title,
    text: title,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.number;
}

// worker gives the context's service worker, once it runs.
async function worker(on: BrowserContext = context): Promise<Worker> {
  return on.serviceWorkers()[0] ?? (await on.waitForEvent("serviceworker"));
}

// recordNotifications has the context's worker record what it shows rather
// than show it, which the headless shell refuses.
async function recordNotifications(on: BrowserContext): Promise<void> {
  await (
    await worker(on)
  ).evaluate(() => {
    const held = globalThis as { shownByTest?: { title: string; options: NotificationOptions }[] };
    if (held.shownByTest === undefined) {
      held.shownByTest = [];
      ServiceWorkerRegistration.prototype.showNotification = (title, options = {}) => {
        held.shownByTest?.push({ title, options });
        return Promise.resolve();
      };
    }
  });
}

// deliverPush delivers a push of this data to the context's service worker,
// as a push service would, through Chromium's DevTools protocol.
async function deliverPush(on: Page, data: unknown): Promise<void> {
  await recordNotifications(on.context());
  const cdp = await on.context().newCDPSession(on);
  const registration = new Promise<string>((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const found = registrations.find((each) => !each.isDeleted);
      if (found !== undefined) {
        resolve(found.registrationId);
      }
    });
  });
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: server.origin,
    registrationId: await registration,
    data: JSON.stringify(data),
  });
  await cdp.detach();
}

// shown gives what the worker showed, in order.
async function shown(on: BrowserContext = context) {
  return (await worker(on)).evaluate(() =>
    (
      (globalThis as { shownByTest?: { title: string; options: NotificationOptions }[] })
        .shownByTest ?? []
    ).map(({ title, options }) => ({ title, ...options })),
  );
}

// click dispatches a click on the latest notification the worker showed of
// a tag, and waits for the worker to finish with it. It answers the address
// the worker opened a window at, if it opened one, and whether it focused
// one.
async function click(
  tag: string,
  on: BrowserContext = context,
): Promise<{ opened?: string; focused: boolean }> {
  return (await worker(on)).evaluate(async (wanted) => {
    // The worker's globals this reaches, which the DOM library the tests
    // compile against leaves out.
    const scope = self as unknown as {
      clients: { openWindow: (url: string) => Promise<unknown> };
      dispatchEvent: (event: Event) => boolean;
    };
    const { WindowClient } = globalThis as unknown as {
      WindowClient: { prototype: { focus: () => Promise<unknown> } };
    };
    const showing = (
      (globalThis as { shownByTest?: { title: string; options: NotificationOptions }[] })
        .shownByTest ?? []
    ).findLast((each) => each.options.tag === wanted);
    if (showing === undefined) {
      throw new Error(`no notification of tag ${wanted}`);
    }
    const record: { opened?: string; focused: boolean } = { focused: false };
    const pending: Promise<unknown>[] = [];
    const openWindow = scope.clients.openWindow.bind(scope.clients);
    const focus = WindowClient.prototype.focus;
    scope.clients.openWindow = (url) => {
      record.opened = String(url);
      return Promise.resolve(null);
    };
    WindowClient.prototype.focus = function () {
      record.focused = true;
      return Promise.resolve(this);
    };
    const event = Object.assign(new Event("notificationclick"), {
      notification: { ...showing.options, title: showing.title, close: () => undefined },
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    });
    try {
      scope.dispatchEvent(event);
      await Promise.all(pending);
    } finally {
      scope.clients.openWindow = openWindow;
      WindowClient.prototype.focus = focus;
    }
    return record;
  }, tag);
}

const settings = (on: Page = page) => on.getByRole("region", { name: "Notifications" });
const thisDevice = (on: Page = page) =>
  settings(on).getByRole("checkbox", { name: "Notifications on this device" });

test.beforeAll(async ({ browser, notificationsServer }) => {
  server = notificationsServer;
  ({ context, page, agent } = await signIn(browser, server));
  page.on("console", (message) => {
    // A refresh the server answers not_found, as for a device removed from
    // another browser, is how the page finds it stopped.
    const refused = message.location().url.endsWith("/api/web/notifications/devices/refresh");
    if (message.type() === "error" && !refused) {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  await context.grantPermissions(["notifications"], { origin: server.origin });
  await stubPushManager(context);
  // The threads exist before any device is on, as write requires.
  await write("Deploy approval");
  await write("Release notes");
});

test.afterAll(async () => {
  await context.close();
});

test("this device turns on and off from Settings, listed with its label", async () => {
  await page.goto("/settings/notifications");
  await expect(thisDevice()).not.toBeChecked();
  await expect(settings().getByText("No device receives notifications.")).toBeVisible();
  await thisDevice().click();
  await expect(thisDevice()).toBeChecked();
  await expect(settings().getByText("On", { exact: true })).toBeVisible();
  const row = settings().getByRole("article", { name: /^Device Chrome on Linux$/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("This device")).toBeVisible();
  await expect(row.getByText(/nothing sent yet/)).toBeVisible();
  // A reload refreshes the subscription with the server, which keeps it.
  await page.reload();
  await expect(thisDevice()).toBeChecked();
  await expect(row).toBeVisible();
  // Off removes it from the list and from the browser.
  await thisDevice().click();
  await expect(settings().getByText("No device receives notifications.")).toBeVisible();
  await expect(settings().getByText("Off", { exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), subscriptionKey)).toBeNull();
  await thisDevice().click();
  await expect(row).toBeVisible();
});

test("a device removed from another browser shows as stopped once this one starts", async ({
  browser,
}) => {
  // Another browser, signed in with this one's cookies, removes this device.
  const elsewhere = await browser.newContext({ baseURL: server.origin });
  try {
    await elsewhere.addCookies(await context.cookies());
    const other = await elsewhere.newPage();
    await other.goto("/settings/notifications");
    const row = settings(other).getByRole("article", { name: /^Device Chrome on Linux$/ });
    await row.getByRole("button", { name: "Remove" }).click();
    await row.getByRole("button", { name: "Remove this device" }).click();
    await expect(settings(other).getByText("No device receives notifications.")).toBeVisible();
  } finally {
    await elsewhere.close();
  }
  await page.goto("/settings/notifications");
  await expect(settings().getByText(/^Stopped\. Another device removed this one/)).toBeVisible();
  await expect(thisDevice()).not.toBeChecked();
  await thisDevice().click();
  await expect(thisDevice()).toBeChecked();
  await expect(settings().getByRole("article", { name: /^Device Chrome on Linux$/ })).toBeVisible();
});

test("a push shows the thread's title and why, tagged with the thread", async () => {
  await page.goto("/settings/notifications");
  await expect(thisDevice()).toBeChecked();
  const thread = { agent: "builder", session: "main", thread: 1 };
  await deliverPush(page, { ...thread, title: "Deploy approval", why: "open" });
  await expect
    .poll(() => shown())
    .toEqual([
      {
        title: "Deploy approval",
        body: "Open ask",
        tag: "builder/main/1",
        renotify: true,
        data: thread,
        icon: "/icons/192.png",
      },
    ]);
  // A later one of the thread takes the same tag, so it replaces the first.
  await deliverPush(page, { ...thread, title: "Deploy approval", why: "blocking" });
  await expect
    .poll(async () => (await shown()).map((each) => [each.tag, each.body]))
    .toEqual([
      ["builder/main/1", "Open ask"],
      ["builder/main/1", "Blocking ask"],
    ]);
  // What the worker cannot read shows something all the same.
  await deliverPush(page, { title: "no thread" });
  await expect.poll(async () => (await shown()).map((each) => each.title)).toContain("Agention");
});

test("a click opens its thread in a web UI window, passing over the API's documentation", async () => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  // The documentation page, opened after, is the focused one.
  const docs = await context.newPage();
  await docs.goto("/docs/api/");
  const thread = { agent: "builder", session: "main", thread: 1 };
  await deliverPush(page, { ...thread, title: "Deploy approval", why: "blocking" });
  await expect.poll(async () => (await shown()).length).toBeGreaterThan(0);
  const done = await click("builder/main/1");
  expect(done).toEqual({ focused: true });
  await expect(page).toHaveURL(`${threads}/1`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("#1 Deploy approval");
  expect(new URL(docs.url()).pathname).toBe("/docs/api/");

  // With only the documentation page open, the click opens a window at the
  // thread, which shows it.
  await page.close();
  await deliverPush(docs, {
    agent: "builder",
    session: "main",
    thread: 2,
    title: "Release notes",
    why: "message",
  });
  await expect
    .poll(async () => (await shown()).map((each) => each.tag))
    .toContain("builder/main/2");
  const alone = await click("builder/main/2");
  expect(alone).toEqual({ focused: false, opened: `${server.origin}${threads}/2` });
  page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  await page.goto(alone.opened ?? "/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("#2 Release notes");
  await docs.close();
});

test("a click with only the sign-in page open, signed out, signs in to the thread", async ({
  browser,
}) => {
  const signedOut = await browser.newContext({ baseURL: server.origin });
  try {
    await signedOut.grantPermissions(["notifications"], { origin: server.origin });
    const signIn = await signedOut.newPage();
    await signIn.goto("/sign-in");
    await expect(signIn.getByRole("button", { name: /Sign in/ })).toBeVisible();
    // The worker registers as the page starts.
    await worker(signedOut);
    const thread = { agent: "builder", session: "main", thread: 1 };
    await deliverPush(signIn, { ...thread, title: "Deploy approval", why: "blocking" });
    await expect.poll(async () => (await shown(signedOut)).length).toBe(1);
    const done = await click("builder/main/1", signedOut);
    expect(done).toEqual({ focused: true });
    await expect(signIn).toHaveURL(`/sign-in?next=${encodeURIComponent(`${threads}/1`)}`);
  } finally {
    await signedOut.close();
  }
});

test("Saved views' Notify switch, and the questions of Replace and Remove for a view that notifies", async () => {
  await page.goto("/settings/saved-views");
  const section = page.getByRole("region", { name: "Saved views" });
  const row = (name: string) => section.getByRole("article", { name: `Saved view ${name}` });
  // The starting view notifies.
  const blocking = row("Blocking asks").getByRole("checkbox", { name: "Notify" });
  await expect(blocking).toBeChecked();
  await blocking.click();
  await expect(blocking).not.toBeChecked();
  await page.reload();
  await expect(blocking).not.toBeChecked();
  await blocking.click();
  await expect(blocking).toBeChecked();

  // A list with search on, saved as a view, cannot notify.
  await page.goto("/?search=deploy");
  await page.getByRole("button", { name: /^Saved views/ }).click();
  const sheet = page.getByRole("dialog", { name: "Saved views" });
  await sheet.getByRole("button", { name: "Save as new view" }).click();
  await sheet.getByLabel("New view's name").fill("Deploys");
  await sheet.getByRole("button", { name: "Save view" }).click();
  await expect(sheet.getByRole("link", { name: "Deploys", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await sheet.getByRole("button", { name: "Close" }).click();

  await page.goto("/settings/saved-views");
  const deploys = row("Deploys").getByRole("checkbox", { name: "Notify" });
  await expect(deploys).toBeDisabled();
});

test("the pages ran without a console error or a page error", () => {
  expect(problems).toEqual([]);
});
