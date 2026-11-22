// Settings and voice in Chromium against the real server, on a server of
// these tests' own, with a local stub standing in for the transcription
// provider and Chromium's fake microphone, which plays a tone: Settings'
// sections, passkeys, voice and signing out, beside their navigation at a
// desktop's width, and at a phone's the navigation alone, each section
// leading back to it; voice set up to the stub and tried there; dictation in
// a thread, its text at the caret and nothing sent; typing while the
// microphone opens; and reading a message aloud, then stopping it.
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { PublicKey, ThreadGetResult, WriteResult } from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { StubProvider } from "../../server/src/transcription/test-provider.ts";
import { Agent } from "./agent.ts";
import { type Agention, expect, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let agent: Agent;
let server: Agention;
let stub: StubProvider;
const problems: string[] = [];

const threads = "/s/builder/main/threads";
const wide = { width: 1280, height: 800 };
const phone = { width: 390, height: 844 };

// linesOf counts the lines the Send row's controls take, whatever the font:
// Send, dictation's controls and what shares the row with them, leaving out
// the notices that take a line of their own above them.
async function linesOf(row: Locator): Promise<number> {
  return row.evaluate((element) => {
    const controls = [
      ...element.querySelectorAll(
        ":scope > button, :scope > label, .dictation > button, .dictation > p",
      ),
    ]
      .map((control) => control.getBoundingClientRect())
      .filter((box) => box.width > 2 && box.height > 2)
      .sort((a, b) => a.top - b.top);
    let lines = 0;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const box of controls) {
      // A control starting below the last line's middle starts a new line.
      if (box.top >= bottom) {
        lines++;
        bottom = box.top + box.height / 2;
      }
    }
    return lines;
  });
}

test.beforeAll(async ({ browser, voiceServer }) => {
  server = voiceServer;
  stub = await StubProvider.start();
  stub.answer = () => ({ status: 200, body: JSON.stringify({ text: "SQLite" }) });
  context = await browser.newContext({ baseURL: server.origin, viewport: wide });
  await context.grantPermissions(["microphone"], { origin: server.origin });
  page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  // Reading aloud speaks through a stand-in that records what it is asked to
  // say and never finishes, since the headless shell has no voices.
  await page.addInitScript(() => {
    const said: string[] = [];
    Object.assign(window, { said });
    window.speechSynthesis.speak = (utterance) => {
      said.push(utterance.text);
    };
    // The microphone opens after micDelay milliseconds when a test sets it,
    // as it does after a browser's first prompt.
    const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const delay = (window as unknown as { micDelay?: number }).micDelay ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return open(constraints);
    };
  });
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

  // The operator signs in, and approves an agent that starts threads.
  await page.goto(server.passkeyLink());
  await page.getByLabel("Passkey name").fill("Laptop");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");
  agent = new Agent(server);
  await agent.send("POST", "/registrations", { agent: "builder", session: "main" });
  await page.getByRole("link", { name: "Sessions" }).click();
  const code = registrationCode(agent.publicKey as PublicKey);
  await page
    .getByRole("article", { name: `Registration ${code}` })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(page.getByRole("button", { name: /^Agent builder/ })).toBeVisible();
});

test.afterAll(async () => {
  await context.close();
  await stub.close();
});

// Settings' navigation of its sections, the open section's heading, and the
// way back to the navigation.
const settings = () => page.getByRole("navigation", { name: "Settings" });
const sectionHeading = () => page.getByRole("heading", { level: 2 });
const backToSettings = () => page.getByRole("link", { name: "Back to settings" });
const settingsTab = () => page.getByRole("banner").getByRole("link", { name: "Settings" });

// expectNoOverflow says nothing runs off the side of the page.
async function expectNoOverflow() {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("Settings at a desktop's width opens the first section beside the navigation, which stays", async () => {
  await settingsTab().click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(sectionHeading()).toHaveText("Passkeys");
  await expect(page.getByRole("article", { name: "Passkey Laptop" })).toBeVisible();
  await expect(settings().getByRole("link", { name: "Passkeys" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(backToSettings()).toBeHidden();

  await settings().getByRole("link", { name: "Voice" }).click();
  await expect(page).toHaveURL(/\/settings\/voice$/);
  await expect(sectionHeading()).toHaveText("Voice");
  await expect(page.getByRole("button", { name: "Set up" })).toBeVisible();
  await expect(settings().getByRole("link", { name: "Voice" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(backToSettings()).toBeHidden();
  // The navigation is a column beside the section, not above it.
  const column = await settings().boundingBox();
  const section = await page.getByRole("region", { name: "Voice" }).boundingBox();
  expect(column !== null && section !== null && column.x + column.width <= section.x).toBe(true);
  await expectNoOverflow();
});

test("Settings at a phone's width lists the sections alone, and a section leads back to them", async () => {
  await page.setViewportSize(phone);
  try {
    await settingsTab().click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(settings()).toBeVisible();
    await expect(sectionHeading()).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Passkeys" })).toBeHidden();
    await expectNoOverflow();

    for (const [title, shows] of [
      ["Passkeys", page.getByRole("article", { name: "Passkey Laptop" })],
      ["Voice", page.getByRole("button", { name: "Set up" })],
      ["Sign out", page.getByRole("main").getByRole("button", { name: "Sign out" })],
    ] as const) {
      await settings().getByRole("link", { name: title }).click();
      await expect(sectionHeading()).toHaveText(title);
      await expect(shows).toBeVisible();
      await expect(settings()).toBeHidden();
      await expectNoOverflow();
      await backToSettings().click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(settings()).toBeVisible();
    }
    await expect(page.getByRole("banner").getByRole("button")).toHaveCount(0);
  } finally {
    await page.setViewportSize(wide);
  }
});

test("voice set up to the operator's own server transcribes through Try it", async () => {
  await settings().getByRole("link", { name: "Voice" }).click();
  const voice = page.getByRole("region", { name: "Voice" });
  await voice.getByRole("button", { name: "Set up" }).click();
  await voice.getByLabel("Provider").selectOption({ label: "Your own server" });
  await voice.getByLabel("Base URL").fill(stub.baseUrl);
  await voice.getByLabel("Model").fill("whisper-1");
  await expect(voice.getByText(/unencrypted/)).toBeVisible();
  await voice.getByRole("button", { name: "Save" }).click();
  await expect(voice.getByRole("status")).toHaveText("Voice saved.");

  const tryIt = voice.getByRole("region", { name: "Try it" });
  await tryIt.getByRole("button", { name: "Dictate" }).click();
  await expect(tryIt.getByText(/^Recording \d:\d\d of 5:00$/)).toBeVisible();
  await page.waitForTimeout(1500);
  await tryIt.getByRole("button", { name: "Stop" }).click();
  await expect(tryIt.getByText("SQLite", { exact: true })).toBeVisible();
  const [sent] = stub.requests;
  expect(sent?.fields).toMatchObject({ model: "whisper-1", response_format: "json" });
  expect(sent?.file?.name).toBe("audio.webm");
  expect(sent?.file?.size).toBeGreaterThan(1000);
});

test("dictation puts its text at the caret, and sends nothing, at a desktop's width and a phone's", async () => {
  for (const [index, size] of [wide, phone].entries()) {
    await page.setViewportSize(size);
    const created = await agent.send<WriteResult>("POST", threads, {
      request_id: `voice-${index}`,
      title: `Pick a database ${index}`,
      text: "Which database?",
    });
    await page.goto(`${threads}/${created.body.number}`);
    const reply = page.getByRole("region", { name: "Reply" });
    const box = reply.getByRole("textbox", { name: "Message" });
    await box.fill("Use it.");
    await box.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 3));
    await reply.getByRole("button", { name: "Dictate" }).click();
    await expect(reply.getByText(/^Recording /)).toBeVisible();
    // Send and the recording's controls stay in the row at the foot of the
    // screen, which stays short: at most two lines, with Go back after
    // sending below it while dictation is there.
    const row = reply.locator(".actions");
    await expect(reply.getByRole("button", { name: "Send" })).toBeInViewport();
    await expect(reply.getByRole("button", { name: "Stop" })).toBeInViewport();
    await expect(row.getByRole("checkbox")).toHaveCount(0);
    expect(await linesOf(row)).toBeLessThanOrEqual(2);
    await page.waitForTimeout(1500);
    await reply.getByRole("button", { name: "Stop" }).click();
    await expect(box).toHaveValue("Use SQLite it.");
    await expect(reply.getByRole("button", { name: "Dictate" })).toBeInViewport();
    await expect(box).toBeFocused();
    const thread = await agent.send<ThreadGetResult>("GET", `${threads}/${created.body.number}`);
    expect(thread.body.messages).toHaveLength(1);
  }
  await page.setViewportSize(wide);
});

test("on a short phone's screen, typed lines stay clear of the row while recording and after a failure", async () => {
  const short = { width: 390, height: 500 };
  await page.setViewportSize(short);
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "voice-short",
    title: "Short screen",
    text: "Which database?",
  });
  await page.goto(`${threads}/${created.body.number}`);
  const reply = page.getByRole("region", { name: "Reply" });
  const box = reply.getByRole("textbox", { name: "Message" });
  const row = reply.locator(".actions");
  const boxOf = async (what: Locator) => {
    const found = await what.boundingBox();
    expect(found).not.toBeNull();
    return found ?? { x: 0, y: 0, width: 0, height: 0 };
  };
  // typeLines types at the end of the message box, focused at the foot of
  // the screen as a phone's keyboard leaves it, and checks what is typed
  // stays above the row.
  const typeLines = async () => {
    await box.focus();
    await box.evaluate((element) => element.scrollIntoView({ block: "end" }));
    for (const line of ["One", "Two", "Three", "Four", "Five"]) {
      await page.keyboard.type(line);
      await page.keyboard.press("Enter");
    }
    expect((await boxOf(box)).y + (await boxOf(box)).height).toBeLessThanOrEqual(
      (await boxOf(row)).y + 1,
    );
  };
  await reply.getByRole("button", { name: "Dictate" }).click();
  await expect(reply.getByRole("button", { name: "Stop" })).toBeInViewport();
  expect(await linesOf(row)).toBeLessThanOrEqual(2);
  await typeLines();
  await expect(reply.getByRole("button", { name: "Send" })).toBeInViewport();
  await expect(reply.getByRole("button", { name: "Stop" })).toBeInViewport();

  stub.answer = () => ({ status: 500, body: "{}" });
  await page.waitForTimeout(1200);
  await reply.getByRole("button", { name: "Stop" }).click();
  const failed = row.getByRole("alert");
  await expect(failed).toBeInViewport();
  await expect(reply.getByRole("button", { name: "Retry" })).toBeFocused();
  expect(await linesOf(row)).toBeLessThanOrEqual(2);
  // The browser logs the failed request itself; nothing else is logged.
  await expect.poll(() => problems).toEqual([expect.stringContaining("502")]);
  problems.length = 0;
  await typeLines();
  await expect(failed).toBeInViewport();
  await expect(reply.getByRole("button", { name: "Retry" })).toBeInViewport();
  await reply.getByRole("button", { name: "Discard" }).click();
  stub.answer = () => ({ status: 200, body: JSON.stringify({ text: "SQLite" }) });
  await page.setViewportSize(wide);
});

test("typing while the microphone opens keeps focus and every key in the message box", async () => {
  await page.setViewportSize({ width: 390, height: 500 });
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: "voice-typing",
    title: "Typing while it opens",
    text: "Which database?",
  });
  await page.goto(`${threads}/${created.body.number}`);
  const reply = page.getByRole("region", { name: "Reply" });
  const box = reply.getByRole("textbox", { name: "Message" });
  const row = reply.locator(".actions");
  await page.evaluate(() => Object.assign(window, { micDelay: 800 }));
  await reply.getByRole("button", { name: "Dictate" }).click();
  await box.focus();
  await page.keyboard.type("abc");
  await expect(reply.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(box).toBeFocused();
  for (const line of ["", "One", "Two", "Three", "Four", "Five"]) {
    await page.keyboard.press("Enter");
    await page.keyboard.type(line);
  }
  await expect(box).toHaveValue("abc\n\nOne\nTwo\nThree\nFour\nFive");
  await expect(reply.getByRole("button", { name: "Stop" })).toBeVisible();
  const boxAt = await box.boundingBox();
  const rowAt = await row.boundingBox();
  expect((boxAt?.y ?? 0) + (boxAt?.height ?? 0)).toBeLessThanOrEqual((rowAt?.y ?? 0) + 1);
  await page.evaluate(() => Object.assign(window, { micDelay: 0 }));
  await page.waitForTimeout(1500);
  await reply.getByRole("button", { name: "Stop" }).click();
  await expect(box).toHaveValue("abc\n\nOne\nTwo\nThree\nFour\nFive SQLite");
  await page.setViewportSize(wide);
});

test("a message read aloud speaks until stopped", async () => {
  await page.getByRole("button", { name: "Options for message 1" }).click();
  await page.getByRole("button", { name: "Read aloud" }).click();
  expect(await page.evaluate(() => (window as unknown as { said: string[] }).said)).toEqual([
    "Which database?",
  ]);
  await page.getByRole("button", { name: "Options for message 1" }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Options for message 1" }).click();
  await expect(page.getByRole("button", { name: "Read aloud" })).toBeVisible();
});

test("the pages ran without a console error or a page error", () => {
  expect(problems).toEqual([]);
});
