import type { ThreadGroups, ThreadSummary } from "@wayfarerlabs/agention-api";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanded } from "../api.ts";
import { leaveNotice } from "../notice.ts";
import {
  FakeApi,
  message,
  renderAt,
  threadAnswer,
  threadSummary,
  titleOf,
} from "../test-support.tsx";
import { textBox } from "./thread/thread-test-support.tsx";

// The Threads tab at a desktop's width, where the list and the thread open
// stand side by side, and across the breakpoint.

let api: FakeApi;
let wide: boolean;
// What follows the page's media queries.
const followers = new Set<() => void>();

beforeEach(() => {
  api = new FakeApi();
  wide = true;
  followers.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return query === "(min-width: 64rem)" && wide;
    },
    addEventListener: (_: string, follow: () => void) => followers.add(follow),
    removeEventListener: (_: string, follow: () => void) => followers.delete(follow),
  }));
});

// resize takes the page across the breakpoint, as a window resized does.
function resize(toWide: boolean): void {
  act(() => {
    wide = toWide;
    followers.forEach((follow) => follow());
  });
}

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const rows = [
  threadSummary({ number: 1, title: "First", unread: 0 }),
  threadSummary({ number: 2, title: "Second", unread: 0 }),
  threadSummary({ number: 3, title: "Third", unread: 1 }),
];

const threadPath = (number: number) => `/s/builder/main/threads/${number}`;

// serve answers the list with rows, and each of their threads with one
// message.
function serve(threads: ThreadSummary[] = rows) {
  api.on("GET", "/threads", { body: { threads, total: threads.length } });
  for (const thread of threads) {
    api.on("GET", threadPath(thread.number), {
      body: threadAnswer(thread, [message(1, { text: `In ${thread.title}` })]),
    });
    api.on("POST", `${threadPath(thread.number)}/read`, {
      body: { cursors: { requester: 1, audience: 1 } },
    });
  }
}

const listPane = () => screen.getByRole("region", { name: "Thread list" });
const threadPane = () => screen.getByRole("region", { name: "Thread" });
const rowLink = (title: string) =>
  within(listPane()).getByRole<HTMLAnchorElement>("link", { name: new RegExp(`^#\\d+ ${title}`) });
const threadHeading = () => within(threadPane()).getByRole("heading", { level: 1 });
// Whether focus is in the thread's pane: on its heading, or on the pane while
// the thread loads, as a page's content takes it on a phone.
const focusInThread = () => threadPane().contains(document.activeElement);
// Whether the thread's pane holds its word on opening one, with none open.
const noThread = () => threadPane().querySelector(".empty") !== null;

// The list's own loads, not the walks of its pages a thread's page makes to
// find the thread above or below, which ask for the most a page holds.
const listLoads = () =>
  api.callsTo("GET", "/threads").filter((call) => !call.url.searchParams.has("limit"));
// Those walks, which the thread open makes of the list it returns to.
const walks = () =>
  api.callsTo("GET", "/threads").filter((call) => call.url.searchParams.has("limit"));

// press presses a key where focus is, as the keyboard does.
function press(key: string): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
}

async function openList() {
  serve();
  renderAt("/");
  const list = await screen.findByRole("region", { name: "Thread list" });
  await within(list).findByRole("heading", { level: 2, name: /First/ });
}

async function openFromList(title: string) {
  fireEvent.click(rowLink(title));
  await waitFor(() => expect(titleOf(threadHeading())).toBe(title));
}

describe("side by side", () => {
  it("shows the list beside a word on opening a thread, and the thread beside it once one opens", async () => {
    await openList();
    expect(noThread()).toBe(true);
    await openFromList("Second");
    expect(window.location.pathname).toBe(threadPath(2));
    expect(within(listPane()).getAllByRole("heading", { level: 2 })).toHaveLength(3);
    expect(document.title).toMatch(/^Second · /);
  });

  it("keeps the list mounted while threads open beside it, loading it no more than it follows", async () => {
    await openList();
    const list = listPane().querySelector("ul.threads");
    const sort = within(listPane()).getByRole("combobox", { name: "Sort" });
    const loads = listLoads().length;
    // Both are read, so opening them changes nothing the list follows.
    await openFromList("First");
    await openFromList("Second");
    expect(listPane().querySelector("ul.threads")).toBe(list);
    expect(within(listPane()).getByRole("combobox", { name: "Sort" })).toBe(sort);
    expect(listLoads()).toHaveLength(loads);
  });

  it("opens the thread below beside the list, which stays mounted, its row current", async () => {
    await openList();
    const list = listPane().querySelector("ul.threads");
    await openFromList("First");
    // The page has walked the list for where its thread stands.
    await waitFor(() => expect(walks()).toHaveLength(1));
    fireEvent.click(within(threadPane()).getByRole("button", { name: "Thread below" }));
    await waitFor(() => expect(titleOf(threadHeading())).toBe("Second"));
    expect(window.location.pathname).toBe(threadPath(2));
    expect(listPane().querySelector("ul.threads")).toBe(list);
    expect(rowLink("Second").getAttribute("aria-current")).toBe("page");
    expect(rowLink("First").getAttribute("aria-current")).toBeNull();
    expect(focusInThread()).toBe(true);
  });

  it("walks the list again for where the thread stands when the list beside it changes", async () => {
    await openList();
    await openFromList("Second");
    await waitFor(() => expect(walks()).toHaveLength(1));
    fireEvent.change(within(listPane()).getByRole("combobox", { name: "Sort" }), {
      target: { value: "latest" },
    });
    await waitFor(() => expect(walks()).toHaveLength(2));
    expect(walks()[1]?.url.searchParams.get("sort")).toBe("latest");
  });

  it("has one level-one heading, the list's while no thread is open and the thread's while one is", async () => {
    await openList();
    expect(
      screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent),
    ).toEqual(["Threads"]);
    await openFromList("Second");
    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([threadHeading()]);
  });

  it("marks the open thread's row current, and only it", async () => {
    await openList();
    await openFromList("Second");
    expect(rowLink("Second").getAttribute("aria-current")).toBe("page");
    expect(rowLink("First").getAttribute("aria-current")).toBeNull();
    await openFromList("First");
    expect(rowLink("First").getAttribute("aria-current")).toBe("page");
    expect(rowLink("Second").getAttribute("aria-current")).toBeNull();
  });

  it("moves focus to the thread's pane on opening it, the list first in the page", async () => {
    await openList();
    await openFromList("Second");
    expect(focusInThread()).toBe(true);
    expect(
      listPane().compareDocumentPosition(threadPane()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("returns to the list with u, Escape and Back, focus on the row of the thread left", async () => {
    await openList();
    await openFromList("Second");
    press("u");
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(document.activeElement).toBe(rowLink("Second"));
    expect(noThread()).toBe(true);

    await openFromList("Third");
    press("Escape");
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(document.activeElement).toBe(rowLink("Third"));

    await openFromList("First");
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(document.activeElement).toBe(rowLink("First"));
  });

  it("goes back from one thread to the one before, each at its own address", async () => {
    await openList();
    await openFromList("First");
    await openFromList("Second");
    window.history.back();
    await waitFor(() => expect(titleOf(threadHeading())).toBe("First"));
    expect(window.location.pathname).toBe(threadPath(1));
    expect(focusInThread()).toBe(true);
  });

  it("moves through the list with j and k from the open thread's row, opening nothing", async () => {
    await openList();
    await openFromList("Second");
    press("j");
    expect(document.activeElement).toBe(rowLink("Third"));
    press("k");
    press("k");
    expect(document.activeElement).toBe(rowLink("First"));
    expect(window.location.pathname).toBe(threadPath(2));
    press("o");
    await waitFor(() => expect(titleOf(threadHeading())).toBe("First"));
  });

  it("moves focus to the thread's pane on opening the thread already open, by o or by its row", async () => {
    await openList();
    await openFromList("Second");
    rowLink("Second").focus();
    press("o");
    expect(focusInThread()).toBe(true);
    rowLink("Second").focus();
    fireEvent.click(rowLink("Second"));
    expect(focusInThread()).toBe(true);
    expect(window.location.pathname).toBe(threadPath(2));
  });

  it("holds back the thread's own keys while focus is in the list", async () => {
    await openList();
    await openFromList("First");
    rowLink("Second").focus();
    press("e");
    press("u");
    expect(api.callsTo("POST", `${threadPath(1)}/archive`)).toEqual([]);
    expect(window.location.pathname).toBe(threadPath(1));
    expect(document.activeElement).toBe(rowLink("Second"));
  });

  it("gives n to the pane that holds focus, the list's next thread needing you or the thread's, and else the thread's", async () => {
    await openList();
    await openFromList("First");
    // In the thread, n jumps within it, which has nothing unread.
    press("n");
    expect(focusInThread()).toBe(true);
    // In the list, it moves to the next row that needs the operator.
    rowLink("First").focus();
    press("n");
    expect(document.activeElement).toBe(rowLink("Third"));
    // In neither, as in the banner, the thread takes it.
    screen.getByRole("link", { name: "Agention" }).focus();
    press("n");
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Agention" }));
  });

  it("narrows the list beside the thread by a grouped header's link, keeping the thread open", async () => {
    serve();
    const groups: ThreadGroups = {
      sessions: [
        {
          agent: "builder",
          session: "main",
          rollup: { threads: 3, unread: 1, blocked: false, archived: false },
          presence: { quiet: false },
          topics: [{ rollup: { threads: 3, unread: 1, blocked: false, archived: false } }],
        },
      ],
      truncated: false,
    };
    api.on("GET", "/threads", { body: { threads: rows, total: rows.length, groups } });
    renderAt("/?group=session");
    const list = await screen.findByRole("region", { name: "Thread list" });
    await within(list).findByRole("heading", { level: 3, name: /First/ });
    fireEvent.click(rowLink("First"));
    await waitFor(() => expect(titleOf(threadHeading())).toBe("First"));
    const unread = within(listPane()).getByRole<HTMLAnchorElement>("link", {
      name: /^1 unread thread of /,
    });
    expect(unread.getAttribute("href")).toBe("/?unread=true&session=builder/main&group=session");
    fireEvent.click(unread);
    await waitFor(() =>
      expect(window.history.state).toEqual({
        from: "/?unread=true&session=builder/main&group=session",
      }),
    );
    expect(window.location.pathname).toBe(threadPath(1));
    expect(titleOf(threadHeading())).toBe("First");
    await waitFor(() => expect(listLoads().at(-1)?.url.searchParams.get("unread")).toBe("true"));
  });

  it("keeps the thread open when the list beside it changes, and returns to the list as changed", async () => {
    await openList();
    await openFromList("Second");
    fireEvent.change(within(listPane()).getByRole("combobox", { name: "Sort" }), {
      target: { value: "latest" },
    });
    await waitFor(() => expect(listLoads().at(-1)?.url.searchParams.get("sort")).toBe("latest"));
    expect(window.location.pathname).toBe(threadPath(2));
    expect(titleOf(threadHeading())).toBe("Second");
    press("u");
    await waitFor(() => expect(window.location.search).toBe("?sort=latest"));
    expect(window.location.pathname).toBe("/");
  });

  it("says on arrival what a thread that went back after sending sent, and is quiet once a thread opens", async () => {
    await openList();
    await openFromList("Second");
    // As the composer does on going back after sending.
    leaveNotice("Message sent.");
    press("u");
    await waitFor(() =>
      expect(within(listPane()).getByRole("status").textContent).toBe("Message sent."),
    );
    await openFromList("First");
    expect(within(listPane()).getByRole("status").textContent).toBe("");
  });

  it("records in a row's link the list it was opened from, beside a thread too", async () => {
    serve();
    renderAt("/?sort=latest");
    await within(await screen.findByRole("region", { name: "Thread list" })).findByRole("heading", {
      level: 2,
      name: /First/,
    });
    await openFromList("First");
    expect(window.history.state).toEqual({ from: "/?sort=latest" });
    await openFromList("Second");
    expect(window.history.state).toEqual({ from: "/?sort=latest" });
  });

  it("loads again once on returning to the list from a thread, not on moving between threads", async () => {
    await openList();
    await openFromList("First");
    await openFromList("Second");
    const loads = listLoads().length;
    press("u");
    await waitFor(() => expect(listLoads()).toHaveLength(loads + 1));
    expect(window.location.pathname).toBe("/");
  });

  it("returns to the list as it stands once a change that leaves the thread lands", async () => {
    await openList();
    await openFromList("First");
    let land = () => {};
    api.on(
      "POST",
      `${threadPath(1)}/archive`,
      () =>
        new Promise((resolve) => {
          land = () => resolve({ body: { marks: { read_through: 1, archived_through: 1 } } });
        }),
    );
    fireEvent.click(within(threadPane()).getByRole("button", { name: "Archive all" }));
    await waitFor(() => expect(api.callsTo("POST", `${threadPath(1)}/archive`)).toHaveLength(1));
    // The list beside changes while the archive waits.
    fireEvent.change(within(listPane()).getByRole("combobox", { name: "Sort" }), {
      target: { value: "latest" },
    });
    await waitFor(() => expect(window.history.state).toEqual({ from: "/?sort=latest" }));
    land();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(window.location.search).toBe("?sort=latest");
    expect(document.title).toMatch(/^Threads · /);
  });

  it("loads again as a change lands, as the thread beside it is read", async () => {
    await openList();
    await openFromList("First");
    const loads = listLoads().length;
    window.dispatchEvent(new Event(changeLanded));
    await waitFor(() => expect(listLoads().length).toBe(loads + 1));
  });

  it("keeps the list as set going back from thread to thread, neither changing nor remounting it", async () => {
    await openList();
    await openFromList("First");
    await openFromList("Second");
    fireEvent.change(within(listPane()).getByRole("combobox", { name: "Sort" }), {
      target: { value: "latest" },
    });
    await waitFor(() => expect(listLoads().at(-1)?.url.searchParams.get("sort")).toBe("latest"));
    const list = listPane().querySelector("ul.threads");
    const loads = listLoads().length;
    window.history.back();
    await waitFor(() => expect(titleOf(threadHeading())).toBe("First"));
    expect(
      within(listPane()).getByRole<HTMLSelectElement>("combobox", { name: "Sort" }).value,
    ).toBe("latest");
    expect(listPane().querySelector("ul.threads")).toBe(list);
    expect(listLoads()).toHaveLength(loads);
    // The entry gone back to returns to the list as set, as u does.
    expect(window.history.state).toMatchObject({ from: "/?sort=latest" });
    press("u");
    await waitFor(() => expect(window.location.search).toBe("?sort=latest"));
  });

  it("keeps the list as set going back onto the list's own entry, with no thread open", async () => {
    await openList();
    await openFromList("First");
    fireEvent.change(within(listPane()).getByRole("combobox", { name: "Sort" }), {
      target: { value: "latest" },
    });
    await waitFor(() => expect(listLoads().at(-1)?.url.searchParams.get("sort")).toBe("latest"));
    const list = listPane().querySelector("ul.threads");
    window.history.back();
    await waitFor(() => expect(noThread()).toBe(true));
    expect(window.location.pathname + window.location.search).toBe("/?sort=latest");
    expect(listPane().querySelector("ul.threads")).toBe(list);
  });

  it("keeps focus in the page when the row that has it goes, as an archived thread's does", async () => {
    await openList();
    await openFromList("Second");
    press("u");
    await waitFor(() => expect(document.activeElement).toBe(rowLink("Second")));
    api.on("GET", "/threads", { body: { threads: [rows[0], rows[2]], total: 2 } });
    window.dispatchEvent(new Event(changeLanded));
    await waitFor(() =>
      expect(within(listPane()).queryByRole("link", { name: /Second/ })).toBeNull(),
    );
    expect(document.activeElement).toBe(
      within(listPane()).getByRole("heading", { level: 1, name: "Threads" }),
    );
  });
});

describe("across the breakpoint", () => {
  it("keeps the thread open as it is, its composer and focus, while the list comes and goes", async () => {
    await openList();
    await openFromList("Second");
    const box = textBox();
    fireEvent.change(box, { target: { value: "Half typed" } });
    box.focus();
    resize(false);
    expect(screen.queryByRole("region", { name: "Thread list" })).toBeNull();
    expect(textBox()).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(document.title).toMatch(/^Second · /);
    resize(true);
    expect(textBox()).toBe(box);
    expect(box.value).toBe("Half typed");
    expect(document.activeElement).toBe(box);
    expect(await within(listPane()).findAllByRole("heading", { level: 2 })).toHaveLength(3);
    // The list come back leaves the page named after the thread.
    expect(document.title).toMatch(/^Second · /);
  });

  it("moves focus to the thread when the list that held it goes", async () => {
    await openList();
    await openFromList("Second");
    listPane().focus();
    resize(false);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    expect(titleOf(screen.getByRole("heading", { level: 1 }))).toBe("Second");
  });

  it("moves focus to the thread's heading when its own pane held it and stops being one", async () => {
    await openList();
    await openFromList("Second");
    threadPane().focus();
    resize(false);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });
});

describe("one at a time, below a desktop's width", () => {
  it("shows the thread alone, and the list alone again on going back", async () => {
    wide = false;
    serve();
    renderAt("/");
    await screen.findByRole("heading", { level: 2, name: /First/ });
    fireEvent.click(screen.getByRole("link", { name: /^#2 Second/ }));
    await waitFor(() => expect(titleOf(screen.getByRole("heading", { level: 1 }))).toBe("Second"));
    expect(screen.queryByRole("region", { name: "Thread list" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: /First/ })).toBeNull();
    press("u");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Threads"),
    );
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("leaves focus where it was when the row that has it goes, as before", async () => {
    wide = false;
    serve();
    renderAt("/");
    await screen.findByRole("heading", { level: 2, name: /First/ });
    press("j");
    press("j");
    const second = screen.getByRole("link", { name: /^#2 Second/ });
    expect(document.activeElement).toBe(second);
    api.on("GET", "/threads", { body: { threads: [rows[0], rows[2]], total: 2 } });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(second.isConnected).toBe(false));
    expect(document.activeElement).toBe(document.body);
  });
});
