import {
  type AskSummary,
  maxListedAsks,
  maxNarrowed,
  type OpenAsks,
  type ThreadCounts,
  type ThreadSummary,
} from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { absoluteTime, sinceTime } from "../format.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { leaveNotice } from "../notice.ts";
import {
  csrf,
  FakeApi,
  type Reply,
  renderAt,
  threadSummary,
  titled,
  titleOf,
} from "../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const total = 12;

function serve(threads: ThreadSummary[], extra: Record<string, unknown> = {}) {
  api.on("GET", "/threads", { body: { threads, total, ...extra } });
}

// holdLists answers each list request only when released, from then on.
function holdLists(answer: (url: URL) => Record<string, unknown> = () => ({})) {
  const held = { holding: false, release: () => {} };
  api.on("GET", "/threads", async (call) => {
    if (held.holding) {
      await new Promise<void>((resolve) => (held.release = resolve));
    }
    return { body: { threads: [], total, ...answer(call.url) } };
  });
  return held;
}

const titles = () => screen.getAllByRole("heading", { level: 2 }).map(titleOf);
const lastQuery = () => api.callsTo("GET", "/threads").at(-1)?.url.searchParams;
const address = () => window.location.search;

const filtersButton = () => screen.getByRole("button", { name: /^Filters/ });
const groupSelect = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Group" });
const sortSelect = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Sort" });
// The button reversing the order, found by the words it shows, which start
// its name.
const directionButton = (shown: string) =>
  screen.getByRole("button", { name: new RegExp(`^${shown}, reverse to `) });
const sheet = () => screen.getByRole<HTMLDialogElement>("dialog", { hidden: true });
const isOpen = () => sheet().hasAttribute("open");
const chips = () => Array.from(document.querySelectorAll<HTMLElement>("button.chip"));
// chipText reads what a chip shows in words, without its badge or its ×,
// which are for the eye alone; badgeOf reads its badge's letter.
const chipText = (chip: HTMLElement) =>
  Array.from(chip.childNodes)
    .filter((node) => !(node instanceof HTMLElement && node.getAttribute("aria-hidden") === "true"))
    .map((node) => node.textContent)
    .join("")
    .trim();
const badgeOf = (chip: HTMLElement) => chip.querySelector(".path-badge")?.textContent;

// openSheet opens the filter sheet from the Filters button.
async function openSheet() {
  await screen.findByRole("heading", { level: 1 });
  filtersButton().focus();
  fireEvent.click(filtersButton());
  expect(isOpen()).toBe(true);
  return sheet();
}

// group finds a group of the open sheet by its legend.
const group = (legend: string) => within(sheet()).getByRole("group", { name: legend });
// segment finds a value of a group by its name, whatever count it shows.
const segment = (legend: string, name: string) =>
  within(group(legend)).getByRole<HTMLInputElement>("radio", {
    name: new RegExp(`^${name.replace(/[+]/g, "\\+")}(, \\d+ threads?)?$`),
  });
const checked = (legend: string) =>
  within(group(legend))
    .getAllByRole<HTMLInputElement>("radio")
    .find((radio) => radio.checked)
    ?.closest("label")?.textContent;

const asking = threadSummary({
  number: 4,
  title: "Pick a database",
  topic: "storage",
  unread: 2,
  open_asks: {
    asks: [
      { number: 1, seq: 3 },
      { number: 2, seq: 5 },
    ],
    count: 2,
    lead: {
      number: 1,
      seq: 3,
      question: "SQLite or Postgres?",
      impact: "blocking",
      priority: "urgent",
      effort: "quick",
      answer_by: "2026-10-27T09:00:00.000Z",
      overdue: true,
    },
    priority: "urgent",
    answer_by: "2026-10-27T09:00:00.000Z",
    blocking: true,
    overdue: true,
  },
});

describe("the thread list", () => {
  it("lists threads in the server's order, each a link holding its heading", async () => {
    serve([
      asking,
      threadSummary({
        number: 2,
        title: "Notes",
        unread: 0,
        credential_active: false,
        open_asks: {
          asks: [{ number: 1, seq: 1 }],
          count: 1,
          lead: {
            number: 1,
            seq: 1,
            question: "Keep the notes?",
            impact: "assuming",
            priority: "normal",
            effort: "longer",
            overdue: false,
          },
          priority: "normal",
          blocking: false,
          overdue: false,
        },
      }),
    ]);
    renderAt("/");
    await screen.findByText("Pick a database");
    expect(titles()).toEqual(["Pick a database", "Notes"]);
    const first = screen.getByRole("link", { name: /Pick a database/ });
    expect(first.getAttribute("href")).toBe("/s/builder/main/threads/4");
    // The thread's number leads its title in the heading.
    const heading = within(first).getByRole("heading", { name: titled("Pick a database") });
    expect(heading.querySelector(".thread-number")?.textContent).toBe("#4");
    expect(within(first).getByText("SQLite or Postgres?")).toBeTruthy();
    expect(
      within(first)
        .getAllByRole("listitem")
        .map((tag) => tag.textContent),
    ).toEqual([
      "Urgent",
      "Blocked on you",
      expect.stringMatching(/^Overdue since /),
      "Quick",
      "1 more open",
    ]);
    // Where the thread is: each part behind its badge, for the eye alone,
    // and said with its kind; the topic never a tag.
    expect(screen.getByRole("link", { name: /Agent builder Session main Topic storage/ })).toBe(
      first,
    );
    expect(
      Array.from(first.querySelectorAll(".where .path-badge")).map((badge) => [
        badge.textContent,
        badge.getAttribute("aria-hidden"),
      ]),
    ).toEqual([
      ["A", "true"],
      ["S", "true"],
      ["T", "true"],
    ]);
    expect(
      within(first)
        .getAllByRole("listitem")
        .map((tag) => tag.textContent),
    ).not.toContain("storage");
    const second = screen.getByRole("link", { name: /Notes/ });
    expect(within(second).getByText("No active credential")).toBeTruthy();
    // An ask the agent goes on assuming about, and its effort, shown short
    // and said in words.
    expect(within(second).getByText("Assuming")).toBeTruthy();
    expect(within(second).getByText(">1h").getAttribute("aria-hidden")).toBe("true");
    expect(within(second).getByText("An hour or more").className).toBe("visually-hidden");
  });

  it("says, muted, that a thread's asks were answered or withdrawn, and why, once none is open", async () => {
    const reason = "Merged at 14:02 by the release job";
    serve([
      threadSummary({ number: 1, title: "Answered", status: "answered" }),
      threadSummary({
        number: 2,
        title: "Withdrawn",
        status: "withdrawn",
        withdrawal: { ask: 3, seq: 4, reason },
      }),
      threadSummary({ number: 3, title: "Nothing asked", status: "none" }),
      threadSummary({ ...asking, status: "open" }),
    ]);
    renderAt("/");
    await screen.findByText("Pick a database");
    const status = (name: string) =>
      screen.getByRole("link", { name: new RegExp(name) }).querySelector(".row-status");
    expect(status("Answered")?.textContent).toBe("Answered");
    expect(status("Withdrawn")?.textContent).toBe(`Withdrawn: ${reason}`);
    expect(status("Nothing asked")).toBeNull();
    expect(status("Pick a database")).toBeNull();
  });

  it("marks every stranded thread with why: its session stopped, is quiet or has no credential", async () => {
    const lastSeen = "2026-10-27T09:00:00.000Z";
    const quiet = { last_seen_at: lastSeen, quiet: true };
    serve([
      threadSummary({ number: 1, title: "Quiet", stranded: true, presence: quiet }),
      threadSummary({ number: 2, title: "Never seen", stranded: true, presence: { quiet: true } }),
      threadSummary({ number: 3, title: "Just revoked", stranded: true, credential_active: false }),
      threadSummary({ number: 4, title: "Fine", stranded: false, presence: quiet }),
      threadSummary({
        number: 5,
        title: "Revoked long ago",
        stranded: true,
        credential_active: false,
        presence: quiet,
      }),
      threadSummary({
        number: 6,
        title: "Stalled",
        stranded: true,
        presence: { ...quiet, state: "stopped", outcome: "stalled" },
      }),
    ]);
    renderAt("/");
    await screen.findByText("Quiet");
    const row = (name: string) => within(screen.getByRole("link", { name: new RegExp(name) }));
    const stranded = (name: string) => row(name).queryByText(/^Stranded/)?.textContent;
    // A quiet session's names when it was last seen, or that it never was.
    expect(stranded("Quiet")).toContain(sinceTime(lastSeen));
    expect(stranded("Never seen")).not.toBe("Stranded");
    // A stopped session's names its outcome, whether or not it is quiet too.
    expect(stranded("Stalled")).toContain("stalled");
    expect(stranded("Stalled")).not.toContain(sinceTime(lastSeen));
    // A session with no active credential is marked once for it, and named
    // for when it was last seen once it is quiet, its credential's tag
    // saying the rest.
    expect(stranded("Just revoked")).not.toBe("Stranded");
    expect(row("Just revoked").getAllByText(/credential/)).toHaveLength(1);
    expect(stranded("Revoked long ago")).toContain(sinceTime(lastSeen));
    expect(row("Revoked long ago").getByText("No active credential")).toBeTruthy();
    expect(stranded("Fine")).toBeUndefined();
  });

  it("counts every other open ask, not only those the summary lists", async () => {
    serve([
      threadSummary({
        ...asking,
        open_asks: {
          ...asking.open_asks,
          asks: Array.from({ length: maxListedAsks }, (_, i) => ({ number: i + 1, seq: 3 })),
          count: 120,
        },
      }),
    ]);
    renderAt("/");
    const row = await screen.findByRole("link", { name: /Pick a database/ });
    expect(within(row).getByText("119 more open")).toBeTruthy();
  });

  it("marks each thread read or unread with its messages, its title bold while unread, and archived", async () => {
    serve([
      // Seven messages, two of them replaced, so five live.
      threadSummary({ number: 1, title: "Unread", last_seq: 7, message_count: 5, unread: 2 }),
      threadSummary({ number: 2, title: "Read", last_seq: 7, message_count: 5, unread: 0 }),
      threadSummary({ number: 3, title: "Archived", unread: 0, archived: true }),
    ]);
    renderAt("/?include_archived=true");
    await screen.findByRole("heading", { level: 2, name: titled("Unread") });
    const row = (name: string) => screen.getByRole("link", { name: new RegExp(`^#\\d+ ${name}`) });
    const heading = (name: string) => within(row(name)).getByRole("heading", { level: 2 });
    // While any message is unread, the closed envelope with the unread
    // messages over all the thread holds; once all are read, the open
    // envelope with how many it holds. Each is shown short for the eye and
    // said in words, which name the row too.
    const mark = (name: string, label: string) => within(row(name)).getByTitle(label);
    const unread = mark("Unread", "2 of 5 messages unread");
    const read = mark("Read", "5 messages read");
    expect(within(unread).getByText("2/5").getAttribute("aria-hidden")).toBe("true");
    expect(within(read).getByText("5").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("link", { name: /2 of 5 messages unread/ })).toBe(row("Unread"));
    const drawn = (icon: IconName) => render(<Icon name={icon} />).container.innerHTML;
    expect(unread.querySelector("svg")?.outerHTML).toBe(drawn("unread"));
    expect(read.querySelector("svg")?.outerHTML).toBe(drawn("read"));
    expect(heading("Unread").closest("li")?.classList.contains("unread")).toBe(true);
    expect(heading("Read").closest("li")?.classList.contains("unread")).toBe(false);
    expect(mark("Archived", "1 message read")).toBeTruthy();
    expect(mark("Archived", "Archived").querySelector("svg")).not.toBeNull();
    expect(within(row("Read")).queryByTitle("Archived")).toBeNull();
  });

  it("asks for the threads not archived, in priority order, ungrouped, with no filter on", async () => {
    serve([]);
    renderAt("/");
    const heading = await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(lastQuery()).toBeDefined());
    expect(Array.from(lastQuery()?.keys() ?? [])).toEqual([]);
    expect(heading.textContent).toBe("Threads");
    expect(chips()).toEqual([]);
    expect(api.callsTo("GET", "/threads/counts")).toEqual([]);
  });

  it("heads the list with the order and its direction, the grouping and the Filters button, after its heading", async () => {
    serve([]);
    renderAt("/");
    const heading = await screen.findByRole("heading", { level: 1 });
    const head = filtersButton().parentElement as HTMLElement;
    const controls = Array.from(head.querySelectorAll("h1, select, button"));
    expect(controls).toEqual([
      sortSelect(),
      directionButton("Most pressing first"),
      groupSelect(),
      filtersButton(),
    ]);
    // Sort and its direction are held together.
    expect(directionButton("Most pressing first").parentElement).toBe(
      sortSelect().closest(".sort-control"),
    );
    expect(heading.nextElementSibling).toBe(head);
    expect(Array.from(groupSelect().options).map((each) => each.value)).toEqual([
      "",
      "session",
      "agent",
    ]);
    expect(groupSelect().value).toBe("");
    expect(Array.from(sortSelect().options).map((each) => each.value)).toEqual([
      "priority",
      "due",
      "effort",
      "latest",
      "created",
    ]);
    expect(sortSelect().value).toBe("priority");
    // Each control's icon is drawn for the eye alone; Filters is named by
    // words, and says how many filters are on once any are.
    for (const icon of head.querySelectorAll("svg")) {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
    expect(filtersButton().getAttribute("aria-label")).toBe("Filters");
    expect(filtersButton().getAttribute("aria-haspopup")).toBe("dialog");
    expect(filtersButton().querySelector(".badge")).toBeNull();
  });

  it("orders the list as chosen, keeping the filters and focus, and replacing the address", async () => {
    serve([]);
    renderAt("/?unread=true");
    await screen.findByRole("heading", { level: 1 });
    const length = window.history.length;
    sortSelect().focus();
    fireEvent.change(sortSelect(), { target: { value: "due" } });
    await waitFor(() => expect(address()).toBe("?unread=true&sort=due"));
    await waitFor(() => expect(lastQuery()?.get("sort")).toBe("due"));
    expect(lastQuery()?.get("unread")).toBe("true");
    expect(document.activeElement).toBe(sortSelect());
    // The order is no filter: no chip, and the badge counts only Unread.
    expect(chips().map(chipText)).toEqual(["Unread"]);
    expect(filtersButton().getAttribute("aria-label")).toBe("Filters, 1 on");
    fireEvent.change(sortSelect(), { target: { value: "priority" } });
    await waitFor(() => expect(address()).toBe("?unread=true"));
    await waitFor(() => expect(lastQuery()?.has("sort")).toBe(false));
    expect(window.history.length).toBe(length);
  });

  it("reverses the order with its direction button, keeping the filters and focus, and replacing the address", async () => {
    serve([]);
    renderAt("/?unread=true&sort=due&group=agent");
    await screen.findByRole("heading", { level: 1 });
    const length = window.history.length;
    const button = directionButton("Soonest first");
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(address()).toBe("?unread=true&sort=due&reverse=true&group=agent"));
    await waitFor(() => expect(lastQuery()?.get("reverse")).toBe("true"));
    expect(lastQuery()?.get("sort")).toBe("due");
    expect(lastQuery()?.get("unread")).toBe("true");
    // The same button now shows the order reversed, and keeps focus.
    expect(directionButton("Latest first")).toBe(button);
    expect(document.activeElement).toBe(button);
    // The direction is no filter.
    expect(chips().map(chipText)).toEqual(["Unread"]);
    expect(filtersButton().getAttribute("aria-label")).toBe("Filters, 1 on");
    fireEvent.click(button);
    await waitFor(() => expect(address()).toBe("?unread=true&sort=due&group=agent"));
    await waitFor(() => expect(lastQuery()?.has("reverse")).toBe(false));
    expect(window.history.length).toBe(length);
  });

  it.each(["priority", "due", "effort", "latest", "created"])(
    "names the %s order's direction by the words it shows, first in its name, and no pressed state",
    async (sort) => {
      serve([]);
      renderAt(`/?sort=${sort}`);
      await screen.findByRole("heading", { level: 1 });
      const button = screen.getByRole("button", { name: /, reverse to / });
      const own = button.textContent ?? "";
      expect(button.getAttribute("aria-label")?.startsWith(`${own}, reverse to `)).toBe(true);
      expect(button.hasAttribute("aria-pressed")).toBe(false);
      fireEvent.click(button);
      // Priority, the default order, leaves the address.
      const order = sort === "priority" ? "" : `sort=${sort}&`;
      await waitFor(() => expect(address()).toBe(`?${order}reverse=true`));
      const reversed = button.textContent ?? "";
      expect(reversed).not.toBe(own);
      expect(button.getAttribute("aria-label")).toBe(
        `${reversed}, reverse to ${own.toLowerCase()}`,
      );
    },
  );

  it("takes another order in its own direction", async () => {
    serve([]);
    renderAt("/?sort=due&reverse=true");
    await screen.findByRole("heading", { level: 1 });
    directionButton("Latest first");
    fireEvent.change(sortSelect(), { target: { value: "created" } });
    await waitFor(() => expect(address()).toBe("?sort=created"));
    await waitFor(() => expect(lastQuery()?.has("reverse")).toBe(false));
    expect(lastQuery()?.get("sort")).toBe("created");
    directionButton("Newest first");
  });

  it("groups the list as chosen, keeping the filters, the order and focus, and replacing the address", async () => {
    serve([]);
    renderAt("/?unread=true&sort=due");
    await screen.findByRole("heading", { level: 1 });
    const length = window.history.length;
    groupSelect().focus();
    fireEvent.change(groupSelect(), { target: { value: "agent" } });
    await waitFor(() => expect(address()).toBe("?unread=true&sort=due&group=agent"));
    await waitFor(() => expect(lastQuery()?.get("group")).toBe("agent"));
    expect(lastQuery()?.get("sort")).toBe("due");
    expect(lastQuery()?.get("unread")).toBe("true");
    expect(document.activeElement).toBe(groupSelect());
    // Grouping is no filter either.
    expect(filtersButton().getAttribute("aria-label")).toBe("Filters, 1 on");
    fireEvent.change(groupSelect(), { target: { value: "" } });
    await waitFor(() => expect(address()).toBe("?unread=true&sort=due"));
    expect(window.history.length).toBe(length);
  });

  it("shows the list's total on the sheet's Show button, clearing it while another list loads", async () => {
    const held = holdLists();
    renderAt("/");
    const open = await openSheet();
    const show = () => within(open).getAllByRole("button").at(-1)?.textContent;
    await waitFor(() => expect(show()).toBe(`Show ${total} threads`));
    held.holding = true;
    fireEvent.click(segment("Read", "Unread"));
    await waitFor(() => expect(address()).toBe("?unread=true"));
    expect(show()).toBe("Show threads");
    held.release();
    await waitFor(() => expect(show()).toBe(`Show ${total} threads`));
  });
});

// local writes a time on the browser's own clock, given as Date's
// constructor takes one, as the server writes times. The due marks' tests
// set that clock to noon on 10 November 2026, so the times fall on the days
// they name in every time zone.
const local = (...parts: [number, number, number, number]) => new Date(...parts).toISOString();

// due is when an ask is due, and whether the server finds that passed.
const due = (answer_by: string, overdue = false) => ({ answer_by, overdue });

// dueThread is a thread with two asks open: when the earliest of them is
// due, and when its lead ask is.
function dueThread(
  number: number,
  title: string,
  earliest: Pick<OpenAsks, "answer_by" | "overdue">,
  lead: Pick<AskSummary, "answer_by" | "overdue"> = { overdue: false },
): ThreadSummary {
  return threadSummary({
    number,
    title,
    open_asks: {
      asks: [
        { number: 1, seq: 1 },
        { number: 2, seq: 1 },
      ],
      count: 2,
      lead: {
        number: 1,
        seq: 1,
        question: "Ship it?",
        impact: "none",
        priority: "normal",
        ...lead,
      },
      priority: "normal",
      blocking: false,
      ...earliest,
    },
  });
}

// dueMarks reads the marks on a thread's row saying an ask is due or
// overdue: the words of each, the time it stands for and its tone.
const dueMarks = (title: string) =>
  within(screen.getByRole("link", { name: new RegExp(title) }))
    .getAllByRole("listitem")
    .filter((tag) => /Due|Overdue/.test(tag.textContent ?? ""))
    .map((tag) => ({
      words: tag.textContent,
      at: tag.querySelector("time")?.getAttribute("datetime"),
      tone: tag.className,
    }));

describe("a row's due mark", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 10, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says when the earliest of a thread's open asks is due, by its time today and its date on another day", async () => {
    const today = local(2026, 10, 10, 15);
    const later = local(2026, 10, 12, 9);
    const nextYear = local(2027, 0, 5, 10);
    serve([
      dueThread(1, "Today", due(today), due(local(2026, 10, 11, 10))),
      dueThread(2, "Later", due(later)),
      dueThread(3, "Next year", due(nextYear)),
      dueThread(4, "Whenever", { overdue: false }),
    ]);
    renderAt("/");
    await screen.findByText("Today");
    // The earliest answer-by, whichever ask carries it, with the exact time
    // in its tooltip.
    expect(dueMarks("Today")).toEqual([{ words: `Due ${sinceTime(today)}`, at: today, tone: "" }]);
    const time = screen.getByRole("link", { name: /Today/ }).querySelector(".tags time");
    expect(time?.getAttribute("title")).toBe(absoluteTime(today));
    // Another day's with its date, and with its year only when not this
    // year's.
    const dayAndClock = new Date(later).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(dueMarks("Later")).toEqual([{ words: `Due ${dayAndClock}`, at: later, tone: "" }]);
    expect(dueMarks("Next year")).toEqual([
      { words: `Due ${absoluteTime(nextYear)}`, at: nextYear, tone: "" },
    ]);
    expect(dueMarks("Whenever")).toEqual([]);
  });

  it("says a thread is overdue as the server finds it, whatever the browser's clock, and only once", async () => {
    const afternoon = local(2026, 10, 10, 15);
    const morning = local(2026, 10, 10, 9);
    serve([
      dueThread(1, "Late on the server", due(afternoon, true), due(afternoon, true)),
      dueThread(2, "In time on the server", due(morning), due(morning)),
    ]);
    renderAt("/");
    await screen.findByText("Late on the server");
    // The lead ask's own overdue adds no mark of its own.
    expect(dueMarks("Late on the server")).toEqual([
      { words: `Overdue since ${sinceTime(afternoon)}`, at: afternoon, tone: "warning" },
    ]);
    expect(dueMarks("In time on the server")).toEqual([
      { words: `Due ${sinceTime(morning)}`, at: morning, tone: "" },
    ]);
  });
});

// counts answers the counts of a list: some of each kind, each different, so
// a test can tell which is shown where.
const counts: ThreadCounts = {
  status: { any: 30, open: 9, answered: 34, withdrawn: 35, none: 36 },
  priority: { any: 29, normal: 8, high: 7, urgent: 6 },
  impact: { any: 28, blocking: 5, assuming: 4 },
  overdue: { any: 27, overdue: 3 },
  effort: { any: 26, quick: 2, under_15m: 11, under_1h: 12 },
  unread: { any: 25, unread: 13 },
  agent_read: { any: 24, unread: 14, stranded: 37 },
  include_archived: { hide: 23, show: 33 },
  agent: {
    agents: [
      { agent: "builder", total: 15 },
      { agent: "reviewer", total: 16 },
    ],
    truncated: false,
  },
  session: {
    sessions: [
      { agent: "builder", session: "main", total: 17 },
      { agent: "reviewer", session: "main", total: 18 },
      { agent: "builder", session: "side", total: 19 },
    ],
    truncated: false,
  },
  topic: {
    topics: [
      { agent: "builder", session: "main", topic: "auth", total: 21 },
      { agent: "reviewer", session: "main", topic: "billing", total: 22 },
    ],
    truncated: false,
  },
  reset: 40,
};

// serveCounts answers each counts request with counts, until a test holds
// them; held, it answers only once released.
function serveCounts() {
  const held = { holding: false, release: () => {} };
  api.on("GET", "/threads/counts", async (): Promise<Reply> => {
    if (held.holding) {
      await new Promise<void>((resolve) => (held.release = resolve));
    }
    return { body: counts };
  });
  return held;
}

const countCalls = () => api.callsTo("GET", "/threads/counts");

describe("the filter sheet", () => {
  it("opens as a modal dialog of labelled groups, and returns focus to Filters on closing", async () => {
    serve([]);
    renderAt("/");
    const open = await openSheet();
    expect(open.getAttribute("aria-labelledby")).not.toBeNull();
    // Focus lands on the sheet's heading, not the search box, so no keyboard
    // rises over the sheet as it opens.
    expect(document.activeElement).toBe(within(open).getByRole("heading", { level: 2 }));
    expect(within(open).getByRole("searchbox", { name: "Search titles" })).toBeTruthy();
    const groups = within(open).getAllByRole("group");
    expect(groups.map((each) => each.querySelector("legend")?.textContent)).toEqual([
      "Status",
      "Priority",
      "Impact",
      "Due",
      "Effort",
      "Read",
      "Read by agent",
      "Archived",
    ]);
    // Each is a row of radio buttons, the first, which turns its filter off,
    // checked.
    for (const each of groups) {
      const radios = within(each).getAllByRole<HTMLInputElement>("radio");
      expect(radios.map((radio) => radio.checked)).toEqual(radios.map((_, i) => i === 0));
    }
    // Agent and Session are buttons disclosing their choices.
    for (const name of [/^Agent/, /^Session/]) {
      expect(within(open).getByRole("button", { name }).getAttribute("aria-expanded")).toBe(
        "false",
      );
    }
    const [show] = within(open).getAllByRole("button").slice(-1);
    fireEvent.click(show as HTMLElement);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(filtersButton());
    // Escape closes it as the browser does, and focus returns the same way.
    await openSheet();
    sheet().focus();
    sheet().close();
    expect(document.activeElement).toBe(filtersButton());
  });

  it.each([
    ["Status", "Open", "status=open", ["status", "open"]],
    ["Status", "Answered", "status=answered", ["status", "answered"]],
    ["Status", "Withdrawn", "status=withdrawn", ["status", "withdrawn"]],
    ["Status", "No asks", "status=none", ["status", "none"]],
    ["Priority", "Normal priority or more", "priority=normal", ["priority", "normal"]],
    ["Priority", "High priority or more", "priority=high", ["priority", "high"]],
    ["Priority", "Urgent", "priority=urgent", ["priority", "urgent"]],
    ["Impact", "Blocking", "impact=blocking", ["impact", "blocking"]],
    ["Impact", "Assuming", "impact=assuming", ["impact", "assuming"]],
    ["Due", "Overdue", "overdue=true", ["overdue", "true"]],
    ["Effort", "Quick", "effort=quick", ["effort", "quick"]],
    ["Effort", "Under 15 minutes", "effort=under_15m", ["effort", "under_15m"]],
    ["Effort", "Under an hour", "effort=under_1h", ["effort", "under_1h"]],
    ["Read", "Unread", "unread=true", ["unread", "true"]],
    ["Read by agent", "Unread", "agent_read=unread", ["agent_read", "unread"]],
    ["Read by agent", "Stranded", "agent_read=stranded", ["agent_read", "stranded"]],
    ["Archived", "Show", "include_archived=true", ["include_archived", "true"]],
  ] as const)(
    "sets %s to %s, updating the list behind it",
    async (legend, name, set, [key, value]) => {
      serve([]);
      renderAt("/");
      await openSheet();
      fireEvent.click(segment(legend, name));
      await waitFor(() => expect(address()).toBe(`?${set}`));
      await waitFor(() => expect(lastQuery()?.get(key)).toBe(value));
      expect(segment(legend, name).checked).toBe(true);
      expect(isOpen()).toBe(true);
      // Its first value turns it off again.
      fireEvent.click(within(group(legend)).getAllByRole("radio")[0] as HTMLElement);
      await waitFor(() => expect(address()).toBe(""));
    },
  );

  it("shows Status as Open while a property of open asks is on, and another status turns them all off", async () => {
    serve([]);
    renderAt("/?priority=high&overdue=true&effort=quick&unread=true");
    await openSheet();
    expect(checked("Status")).toContain("Open");
    expect(checked("Priority")).toContain("High+");
    fireEvent.click(segment("Status", "Answered"));
    await waitFor(() => expect(address()).toBe("?status=answered&unread=true"));
    expect(checked("Effort")).toContain("Any");
    // Open keeps a property chosen beside it, and another status turns it off.
    fireEvent.click(segment("Status", "Open"));
    await waitFor(() => expect(address()).toBe("?status=open&unread=true"));
    fireEvent.click(segment("Priority", "High priority or more"));
    await waitFor(() => expect(address()).toBe("?status=open&priority=high&unread=true"));
    fireEvent.click(segment("Status", "No asks"));
    await waitFor(() => expect(address()).toBe("?status=none&unread=true"));
    fireEvent.click(segment("Status", "Any"));
    await waitFor(() => expect(address()).toBe("?unread=true"));
    expect(checked("Status")).toContain("Any");
    expect(checked("Priority")).toContain("Any");
    // A property chosen under another status chooses Open.
    fireEvent.click(segment("Status", "Withdrawn"));
    await waitFor(() => expect(address()).toBe("?status=withdrawn&unread=true"));
    fireEvent.click(segment("Effort", "Quick"));
    await waitFor(() => expect(address()).toBe("?status=open&effort=quick&unread=true"));
    expect(checked("Status")).toContain("Open");
  });

  it("takes one of Unread and Stranded for Read by agent", async () => {
    serve([]);
    renderAt("/?agent_read=unread");
    await openSheet();
    fireEvent.click(segment("Read by agent", "Stranded"));
    await waitFor(() => expect(address()).toBe("?agent_read=stranded"));
    fireEvent.click(segment("Read by agent", "Unread"));
    await waitFor(() => expect(address()).toBe("?agent_read=unread"));
  });

  it("counts the threads each value keeps, from counts of the list's filters loaded while it is open", async () => {
    serve([]);
    serveCounts();
    renderAt(
      "/?unread=true&agent=builder&agent=reviewer&session=builder/main&topic=builder/main/auth",
    );
    await screen.findByRole("heading", { level: 1 });
    // Nothing is counted until the sheet opens.
    expect(countCalls()).toEqual([]);
    await openSheet();
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    const asked = countCalls()[0]?.url.searchParams;
    expect(asked?.get("unread")).toBe("true");
    expect(asked?.getAll("agent")).toEqual(["builder", "reviewer"]);
    expect(asked?.getAll("session")).toEqual(["builder/main"]);
    expect(asked?.getAll("topic")).toEqual(["builder/main/auth"]);
    // Each value not chosen shows its count, said in words; a chosen one
    // shows none.
    const name = (legend: string, label: string) =>
      within(group(legend))
        .getAllByRole("radio")
        .find((radio) => radio.closest("label")?.textContent?.startsWith(label))
        ?.closest("label")?.textContent;
    await waitFor(() => expect(name("Read", "Any")).toBe("Any (25)Any, 25 threads"));
    expect(name("Read", "Unread")).toBe("Unread");
    expect(segment("Read by agent", "Unread").closest("label")?.textContent).toContain("(14)");
    expect(segment("Read by agent", "Stranded").closest("label")?.textContent).toContain("(37)");
    expect(segment("Status", "Withdrawn").closest("label")?.textContent).toContain("(35)");
    expect(segment("Status", "No asks").closest("label")?.textContent).toContain("(36)");
    expect(segment("Effort", "Under 15 minutes").closest("label")?.textContent).toContain("(11)");
    expect(segment("Archived", "Show").closest("label")?.textContent).toContain("(33)");
    expect(segment("Archived", "Hide").closest("label")?.textContent).not.toContain("(");
    // Reset filters counts the threads with none on.
    expect(within(sheet()).getByRole("button", { name: /^Reset filters/ }).textContent).toContain(
      "(40)",
    );
    // Each change counts again, with the filters it leaves.
    fireEvent.click(segment("Due", "Overdue"));
    await waitFor(() => expect(countCalls()).toHaveLength(2));
    expect(countCalls()[1]?.url.searchParams.get("overdue")).toBe("true");
  });

  it("keeps the last counts until new ones arrive, and counts nothing once closed", async () => {
    serve([]);
    const held = serveCounts();
    renderAt("/");
    await openSheet();
    await waitFor(() =>
      expect(segment("Read", "Unread").closest("label")?.textContent).toContain("(13)"),
    );
    held.holding = true;
    fireEvent.click(segment("Due", "Overdue"));
    await waitFor(() => expect(countCalls()).toHaveLength(2));
    expect(segment("Read", "Unread").closest("label")?.textContent).toContain("(13)");
    held.release();
    sheet().close();
    fireEvent.change(sortSelect(), { target: { value: "due" } });
    fireEvent.click(chips()[0] as HTMLElement);
    await waitFor(() => expect(address()).toBe("?sort=due"));
    expect(countCalls()).toHaveLength(2);
  });

  it("searches titles once typing pauses, and Reset filters turns every filter off but keeps the order and grouping", async () => {
    serve([]);
    renderAt("/?unread=true&sort=effort&reverse=true&group=session");
    const open = await openSheet();
    const box = within(open).getByRole<HTMLInputElement>("searchbox", { name: "Search titles" });
    fireEvent.change(box, { target: { value: "release" } });
    fireEvent.change(box, { target: { value: "release notes" } });
    expect(address()).toBe("?unread=true&sort=effort&reverse=true&group=session");
    await waitFor(() =>
      expect(address()).toBe(
        "?search=release+notes&unread=true&sort=effort&reverse=true&group=session",
      ),
    );
    fireEvent.click(within(open).getByRole("button", { name: /^Reset filters/ }));
    await waitFor(() => expect(address()).toBe("?sort=effort&reverse=true&group=session"));
    expect(box.value).toBe("");
    expect(sortSelect().value).toBe("effort");
    expect(groupSelect().value).toBe("session");
  });

  // pause waits past the pause after typing, so a pending search would apply.
  const pause = () => new Promise((resolve) => setTimeout(resolve, 600));

  it("applies a pending search to the list as it stands, keeping a filter chosen meanwhile", async () => {
    serve([]);
    renderAt("/");
    const open = await openSheet();
    fireEvent.change(within(open).getByRole("searchbox", { name: "Search titles" }), {
      target: { value: "release" },
    });
    fireEvent.click(segment("Read", "Unread"));
    await waitFor(() => expect(address()).toBe("?search=release&unread=true"));
  });

  it("leaves the search off while the box holds only white space", async () => {
    serve([]);
    renderAt("/?unread=true");
    const open = await openSheet();
    fireEvent.change(within(open).getByRole("searchbox", { name: "Search titles" }), {
      target: { value: " \t " },
    });
    await pause();
    expect(address()).toBe("?unread=true");
    expect(api.callsTo("GET", "/threads").some((call) => call.url.searchParams.has("search"))).toBe(
      false,
    );
  });

  it.each([
    ["a zero-width space", "no\u200btes"],
    ["a tab", "notes\t and more"],
    ["a bidirectional override", "no\u202etes"],
  ])(
    "keeps text holding %s in the box, marked invalid, and the list as it was",
    async (_, text) => {
      serve([]);
      renderAt("/?search=notes");
      const open = await openSheet();
      const box = within(open).getByRole<HTMLInputElement>("searchbox", { name: "Search titles" });
      fireEvent.change(box, { target: { value: text } });
      await pause();
      expect(address()).toBe("?search=notes");
      expect(box.value).toBe(text);
      expect(box.getAttribute("aria-invalid")).toBe("true");
      const error = document.getElementById(box.getAttribute("aria-describedby") ?? "");
      expect(error?.classList.contains("field-error")).toBe(true);
      expect(
        api.callsTo("GET", "/threads").map((call) => call.url.searchParams.get("search")),
      ).not.toContain(text);
      // Text the API takes clears the mark, and applies.
      fireEvent.change(box, { target: { value: "notes and more" } });
      expect(box.hasAttribute("aria-invalid")).toBe(false);
      await waitFor(() => expect(address()).toBe("?search=notes+and+more"));
    },
  );

  it("cancels a pending search on Reset filters, and when its chip is removed", async () => {
    serve([]);
    renderAt("/?search=notes");
    const open = await openSheet();
    const box = within(open).getByRole<HTMLInputElement>("searchbox", { name: "Search titles" });
    fireEvent.change(box, { target: { value: "notes and more" } });
    fireEvent.click(screen.getByRole("button", { name: /^Remove filter: Search/ }));
    await pause();
    expect(address()).toBe("");
    expect(box.value).toBe("");
    fireEvent.change(box, { target: { value: "release" } });
    fireEvent.click(within(open).getByRole("button", { name: /^Reset filters/ }));
    await pause();
    expect(address()).toBe("");
    expect(box.value).toBe("");
  });
});

describe("the agent, session and topic choices", () => {
  type Part = "Agent" | "Session" | "Topic";
  const picker = (name: Part) =>
    within(sheet()).getByRole("button", { name: new RegExp(`^${name} `) });
  const popupOf = (name: Part) =>
    document.getElementById(picker(name).getAttribute("aria-controls") ?? "") as HTMLElement;
  // options lists the choices offered, checked or not, as the eye reads them.
  const options = (name: Part) =>
    within(popupOf(name))
      .getAllByRole<HTMLInputElement>("checkbox")
      .map(
        (box) =>
          `${box.checked ? "☑" : "☐"} ${box.closest("label")?.textContent?.replace(/\s+/g, " ")}`,
      );

  it("offer each agent and session holding a thread, with its count, checked or not", async () => {
    serve([]);
    serveCounts();
    renderAt("/?agent=builder");
    await openSheet();
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    // The button names what is chosen.
    expect(picker("Agent").textContent).toBe("builder");
    expect(picker("Session").textContent).toBe("Any");
    fireEvent.click(picker("Agent"));
    expect(picker("Agent").getAttribute("aria-expanded")).toBe("true");
    expect(options("Agent")).toEqual(["☑ builder (15)", "☐ reviewer (16)"]);
    expect(within(popupOf("Agent")).getByRole("checkbox", { name: /^reviewer, 16 threads$/ }));
    // While agents are chosen, only their sessions are offered.
    fireEvent.click(picker("Session"));
    expect(picker("Agent").getAttribute("aria-expanded")).toBe("false");
    expect(options("Session")).toEqual(["☐ main builder (17)", "☐ side builder (19)"]);
  });

  it("offer the topics of the sessions chosen, or else of the agents chosen, keeping those chosen", async () => {
    serve([]);
    api.on("GET", "/threads/counts", {
      body: {
        ...counts,
        topic: {
          topics: [
            { agent: "builder", session: "main", topic: "auth", total: 21 },
            { agent: "reviewer", session: "main", topic: "billing", total: 22 },
            { agent: "builder", session: "side", topic: "deploy", total: 0 },
          ],
          truncated: false,
        },
      },
    });
    const offered = async (address: string) => {
      cleanup();
      renderAt(address);
      await openSheet();
      await waitFor(() => expect(within(sheet()).getByRole("button", { name: /^Topic / })));
      fireEvent.click(picker("Topic"));
      return options("Topic");
    };
    expect(await offered("/")).toEqual([
      "☐ main/auth builder (21)",
      "☐ main/billing reviewer (22)",
      "☐ side/deploy builder (0)",
    ]);
    expect(await offered("/?agent=builder&topic=reviewer/main/billing")).toEqual([
      "☐ main/auth builder (21)",
      "☑ main/billing reviewer (22)",
      "☐ side/deploy builder (0)",
    ]);
    expect(await offered("/?agent=reviewer")).toEqual(["☐ main/billing reviewer (22)"]);
    // Sessions chosen narrow it further than agents do.
    expect(await offered("/?agent=builder&session=builder/side")).toEqual([
      "☐ side/deploy builder (0)",
    ]);
  });

  it("offer Topic always, as Agent and Session, saying when it offers none", async () => {
    serve([]);
    api.on("GET", "/threads/counts", {
      body: { ...counts, topic: { topics: [], truncated: false } },
    });
    renderAt("/");
    await openSheet();
    expect(picker("Topic").textContent).toBe("Any");
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    fireEvent.click(picker("Topic"));
    expect(within(popupOf("Topic")).getByText("None yet.")).toBeTruthy();
  });

  it("take no more than the list does, the boxes not checked unavailable and saying why", async () => {
    serve([]);
    const names = Array.from({ length: maxNarrowed + 1 }, (_, i) => `agent-${i + 10}`);
    api.on("GET", "/threads/counts", {
      body: {
        ...counts,
        agent: { agents: names.map((agent) => ({ agent, total: 1 })), truncated: false },
      },
    });
    renderAt(
      `/?${names
        .slice(0, maxNarrowed)
        .map((name) => `agent=${name}`)
        .join("&")}`,
    );
    await openSheet();
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    fireEvent.click(picker("Agent"));
    const boxes = () => within(popupOf("Agent")).getAllByRole<HTMLInputElement>("checkbox");
    const unchecked = boxes().filter((box) => !box.checked);
    expect(unchecked).toHaveLength(1);
    expect(boxes().filter((box) => box.disabled)).toEqual(unchecked);
    const why = unchecked[0]?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(why)?.textContent).toContain(String(maxNarrowed));
    // A checked box still unchecks, which frees the others.
    fireEvent.click(boxes()[0] as HTMLInputElement);
    await waitFor(() =>
      expect(new URLSearchParams(address()).getAll("agent")).toHaveLength(maxNarrowed - 1),
    );
    expect(boxes().some((box) => box.disabled)).toBe(false);
  });

  it("choose any number, each checked box adding to the address, the other filters staying", async () => {
    serve([]);
    serveCounts();
    const topic = "topic=builder/main/auth";
    renderAt(`/?session=reviewer/main&${topic}`);
    await openSheet();
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    fireEvent.click(picker("Agent"));
    fireEvent.click(within(popupOf("Agent")).getByRole("checkbox", { name: /^builder/ }));
    await waitFor(() => expect(address()).toBe(`?agent=builder&session=reviewer/main&${topic}`));
    fireEvent.click(within(popupOf("Agent")).getByRole("checkbox", { name: /^reviewer/ }));
    await waitFor(() =>
      expect(address()).toBe(`?agent=builder&agent=reviewer&session=reviewer/main&${topic}`),
    );
    expect(picker("Agent").textContent).toBe("2 chosen");
    fireEvent.click(picker("Session"));
    // A session already chosen stays on offer.
    fireEvent.click(within(popupOf("Session")).getByRole("checkbox", { name: /^builder\/side,/ }));
    await waitFor(() =>
      expect(address()).toBe(
        `?agent=builder&agent=reviewer&session=reviewer/main&session=builder/side&${topic}`,
      ),
    );
    await waitFor(() =>
      expect(lastQuery()?.getAll("session")).toEqual(["reviewer/main", "builder/side"]),
    );
    fireEvent.click(within(popupOf("Session")).getByRole("checkbox", { name: /^reviewer\/main,/ }));
    await waitFor(() =>
      expect(address()).toBe(`?agent=builder&agent=reviewer&session=builder/side&${topic}`),
    );
  });

  it("narrow the options as the search box is typed in", async () => {
    serve([]);
    serveCounts();
    renderAt("/");
    await openSheet();
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    fireEvent.click(picker("Session"));
    const search = within(popupOf("Session")).getByRole("searchbox", { name: "Search sessions" });
    fireEvent.change(search, { target: { value: "SID" } });
    expect(options("Session")).toEqual(["☐ side builder (19)"]);
    fireEvent.change(search, { target: { value: "review" } });
    expect(options("Session")).toEqual(["☐ main reviewer (18)"]);
  });

  it("say when the counts left some of their options out", async () => {
    serve([]);
    api.on("GET", "/threads/counts", {
      body: { ...counts, session: { ...counts.session, truncated: true } },
    });
    renderAt("/");
    await openSheet();
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    fireEvent.click(picker("Agent"));
    expect(popupOf("Agent").querySelector("p.muted")).toBeNull();
    fireEvent.click(picker("Session"));
    expect(popupOf("Session").querySelector("p.muted")).not.toBeNull();
  });

  it("close on Escape, Done or a tap outside, returning focus to their button, the sheet staying open", async () => {
    serve([]);
    serveCounts();
    renderAt("/");
    await openSheet();
    fireEvent.click(picker("Agent"));
    const search = within(popupOf("Agent")).getByRole("searchbox", { name: "Search agents" });
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(picker("Agent").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(picker("Agent"));
    expect(isOpen()).toBe(true);
    fireEvent.click(picker("Agent"));
    fireEvent.click(within(popupOf("Agent")).getByRole("button", { name: "Done" }));
    expect(picker("Agent").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(picker("Agent"));
    fireEvent.click(picker("Agent"));
    fireEvent.click(within(sheet()).getByRole("heading", { level: 2 }));
    expect(picker("Agent").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(picker("Agent"));
  });

  it("offer each topic holding a thread, as session/topic, with its count", async () => {
    serve([]);
    serveCounts();
    renderAt("/");
    await openSheet();
    await waitFor(() => expect(countCalls()).toHaveLength(1));
    // The label shows its part's badge beside the word.
    const label = document.getElementById(
      picker("Topic").getAttribute("aria-labelledby")?.split(" ")[0] ?? "",
    );
    expect(label?.querySelector(".path-badge")?.textContent).toBe("T");
    expect(picker("Topic").textContent).toBe("Any");
    fireEvent.click(picker("Topic"));
    expect(options("Topic")).toEqual(["☐ main/auth builder (21)", "☐ main/billing reviewer (22)"]);
    // Each is said, and named on hover, whole.
    const billing = within(popupOf("Topic")).getByRole("checkbox", {
      name: "reviewer/main/billing, 22 threads",
    });
    expect(billing.closest("label")?.querySelector(".pick")?.getAttribute("title")).toBe(
      "reviewer/main/billing",
    );
    // The search box narrows them by what they show.
    const search = within(popupOf("Topic")).getByRole("searchbox", { name: "Search topics" });
    fireEvent.change(search, { target: { value: "N/BILL" } });
    expect(options("Topic")).toEqual(["☐ main/billing reviewer (22)"]);
    fireEvent.change(search, { target: { value: "build" } });
    expect(options("Topic")).toEqual(["☐ main/auth builder (21)"]);
    fireEvent.change(search, { target: { value: "" } });
    // Any number may be chosen, each one filter value of its own.
    fireEvent.click(
      within(popupOf("Topic")).getByRole("checkbox", { name: /^reviewer\/main\/billing/ }),
    );
    await waitFor(() => expect(address()).toBe("?topic=reviewer/main/billing"));
    fireEvent.click(
      within(popupOf("Topic")).getByRole("checkbox", { name: /^builder\/main\/auth/ }),
    );
    await waitFor(() =>
      expect(address()).toBe("?topic=reviewer/main/billing&topic=builder/main/auth"),
    );
    await waitFor(() =>
      expect(lastQuery()?.getAll("topic")).toEqual(["reviewer/main/billing", "builder/main/auth"]),
    );
    expect(picker("Topic").textContent).toBe("2 chosen");
  });
});

describe("the chips", () => {
  it("show each filter that is on, each removing its own, with a badge counting them", async () => {
    serve([]);
    // Every filter on, in the order the sheet gives them, an order and a
    // grouping.
    const on = [
      "search=notes",
      "status=open",
      "priority=high",
      "impact=assuming",
      "overdue=true",
      "effort=under_1h",
      "unread=true",
      "agent_read=stranded",
      "agent=builder&agent=reviewer",
      "session=builder/main",
      "topic=builder/main/auth&topic=reviewer/main/billing",
      "include_archived=true",
    ];
    renderAt(`/?${on.join("&")}&sort=effort&group=agent`);
    await screen.findByRole("heading", { level: 1 });
    // One chip for each filter on, none for the order or grouping, and the
    // badge counts them.
    expect(chips()).toHaveLength(on.length);
    expect(filtersButton().querySelector(".badge")?.textContent).toBe(String(on.length));
    expect(filtersButton().getAttribute("aria-label")).toContain(String(on.length));
    // Each says it removes its filter.
    for (const chip of chips()) {
      expect(chip.getAttribute("aria-label")?.startsWith("Remove filter: ")).toBe(true);
    }
    // A filter on where threads are shows its badge: several agents or topics
    // are counted, and one session is named, its agent left out but said.
    const at = (filter: string) => chips()[on.indexOf(filter)] as HTMLElement;
    const agents = at("agent=builder&agent=reviewer");
    expect([badgeOf(agents), chipText(agents)]).toEqual(["A", "2 agents"]);
    expect(agents.getAttribute("aria-label")).toBe("Remove filter: 2 agents");
    const session = at("session=builder/main");
    expect([badgeOf(session), chipText(session)]).toEqual(["S", "main"]);
    expect(session.getAttribute("aria-label")).toBe("Remove filter: Session builder/main");
    const topics = at("topic=builder/main/auth&topic=reviewer/main/billing");
    expect([badgeOf(topics), chipText(topics)]).toEqual(["T", "2 topics"]);
    expect(badgeOf(at("search=notes"))).toBeUndefined();
    // The status chip says the status.
    expect(chipText(at("status=open"))).toBe("Status: Open");
    const remove = (chip: HTMLElement) => {
      chip.focus();
      fireEvent.click(chip);
    };
    remove(chips()[on.indexOf("impact=assuming")] as HTMLElement);
    await waitFor(() => expect(new URLSearchParams(address()).has("impact")).toBe(false));
    // The chip is gone, and focus moves to Filters.
    expect(chips()).toHaveLength(on.length - 1);
    expect(document.activeElement).toBe(filtersButton());
    // Removing the agents leaves the sessions, and removing the sessions
    // leaves the topics.
    remove(agents);
    await waitFor(() => expect(new URLSearchParams(address()).has("agent")).toBe(false));
    expect(new URLSearchParams(address()).get("session")).toBe("builder/main");
    remove(screen.getByRole("button", { name: "Remove filter: Session builder/main" }));
    await waitFor(() => expect(new URLSearchParams(address()).has("session")).toBe(false));
    expect(new URLSearchParams(address()).getAll("topic")).toEqual([
      "builder/main/auth",
      "reviewer/main/billing",
    ]);
    expect(chips()).toHaveLength(on.length - 3);
    expect(new URLSearchParams(address()).get("group")).toBe("agent");
  });

  it("fit a label of up to 20 characters, a badge counting as two, cutting a longer one short and naming it whole", async () => {
    serve([]);
    renderAt(
      "/?search=12345678901234567890&agent=agent-eighteen-chr&session=builder/a-long-session-name" +
        "&topic=builder/main/auth",
    );
    await screen.findByRole("heading", { level: 1 });
    const [search, agent, session, topic] = chips() as HTMLElement[];
    // “12345678901234567890”: 22 characters, cut to 19 and an ellipsis.
    expect(chipText(search as HTMLElement)).toBe("“123456789012345678…");
    expect(search?.getAttribute("title")).toBe("Search “12345678901234567890”");
    // agent-eighteen-chr: 18 characters, beside the badge's two.
    expect(chipText(agent as HTMLElement)).toBe("agent-eighteen-chr");
    // a-long-session-name: 19 characters, cut to an ellipsis and its last 17.
    expect(chipText(session as HTMLElement)).toBe("…long-session-name");
    expect(session?.getAttribute("title")).toBe("Session builder/a-long-session-name");
    expect(session?.getAttribute("aria-label")).toBe(
      "Remove filter: Session builder/a-long-session-name",
    );
    // One topic shows as session/topic, and is said and named whole.
    expect([badgeOf(topic as HTMLElement), chipText(topic as HTMLElement)]).toEqual([
      "T",
      "main/auth",
    ]);
    expect(topic?.getAttribute("title")).toBe("Topic builder/main/auth");
    expect(topic?.getAttribute("aria-label")).toBe("Remove filter: Topic builder/main/auth");
  });

  it("cut a topic short at its front, keeping its own name", async () => {
    serve([]);
    const shown = async (topic: string) => {
      cleanup();
      renderAt(`/?topic=${topic}`);
      await screen.findByRole("heading", { level: 1 });
      const [chip] = chips() as HTMLElement[];
      return [chipText(chip as HTMLElement), chip?.getAttribute("title")];
    };
    // reviewer-session-x/auth: 23 characters, with room for 18 beside the badge.
    expect(await shown("builder/reviewer-session-x/auth")).toEqual([
      "…er-session-x/auth",
      "Topic builder/reviewer-session-x/auth",
    ]);
    expect(await shown("builder/main/a-very-long-topic-name")).toEqual([
      "…y-long-topic-name",
      "Topic builder/main/a-very-long-topic-name",
    ]);
  });
});

describe("the status region", () => {
  it("says what the thread page sent before going back to the list", async () => {
    serve([]);
    leaveNotice("Answer sent.");
    renderAt("/");
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Answer sent."));
    // Said once: the list opened again is quiet.
    cleanup();
    renderAt("/");
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("paging", () => {
  it("loads the next page from the cursor, and keeps it on refresh", async () => {
    api.on("GET", "/threads", (call) =>
      call.url.searchParams.get("cursor") === "page-2"
        ? { body: { threads: [threadSummary({ number: 2, title: "Second page" })], total } }
        : {
            body: {
              threads: [threadSummary({ number: 1, title: "First page" })],
              next: "page-2",
              total,
            },
          },
    );
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await screen.findByText("Second page");
    expect(titles()).toEqual(["First page", "Second page"]);
    fireEvent.focus(window);
    await waitFor(() => expect(api.callsTo("GET", "/threads").length).toBeGreaterThanOrEqual(5));
    expect(titles()).toEqual(["First page", "Second page"]);
  });

  it("shows a thread that moved between two pages once", async () => {
    const thread = (number: number) => threadSummary({ number, title: `Thread ${number}` });
    api.on("GET", "/threads", (call) =>
      call.url.searchParams.get("cursor") === "page-2"
        ? { body: { threads: [thread(2), thread(3)], total } }
        : { body: { threads: [thread(1), thread(2)], next: "page-2", total } },
    );
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await screen.findByText("Thread 3");
    expect(titles()).toEqual(["Thread 1", "Thread 2", "Thread 3"]);
  });

  it("shows on the next refresh a thread that moved ahead of the cursor as the pages loaded", async () => {
    const thread = (number: number) => threadSummary({ number, title: `Thread ${number}` });
    let moved = false;
    api.on("GET", "/threads", (call) =>
      call.url.searchParams.get("cursor") === "page-2"
        ? { body: { threads: [thread(3)], total } }
        : {
            body: { threads: moved ? [thread(2), thread(1)] : [thread(1)], next: "page-2", total },
          },
    );
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await screen.findByText("Thread 3");
    expect(titles()).toEqual(["Thread 1", "Thread 3"]);
    moved = true;
    fireEvent.focus(window);
    await screen.findByText("Thread 2");
    expect(titles()).toEqual(["Thread 2", "Thread 1", "Thread 3"]);
  });
});

describe("bulk marks", () => {
  // said waits for the status region to say what an action did.
  const said = () => waitFor(() => expect(screen.getByRole("status").textContent).not.toBe(""));

  it("archive every read thread through its latest message, saying what stayed", async () => {
    let archived = false;
    api
      .on("GET", "/threads", () => ({
        body: {
          threads: archived
            ? [asking]
            : [
                asking,
                threadSummary({ number: 2, title: "Read", unread: 0, last_seq: 4 }),
                threadSummary({
                  number: 3,
                  title: "Read, with an ask",
                  unread: 0,
                  last_seq: 2,
                  open_asks: { ...asking.open_asks, asks: [{ number: 1, seq: 2 }], count: 1 },
                }),
              ],
          total,
        },
      }))
      .on("POST", "/archives", () => {
        archived = true;
        return {
          body: {
            archived: [{ agent: "builder", session: "main", thread: 2, marks: {} }],
            skipped: [{ agent: "builder", session: "main", thread: 3, open_asks: [2] }],
          },
        };
      });
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Archive all read" }));
    await said();
    const [call] = api.callsTo("POST", "/archives");
    expect(call?.headers["x-csrf-token"]).toBe(csrf);
    expect(call?.body).toEqual({
      threads: [
        { agent: "builder", session: "main", thread: 2, through: 4 },
        { agent: "builder", session: "main", thread: 3, through: 2 },
      ],
    });
    await waitFor(() => expect(titles()).toEqual(["Pick a database"]));
  });

  it.each([
    "/?status=open",
    "/?priority=normal",
    "/?impact=assuming",
    "/?overdue=true",
    "/?effort=under_1h",
    "/?include_archived=true",
  ])(
    "offer no archiving of read threads while %s keeps open asks or archived threads",
    async (address) => {
      serve([threadSummary({ number: 2, title: "Read", unread: 0 })]);
      renderAt(address);
      await screen.findByText("Read");
      expect(screen.queryByRole("button", { name: "Archive all read" })).toBeNull();
    },
  );

  it("mark every unread thread read through its latest message", async () => {
    serve([asking, threadSummary({ number: 2, title: "Notes", last_seq: 6 })]);
    api.on("POST", "/reads", { body: { threads: [] } });
    renderAt("/?unread=true");
    fireEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
    await said();
    expect(api.callsTo("POST", "/reads")[0]?.body).toEqual({
      threads: [
        { agent: "builder", session: "main", thread: 4, through: 1 },
        { agent: "builder", session: "main", thread: 2, through: 6 },
      ],
    });
  });

  it("act on the threads loaded while more remain to load", async () => {
    api
      .on("GET", "/threads", {
        body: { threads: [threadSummary({ number: 2, last_seq: 6 })], next: "page-2", total },
      })
      .on("POST", "/reads", { body: { threads: [] } });
    renderAt("/?unread=true");
    fireEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
    await said();
    expect(api.callsTo("POST", "/reads")[0]?.body).toEqual({
      threads: [{ agent: "builder", session: "main", thread: 2, through: 6 }],
    });
  });
});
