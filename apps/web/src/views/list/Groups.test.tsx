import type { ThreadSummary } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Rollup, ThreadGroups } from "@wayfarerlabs/agention-server-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sinceTime } from "../../format.tsx";
import type { ListedThread } from "./listing.ts";
import {
  FakeApi,
  type Reply,
  renderAt,
  threadSummary,
  titled,
  titleOf,
} from "../../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  window.localStorage.clear();
  api = new FakeApi();
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const rollup = (threads: number, more: Partial<Rollup> = {}): Rollup => ({
  threads,
  unread: 0,
  blocked: false,
  archived: false,
  ...more,
});

// The threads of three sessions, in the order the list grouped by session
// gives them: builder/main's under two topics and none, then reviewer/main's
// and builder/side's under none.
const bySession: ThreadSummary[] = [
  threadSummary({ number: 1, title: "Auth one", topic: "auth" }),
  threadSummary({ number: 3, title: "Auth two", topic: "auth", unread: 0 }),
  threadSummary({ number: 2, title: "Loose", unread: 0 }),
  threadSummary({ agent: "reviewer", number: 1, title: "Review" }),
  threadSummary({ session: "side", number: 1, title: "Side", unread: 0 }),
];

// When builder/side was last seen, long enough ago to be quiet; builder/main
// was seen since, and reviewer/main never.
const lastSeen = "2026-10-27T09:00:00.000Z";
const quietSeen = `last seen ${sinceTime(lastSeen)}`;

const groups: ThreadGroups = {
  sessions: [
    {
      agent: "builder",
      session: "main",
      rollup: rollup(3, { unread: 1, blocked: true, priority: "urgent" }),
      presence: { last_seen_at: "2026-10-27T12:00:00.000Z", quiet: false },
      topics: [
        { topic: "auth", rollup: rollup(2, { unread: 1, blocked: true, priority: "urgent" }) },
        { rollup: rollup(1) },
      ],
    },
    {
      agent: "reviewer",
      session: "main",
      rollup: rollup(1, { unread: 1 }),
      presence: { quiet: true },
      topics: [{ rollup: rollup(1, { unread: 1 }) }],
    },
    {
      agent: "builder",
      session: "side",
      rollup: rollup(1, { archived: true, priority: "high" }),
      presence: { last_seen_at: lastSeen, quiet: true },
      topics: [{ rollup: rollup(1, { archived: true, priority: "high" }) }],
    },
  ],
  truncated: false,
};

// serve answers the list as pages of the threads given, each carrying the
// roll-ups, a page holding the threads before each cut.
function serve(threads: ThreadSummary[], cuts: number[] = [], rolled: ThreadGroups = groups) {
  const bounds = [0, ...cuts, threads.length];
  api.on("GET", "/threads", (call): Reply => {
    const page = Number(call.url.searchParams.get("cursor") ?? "0");
    return {
      body: {
        threads: threads.slice(bounds[page], bounds[page + 1]),
        ...(page + 2 < bounds.length ? { next: String(page + 1) } : {}),
        total: threads.length,
        groups: rolled,
      },
    };
  });
}

// header finds a group's disclosure button, by what it heads.
const header = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^${label}(, |$)`) });
// rows lists the threads' headings at a level.
const rows = (level: number) =>
  screen
    .queryAllByRole("heading", { level })
    .filter((heading) => heading.closest(".thread-row") !== null)
    .map(titleOf);
// outerHeaders and innerHeaders name the headers at each depth.
const namesOf = (selector: string) =>
  Array.from(document.querySelectorAll(selector)).map((each) => each.getAttribute("aria-label"));
const outerHeaders = () => namesOf("h2.group-head button");
const innerHeaders = () => namesOf("h3.subgroup-head button");

describe("grouped by session", () => {
  it("asks the list for its grouping, and folds its rows under each session's header and its topics' when two or more", async () => {
    serve(bySession);
    renderAt("/?unread=true&sort=due&group=session");
    await screen.findByRole("heading", { level: 4, name: titled("Auth one") });
    const [asked] = api.callsTo("GET", "/threads");
    expect(asked?.url.searchParams.get("group")).toBe("session");
    expect(asked?.url.searchParams.get("unread")).toBe("true");
    expect(asked?.url.searchParams.get("sort")).toBe("due");
    // Sessions in the list's order, each a heading wrapping a disclosure
    // button named with its roll-up, expanded.
    const outer = screen.getAllByRole("heading", { level: 2 });
    expect(
      outer.map((heading) => within(heading).getByRole("button").getAttribute("aria-expanded")),
    ).toEqual(["true", "true", "true"]);
    expect(outerHeaders()).toEqual([
      "Agent builder Session main, 3 threads, 1 unread, blocked on you, urgent",
      "Agent reviewer Session main, 1 thread, 1 unread, quiet, never seen",
      `Agent builder Session side, 1 thread, high priority, archived, quiet, ${quietSeen}`,
    ]);
    // A quiet session's header says so for the eye too, in the warning's
    // tone, as the sessions view does.
    expect(
      header("Agent builder Session side").querySelector(".last-seen.warning")?.textContent,
    ).toBe(quietSeen);
    expect(header("Agent builder Session main").querySelector(".last-seen")).toBeNull();
    // Each part of where a session's threads are shows behind its badge.
    const [builder] = outer;
    expect(
      Array.from(builder?.querySelectorAll(".path-badge") ?? []).map((badge) => [
        badge.textContent,
        badge.getAttribute("title"),
        badge.getAttribute("aria-hidden"),
      ]),
    ).toEqual([
      ["A", "Agent", "true"],
      ["S", "Session", "true"],
    ]);
    // Only builder/main's topics branch, so only it has inner headers, each
    // topic behind its badge and named alone beneath its session's, the
    // threads without a topic under none; its threads sit beneath them.
    expect(innerHeaders()).toEqual([
      "Topic auth, 2 threads, 1 unread, blocked on you, urgent",
      "No topic, 1 thread",
    ]);
    expect(
      Array.from(document.querySelectorAll("h3.subgroup-head")).map((heading) => [
        heading.querySelector(".path-badge")?.textContent,
        (heading.querySelector(".path-name") ?? heading.querySelector(".group-label"))?.textContent,
      ]),
    ).toEqual([
      ["T", "auth"],
      [undefined, "No topic"],
    ]);
    expect(rows(4)).toEqual(["Auth one", "Auth two", "Loose"]);
    expect(rows(3)).toEqual(["Review", "Side"]);
  });

  it("shows the closed envelope with a header's unread count, or the open envelope when none is", async () => {
    serve(bySession);
    renderAt("/?group=session");
    await screen.findByRole("heading", { name: titled("Side") });
    expect(
      within(header("Agent reviewer Session main")).getByTitle("1 unread").querySelector("svg"),
    ).not.toBe(null);
    const side = header("Agent builder Session side");
    expect(within(side).queryByTitle(/unread/)).toBeNull();
    expect(within(side).getByTitle("Read").querySelector("svg")).not.toBeNull();
    expect(within(side).getByTitle("Archived").querySelector("svg")).not.toBeNull();
  });

  it("stands a header with its roll-up before all its rows have loaded, and shows more as the list's own pages", async () => {
    serve(bySession, [1]);
    renderAt("/?group=session");
    await screen.findByRole("heading", { name: titled("Auth one") });
    expect(outerHeaders()).toEqual([
      "Agent builder Session main, 3 threads, 1 unread, blocked on you, urgent",
    ]);
    expect(rows(4)).toEqual(["Auth one"]);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByRole("heading", { name: titled("Side") });
    expect(rows(4)).toEqual(["Auth one", "Auth two", "Loose"]);
    expect(api.callsTo("GET", "/threads").at(-1)?.url.searchParams.get("group")).toBe("session");
  });

  it("folds a group's rows under one header though they arrive in two runs", async () => {
    // A group whose first thread changed between pages comes again on the
    // next one.
    const moved = threadSummary({ number: 4, title: "Moved", topic: "auth" });
    serve([...bySession.slice(0, 4), moved, ...bySession.slice(4)], [4]);
    renderAt("/?group=session");
    await screen.findByRole("heading", { name: titled("Review") });
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByRole("heading", { name: titled("Moved") });
    expect(outerHeaders()).toHaveLength(3);
    expect(innerHeaders()).toHaveLength(2);
    expect(rows(4)).toEqual(["Auth one", "Auth two", "Moved", "Loose"]);
  });

  it("names a header without a roll-up when the list left its group out", async () => {
    serve(bySession, [], { sessions: groups.sessions.slice(0, 1), truncated: true });
    renderAt("/?group=session");
    await screen.findByRole("heading", { name: titled("Side") });
    expect(outerHeaders()).toEqual([
      "Agent builder Session main, 3 threads, 1 unread, blocked on you, urgent",
      "Agent reviewer Session main",
      "Agent builder Session side",
    ]);
  });

  it("collapses a header, hiding everything under it, and keeps that on this device", async () => {
    serve(bySession);
    renderAt("/?group=session");
    await screen.findByRole("heading", { name: titled("Auth one") });
    const builder = header("Agent builder Session main");
    builder.focus();
    fireEvent.click(builder);
    expect(builder.getAttribute("aria-expanded")).toBe("false");
    const body = document.getElementById(builder.getAttribute("aria-controls") ?? "");
    expect(body?.hidden).toBe(true);
    expect(screen.queryByRole("heading", { name: titled("Auth one"), hidden: true })).toBeNull();
    expect(document.activeElement).toBe(builder);
    // Opened again on this device, it stays collapsed.
    cleanup();
    api = new FakeApi();
    serve(bySession);
    renderAt("/?group=session");
    await screen.findByRole("heading", { name: titled("Review") });
    expect(header("Agent builder Session main").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header("Agent builder Session main"));
    expect(screen.getByRole("heading", { name: titled("Auth one") })).toBeTruthy();
    // Grouped the other way, the headers are its own.
    fireEvent.click(header("Agent builder Session main"));
    cleanup();
    renderAt("/?group=agent");
    await screen.findByRole("heading", { name: titled("Review") });
    expect(header("Agent builder").getAttribute("aria-expanded")).toBe("true");
  });

  it("says how many threads the list holds on the sheet's Show button", async () => {
    serve(bySession, [2]);
    renderAt("/?group=session");
    await screen.findByRole("heading", { name: titled("Auth one") });
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const sheet = screen.getByRole("dialog", { hidden: true });
    expect(within(sheet).getAllByRole("button").at(-1)?.textContent).toBe("Show 5 threads");
  });

  it("archives the read threads loaded, whatever their group", async () => {
    serve(bySession);
    api.on("POST", "/archives", { body: { archived: [], skipped: [] } });
    renderAt("/?group=session");
    fireEvent.click(await screen.findByRole("button", { name: "Archive all read" }));
    await waitFor(() => expect(api.callsTo("POST", "/archives")).toHaveLength(1));
    expect(api.callsTo("POST", "/archives")[0]?.body).toEqual({
      threads: [
        { agent: "builder", session: "main", thread: 3, through: 1 },
        { agent: "builder", session: "main", thread: 2, through: 1 },
        { agent: "builder", session: "side", thread: 1, through: 1 },
      ],
    });
    // The list loads again.
    await waitFor(() => expect(api.callsTo("GET", "/threads")).toHaveLength(2));
  });
});

describe("grouped by agent", () => {
  // The same threads, as the list grouped by agent gives them.
  const byAgent = [bySession[0], bySession[1], bySession[2], bySession[4], bySession[3]].filter(
    (each) => each !== undefined,
  );

  it("composes each agent from its sessions, its sessions under it when two or more", async () => {
    serve(byAgent);
    renderAt("/?group=agent");
    await screen.findByRole("heading", { name: titled("Side") });
    expect(api.callsTo("GET", "/threads")[0]?.url.searchParams.get("group")).toBe("agent");
    // An agent is quiet only while all its sessions are.
    expect(outerHeaders()).toEqual([
      "Agent builder, 4 threads, 1 unread, blocked on you, urgent",
      "Agent reviewer, 1 thread, 1 unread, quiet, never seen",
    ]);
    // builder has two sessions, each an inner header over its threads;
    // reviewer has one, whose level is skipped.
    expect(innerHeaders()).toEqual([
      "Session main, 3 threads, 1 unread, blocked on you, urgent",
      `Session side, 1 thread, high priority, archived, quiet, ${quietSeen}`,
    ]);
    // An agent's header shows its badge, and a session's within it its own.
    const badges = (selector: string) =>
      Array.from(document.querySelectorAll(`${selector} .path-badge`)).map(
        (badge) => badge.textContent,
      );
    expect(badges("h2.group-head")).toEqual(["A", "A"]);
    expect(badges("h3.subgroup-head")).toEqual(["S", "S"]);
    expect(rows(4)).toEqual(["Auth one", "Auth two", "Loose", "Side"]);
    expect(rows(3)).toEqual(["Review"]);
  });

  it("says an agent is quiet once all its sessions are, last seen when the latest of them was", async () => {
    const later = "2026-10-27T10:00:00.000Z";
    const [main, ...rest] = groups.sessions;
    const quiet =
      main === undefined ? [] : [{ ...main, presence: { last_seen_at: later, quiet: true } }];
    serve(byAgent, [], { sessions: [...quiet, ...rest], truncated: false });
    renderAt("/?group=agent");
    await screen.findByRole("heading", { name: titled("Side") });
    expect(outerHeaders()[0]).toBe(
      `Agent builder, 4 threads, 1 unread, blocked on you, urgent, quiet, last seen ${sinceTime(later)}`,
    );
  });

  it("composes no roll-up for an agent whose sessions the list may have left out", async () => {
    // The roll-ups come in the list's order, cut after builder's first
    // session, so builder's may be missing some and reviewer's are missing.
    serve(byAgent, [], { sessions: groups.sessions.slice(0, 1), truncated: true });
    renderAt("/?group=agent");
    await screen.findByRole("heading", { name: titled("Side") });
    expect(outerHeaders()).toEqual(["Agent builder", "Agent reviewer"]);
    expect(innerHeaders()).toEqual([
      "Session main, 3 threads, 1 unread, blocked on you, urgent",
      "Session side",
    ]);
  });
});

describe("grouped by session group", () => {
  const billing = { id: 4, name: "Billing" };
  // builder's two sessions in Billing, which their first thread places
  // first, and reviewer/main in no group.
  const [authOne, authTwo, loose, review, side] = bySession.map((thread): ListedThread =>
    thread.agent === "builder" ? { ...thread, group: billing } : thread,
  );
  const inGroups = [authOne, authTwo, loose, side, review].filter((each) => each !== undefined);
  const [main, reviewer, sideRollup] = groups.sessions;
  const grouped: ThreadGroups = {
    sessions: [main, sideRollup, reviewer].flatMap((each) =>
      each === undefined ? [] : [each.agent === "builder" ? { ...each, group: billing } : each],
    ),
    truncated: false,
  };
  const innermostHeaders = () => namesOf("h4.subgroup-head button");

  it("folds the sessions under their group's header, each group composed from its sessions", async () => {
    serve(inGroups, [], grouped);
    renderAt("/?group=session_group");
    await screen.findByRole("heading", { level: 5, name: titled("Auth one") });
    expect(api.callsTo("GET", "/threads")[0]?.url.searchParams.get("group")).toBe("session_group");
    expect(outerHeaders()).toEqual([
      "Group Billing, 4 threads, 1 unread, blocked on you, urgent",
      "No group, 1 thread, 1 unread",
    ]);
    expect(innerHeaders()).toEqual([
      "Agent builder Session main, 3 threads, 1 unread, blocked on you, urgent",
      `Agent builder Session side, 1 thread, high priority, archived, quiet, ${quietSeen}`,
      "Agent reviewer Session main, 1 thread, 1 unread, quiet, never seen",
    ]);
    expect(innermostHeaders()).toEqual([
      "Topic auth, 2 threads, 1 unread, blocked on you, urgent",
      "No topic, 1 thread",
    ]);
    expect(rows(5)).toEqual(["Auth one", "Auth two", "Loose"]);
    expect(rows(4)).toEqual(["Side", "Review"]);
  });

  it("keeps a group's fold by its id, so it stays collapsed once renamed", async () => {
    serve(inGroups, [], grouped);
    renderAt("/?group=session_group");
    await screen.findByRole("heading", { name: titled("Auth one") });
    fireEvent.click(header("Group Billing"));
    expect(screen.queryByRole("heading", { name: titled("Auth one") })).toBeNull();
    cleanup();
    api = new FakeApi();
    const ledger = { id: 4, name: "Ledger" };
    serve(
      inGroups.map((thread) =>
        thread.group === undefined ? thread : { ...thread, group: ledger },
      ),
      [],
      {
        ...grouped,
        sessions: grouped.sessions.map((each) =>
          each.group === undefined ? each : { ...each, group: ledger },
        ),
      },
    );
    renderAt("/?group=session_group");
    await screen.findByRole("heading", { name: titled("Review") });
    expect(header("Group Ledger").getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves the sessions heading the list while every one is in one group", async () => {
    const allBilling = bySession.map((thread) => ({ ...thread, group: billing }));
    serve(allBilling, [], {
      sessions: groups.sessions.map((each) => ({ ...each, group: billing })),
      truncated: false,
    });
    renderAt("/?group=session_group");
    await screen.findByRole("heading", { level: 4, name: titled("Auth one") });
    expect(outerHeaders()).toHaveLength(3);
    expect(outerHeaders()[0]).toMatch(/^Agent builder Session main, /);
  });

  it("leaves the groups out grouped by session, though sessions are in them", async () => {
    serve(inGroups, [], grouped);
    renderAt("/?group=session");
    await screen.findByRole("heading", { level: 4, name: titled("Auth one") });
    expect(outerHeaders()).toEqual([
      "Agent builder Session main, 3 threads, 1 unread, blocked on you, urgent",
      `Agent builder Session side, 1 thread, high priority, archived, quiet, ${quietSeen}`,
      "Agent reviewer Session main, 1 thread, 1 unread, quiet, never seen",
    ]);
  });

  it("composes no roll-up for a group whose sessions the list may have left out", async () => {
    serve(inGroups, [], { sessions: grouped.sessions.slice(0, 1), truncated: true });
    renderAt("/?group=session_group");
    await screen.findByRole("heading", { name: titled("Review") });
    expect(outerHeaders()).toEqual(["Group Billing", "No group"]);
  });
});
