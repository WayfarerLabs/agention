// Session monitoring in Chromium against the real server, on a server of
// these tests' own: two sessions whose bridges, speaking the agent API's
// current version, hold the background connection and report their
// terminals, one stopped by its usage limit at a prompt, with when the limit
// resets, and one running; the sessions view showing each connected with its
// condition apart from its reported state, the longest line there is fitting
// a phone's width, flagging the stopped one and counting it on its agent's
// header, whose count lists just that session, its chip removing the filter,
// at a phone's width too; and a thread stranded on a session at a prompt,
// whose reason names its condition on the thread list, on the thread and in
// the new-thread sheet; and a session that can be nudged, whose nudge its
// bridge claimed and did not send, showing it on its line and stranding the
// thread written to it.
import type { BrowserContext, Page } from "@playwright/test";
import {
  agentApi,
  type MonitorReport,
  type PublicKey,
  type WriteResult,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { Agent } from "./agent.ts";
import { type Agention, expect, resize, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let server: Agention;
const problems: string[] = [];

const wide = { width: 1280, height: 800 };
const phone = { width: 390, height: 844 };

// Each session's agent and the id its bridge draws for monitoring.
const sessions = {
  main: { bridge: "browser-main-0000", agent: undefined as Agent | undefined },
  review: { bridge: "browser-review-00", agent: undefined as Agent | undefined },
};
type Name = keyof typeof sessions;

const agentOf = (name: Name): Agent => {
  const { agent } = sessions[name];
  if (agent === undefined) {
    throw new Error(`no agent for ${name}`);
  }
  return agent;
};

test.beforeAll(async ({ browser, monitoringServer }) => {
  server = monitoringServer;
  context = await browser.newContext({ baseURL: server.origin, viewport: wide });
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
  await page.goto(server.passkeyLink());
  await page.getByLabel("Passkey name").fill("Laptop");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Threads");

  // The operator approves both sessions of builder, each agent on a bridge
  // that speaks the current agent API.
  await page.getByRole("link", { name: "Sessions" }).click();
  for (const name of Object.keys(sessions) as Name[]) {
    const agent = new Agent(server, { version: agentApi.version });
    sessions[name].agent = agent;
    await agent.send("POST", "/registrations", { agent: "builder", session: name });
    const code = registrationCode(agent.publicKey as PublicKey);
    await page
      .getByRole("article", { name: `Registration ${code}` })
      .getByRole("button", { name: "Approve" })
      .click();
    await expect(page.getByRole("button", { name: `Session ${name}` })).toBeVisible();
  }
});

test.afterAll(async () => {
  await context.close();
});

// report has a session's bridge claim the session on its background poll,
// which keeps it connected, and report its terminal's condition, as the
// bridge's reporter does at its start.
async function report(name: Name, condition: MonitorReport): Promise<void> {
  const agent = agentOf(name);
  const { bridge } = sessions[name];
  const path = `/s/builder/${name}/monitor?bridge=${bridge}`;
  const polled = await agent.send("GET", `${path}&claim=true&wait=0`);
  expect(polled.status).toBe(200);
  const reported = await agent.send("POST", `${path}&seq=${Date.now()}`, condition);
  expect(reported.status).toBe(200);
}

const at = (
  condition: "permission_prompt" | "running" | "at_prompt",
): Extract<MonitorReport, { monitored: true }> => ({
  monitored: true,
  profile: "claude-code",
  condition,
  since: new Date(Date.now() - 60_000).toISOString(),
});

// Stopped by a usage limit, beside a prompt, with when it resets on another
// day, which says the most a session's line can.
const limited = (): MonitorReport => ({
  monitored: true,
  profile: "claude-code",
  condition: "other_prompt",
  since: new Date(Date.now() - 60_000).toISOString(),
  stopped_by: {
    reason: "usage_limit",
    resets_at: new Date(Date.now() + 26 * 3600_000).toISOString(),
  },
});

const row = (name: Name) =>
  page.getByRole("listitem").filter({ has: page.getByRole("button", { name: `Session ${name}` }) });

// The filter's chip, which shows while it is on.
const chip = () => page.getByRole("button", { name: "Remove filter: Needs you" });

test("the sessions view flags a session stopped by its usage limit, and lists just those sessions, at a phone's width too", async () => {
  for (const name of Object.keys(sessions) as Name[]) {
    const reported = await agentOf(name).send("POST", `/s/builder/${name}/status`, {
      state: "working",
    });
    expect(reported.status).toBe(200);
  }
  await report("main", limited());
  await report("review", at("running"));
  for (const size of [wide, phone]) {
    await resize(page, size);
    await page.goto("/sessions");
    // Each session is connected, with what its terminal shows and since
    // when, on the line under its head, apart from the state it reports.
    // Connected is not a warning, though what follows it may be.
    for (const name of Object.keys(sessions) as Name[]) {
      await expect(row(name).locator(".session-seen .session-connection")).toBeVisible();
      await expect(row(name).locator(".session-seen .session-connection.warning")).toHaveCount(0);
      await expect(row(name).locator(".session-condition time")).toBeVisible();
      await expect(row(name).locator(".session-facts").getByText("Working")).toBeVisible();
    }
    // The session stopped by its limit is flagged, in the warning's tone,
    // and the other is not.
    await expect(row("main").locator(".session-condition .warning")).toBeVisible();
    await expect(row("review").locator(".session-condition .warning")).toHaveCount(0);
    await expect(row("main").getByRole("link", { name: /needs you/ })).toBeVisible();
    await expect(row("review").getByRole("link", { name: /needs you/ })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);

    // Its agent's header counts it, and its count lists just that session,
    // the filter's chip removing the filter.
    const count = page.getByRole("link", { name: /^1 session of builder needs you/ });
    await count.click();
    await expect(page).toHaveURL(/\/sessions\?needs_you=true$/);
    await expect(chip()).toBeVisible();
    await expect(page.getByRole("button", { name: "Session main" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Session review" })).toHaveCount(0);
    await chip().click();
    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.getByRole("button", { name: "Session review" })).toBeVisible();
    await expect(chip()).toHaveCount(0);
  }
  await resize(page, wide);
});

test("a thread stranded on a session at a permission prompt names the prompt in its reason", async () => {
  const agent = agentOf("main");
  const created = await agent.send<WriteResult>("POST", "/s/builder/main/threads", {
    request_id: "monitoring-1",
    title: "Which database?",
    text: "SQLite or Postgres?",
  });
  expect(created.status).toBe(200);
  // The session stops, though its terminal shows a permission prompt, so a
  // message the operator writes strands the thread.
  await agent.send("POST", "/s/builder/main/status", { state: "stopped", outcome: "stalled" });
  await report("main", at("permission_prompt"));

  // The new-thread sheet warns that the session is not likely to see it,
  // saying why and what its terminal shows.
  await page.goto("/sessions");
  await page.getByRole("button", { name: "Options for builder/main" }).click();
  await page.getByRole("button", { name: "New thread" }).click();
  const sheet = page.getByRole("dialog", { name: "New thread" });
  await expect(sheet.locator(".notice.warning")).toContainText(/stalled.*permission prompt/);
  await sheet.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`/s/builder/main/threads/${created.body.number}`);
  const reply = page.getByRole("region", { name: "Reply" });
  await reply.getByRole("combobox", { name: "After sending" }).selectOption("stay");
  await reply.getByRole("textbox", { name: "Message" }).fill("Postgres.");
  await reply.getByRole("button", { name: "Send" }).click();
  // The thread says why it is stranded, naming the prompt.
  await expect(page.locator(".thread-header .why-unread")).toContainText(
    /stalled.*permission prompt/,
  );
  // So does its row on the thread list.
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Which database\?/ })).toContainText(
    /Stranded.*stalled.*permission prompt/,
  );
});

test("a session whose nudge was not sent shows it, and strands the thread written to it", async () => {
  const agent = agentOf("review");
  const canBeNudged = (): MonitorReport => ({ ...at("at_prompt"), nudge: true });
  await report("review", canBeNudged());
  const created = await agent.send<WriteResult>("POST", "/s/builder/review/threads", {
    request_id: "nudge-1",
    title: "Ship it?",
    text: "The release is ready.",
  });
  expect(created.status).toBe(200);
  const thread = `/s/builder/review/threads/${created.body.number}`;
  await page.goto(thread);
  const reply = page.getByRole("region", { name: "Reply" });
  await reply.getByRole("combobox", { name: "After sending" }).selectOption("stay");
  await reply.getByRole("textbox", { name: "Message" }).fill("Ship it.");
  await reply.getByRole("button", { name: "Send" }).click();
  await expect(reply.getByRole("textbox", { name: "Message" })).toHaveValue("");
  // Waiting for the nudge, the thread is not stranded.
  await page.reload();
  await expect(page.locator(".thread-header .why-unread")).toHaveCount(0);

  // The bridge is told a nudge is due, claims it, and says it was not sent.
  const path = `/s/builder/review/monitor?bridge=${sessions.review.bridge}`;
  const polled = await agent.send<{ nudge: boolean }>("GET", `${path}&wait=0`);
  expect(polled.body.nudge).toBe(true);
  const claim = `/s/builder/review/monitor/nudge?bridge=${sessions.review.bridge}`;
  const claimed = await agent.send<{ go: boolean }>("POST", claim, { phase: "start" });
  expect(claimed.body.go).toBe(true);
  const done = await agent.send("POST", claim, { phase: "done", sent: false });
  expect(done.status).toBe(200);
  await page.reload();
  await expect(page.locator(".thread-header .why-unread")).toBeVisible();

  // The sessions view shows the nudge in the warning's tone, its line
  // fitting a phone's width.
  for (const size of [wide, phone]) {
    await resize(page, size);
    await page.goto("/sessions");
    await expect(row("review").locator(".session-seen .session-nudge.warning")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
  }
  await resize(page, wide);
});

test("the pages ran without an error", () => {
  expect(problems).toEqual([]);
});
