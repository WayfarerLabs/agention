// The screenshots the READMEs show, taken in Chromium of a server of their
// own that holds four demonstration sessions and their threads: the thread
// list beside an open thread at a desktop's width, and that thread at a
// phone's, each in the light and the dark theme. scripts/generate-screenshots.sh runs this file, and the
// browser tests never do.
import type { PublicKey } from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-server-api/registration-code";
import path from "node:path";
import { Agent } from "./agent.ts";
import { expect, resize, test } from "./fixtures.ts";

const images = path.join(import.meta.dirname, "../../../docs/images");

test("the README's screenshots", async ({ browser, screenshotsServer: server }) => {
  const context = await browser.newContext({
    baseURL: server.origin,
    viewport: { width: 1100, height: 700 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
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

  const view = (label: string) =>
    page
      .getByRole("navigation", { name: "Views" })
      .getByRole("link", { name: new RegExp(`^${label}`) });

  // post sends as an agent, and fails on anything the server refuses.
  const post = async (agent: Agent, route: string, body: object): Promise<void> => {
    const response = await agent.send("POST", route, body);
    if (response.status >= 300) {
      throw new Error(`${route}: ${response.status} ${JSON.stringify(response.body)}`);
    }
  };

  // join registers a session, which the operator approves, and reports its
  // status.
  async function join(agentName: string, session: string, status: object): Promise<Agent> {
    const agent = new Agent(server);
    await post(agent, "/registrations", { agent: agentName, session });
    await view("Sessions").click();
    await page
      .getByRole("article", {
        name: `Registration ${registrationCode(agent.publicKey as PublicKey)}`,
      })
      .getByRole("button", { name: "Approve" })
      .click();
    await expect(
      page.getByRole("region", { name: "Waiting for approval" }).getByRole("article"),
    ).toHaveCount(0);
    await post(agent, `/s/${agentName}/${session}/status`, status);
    return agent;
  }

  let requests = 0;
  const thread = (agent: Agent, session: string, body: object) =>
    post(agent, `/s/${session}/threads`, { request_id: `screenshots-${++requests}`, ...body });

  const billing = await join("builder", "billing-ledger", {
    state: "working",
    title: "Moving billing to the ledger",
    goal: "Retire the invoices table",
    percent: 60,
    note: "Backfill 62% done",
  });
  const auth = await join("builder", "auth-rework", {
    state: "working",
    title: "Passkey sign-in",
    goal: "Replace password login with passkeys",
    percent: 35,
    note: "Opened the pull request",
  });
  const review = await join("reviewer", "pr-412", {
    state: "idle",
    title: "Reviewing the rate limiter",
    note: "Waiting on CI",
  });
  const ops = await join("ops", "nightly", {
    state: "stopped",
    outcome: "completed",
    title: "Nightly dependency sweep",
    note: "3 updates merged",
  });

  // The threads, the least pressing first, so the list shows the most
  // pressing on top.
  await thread(ops, "ops/nightly", {
    title: "Nightly sweep: 3 updates merged, 1 held back",
    topic: "dependencies",
    text: "Merged three patch updates overnight, all green. I held back the `undici` major: it changes how timeouts behave, and that wants a human look.",
  });
  await thread(review, "reviewer/pr-412", {
    title: "Rate limiter review: one race worth fixing before merge",
    topic: "rate-limiter",
    text: "The limiter reads and writes its counter in two steps, so two requests in the same millisecond can both pass. I have a fix ready on a branch.",
    asks: [
      {
        question: "Push the fix to the pull request, or leave it as a comment?",
        suggestions: [{ label: "Push the fix" }, { label: "Comment only" }],
        impact: "assuming",
        effort: "quick",
      },
    ],
  });
  await thread(auth, "builder/auth-rework", {
    title: "Passkeys: keep password login as a fallback?",
    topic: "auth",
    text: "Passkey sign-in works end to end. Before I delete the password path I need a call on whether anyone still depends on it.",
    asks: [
      {
        question: "Keep password login as a fallback for now?",
        suggestions: [
          { label: "Remove it", description: "One way in. 11 accounts would need a reset link." },
          { label: "Keep for 30 days", description: "Ship both, then remove." },
        ],
        impact: "assuming",
        priority: "high",
        effort: "under_15m",
      },
    ],
  });
  await thread(billing, "builder/billing-ledger", {
    title: "Retiring the invoices table",
    topic: "invoices",
    text: "The `invoices` table is ready to retire. I need you to choose whether to drop it now or after the ledger backfill, and whether to keep its nightly archive. Until you answer, I am assuming we wait.",
    detail: [
      "## Found",
      "",
      "- `invoices` holds 40 GB, and nothing has read it in the 9 days since billing moved to the ledger.",
      "- The backfill into `ledger_entries` is 62% done, with about 6 hours to go.",
      "- Moving billing back would read `invoices`, so dropping it ends that rollback path.",
      "",
      "## Options",
      "",
      "| | Frees | Costs |",
      "| --- | --- | --- |",
      "| Drop now | 40 GB today | No rollback if the backfill fails |",
      "| After the backfill | 40 GB in about 6 hours | Nothing more |",
    ].join("\n"),
    asks: [
      {
        question: "Drop the invoices table now, or after the backfill?",
        suggestions: [
          { label: "Drop now", description: "Frees 40 GB today, with no rollback." },
          { label: "After the backfill", description: "Keeps the rollback path until it ends." },
        ],
        impact: "blocking",
        priority: "urgent",
        effort: "quick",
      },
      {
        question: "Keep the table's nightly archive once it is dropped?",
        suggestions: [
          { label: "Keep it", description: "Costs 2 GB a month." },
          { label: "Delete it", description: "Frees the space with the table." },
        ],
        effort: "quick",
      },
    ],
  });

  // shoot takes the page in both themes, once each theme's colors have
  // settled.
  const shoot = async (name: string): Promise<void> => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(images, `${name}-${scheme}.png`) });
    }
  };

  // The list with the most pressing thread open beside it, a suggested
  // answer picked.
  await view("Threads").click();
  await page.getByRole("link", { name: /Retiring the invoices table/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Retiring");
  await page.getByRole("radio", { name: /After the backfill/ }).check();
  await shoot("inbox");

  // The same thread at a phone's width, with the first ask in view.
  await resize(page, { width: 390, height: 640 });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Retiring");
  await page.getByText("Ask 1", { exact: true }).evaluate((ask) => {
    window.scrollTo(0, ask.getBoundingClientRect().top + window.scrollY - 150);
  });
  await shoot("phone-thread");
  await context.close();
});
