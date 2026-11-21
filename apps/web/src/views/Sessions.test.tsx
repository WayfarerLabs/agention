import type {
  Registration,
  SessionLog,
  SessionsPage,
  SessionSummary,
  SessionUpdate,
} from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Call,
  csrf,
  FakeApi,
  failure,
  operatorMessage,
  registration,
  renderAt,
  sessionSummary,
  threadAnswer,
  threadSummary,
  titled,
} from "../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  window.localStorage.clear();
  api = new FakeApi();
  api.on("GET", "/registrations", { body: { registrations: [] } });
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const time = "2026-10-27T12:00:00.000Z";

type Agents = SessionsPage["agents"];

const agent = (name: string, sessions: SessionSummary[], truncated = false) => ({
  agent: name,
  tags: [],
  sessions,
  truncated,
});

// serve answers the sessions view's page from agents the test can change.
function serve(agents: Agents): { agents: Agents } {
  const state = { agents };
  api.on("GET", "/sessions", () => ({ body: { agents: state.agents } }));
  return state;
}

// serveRegistrations answers the registrations lists, those waiting when
// asked for.
function serveRegistrations(registrations: Registration[]) {
  api.on("GET", "/registrations", (call) => {
    const status = call.url.searchParams.get("status");
    return {
      body: {
        registrations: registrations.filter((each) => status === null || each.status === status),
      },
    };
  });
}

// open shows the sessions view, once its agents have loaded.
async function open(agents: Agents, path = "/sessions") {
  const state = serve(agents);
  renderAt(path);
  await screen.findByRole("button", { name: new RegExp(`^Agent ${agents[0]?.agent ?? ""}`) });
  return state;
}

// An agent's header, by its name.
const header = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^Agent ${name}(,|$)`) });

// What a header folds.
const folded = (button: HTMLElement) =>
  document.getElementById(button.getAttribute("aria-controls") ?? "") as HTMLElement;

// A session row's fold, by the session's name, within an agent's header's
// fold when given.
const fold = (session: string, within_: HTMLElement = document.body) =>
  within(within_).getByRole("button", { name: new RegExp(`^${session}( |$)`) });

// A session's row.
const row = (session: string, within_?: HTMLElement) =>
  fold(session, within_).closest("li") as HTMLElement;

const options = (path: string) => screen.getByRole("button", { name: `Options for ${path}` });

// entry is one of a session's log entries.
function entry(seq: number, fields: Partial<SessionUpdate> = {}): SessionUpdate {
  return { seq, created_at: time, state: "working", ...fields };
}

// serveLog answers a session's log from its entries, oldest first, as the
// server pages it: newest first, before a sequence when asked.
function serveLog(entries: SessionUpdate[], readThrough: number, path = "/s/builder/main") {
  // While gate is set, the log answers once it resolves.
  const state: { readThrough: number; gate?: Promise<void> | undefined } = { readThrough };
  api.on("GET", `${path}/updates`, async (call) => {
    await state.gate;
    const before = Number(call.url.searchParams.get("before") ?? Infinity);
    const limit = Number(call.url.searchParams.get("limit") ?? 50);
    const updates = entries
      .filter((each) => each.seq < before)
      .reverse()
      .slice(0, limit);
    const log: SessionLog = { updates, read_through: state.readThrough };
    return { body: log };
  });
  api.on("POST", `${path}/updates/read`, (call) => {
    state.readThrough = (call.body as { through: number }).through;
    return { body: { read_through: state.readThrough } };
  });
  return state;
}

describe("the sessions view", () => {
  it("shows the registrations waiting, each agent's sessions, then the past requests, folded", async () => {
    serveRegistrations([
      registration(),
      registration({
        id: 2,
        code: "WE26Z-8SH11",
        status: "approved",
        decided_at: time,
        granted: { agent: "builder", session: "main", credential_active: true },
      }),
    ]);
    await open([agent("builder", [sessionSummary()])]);
    await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((each) => each.textContent)).toEqual([
      "Waiting for approval",
      "Agents",
      "Credentials and past requests",
    ]);
    const past = screen.getByRole("button", { name: "Credentials and past requests" });
    expect(past.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("article", { name: "Registration WE26Z-8SH11" })).toBeNull();
    // Folded, they are not loaded.
    const statuses = () =>
      api.callsTo("GET", "/registrations").map((call) => call.url.searchParams.get("status"));
    expect(new Set(statuses())).toEqual(new Set(["pending"]));
    fireEvent.click(past);
    await screen.findByRole("article", { name: "Registration WE26Z-8SH11" });
    expect(statuses()).toContain(null);
    // Opened again in this browser, they stay unfolded.
    cleanup();
    renderAt("/sessions");
    await screen.findByRole("article", { name: "Registration WE26Z-8SH11" });
    expect(
      screen
        .getByRole("button", { name: "Credentials and past requests" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("is what /registrations shows, the page agents' registrations name", async () => {
    await open([agent("builder", [sessionSummary()])], "/registrations");
    expect(screen.getByRole("heading", { level: 1, name: "Sessions" })).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Views" }))
        .getByRole("link", { name: "Sessions" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("says when no agent has a session yet", async () => {
    serve([]);
    renderAt("/sessions");
    const agents = (await screen.findByRole("heading", { name: "Agents" })).closest("section");
    await waitFor(() => expect(agents?.querySelector(".empty")).not.toBeNull());
  });

  it("folds an agent under its header, named with its roll-up, and keeps that in this browser", async () => {
    await open([
      agent("builder", [
        sessionSummary({
          open_asks: { count: 2, blocking_count: 1 },
          unread_updates: 3,
          threads: { total: 4, stranded: 1 },
        }),
        sessionSummary({ session: "side", open_asks: { count: 1, blocking_count: 0 } }),
      ]),
      agent("reviewer", [sessionSummary()]),
    ]);
    const builder = header("builder");
    // The roll-up adds up the sessions' counts.
    expect(builder.getAttribute("aria-label")).toMatch(/\b2 sessions\b.*\b3 open asks\b/);
    expect(builder.getAttribute("aria-label")).toMatch(/\b3 unread updates\b.*\b1 stranded/);
    expect(builder.getAttribute("aria-expanded")).toBe("true");
    expect(fold("side", folded(builder))).toBeTruthy();
    builder.focus();
    fireEvent.click(builder);
    expect(builder.getAttribute("aria-expanded")).toBe("false");
    expect(folded(builder).hidden).toBe(true);
    expect(document.activeElement).toBe(builder);
    expect(folded(header("reviewer")).hidden).toBe(false);
    cleanup();
    renderAt("/sessions");
    await screen.findByRole("button", { name: /^Agent builder/ });
    expect(header("builder").getAttribute("aria-expanded")).toBe("false");
    expect(header("reviewer").getAttribute("aria-expanded")).toBe("true");
  });

  it("carries each session's key facts on its folded row", async () => {
    await open([
      agent("builder", [
        sessionSummary({
          status: {
            state: "working",
            title: "Retire invoices",
            percent: 62,
            note: "Backfill 62% done",
          },
          open_asks: { count: 3, blocking_count: 2 },
          unread_updates: 2,
          threads: { total: 4, stranded: 1 },
        }),
        sessionSummary({ session: "review", status: { state: "idle" } }),
        sessionSummary({
          session: "docs",
          presence: { last_seen_at: time, quiet: true },
          registrations: [],
          status: { state: "stopped", outcome: "completed" },
        }),
        sessionSummary({ session: "nightly", presence: { last_seen_at: time, quiet: true } }),
      ]),
    ]);
    const main = row("main");
    // Folded by default, so no log loads.
    expect(fold("main").getAttribute("aria-expanded")).toBe("false");
    expect(api.callsTo("GET", "/s/builder/main/updates")).toEqual([]);
    expect(fold("main").textContent).toContain("Retire invoices");
    expect(fold("main").textContent).toContain("62%");
    expect(within(main).getByText("Working")).toBeTruthy();
    const asks = within(main).getByRole("link", { name: /^Waiting on you/ });
    expect(asks.textContent).toMatch(/\b3\b.*\b2\b/);
    expect(asks.getAttribute("href")).toBe("/?status=open&session=builder/main");
    const threads = within(main).getByRole("link", { name: /\b4 threads\b/ });
    expect(threads.getAttribute("href")).toBe("/?session=builder/main");
    expect(main.querySelector(".stranded")?.textContent).toMatch(/\b1\b/);
    expect(within(main).getByTitle(/^2 unread/)).toBeTruthy();
    expect(within(main).getByText("Backfill 62% done")).toBeTruthy();

    expect(within(row("review")).getByText("Idle")).toBeTruthy();
    expect(within(row("review")).queryByRole("link", { name: /^Waiting on you/ })).toBeNull();
    expect(within(row("review")).queryByTitle(/unread/)).toBeNull();
    // A stopped session says how it stopped, which says it will not read
    // what is written, so it is not also quiet.
    expect(within(row("docs")).getByText("Stopped · completed")).toBeTruthy();
    expect(within(row("docs")).getByText("No credential")).toBeTruthy();
    expect(within(row("docs")).queryByText(/^Quiet/)).toBeNull();
    expect(within(row("nightly")).getByText("No status")).toBeTruthy();
    expect(
      within(row("nightly"))
        .getByText(/^Quiet/)
        .querySelector("time"),
    ).not.toBeNull();
  });

  it("goes to the session's open threads from what waits on the operator", async () => {
    await open([
      agent("builder", [sessionSummary({ open_asks: { count: 1, blocking_count: 0 } })]),
    ]);
    fireEvent.click(within(row("main")).getByRole("link", { name: /^Waiting on you/ }));
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    expect(window.location.pathname + window.location.search).toBe(
      "/?status=open&session=builder/main",
    );
    const listed = api.callsTo("GET", "/threads").at(-1)?.url.searchParams;
    expect([listed?.get("status"), listed?.getAll("session")]).toEqual(["open", ["builder/main"]]);
  });
});

describe("a session unfolded", () => {
  // A session's life: its first report, a goal and a percent, three updates
  // of progress alone, idle and back; read through the progress.
  const life = [
    entry(1, { title: "Retire invoices" }),
    entry(2, { title: "Retire invoices", goal: "Drop the table", percent: 10 }),
    entry(3, { title: "Retire invoices", goal: "Drop the table", percent: 20 }),
    entry(4, { title: "Retire invoices", goal: "Drop the table", percent: 40 }),
    entry(5, { title: "Retire invoices", goal: "Drop the table", percent: 62 }),
    entry(6, {
      state: "idle",
      title: "Retire invoices",
      goal: "Drop the table",
      percent: 62,
      note: "Waiting on CI",
    }),
    entry(7, { title: "Retire invoices", goal: "Drop the table", percent: 62, note: "CI passed" }),
  ];
  const reported = sessionSummary({
    status: { state: "working", title: "Retire invoices", goal: "Drop the table", percent: 62 },
    unread_updates: 2,
  });

  it("shows its goal, how far it has come, when it was seen, its credentials and its log", async () => {
    serveLog(life, 5);
    await open([agent("builder", [reported])]);
    fireEvent.click(fold("main"));
    expect(fold("main").getAttribute("aria-expanded")).toBe("true");
    const detail = document.getElementById(fold("main").getAttribute("aria-controls") ?? "");
    // The title wraps whole in the row's head, so the goal does not repeat it.
    expect(fold("main").textContent).toContain("Retire invoices");
    expect(detail?.querySelector(".session-goal")?.textContent).not.toContain("Retire invoices");
    expect(detail?.textContent).toContain("Drop the table");
    expect(detail?.querySelector("progress")?.getAttribute("value")).toBe("62");
    expect(detail?.querySelector("time")).not.toBeNull();
    expect(detail?.textContent).toContain("7KQ2M-X9DPA");
    const log = await screen.findByRole("list", { name: "Updates" });
    // One more than it shows, to read what the oldest shown changed.
    expect(api.callsTo("GET", "/s/builder/main/updates")[0]?.url.searchParams.get("limit")).toBe(
      "11",
    );
    // Seven entries, newest first, the three of progress alone in one line.
    const lines = within(log).getAllByRole("listitem");
    expect(lines).toHaveLength(5);
    expect(lines[0]?.textContent).toContain("CI passed");
    expect(lines[2]?.textContent).toMatch(/10%.*62%/);
    expect(lines[4]?.textContent).toContain("Retire invoices");
    // The unread entries are marked, and stay marked once read.
    expect(lines.map((line) => within(line).queryByTitle("Unread") !== null)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    await waitFor(() =>
      expect(api.callsTo("POST", "/s/builder/main/updates/read").map((call) => call.body)).toEqual([
        { through: 7 },
      ]),
    );
    expect(api.callsTo("POST", "/s/builder/main/updates/read")[0]?.headers["x-csrf-token"]).toBe(
      csrf,
    );
    // Reading it reloads the view, for the counts it changed.
    await waitFor(() => expect(api.callsTo("GET", "/sessions").length).toBeGreaterThan(1));
    expect(within(log).getAllByRole("listitem")[0]?.querySelector("[title='Unread']")).not.toBe(
      null,
    );
  });

  it("collapses a run of progress from the first percent the session gave", async () => {
    serveLog([entry(1), entry(2, { percent: 20 }), entry(3, { percent: 60 })], 3);
    await open([agent("builder", [{ ...reported, unread_updates: 0 }])]);
    fireEvent.click(fold("main"));
    const log = await screen.findByRole("list", { name: "Updates" });
    const lines = within(log).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toMatch(/20%.*60%/);
  });

  it("reads nothing it has read already", async () => {
    serveLog(life, 7);
    await open([agent("builder", [{ ...reported, unread_updates: 0 }])]);
    fireEvent.click(fold("main"));
    const log = await screen.findByRole("list", { name: "Updates" });
    expect(within(log).queryAllByTitle("Unread")).toEqual([]);
    expect(api.callsTo("POST", "/s/builder/main/updates/read")).toEqual([]);
  });

  it("shows older entries a page at a time, until the first, keeping focus", async () => {
    const entries = Array.from({ length: 25 }, (_, index) =>
      entry(index + 1, { note: `Step ${index + 1}` }),
    );
    const state = serveLog(entries, 25);
    await open([agent("builder", [reported])]);
    fireEvent.click(fold("main"));
    const log = await screen.findByRole("list", { name: "Updates" });
    expect(within(log).getAllByRole("listitem")).toHaveLength(10);
    const older = screen.getByRole("button", { name: "Older" });
    // A refresh leaves Older as it is.
    let release = () => {};
    state.gate = new Promise((resolve) => (release = resolve));
    const before = api.callsTo("GET", "/s/builder/main/updates").length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(api.callsTo("GET", "/s/builder/main/updates").length).toBeGreaterThan(before),
    );
    expect(older.hasAttribute("aria-disabled")).toBe(false);
    release();
    // The entries it asks for, while they load, make it unavailable, but it
    // keeps focus.
    state.gate = new Promise((resolve) => (release = resolve));
    older.focus();
    fireEvent.click(older);
    await waitFor(() => expect(older.getAttribute("aria-disabled")).toBe("true"));
    expect(document.activeElement).toBe(older);
    release();
    state.gate = undefined;
    await waitFor(() => expect(within(log).getAllByRole("listitem")).toHaveLength(20));
    expect(older.hasAttribute("aria-disabled")).toBe(false);
    expect(document.activeElement).toBe(older);
    // Once the first entry shows, Older goes, and focus moves to the oldest.
    fireEvent.click(older);
    await waitFor(() => expect(within(log).getAllByRole("listitem")).toHaveLength(25));
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
    const oldest = within(log).getAllByRole("listitem").at(-1);
    expect(oldest?.textContent).toContain("Step 1");
    expect(document.activeElement).toBe(oldest);
  });

  it("loads and reads its log only while unfolded under an unfolded agent, starting folded on every visit", async () => {
    const entries = [...life];
    serveLog(entries, 5);
    const reads = () =>
      api.callsTo("POST", "/s/builder/main/updates/read").map((call) => call.body);
    await open([agent("builder", [reported])]);
    fireEvent.click(fold("main"));
    await screen.findByRole("list", { name: "Updates" });
    await waitFor(() => expect(reads()).toEqual([{ through: 7 }]));
    // Under a folded agent the row is not shown, so as new entries arrive
    // and the view refreshes, its log neither loads nor is read.
    fireEvent.click(header("builder"));
    expect(screen.queryByRole("list", { name: "Updates" })).toBeNull();
    entries.push(entry(8, { note: "Unseen" }));
    const loaded = api.callsTo("GET", "/s/builder/main/updates").length;
    const listed = api.callsTo("GET", "/sessions").length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(api.callsTo("GET", "/sessions").length).toBeGreaterThan(listed));
    expect(api.callsTo("GET", "/s/builder/main/updates")).toHaveLength(loaded);
    expect(reads()).toEqual([{ through: 7 }]);
    // Unfolding the agent shows the row as it was, and reads what it shows.
    fireEvent.click(header("builder"));
    await screen.findByRole("list", { name: "Updates" });
    await waitFor(() => expect(reads()).toEqual([{ through: 7 }, { through: 8 }]));
    // Opened again, the row starts folded, and nothing loads its log.
    cleanup();
    const before = api.callsTo("GET", "/s/builder/main/updates").length;
    renderAt("/sessions");
    await screen.findByRole("button", { name: /^Agent builder/ });
    expect(fold("main").getAttribute("aria-expanded")).toBe("false");
    expect(api.callsTo("GET", "/s/builder/main/updates")).toHaveLength(before);
  });

  it("says a session that never reported has no status, and loads no log", async () => {
    await open([agent("builder", [sessionSummary()])]);
    fireEvent.click(fold("main"));
    expect(fold("main").getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("list", { name: "Updates" })).toBeNull();
    expect(api.callsTo("GET", "/s/builder/main/updates")).toEqual([]);
  });
});

describe("a session's options", () => {
  it("offer a new thread, and revoking each credential, closing on Escape", async () => {
    await open([
      agent("builder", [
        sessionSummary({
          registrations: [
            { id: 1, code: "7KQ2M-X9DPA" },
            { id: 2, code: "WE26Z-8SH11" },
          ],
        }),
      ]),
    ]);
    const button = options("builder/main");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const menu = document.getElementById(button.getAttribute("aria-controls") ?? "");
    expect(
      within(menu as HTMLElement)
        .getAllByRole("button")
        .map((each) => each.textContent),
    ).toEqual(["New thread", "Revoke 7KQ2M-X9DPA", "Revoke WE26Z-8SH11"]);
    fireEvent.keyDown(within(menu as HTMLElement).getByRole("button", { name: "New thread" }), {
      key: "Escape",
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("revoke a credential after asking once more, focus returning to the options", async () => {
    const state = await open([agent("builder", [sessionSummary()])]);
    api.on("POST", "/registrations/1/revoke", () => {
      state.agents = [agent("builder", [sessionSummary({ registrations: [] })])];
      return { body: { registration: registration({ status: "revoked" }) } };
    });
    fireEvent.click(options("builder/main"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke 7KQ2M-X9DPA" }));
    const confirm = screen.getByRole("button", { name: "Revoke credential" });
    expect(document.activeElement).toBe(confirm);
    // Cancel asks nothing of the server.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(options("builder/main"));
    expect(api.callsTo("POST", "/registrations/1/revoke")).toEqual([]);

    fireEvent.click(options("builder/main"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke 7KQ2M-X9DPA" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke credential" }));
    await within(row("main")).findByText("No credential");
    expect(api.callsTo("POST", "/registrations/1/revoke")).toHaveLength(1);
    expect(document.activeElement).toBe(options("builder/main"));
  });
});

describe("the new-thread sheet", () => {
  const sheet = () => screen.getByRole("dialog", { name: "New thread" });

  async function openSheet(
    session: SessionSummary = sessionSummary({ status: { state: "working" } }),
  ) {
    await open([agent("builder", [session])]);
    fireEvent.click(options("builder/main"));
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    return sheet();
  }

  it("starts a thread with a title, a message and its details, and opens it", async () => {
    const dialog = await openSheet();
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("heading", { name: "New thread" }),
    );
    // A session that will see the thread draws no warning.
    expect(dialog.querySelector(".notice.warning")).toBeNull();
    const send = within(dialog).getByRole("button", { name: "Send" });
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Title"), {
      target: { value: "Keep the archive" },
    });
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Message"), {
      target: { value: "Keep the nightly archive a week longer." },
    });
    fireEvent.change(within(dialog).getByLabelText("Details"), {
      target: { value: "Finance wants one more close." },
    });
    const thread = threadSummary({ number: 3, title: "Keep the archive", unread: 0 });
    api.on("POST", "/s/builder/main/threads", { body: { number: 3, seq: 1 } });
    api.on("GET", "/s/builder/main/threads/3", {
      body: threadAnswer(thread, [operatorMessage(1, { text: "Keep it." })]),
    });
    fireEvent.click(send);
    await screen.findByRole("heading", { level: 1, name: titled("Keep the archive") });
    expect(window.location.pathname).toBe("/s/builder/main/threads/3");
    const [sent] = api.callsTo("POST", "/s/builder/main/threads") as [Call];
    expect(sent.body).toEqual({
      title: "Keep the archive",
      text: "Keep the nightly archive a week longer.",
      detail: "Finance wants one more close.",
      request_id: expect.stringMatching(/^web-/),
    });
    expect(sent.headers["x-csrf-token"]).toBe(csrf);
  });

  it.each([
    [
      "has stopped, saying how",
      sessionSummary({ status: { state: "stopped", outcome: "stalled" } }),
      "stalled",
    ],
    [
      "is quiet, saying when it was last seen",
      sessionSummary({ presence: { last_seen_at: time, quiet: true } }),
      undefined,
    ],
    ["has no credential", sessionSummary({ registrations: [] }), undefined],
  ])("warns that a session that %s is not likely to see the thread", async (_, session, word) => {
    const dialog = await openSheet(session);
    const warning = dialog.querySelector(".notice.warning");
    expect(warning).not.toBeNull();
    if (word !== undefined) {
      expect(warning?.textContent).toContain(word);
    }
    if (session.presence.quiet) {
      expect(warning?.querySelector("time")).not.toBeNull();
    }
  });

  it("follows the session as the view refreshes", async () => {
    const working = sessionSummary({ status: { state: "working" } });
    const state = serve([agent("builder", [working])]);
    renderAt("/sessions");
    await screen.findByRole("button", { name: /^Agent builder/ });
    fireEvent.click(options("builder/main"));
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(sheet().querySelector(".notice.warning")).toBeNull();
    state.agents = [
      agent("builder", [{ ...working, status: { state: "stopped", outcome: "withdrawn" } }]),
    ];
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(sheet().querySelector(".notice.warning")).not.toBeNull());
    expect(sheet().querySelector(".notice.warning")?.textContent).toContain("withdrawn");
  });

  it("closes on Cancel, sending nothing, and returns focus to the row's options", async () => {
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Later" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(options("builder/main"));
    expect(api.callsTo("POST", "/s/builder/main/threads")).toEqual([]);
  });

  it("ties the server's refusal to the field it names, and retries with the same request id", async () => {
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Keep it" } });
    fireEvent.change(within(dialog).getByLabelText("Message"), { target: { value: "Please." } });
    api.on(
      "POST",
      "/s/builder/main/threads",
      failure("invalid_input", "is refused", { field: "title" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    const title = within(dialog).getByLabelText("Title");
    await waitFor(() => expect(title.getAttribute("aria-invalid")).toBe("true"));
    api.on("POST", "/s/builder/main/threads", failure("internal", "internal error"));
    fireEvent.change(title, { target: { value: "Keep it" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    await within(dialog).findByRole("alert");
    const ids = api
      .callsTo("POST", "/s/builder/main/threads")
      .map((call) => (call.body as { request_id: string }).request_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(screen.getByRole("dialog", { name: "New thread" })).toBeTruthy();
  });
});
