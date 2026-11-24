// Diagrams in Chromium against the real server and its real policies, on a
// server of these tests' own: a mermaid block drawn through the sandboxed
// frame and shown as an image; hostile sources, and script run in the frame
// itself, reaching neither the page, the network nor anywhere else; the frame
// opened on its own doing nothing; a diagram that cannot be drawn, or whose
// frame never answers, falling back to its source while the next gets a new
// frame, with a note saying why; and the viewer at a phone's width, fitting
// even a diagram too long for its least zoom. No
// image's blob: URL outlives its loading, so none can be opened on its own.
import type { BrowserContext, Frame, Locator, Page, Request } from "@playwright/test";
import type { PublicKey, WriteResult } from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-server-api/registration-code";
import { Agent } from "./agent.ts";
import { type Agention, expect, resize, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let agent: Agent;
let server: Agention;
let threadCount = 0;
const problems: string[] = [];
const requests: Request[] = [];
const dialogs: string[] = [];

const threads = "/s/builder/main/threads";

// A diagram that declares a title and a description.
const flowchart = [
  "flowchart LR",
  "  accTitle: Release flow",
  "  accDescr: A build is tested, then shipped.",
  "  build[Build] --> test[Test] --> ship[Ship]",
].join("\n");

const sequence = [
  "sequenceDiagram",
  "  Agent->>Operator: Ship it?",
  "  Operator-->>Agent: Yes",
].join("\n");

const fenced = (source: string) => ["```mermaid", source, "```"].join("\n");

test.beforeAll(async ({ browser, diagramsServer }) => {
  server = diagramsServer;
  context = await browser.newContext({ baseURL: server.origin });
  page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("request", (request) => requests.push(request));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
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
});

// openThread has the agent start a thread with the text given, and its
// detail when given, and opens it in a page loaded anew, so the page holds no
// frame yet.
async function openThread(text: string, detail?: string): Promise<void> {
  threadCount += 1;
  const created = await agent.send<WriteResult>("POST", threads, {
    request_id: `diagrams-${threadCount}`,
    title: `Diagrams ${threadCount}`,
    text,
    ...(detail === undefined ? {} : { detail }),
  });
  expect(created.status).toBe(200);
  await page.goto(`${threads}/${created.body.number}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `#${created.body.number} Diagrams ${threadCount}`,
  );
}

// opensOnItsOwn says whether an image's URL opens in a page of its own, as a
// tab of its own would open it, outside the web UI's policy.
async function opensOnItsOwn(image: Locator): Promise<boolean> {
  const src = await image.getAttribute("src");
  expect(src).toMatch(/^blob:/);
  const alone = await context.newPage();
  try {
    await alone.goto(src ?? "");
    return true;
  } catch {
    return false;
  } finally {
    await alone.close();
  }
}

const frameRequests = () => requests.filter((request) => request.url().endsWith("/diagram-frame"));

// diagramFrame returns the page's diagram frame.
function diagramFrame(): Frame {
  const frame = page.frames().find((each) => each.url().endsWith("/diagram-frame"));
  if (frame === undefined) {
    throw new Error("the page has no diagram frame");
  }
  return frame;
}

test("a mermaid block draws through the frame as an image, under the app's policy", async () => {
  problems.length = 0;
  await openThread(
    [
      fenced(flowchart),
      "",
      "Between the two.",
      "",
      fenced(sequence),
      "",
      "```",
      "plain",
      "```",
    ].join("\n"),
  );
  const message = page.getByRole("article", { name: /^Message 1 by/ });
  const release = message.getByRole("img", { name: "Release flow" });
  await expect(release).toBeVisible();
  await expect(message.getByRole("img", { name: "Diagram" })).toBeVisible();
  // Each is an image the page made from the frame's answer, with its natural
  // size, whose URL is gone once it has loaded, and nothing the Markdown
  // holds is a frame or an SVG.
  for (const image of await message.locator("figure img").all()) {
    expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    expect(await opensOnItsOwn(image)).toBe(false);
    await expect(image).toBeVisible();
  }
  await expect(message.locator(".markdown iframe, .markdown svg")).toHaveCount(0);
  await expect(message.locator("pre code")).toHaveText("plain");
  // One frame drew both.
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");

  // The description describes the diagram, and Source shows its text.
  const opener = message.getByRole("button", { name: "Release flow" });
  await expect(opener).toHaveAccessibleDescription("A build is tested, then shipped.");
  const source = message.getByRole("button", { name: "Source" }).first();
  await expect(source).toHaveAttribute("aria-expanded", "false");
  await source.click();
  await expect(source).toHaveAttribute("aria-expanded", "true");
  await expect(message.locator("figure pre code").first()).toHaveText(flowchart);

  // A dark color scheme draws it again.
  const light = await release.getAttribute("src");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(release).not.toHaveAttribute("src", light ?? "");
  await expect(release).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });

  expect(problems).toEqual([]);
});

test("a hostile source reaches neither the page, the network nor anywhere else", async () => {
  const hostile = [
    [
      "flowchart LR",
      `  A["<img src=x onerror=top.location='https://evil.example/'>"] --> B["<script>parent.document.title='taken'</script>"]`,
      `  click A href "javascript:top.location='https://evil.example/'"`,
      "  click B call alert(1)",
    ].join("\n"),
    [
      `%%{init: {"securityLevel": "loose", "startOnLoad": true}}%%`,
      "flowchart LR",
      `  C["<iframe src='https://evil.example/'></iframe>"] --> D["<meta http-equiv='refresh' content='0;url=https://evil.example/'>"]`,
      `  click C callback "alert"`,
    ].join("\n"),
    [
      "sequenceDiagram",
      "  Alice->>Bob: <img src='https://evil.example/pixel.png' onerror='fetch(`/api/web/threads`)'>",
    ].join("\n"),
  ];
  const before = requests.length;
  await openThread(hostile.map(fenced).join("\n\n"));
  const title = await page.title();
  const message = page.getByRole("article", { name: /^Message 1 by/ });
  await expect(message.locator("figure")).toHaveCount(3);
  await expect(message.locator("figure[aria-busy]")).toHaveCount(0, { timeout: 30_000 });
  // No drawing can be opened on its own, outside the web UI's policy, where
  // what Mermaid's strict level keeps, such as an image in a label, loads.
  for (const image of await message.locator("figure img").all()) {
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete)).toBe(true);
    expect(await opensOnItsOwn(image)).toBe(false);
  }

  // Script in the frame itself, as if Mermaid ran what it was given, can
  // neither fetch, reach the page, navigate the page nor take the frame
  // elsewhere.
  const frame = diagramFrame();
  const attempts = await frame.evaluate(async () => {
    const outcome = async (attempt: () => unknown) => {
      try {
        await attempt();
        return "done";
      } catch {
        return "refused";
      }
    };
    return {
      fetch: await outcome(() => fetch("/api/web/threads")),
      parent: await outcome(() => window.parent.document.title),
      top: await outcome(() => {
        window.top!.location.href = "https://evil.example/";
      }),
      storage: await outcome(() => window.localStorage.length),
      cookie: await outcome(() => document.cookie),
    };
  });
  expect(attempts).toEqual({
    fetch: "refused",
    parent: "refused",
    top: "refused",
    storage: "refused",
    cookie: "refused",
  });
  await frame.evaluate(() => {
    window.location.href = "https://evil.example/";
  });
  await page.waitForTimeout(500);

  expect(new URL(page.url()).pathname).toMatch(/^\/s\/builder\/main\/threads\/\d+$/);
  expect(await page.title()).toBe(title);
  expect(dialogs).toEqual([]);
  // Every request went to the server, but for the images the page made.
  const origins = new Set(requests.slice(before).map((request) => new URL(request.url()).origin));
  expect([...origins].filter((origin) => !origin.startsWith("blob:"))).toEqual([server.origin]);
  expect(page.frames().some((each) => each.url().includes("evil.example"))).toBe(false);
});

test("the frame opened on its own does nothing", async () => {
  const alone = await context.newPage();
  try {
    const seen: string[] = [];
    alone.on("request", (request) => seen.push(new URL(request.url()).pathname));
    const response = await alone.goto("/diagram-frame");
    expect(response?.headers()["content-security-policy"]).toMatch(/^sandbox allow-scripts;/);
    // Its origin is opaque, and a request it posts to itself is never
    // answered.
    const result = await alone.evaluate(async () => {
      const messages: unknown[] = [];
      window.addEventListener("message", (event) => messages.push(event.data));
      window.postMessage({ id: 1, source: "flowchart LR\n  A --> B", theme: "default" }, "*");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return { origin: window.origin, messages, svgs: document.querySelectorAll("svg").length };
    });
    expect(result).toEqual({
      origin: "null",
      messages: [{ id: 1, source: "flowchart LR\n  A --> B", theme: "default" }],
      svgs: 0,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe("/diagram-frame");
    expect(seen[1]).toMatch(/^\/assets\/diagram-frame-[A-Za-z0-9]+\.js$/);
  } finally {
    await alone.close();
  }
});

test("a diagram that cannot be drawn shows its source", async () => {
  const broken = "flowchart LR\n  A -->";
  // Over the size drawn, so it goes in the message's detail, which holds more
  // than its text.
  const long = `flowchart LR\n  A --> B\n%% ${"x".repeat(10_000)}`;
  await openThread(
    [fenced(broken), "", fenced(sequence)].join("\n"),
    [fenced(long), "", fenced(flowchart)].join("\n"),
  );
  const message = page.getByRole("article", { name: /^Message 1 by/ });
  await message.getByRole("button", { name: "Details of message 1" }).click();
  const figures = message.locator("figure");
  await expect(figures).toHaveCount(4);
  await expect(figures.nth(1).getByRole("img", { name: "Diagram" })).toBeVisible();
  await expect(figures.nth(3).getByRole("img", { name: "Release flow" })).toBeVisible();
  await expect(figures.nth(0).locator("pre code")).toHaveText(broken);
  await expect(figures.nth(2).locator("pre code")).toHaveText(long);
  await expect(figures.locator("img")).toHaveCount(2);
  // The one too long to draw says so, apart from the one that could not be.
  const note = await figures.nth(0).locator(".diagram-note").textContent();
  await expect(figures.nth(2).locator(".diagram-note")).toBeVisible();
  await expect(figures.nth(2).locator(".diagram-note")).not.toHaveText(note ?? "");
});

test("a frame that never answers is replaced, and the next diagram drawn in a new one", async () => {
  // The first frame the page asks for never gets its script.
  const script = "**/assets/diagram-frame-*.js";
  let served = 0;
  await page.route(script, async (route) => {
    served += 1;
    await (served > 1 ? route.continue() : route.abort());
  });
  const before = frameRequests().length;
  try {
    await openThread([fenced(flowchart), "", fenced(sequence)].join("\n"));
    const message = page.getByRole("article", { name: /^Message 1 by/ });
    const figures = message.locator("figure");
    await expect(figures.nth(0).locator(".diagram-note")).toBeVisible();
    await expect(figures.nth(0).locator("pre code")).toHaveText(flowchart, { timeout: 15_000 });
    await expect(figures.nth(1).getByRole("img", { name: "Diagram" })).toBeVisible();
    expect(frameRequests().length - before).toBe(2);
    await expect(page.locator("iframe")).toHaveCount(1);
  } finally {
    await page.unroute(script);
  }
});

test("the viewer opens a diagram full screen at a phone's width, and gives focus back", async () => {
  await resize(page, { width: 390, height: 844 });
  const wide = [
    "flowchart LR",
    ...Array.from({ length: 12 }, (_, index) => `  step${index} --> step${index + 1}`),
  ].join("\n");
  await openThread(fenced(wide));
  const message = page.getByRole("article", { name: /^Message 1 by/ });
  const image = message.getByRole("img", { name: "Diagram" });
  await expect(image).toBeVisible();
  // The wide diagram fits the column, so the page does not scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => getComputedStyle(document.body).touchAction)).not.toBe("none");

  const opener = message.getByRole("button", { name: "Diagram" });
  await opener.click();
  const viewer = page.getByRole("dialog", { name: "Diagram" });
  await expect(viewer).toBeVisible();
  const box = await viewer.boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  for (const name of ["Zoom in", "Zoom out", "Fit", "Actual size", "Close"]) {
    await expect(viewer.getByRole("button", { name })).toBeInViewport();
  }

  const shown = viewer.getByRole("img", { name: "Diagram" });
  // Its image is one of its own, whose URL is gone once it has loaded.
  await expect
    .poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  expect(await opensOnItsOwn(shown)).toBe(false);
  const scale = () => shown.evaluate((img) => new DOMMatrix(getComputedStyle(img).transform).a);
  // It opens fitted, smaller than its natural size since it is wide.
  await expect.poll(scale).toBeLessThan(1);
  const fitted = await scale();
  await page.keyboard.press("+");
  await expect.poll(scale).toBeGreaterThan(fitted);
  await page.keyboard.press("1");
  await expect.poll(scale).toBeCloseTo(1);
  await page.keyboard.press("0");
  await expect.poll(scale).toBeCloseTo(fitted);
  await viewer.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(scale).toBeGreaterThan(fitted);
  await viewer.getByRole("button", { name: "Fit" }).click();
  await expect.poll(scale).toBeCloseTo(fitted);

  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await viewer.getByRole("button", { name: "Close" }).click();
  await expect(viewer).toBeHidden();
  await expect(opener).toBeFocused();
});

test("the viewer fits a diagram too long for its least zoom, and zooms out no further", async () => {
  await resize(page, { width: 390, height: 844 });
  // A chain of 100 edges, written short to fit in a message's text.
  const long = `flowchart LR\n  ${Array.from({ length: 101 }, (_, index) => `n${index}`).join("-->")}`;
  await openThread(fenced(long));
  const message = page.getByRole("article", { name: /^Message 1 by/ });
  await message.getByRole("button", { name: "Diagram" }).click();
  const viewer = page.getByRole("dialog", { name: "Diagram" });
  const shown = viewer.getByRole("img", { name: "Diagram" });
  const scale = () => shown.evaluate((img) => new DOMMatrix(getComputedStyle(img).transform).a);
  // Its fit is under the 5% the viewer otherwise zooms out to.
  await expect.poll(scale).toBeLessThan(0.05);
  const fitted = await scale();
  const width = async () => (await shown.boundingBox())?.width ?? Infinity;
  expect(await width()).toBeLessThanOrEqual(390);
  await page.keyboard.press("-");
  await expect.poll(scale).toBeCloseTo(fitted, 4);
  await page.keyboard.press("+");
  await expect.poll(scale).toBeGreaterThan(fitted);
  await viewer.getByRole("button", { name: "Fit" }).click();
  await expect.poll(scale).toBeCloseTo(fitted, 4);
  expect(await width()).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
});

test("no page error happened in any of them", () => {
  expect(problems.filter((text) => /page error/i.test(text))).toEqual([]);
});
