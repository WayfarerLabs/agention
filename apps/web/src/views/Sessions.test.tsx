import type {
  GroupsAndTags,
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
  api = new FakeApi();
  api.on("GET", "/registrations", { body: { registrations: [] } });
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const time = "2026-10-27T12:00:00.000Z";
const earlier = "2026-10-27T10:00:00.000Z";

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
  await screen.findAllByRole("button", { name: new RegExp(`^Agent ${agents[0]?.agent ?? ""}`) });
  return state;
}

// An agent's header, by its name.
const header = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^Agent ${name}(,|$)`) });

// What a header folds.
const folded = (button: HTMLElement) =>
  document.getElementById(button.getAttribute("aria-controls") ?? "") as HTMLElement;

// A header's bar, holding its label and its marks, by its button.
const bar = (button: HTMLElement) => button.closest(".group-head, .subgroup-head") as HTMLElement;

// targets lists where the links on a header's bar lead, in order.
const targets = (button: HTMLElement) =>
  within(bar(button))
    .queryAllByRole("link")
    .map((link) => link.getAttribute("href"));

// A session row's fold, by the session's name, within an agent's header's
// fold when given.
const fold = (session: string, within_: HTMLElement = document.body) =>
  within(within_).getByRole("button", { name: `Session ${session}` });

// A session row's head, which its fold leads.
const headOf = (session: string) => fold(session).parentElement as HTMLElement;

// A session's row.
const row = (session: string, within_?: HTMLElement) =>
  fold(session, within_).closest("li") as HTMLElement;

const options = (path: string) => screen.getByRole("button", { name: `Options for ${path}` });

// A session row's open asks, the link to its open threads, if it has any.
const asksOf = (session: string, within_?: HTMLElement) =>
  within(row(session, within_))
    .queryAllByRole("link")
    .find((link) => link.getAttribute("href")?.startsWith("/?status=open&")) ?? null;

// entry is one of a session's log entries.
function entry(seq: number, fields: Partial<SessionUpdate> = {}): SessionUpdate {
  return { seq, created_at: time, state: "working", inferred: false, ...fields };
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

  it("folds an agent under its header, rolling up its sessions, and keeps that in this browser", async () => {
    await open([
      agent("builder", [
        sessionSummary({
          open_asks: { count: 2, blocking_count: 1 },
          unread_updates: 3,
          threads: { total: 4, unread: 2, stranded: 1 },
        }),
        sessionSummary({
          session: "side",
          open_asks: { count: 1, blocking_count: 0 },
          threads: { total: 1, unread: 1, stranded: 0 },
        }),
      ]),
      agent("reviewer", [sessionSummary()]),
    ]);
    const builder = header("builder");
    // The roll-up adds up the sessions' counts: its sessions and their
    // unread updates, which stand for no threads and link nowhere; its name,
    // the envelope with its unread threads, Blocked on you, in the danger
    // tone, its open asks, its threads and its stranded threads, each
    // linking to those threads, on the header's bar before its options.
    expect(bar(builder).querySelector(".roll-up-count")?.textContent).toMatch(/^2\b/);
    expect(bar(builder).querySelector(".flag.accent")?.textContent).toMatch(/^3\b/);
    expect(within(bar(builder)).getByTitle("3 unread")).toBeTruthy();
    expect(targets(builder)).toEqual([
      "/?agent=builder",
      "/?unread=true&agent=builder",
      "/?impact=blocking&agent=builder",
      "/?status=open&agent=builder",
      "/?agent=builder",
      "/?agent_read=stranded&agent=builder",
    ]);
    expect(within(bar(builder)).getAllByRole("button").at(-1)).toBe(options("builder"));
    // Its heading goes by the button's name alone.
    expect(screen.getByRole("heading", { level: 3, name: "Agent builder" })).toBeTruthy();
    expect(bar(builder).querySelectorAll(".flag.danger")).toHaveLength(1);
    expect(bar(builder).querySelector(".flag.attention")?.textContent).toMatch(/^3\b/);
    // Its threads are a link to them on the thread list, and its stranded
    // threads a link to those.
    const threads = screen.getByRole("link", { name: "5 threads of builder" });
    expect(threads.getAttribute("href")).toBe("/?agent=builder");
    const stranded = screen.getByRole("link", { name: "1 stranded thread of builder" });
    expect(stranded.getAttribute("href")).toBe("/?agent_read=stranded&agent=builder");
    expect(stranded.querySelector(".flag.warning")?.textContent).toMatch(/^1\b/);
    expect(screen.queryByRole("link", { name: /stranded threads? of reviewer$/ })).toBeNull();
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
            updated_at: earlier,
          },
          open_asks: { count: 3, blocking_count: 2 },
          unread_updates: 2,
          threads: { total: 4, unread: 1, stranded: 1 },
        }),
        sessionSummary({ session: "review", status: { state: "idle", updated_at: time } }),
        sessionSummary({
          session: "docs",
          presence: { last_seen_at: time, quiet: true },
          registrations: [],
          status: { state: "stopped", outcome: "completed", updated_at: time },
        }),
        sessionSummary({ session: "nightly", presence: { last_seen_at: time, quiet: true } }),
        sessionSummary({ session: "spare", presence: { quiet: true } }),
      ]),
    ]);
    const main = row("main");
    // Folded by default, so no log loads.
    expect(fold("main").getAttribute("aria-expanded")).toBe("false");
    expect(api.callsTo("GET", "/s/builder/main/updates")).toEqual([]);
    expect(headOf("main").textContent).toContain("Retire invoices");
    expect(headOf("main").textContent).toContain("62%");
    expect(within(main).getByText("Working")).toBeTruthy();
    // Its name links to its threads, and its heading goes by its fold's
    // name alone.
    expect(within(headOf("main")).getByRole("link").getAttribute("href")).toBe(
      "/?session=builder/main",
    );
    expect(within(main).getByRole("heading", { level: 4, name: "Session main" })).toBeTruthy();
    // Blocked on you while any open ask blocks, in the danger tone as the
    // thread list's own blocked mark is, linking to its blocked threads, and
    // its open asks, linking to its open threads.
    const blocked = within(main)
      .getAllByRole("link")
      .find((link) => link.getAttribute("href")?.startsWith("/?impact=blocking&"));
    expect(blocked?.getAttribute("href")).toBe("/?impact=blocking&session=builder/main");
    expect(blocked?.querySelector(".flag.danger")).not.toBeNull();
    const asks = asksOf("main");
    expect(asks?.getAttribute("href")).toBe("/?status=open&session=builder/main");
    expect(asks?.querySelector(".flag.attention")?.textContent).toMatch(/^3\b/);
    // Its threads' roll-up: how many, linking to them, and the envelope with
    // how many are unread, blocked left to its open asks; and its unread
    // updates apart.
    const threads = within(main).getByRole("link", { name: "4 threads of builder/main" });
    expect(threads.getAttribute("href")).toBe("/?session=builder/main");
    // Its stranded threads link to those, flagged as an agent's header flags
    // them.
    const stranded = within(main).getByRole("link", { name: "1 stranded thread of builder/main" });
    expect(stranded.getAttribute("href")).toBe("/?agent_read=stranded&session=builder/main");
    expect(stranded.querySelector(".flag.warning")?.textContent).toMatch(/^1\b/);
    expect(within(row("review")).queryByRole("link", { name: /stranded/ })).toBeNull();
    const unread = within(main).getByTitle("1 unread").closest("a");
    expect(unread?.getAttribute("href")).toBe("/?unread=true&session=builder/main");
    expect(main.querySelectorAll(".flag.danger")).toHaveLength(1);
    expect(within(main).getByText("2 new updates")).toBeTruthy();
    expect(within(main).getByText("Backfill 62% done")).toBeTruthy();

    expect(within(row("review")).getByText("Idle")).toBeTruthy();
    expect(asksOf("review")).toBeNull();
    expect(within(row("review")).queryByTitle(/unread/)).toBeNull();
    // The open envelope says none is unread, and links nowhere.
    expect(within(row("review")).getByTitle("Read").closest("a")).toBeNull();
    expect(within(row("review")).queryByText(/new update/)).toBeNull();
    expect(within(row("docs")).getByText("Stopped · completed")).toBeTruthy();
    expect(within(row("docs")).getByText("No credential")).toBeTruthy();
    expect(within(row("nightly")).getByText("No status")).toBeTruthy();
    // Every row says when its session was last seen, on a line of its own
    // between its head and its facts, in the warning's tone while it is
    // quiet, but for a stopped session, whose state says it will not read
    // what is written; one never seen has no time to give.
    const seen = (session: string) => row(session).querySelector(".session-seen");
    for (const [session, quiet] of [
      ["main", false],
      ["review", false],
      ["docs", false],
      ["nightly", true],
      ["spare", true],
    ] as const) {
      const line = seen(session);
      expect(line?.previousElementSibling?.classList.contains("session-head")).toBe(true);
      expect(line?.nextElementSibling?.classList.contains("session-facts")).toBe(true);
      expect([session, line?.classList.contains("warning")]).toEqual([session, quiet]);
      expect([session, line?.querySelector("time") !== null]).toEqual([
        session,
        session !== "spare",
      ]);
      // The facts hold nothing of when it was seen.
      expect(row(session).querySelector(".session-facts time")).toBeNull();
    }
    // Beside its presence, the line says how old a session's status is, by
    // the time of its latest update, once it has reported one.
    const statusAge = (session: string) =>
      seen(session)?.querySelector(".session-status-age time")?.getAttribute("dateTime");
    expect(statusAge("main")).toBe(earlier);
    expect(statusAge("review")).toBe(time);
    expect(statusAge("docs")).toBe(time);
    expect(statusAge("nightly")).toBeUndefined();
    expect(statusAge("spare")).toBeUndefined();
  });

  it("follows a header's chip to its threads, folding nothing, and folds by the chevron", async () => {
    await open([
      agent("builder", [
        sessionSummary({
          open_asks: { count: 1, blocking_count: 1 },
          threads: { total: 2, unread: 1, stranded: 0 },
        }),
      ]),
    ]);
    const blocked = within(bar(header("builder")))
      .getAllByRole("link")
      .find((link) => link.getAttribute("href")?.startsWith("/?impact=blocking&"));
    fireEvent.click(blocked as HTMLElement);
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    expect(window.location.pathname + window.location.search).toBe(
      "/?impact=blocking&agent=builder",
    );
    // Back on the view, the agent and its row stay as they were.
    cleanup();
    renderAt("/sessions");
    await screen.findByRole("button", { name: "Agent builder" });
    expect(header("builder").getAttribute("aria-expanded")).toBe("true");
    expect(fold("main").getAttribute("aria-expanded")).toBe("false");
    // The chevron is the header's one control, and folds it.
    expect(within(header("builder").closest("h3") as HTMLElement).getAllByRole("button")).toEqual([
      header("builder"),
    ]);
    fireEvent.click(header("builder"));
    expect(header("builder").getAttribute("aria-expanded")).toBe("false");
  });

  it("goes to the session's open threads from its open asks, none blocking", async () => {
    await open([
      agent("builder", [sessionSummary({ open_asks: { count: 1, blocking_count: 0 } })]),
    ]);
    // Asks that block nothing show in the attention tone, on the row and its
    // agent's header alike.
    const asks = asksOf("main") as HTMLElement;
    expect(asks.querySelector(".flag.attention")?.textContent).toMatch(/\b1\b/);
    expect(row("main").querySelector(".flag.danger")).toBeNull();
    expect(bar(header("builder")).querySelector(".flag.attention")?.textContent).toMatch(/\b1\b/);
    expect(bar(header("builder")).querySelector(".flag.danger")).toBeNull();
    fireEvent.click(asks);
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    expect(window.location.pathname + window.location.search).toBe(
      "/?status=open&session=builder/main",
    );
    const listed = api.callsTo("GET", "/threads").at(-1)?.url.searchParams;
    expect([listed?.get("status"), listed?.getAll("session")]).toEqual(["open", ["builder/main"]]);
  });
});

describe("folded by group", () => {
  const billing = { id: 4, name: "Billing" };
  const archive = { id: 7, name: "archive" };
  const sessionIn = (
    group: { id: number; name: string } | undefined,
    session: string,
    threads: number,
    more: Partial<SessionSummary> = {},
  ) =>
    sessionSummary({
      session,
      ...(group === undefined ? {} : { group }),
      threads: { total: threads, unread: 0, stranded: 0 },
      ...more,
    });
  // builder has sessions in Billing, in archive and in no group; reviewer
  // one in Billing, with a blocking ask. The page lists each agent once.
  const grouped: Agents = [
    agent("builder", [
      sessionIn(billing, "main", 2, {
        unread_updates: 1,
        threads: { total: 2, unread: 0, stranded: 1 },
      }),
      sessionIn(undefined, "side", 3),
      sessionIn(archive, "old", 1),
    ]),
    agent("reviewer", [
      sessionIn(billing, "main", 1, {
        threads: { total: 1, unread: 1, stranded: 0 },
        open_asks: { count: 1, blocking_count: 1 },
      }),
    ]),
  ];
  const groupHeader = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^${name}(,|$)`) });
  const groupHeads = () =>
    Array.from(document.querySelectorAll(".group-head > .fold-main > h3 > .fold-toggle")).map(
      (each) => each.getAttribute("aria-label"),
    );

  it("folds the agents under their groups, an agent under each group with that group's sessions", async () => {
    await open(grouped);
    // Groups in name order, whatever the case of their letters, no group last.
    expect(groupHeads()).toEqual(["Group archive", "Group Billing", "No group"]);
    const inBilling = folded(groupHeader("Group Billing"));
    const inNone = folded(groupHeader("No group"));
    const agentsIn = (within_: HTMLElement) =>
      within(within_)
        .getAllByRole("button", { name: /^Agent / })
        .map((each) => each.getAttribute("aria-label"));
    expect(agentsIn(inBilling)).toEqual(["Agent builder", "Agent reviewer"]);
    expect(agentsIn(inNone)).toEqual(["Agent builder"]);
    expect(within(inBilling).getAllByRole("button", { name: "Session main" })).toHaveLength(2);
    expect(within(inBilling).queryByRole("button", { name: /^Session (side|old)$/ })).toBeNull();
    expect(fold("side", inNone)).toBeTruthy();
    // The headings nest: a group's, its agents' a level below, their
    // sessions' below those.
    expect(within(inBilling).getAllByRole("heading", { level: 4 })).toHaveLength(2);
    expect(within(inBilling).getAllByRole("heading", { level: 5 })).toHaveLength(2);
  });

  it("rolls up each group from the sessions it holds, Blocked on its head alone", async () => {
    await open(grouped);
    const billingHead = groupHeader("Group Billing");
    // Its name links to the group's threads; its unread updates link
    // nowhere.
    expect(within(bar(billingHead)).getByTitle("1 unread")).toBeTruthy();
    expect(bar(billingHead).querySelector(".flag.accent")?.textContent).toMatch(/^1\b/);
    expect(targets(billingHead)[0]).toBe("/?session_group=4");
    expect(bar(billingHead).querySelector(".flag.danger")).not.toBeNull();
    expect(screen.getByRole("link", { name: "3 threads of Billing" })).toBeTruthy();
    const noneHead = groupHeader("No group");
    expect(targets(noneHead)[0]).toBe("/?session_group=none");
    expect(bar(noneHead).querySelector(".flag.danger")).toBeNull();
    expect(screen.getByRole("link", { name: "3 threads of no group" })).toBeTruthy();
    // An agent's header under a group rolls up only that group's sessions,
    // with Blocked on you beside its open asks, in the danger tone as the
    // group's, each linking within the group.
    const inBilling = folded(billingHead);
    const reviewer = within(inBilling).getByRole("button", { name: /^Agent reviewer/ });
    expect(bar(reviewer).querySelectorAll(".flag.danger")).toHaveLength(1);
    expect(bar(reviewer).querySelector(".flag.attention")?.textContent).toMatch(/^1\b/);
    expect(targets(reviewer)[0]).toBe("/?agent=reviewer&session_group=4");
    expect(within(inBilling).getByRole("link", { name: "2 threads of builder" })).toBeTruthy();
  });

  it("shows no roll-up on a group's head or an agent's header that left sessions out", async () => {
    await open([{ ...(grouped[0] as Agents[number]), truncated: true }, ...grouped.slice(1)]);
    const billingHead = groupHeader("Group Billing");
    expect(bar(billingHead).querySelector(".roll-up")).toBeNull();
    expect(bar(groupHeader("No group")).querySelector(".roll-up")).toBeNull();
    // Their names link still.
    expect(targets(billingHead)[0]).toBe("/?session_group=4");
    const inBilling = folded(billingHead);
    expect(within(inBilling).getByRole("link", { name: "Threads of builder" })).toBeTruthy();
    expect(within(inBilling).getByRole("link", { name: "1 thread of reviewer" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Threads of Billing" })).toBeTruthy();
    // Its stranded threads link as its threads do, with no count, which
    // would be short, though its session's row has its own.
    const stranded = within(inBilling).getByRole("link", { name: "Stranded threads of builder" });
    expect(stranded.getAttribute("href")).toBe(
      "/?agent_read=stranded&agent=builder&session_group=4",
    );
    expect(stranded.textContent).not.toMatch(/\d/);
    expect(
      within(inBilling).getByRole("link", { name: "1 stranded thread of builder/main" }),
    ).toBeTruthy();
  });

  it("shows no roll-up on any group's head when the view left agents out", async () => {
    // Every page says more follow, so the view stops at its bound, the
    // agents beyond it left out.
    api.on("GET", "/sessions", (call) => ({
      body: { agents: call.url.searchParams.has("cursor") ? [] : grouped, next: "more" },
    }));
    renderAt("/sessions");
    const billingHead = await screen.findByRole("button", { name: /^Group Billing/ });
    expect(bar(billingHead).querySelector(".roll-up")).toBeNull();
    expect(bar(groupHeader("No group")).querySelector(".roll-up")).toBeNull();
    expect(screen.getByRole("link", { name: "Threads of Billing" })).toBeTruthy();
    // An agent that listed all its sessions still rolls them up.
    expect(
      within(folded(billingHead)).getByRole("link", { name: "1 thread of reviewer" }),
    ).toBeTruthy();
  });

  it("links each group's head, and each agent's header within it, to their threads", async () => {
    await open(grouped);
    const link = (name: string, within_: HTMLElement = document.body) =>
      within(within_).getByRole("link", { name }).getAttribute("href");
    expect(link("3 threads of Billing")).toBe("/?session_group=4");
    expect(link("3 threads of no group")).toBe("/?session_group=none");
    // The group's name and each agent's under it link to those threads too.
    expect(targets(groupHeader("Group Billing"))[0]).toBe("/?session_group=4");
    expect(targets(groupHeader("No group"))[0]).toBe("/?session_group=none");
    expect(
      targets(
        within(folded(groupHeader("Group Billing"))).getByRole("button", { name: "Agent builder" }),
      )[0],
    ).toBe("/?agent=builder&session_group=4");
    expect(link("2 threads of builder", folded(groupHeader("Group Billing")))).toBe(
      "/?agent=builder&session_group=4",
    );
    expect(link("3 threads of builder", folded(groupHeader("No group")))).toBe(
      "/?agent=builder&session_group=none",
    );
    // An agent's stranded threads link to those in the group, its session's
    // to the session's; a group's head shows none.
    expect(link("1 stranded thread of builder", folded(groupHeader("Group Billing")))).toBe(
      "/?agent_read=stranded&agent=builder&session_group=4",
    );
    expect(link("1 stranded thread of builder/main", folded(groupHeader("Group Billing")))).toBe(
      "/?agent_read=stranded&session=builder/main",
    );
    expect(screen.getAllByRole("link", { name: /stranded/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("link", { name: "3 threads of Billing" }));
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    expect(window.location.pathname + window.location.search).toBe("/?session_group=4");
    const listed = api.callsTo("GET", "/threads").at(-1)?.url.searchParams;
    expect(listed?.getAll("session_group")).toEqual(["4"]);
  });

  it("keeps a group's fold by its id, and an agent's within each group apart", async () => {
    await open(grouped);
    fireEvent.click(groupHeader("Group Billing"));
    expect(folded(groupHeader("Group Billing")).hidden).toBe(true);
    // builder folded under no group stays unfolded under Billing.
    const inNone = folded(groupHeader("No group"));
    fireEvent.click(within(inNone).getByRole("button", { name: /^Agent builder/ }));
    cleanup();
    const ledger = { ...billing, name: "Ledger" };
    serve(
      grouped.map((entry) => ({
        ...entry,
        sessions: entry.sessions.map((session) =>
          session.group?.id === billing.id ? { ...session, group: ledger } : session,
        ),
      })),
    );
    renderAt("/sessions");
    await screen.findByRole("button", { name: /^Group Ledger/ });
    expect(groupHeader("Group Ledger").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(groupHeader("Group Ledger"));
    expect(
      within(folded(groupHeader("Group Ledger")))
        .getByRole("button", { name: /^Agent builder/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      within(folded(groupHeader("No group")))
        .getByRole("button", { name: /^Agent builder/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("folds by group when any session is in one, whichever agent holds it", async () => {
    await open([
      agent("author", [sessionIn(undefined, "main", 1)]),
      agent("builder", [sessionIn(billing, "main", 1)]),
    ]);
    expect(groupHeads()).toEqual(["Group Billing", "No group"]);
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
    status: {
      state: "working",
      title: "Retire invoices",
      goal: "Drop the table",
      percent: 62,
      updated_at: time,
    },
    unread_updates: 2,
  });

  it("shows its goal, how far it has come, its credentials and its log", async () => {
    serveLog(life, 5);
    await open([agent("builder", [reported])]);
    fireEvent.click(fold("main"));
    expect(fold("main").getAttribute("aria-expanded")).toBe("true");
    const detail = document.getElementById(fold("main").getAttribute("aria-controls") ?? "");
    // The title wraps whole in the row's head, so the goal does not repeat it.
    expect(headOf("main").textContent).toContain("Retire invoices");
    expect(detail?.querySelector(".session-goal")?.textContent).not.toContain("Retire invoices");
    expect(detail?.textContent).toContain("Drop the table");
    expect(detail?.querySelector("progress")?.getAttribute("value")).toBe("62");
    // When it was last seen stays on the row's line alone.
    expect(detail?.querySelector(".session-about time")).toBeNull();
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

  it("marks an entry the server inferred, which carries no note", async () => {
    serveLog([entry(1, { state: "idle", note: "Waiting." }), entry(2, { inferred: true })], 2);
    await open([agent("builder", [{ ...reported, unread_updates: 0 }])]);
    fireEvent.click(fold("main"));
    const log = await screen.findByRole("list", { name: "Updates" });
    const lines = within(log).getAllByRole("listitem");
    expect(lines.map((line) => line.querySelector(".log-inferred") !== null)).toEqual([
      true,
      false,
    ]);
    expect(lines[0]?.querySelector("q")).toBeNull();
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
    // Focus is judged the first time the last page shows, which is when a
    // key could land: moving it any later leaves the page focused between.
    // The probe sits inside waitFor because a late move has already run by
    // the time waitFor resolves.
    fireEvent.click(older);
    let focusedAsShown: Element | null | undefined;
    await waitFor(() => {
      expect(within(log).getAllByRole("listitem")).toHaveLength(25);
      focusedAsShown ??= document.activeElement;
    });
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
    const oldest = within(log).getAllByRole("listitem").at(-1);
    expect(oldest?.textContent).toContain("Step 1");
    expect(focusedAsShown).toBe(oldest);
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
    ).toEqual([
      "New thread",
      "Group: none",
      "Tags: none",
      "Revoke 7KQ2M-X9DPA",
      "Revoke WE26Z-8SH11",
    ]);
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
    // Focus is judged the first time the question is gone, after the revoke
    // request resolves, inside waitFor, as the Older test explains.
    fireEvent.click(screen.getByRole("button", { name: "Revoke credential" }));
    let focusedAsGone: Element | null | undefined;
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Revoke credential" })).toBeNull();
      focusedAsGone ??= document.activeElement;
    });
    expect(focusedAsGone).toBe(options("builder/main"));
    await within(row("main")).findByText("No credential");
    expect(api.callsTo("POST", "/registrations/1/revoke")).toHaveLength(1);
    expect(document.activeElement).toBe(options("builder/main"));
  });
});

describe("the new-thread sheet", () => {
  const sheet = () => screen.getByRole("dialog", { name: "New thread" });

  async function openSheet(
    session: SessionSummary = sessionSummary({ status: { state: "working", updated_at: time } }),
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
      sessionSummary({ status: { state: "stopped", outcome: "stalled", updated_at: time } }),
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
    const working = sessionSummary({ status: { state: "working", updated_at: time } });
    const state = serve([agent("builder", [working])]);
    renderAt("/sessions");
    await screen.findByRole("button", { name: /^Agent builder/ });
    fireEvent.click(options("builder/main"));
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(sheet().querySelector(".notice.warning")).toBeNull();
    state.agents = [
      agent("builder", [
        { ...working, status: { state: "stopped", outcome: "withdrawn", updated_at: time } },
      ]),
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

describe("groups and tags", () => {
  const billing = { id: 4, name: "Billing" };
  const known: GroupsAndTags = {
    groups: [
      { ...billing, color: "blue", sessions: 1 },
      { id: 5, name: "Personal", color: "green", sessions: 0 },
    ],
    tags: [
      { name: "infra", color: "teal", agents: 1, sessions: 1 },
      { name: "urgent", color: "red", agents: 0, sessions: 1 },
    ],
    truncated: false,
  };
  const dialog = (name: string) => screen.getByRole("dialog", { name });
  const posted = (path: string) => api.callsTo("POST", path).map((call) => call.body);

  beforeEach(() => {
    api.on("GET", "/groups-and-tags", { body: known });
  });

  it("show on each session's row and each agent's header, each linking to its threads alone", async () => {
    await open([
      {
        ...agent("builder", [sessionSummary({ group: billing, tags: ["infra", "urgent"] })]),
        tags: ["infra"],
      },
    ]);
    const facts = row("main").querySelector(".session-facts") as HTMLElement;
    const chips = (within_: HTMLElement, selector: string) =>
      Array.from(within_.querySelectorAll(selector)).map((each) => [
        each.textContent,
        each.closest("a")?.getAttribute("href"),
      ]);
    expect(chips(facts, ".group-chip")).toEqual([["Billing", "/?session_group=4"]]);
    expect(chips(facts, ".tag-chip")).toEqual([
      ["infra", "/?tag=infra"],
      ["urgent", "/?tag=urgent"],
    ]);
    // A tag on an agent under a group links to the tag's threads alone, as
    // the agent's other links do not.
    expect(chips(bar(header("builder")), ".tag-chip")).toEqual([["infra", "/?tag=infra"]]);
    fireEvent.click(within(facts).getByRole("link", { name: /urgent/ }));
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    expect(window.location.pathname + window.location.search).toBe("/?tag=urgent");
  });

  it("set a session's group from its options, an existing one or a new one", async () => {
    await open([agent("builder", [sessionSummary()])]);
    api.on("POST", "/s/builder/main/group", { body: {} });
    api.on("POST", "/groups", { body: { id: 6, name: "Release" } });
    fireEvent.click(options("builder/main"));
    fireEvent.click(screen.getByRole("button", { name: "Group: none" }));
    const sheet = dialog("Group for builder/main");
    await within(sheet).findByRole("radio", { name: "Billing" });
    expect(within(sheet).getByRole<HTMLInputElement>("radio", { name: "No group" }).checked).toBe(
      true,
    );
    fireEvent.click(within(sheet).getByRole("radio", { name: "Billing" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted("/s/builder/main/group")).toEqual([{ group: 4 }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(options("builder/main"));

    fireEvent.click(options("builder/main"));
    fireEvent.click(screen.getByRole("button", { name: "Group: none" }));
    const again = dialog("Group for builder/main");
    fireEvent.change(await within(again).findByRole("textbox", { name: "New group's name" }), {
      target: { value: "Release" },
    });
    expect(within(again).getByRole<HTMLInputElement>("radio", { name: "New group" }).checked).toBe(
      true,
    );
    fireEvent.click(within(again).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted("/groups")).toEqual([{ name: "Release" }]));
    await waitFor(() =>
      expect(posted("/s/builder/main/group")).toEqual([{ group: 4 }, { group: 6 }]),
    );
  });

  it("set a session's tags, offering to add a tag no tag has", async () => {
    await open([agent("builder", [sessionSummary({ tags: ["urgent"] })])]);
    api.on("POST", "/s/builder/main/tags", { body: {} });
    fireEvent.click(options("builder/main"));
    fireEvent.click(screen.getByRole("button", { name: "Tags: urgent" }));
    const sheet = dialog("Tags for builder/main");
    const boxes = async () =>
      (await within(sheet).findAllByRole<HTMLInputElement>("checkbox")).map(
        (box) => `${box.checked ? "☑" : "☐"} ${box.closest("label")?.textContent}`,
      );
    expect(await boxes()).toEqual(["☐ infra", "☑ urgent"]);
    const search = within(sheet).getByRole("searchbox", { name: "Search or add tags" });
    fireEvent.change(search, { target: { value: "inf" } });
    expect(await boxes()).toEqual(["☐ infra"]);
    // A name a tag has offers no adding, and one no tag has does.
    fireEvent.change(search, { target: { value: "infra" } });
    expect(within(sheet).queryByRole("button", { name: /^Add tag/ })).toBeNull();
    fireEvent.change(search, { target: { value: "Ops" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Add tag ops" }));
    expect(await boxes()).toEqual(["☐ infra", "☑ ops", "☑ urgent"]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(posted("/s/builder/main/tags")).toEqual([{ tags: ["urgent", "ops"] }]),
    );
  });

  it("set an agent's tags from its header's options", async () => {
    await open([agent("builder", [sessionSummary()])]);
    api.on("POST", "/agents/builder/tags", { body: {} });
    fireEvent.click(screen.getByRole("button", { name: "Options for builder" }));
    fireEvent.click(screen.getByRole("button", { name: "Tags: none" }));
    const sheet = dialog("Tags for builder");
    fireEvent.click(await within(sheet).findByRole("checkbox", { name: "infra" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted("/agents/builder/tags")).toEqual([{ tags: ["infra"] }]));
  });

  it("are listed in their sheet to rename, and to remove once it asks", async () => {
    await open([agent("builder", [sessionSummary()])]);
    api.on("POST", "/groups/4/name", failure("conflict", "another group already has this name"));
    api.on("POST", "/groups/4/remove", { body: {} });
    api.on("POST", "/tags/urgent/name", { body: {} });
    fireEvent.click(screen.getByRole("button", { name: "Groups and tags" }));
    const sheet = dialog("Groups and tags");
    const group = await within(sheet).findByRole("article", { name: "Group Billing" });
    expect(group.textContent).toContain("1 session");
    expect(within(sheet).getByRole("article", { name: "Tag infra" }).textContent).toContain(
      "1 agent, 1 session",
    );
    // Rename refused for a name another group has says why.
    fireEvent.click(within(group).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(group).getByRole("textbox", { name: "New name" }), {
      target: { value: "Personal" },
    });
    fireEvent.click(within(group).getByRole("button", { name: "Save" }));
    expect((await within(group).findByRole("alert")).textContent).toBe(
      "Another group already has this name.",
    );
    fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
    // Remove asks first, saying what it takes the group off.
    fireEvent.click(within(group).getByRole("button", { name: "Remove" }));
    const asking = within(group).getByRole("group", {
      name: "Remove the group Billing? Its 1 session will be in no group.",
    });
    expect(posted("/groups/4/remove")).toEqual([]);
    fireEvent.click(within(asking).getByRole("button", { name: "Remove this group" }));
    await waitFor(() => expect(posted("/groups/4/remove")).toEqual([undefined]));
    // A tag is renamed in its own case.
    const tag = within(sheet).getByRole("article", { name: "Tag urgent" });
    fireEvent.click(within(tag).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(tag).getByRole("textbox", { name: "New name" }), {
      target: { value: "Soon" },
    });
    fireEvent.click(within(tag).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted("/tags/urgent/name")).toEqual([{ name: "soon" }]));
  });
});
