import type { ThreadSummary } from "@wayfarerlabs/agention-api";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ask,
  type Call,
  failure,
  message,
  threadAnswer,
  threadSummary,
  titleOf,
} from "../../test-support.tsx";
import { listViewOf, showList } from "../../router.tsx";
import { type Direction, mostPages, moveOnChoice } from "./neighbor-thread.ts";
import { path, shownMessages, ThreadPageTest } from "./thread-test-support.tsx";
import { noOtherThread } from "./ThreadView.tsx";

// Thread above, Thread below and Archive & move on on a thread's page: the
// thread open is builder/main #1, and the list it returns to is served a few
// threads a page, so finding the thread above or below walks its pages.

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
});

const threadPath = (number: number) => `/s/builder/main/threads/${number}`;
const unread = (number: number) => threadSummary({ number, title: `Thread ${number}`, unread: 1 });
const read = (number: number) => threadSummary({ number, title: `Thread ${number}`, unread: 0 });

// A page of the list holds two threads here, whatever the page asks for.
const listPage = 2;

// serveList answers the list a page at a time with the threads given, and
// each of them, other than the one open, with a message of its own.
function serveList(threads: ThreadSummary[]): { threads: ThreadSummary[] } {
  const list = { threads };
  page.api.on("GET", "/threads", (call: Call) => {
    const from = Number(call.url.searchParams.get("cursor") ?? "0");
    const to = from + listPage;
    return {
      body: {
        threads: list.threads.slice(from, to),
        total: list.threads.length,
        ...(to < list.threads.length ? { next: String(to) } : {}),
      },
    };
  });
  for (const thread of threads.filter((each) => each.number !== 1)) {
    page.api.on("GET", threadPath(thread.number), {
      body: threadAnswer(thread, [message(1)]),
    });
    page.api.on("POST", `${threadPath(thread.number)}/read`, {
      body: { cursors: { requester: 1, audience: 1 } },
    });
  }
  return list;
}

// serveEndless answers the list with a page that always has another after
// it, each holding the thread open alone.
function serveEndless(): void {
  page.api.on("GET", "/threads", (call: Call) => ({
    body: {
      threads: [read(1)],
      total: 1,
      next: `${Number(call.url.searchParams.get("cursor") ?? "0") + 1}`,
    },
  }));
}

// The walks of the list's pages the page has made, each page's query.
const walked = () =>
  page.api
    .callsTo("GET", "/threads")
    .map((call) => call.url.searchParams)
    .filter((query) => query.has("limit"));

// openThread opens builder/main #1, returning to the list given, and waits
// for the page to have walked the list for the threads ahead of it.
async function openThread(
  overrides: Partial<ThreadSummary> = {},
  from = "/",
  messages = [message(1)],
) {
  const state = await page.open(
    { thread: threadSummary({ unread: 0, last_seq: messages.length, ...overrides }), messages },
    { from },
  );
  await waitFor(() => expect(walked().length).toBeGreaterThan(0));
  return state;
}

const belowButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Thread below" });
const aboveButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Thread above" });
const archiveAndMoveOn = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: "Archive & move on" });
// moveOnTo chooses, as Settings does, which way this device moves on, before
// the thread opens.
const moveOnTo = (direction: Direction) => window.localStorage.setItem(moveOnChoice, direction);
// headFailed waits for the thread's head to say that an action on it failed.
const headFailed = () => within(threadHeader()).findByRole("alert");
const threadHeader = () =>
  screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;

// press presses a key where focus is, as the keyboard does.
function press(key: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
}

// holdList holds the list's answers from now on until released, counting the
// pages asked for meanwhile.
function holdList(list: { threads: ThreadSummary[] }) {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let asked = 0;
  page.api.on("GET", "/threads", async (call: Call) => {
    asked += 1;
    await released;
    const from = Number(call.url.searchParams.get("cursor") ?? "0");
    const to = from + listPage;
    return {
      body: {
        threads: list.threads.slice(from, to),
        total: list.threads.length,
        ...(to < list.threads.length ? { next: String(to) } : {}),
      },
    };
  });
  return { release, asked: () => asked };
}

async function landedOn(number: number) {
  await waitFor(() => expect(window.location.pathname).toBe(threadPath(number)));
  await waitFor(() =>
    expect(titleOf(screen.getByRole("heading", { level: 1 }))).toBe(`Thread ${number}`),
  );
}

// The list's polite status, once the page went back to it.
async function listSays(): Promise<string | null> {
  await screen.findByRole("heading", { level: 1, name: "Threads" });
  return screen.getByRole("status").textContent;
}

// holdLists holds every list's answers from now on until released: the list
// searched for "three" holds thread 3 alone, and the whole list threads 1 to
// 3.
function holdLists() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  page.api.on("GET", "/threads", async (call: Call) => {
    await released;
    const threads = call.url.searchParams.has("search")
      ? [unread(3)]
      : [read(1), unread(2), unread(3)];
    return { body: { threads, total: threads.length } };
  });
  return release;
}
// The list searched for "three", which the list beside the thread changes to.
const narrowed = "/?search=three";
const toNarrowed = () => act(() => showList(listViewOf(new URLSearchParams("search=three"))));
// The walks of the whole list, not the narrowed one.
const wholeWalks = () => walked().filter((query) => !query.has("search")).length;

describe("Thread below", () => {
  it("opens the row below this one in the list it returns to, read or not, as a new entry", async () => {
    serveList([unread(4), read(1), read(3), read(2), unread(5)]);
    await openThread({}, "/?sort=latest&group=session");
    const length = window.history.length;
    fireEvent.click(belowButton());
    await landedOn(3);
    expect(window.history.length).toBe(length + 1);
    expect(window.history.state).toMatchObject({ from: "/?sort=latest&group=session" });
    // It walked the list the thread returns to, with its order and grouping,
    // from its first page on: on opening, the first page, which holds this
    // thread, and on the press, until the next turned up on the second, before
    // the page it opened walked its own.
    const walks = walked().slice(0, 3);
    expect(walks.map((query) => query.get("cursor"))).toEqual([null, null, "2"]);
    for (const query of walks) {
      expect(query.get("sort")).toBe("latest");
      expect(query.get("group")).toBe("session");
    }
  });

  it("goes round past the end of the list to its first thread", async () => {
    serveList([read(2), unread(4), read(1)]);
    await openThread();
    press("]");
    await landedOn(2);
  });

  it("goes on from where the thread stood when it opened, though the page moved it since", async () => {
    const list = serveList([unread(2), read(1), unread(3)]);
    await openThread();
    // Answering here moved this thread ahead of thread 2.
    list.threads = [read(1), unread(2), unread(3)];
    press("]");
    await landedOn(3);
  });

  it("passes over a thread gone from the list since the thread opened", async () => {
    const list = serveList([read(1), unread(2), read(3)]);
    await openThread();
    // Thread 2 was archived on another device.
    list.threads = [read(1), read(3)];
    press("]");
    await landedOn(3);
  });

  it("counts a thread new since the thread opened where it stands now, below it or not", async () => {
    const list = serveList([unread(2), read(1), unread(3), unread(8), unread(9)]);
    list.threads = [unread(2), read(1), unread(3)];
    await openThread();
    // Thread 9 arrived at the top, above where this thread sits, and thread
    // 8 just below it.
    list.threads = [unread(9), unread(2), unread(8), read(1), unread(3)];
    press("]");
    await landedOn(8);
  });

  it("opens no thread drawn above where this one sits, as one that moved up since", async () => {
    const list = serveList([unread(2), read(1), unread(3), unread(4)]);
    await openThread();
    // An agent wrote to thread 3, which went to the top under the latest
    // message's order.
    list.threads = [unread(3), unread(2), read(1), unread(4)];
    press("]");
    await landedOn(4);
  });

  it.each([
    ["]", "below", 3],
    ["[", "above", 6],
  ])(
    "with %s opens the thread %s it, though one that was above it moved to the end",
    async (key, _, number) => {
      // Oldest first, an agent wrote to thread 2, which went to the end.
      const list = serveList([unread(6), unread(2), read(1), unread(3), unread(4)]);
      await openThread({}, "/?sort=latest&reverse=true");
      list.threads = [unread(6), read(1), unread(3), unread(4), unread(2)];
      press(key);
      await landedOn(number);
    },
  );

  it("passes over no thread below it when one that was above it moved below them", async () => {
    // Under the priority order, thread 2's ask closed, so it fell below the
    // threads with asks open.
    const list = serveList([unread(2), read(1), unread(3), unread(4), unread(5)]);
    await openThread({}, "/?sort=priority");
    list.threads = [read(1), unread(3), unread(4), unread(2), unread(5)];
    press("]");
    await landedOn(3);
  });

  it("reads one page on opening and one on a press when what it seeks is on the first", async () => {
    serveList([read(1), unread(2)]);
    await openThread();
    const opened = walked().length;
    press("]");
    await landedOn(2);
    // The press read the first page alone, as the page it opened did.
    await waitFor(() => expect(walked().length).toBe(opened + 2));
  });

  it("starts once for a press made again while it is finding the thread below", async () => {
    const list = serveList([read(1), unread(2), unread(3)]);
    await openThread();
    const held = holdList(list);
    const length = window.history.length;
    press("]");
    await waitFor(() => expect(held.asked()).toBe(1));
    expect(belowButton().disabled).toBe(true);
    press("]");
    fireEvent.click(belowButton());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.asked()).toBe(1);
    held.release();
    await landedOn(2);
    expect(window.history.length).toBe(length + 1);
  });

  describe("starts again on the list as it now stands when the list changes", () => {
    it("while the page walks it on opening", async () => {
      serveList([read(1), unread(2), unread(3)]);
      const release = holdLists();
      await openThread();
      press("]");
      toNarrowed();
      release();
      await landedOn(3);
      expect(window.history.state).toMatchObject({ from: narrowed });
    });

    it("while the press walks again for the threads ahead, after the walk on opening failed", async () => {
      serveList([read(1), unread(2), unread(3)]);
      page.api.on("GET", "/threads", { status: 502, text: "<h1>Bad gateway</h1>" });
      await openThread();
      const release = holdLists();
      press("]");
      await waitFor(() => expect(wholeWalks()).toBe(2));
      toNarrowed();
      release();
      await landedOn(3);
      expect(window.history.state).toMatchObject({ from: narrowed });
      // Nothing walked the whole list after it changed.
      expect(wholeWalks()).toBe(2);
    });

    it("abandoning the walk again for the threads ahead in the list before", async () => {
      const list = serveList([unread(2), unread(3), unread(4), unread(5), read(1)]);
      page.api.on("GET", "/threads", { status: 502, text: "<h1>Bad gateway</h1>" });
      await openThread();
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      page.api.on("GET", "/threads", async (call: Call) => {
        if (call.url.searchParams.has("search")) {
          return { body: { threads: [unread(3)], total: 1 } };
        }
        await released;
        const from = Number(call.url.searchParams.get("cursor") ?? "0");
        const to = from + listPage;
        return {
          body: {
            threads: list.threads.slice(from, to),
            total: list.threads.length,
            ...(to < list.threads.length ? { next: String(to) } : {}),
          },
        };
      });
      press("]");
      await waitFor(() => expect(wholeWalks()).toBe(2));
      toNarrowed();
      release();
      await landedOn(3);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The walk again read no page of the whole list past its first.
      expect(wholeWalks()).toBe(2);
    });

    it("while the press walks it for the thread below", async () => {
      serveList([read(1), unread(2), unread(3)]);
      await openThread();
      const release = holdLists();
      press("]");
      await waitFor(() => expect(wholeWalks()).toBe(2));
      toNarrowed();
      release();
      await landedOn(3);
      expect(window.history.state).toMatchObject({ from: narrowed });
    });
  });

  it("stops at its most pages in a list that goes on, and says it could not find the thread below rather than that none is left", async () => {
    serveEndless();
    await openThread();
    press("]");
    await headFailed();
    // One page on opening, which held the thread, and the most on the press.
    expect(walked()).toHaveLength(1 + mostPages);
    expect(window.location.pathname).toBe(path);
  });

  it("goes on from where the thread stood under the unread filter, though reading it took it out of that list first", async () => {
    // The thread is read already when the page walks the list: the unread
    // list no longer holds it, the whole list does.
    page.api.on("GET", "/threads", (call: Call) => {
      const threads = call.url.searchParams.has("unread")
        ? [unread(2), unread(3)]
        : [unread(2), read(1), unread(3)];
      return { body: { threads, total: threads.length } };
    });
    for (const number of [2, 3]) {
      page.api.on("GET", threadPath(number), { body: threadAnswer(unread(number), [message(1)]) });
      page.api.on("POST", `${threadPath(number)}/read`, {
        body: { cursors: { requester: 1, audience: 1 } },
      });
    }
    await openThread({}, "/?unread=true");
    press("]");
    await landedOn(3);
    expect(window.history.state).toMatchObject({ from: "/?unread=true" });
    // It found where the thread stood with the unread filter off, and the
    // next with it on.
    expect(
      walked()
        .slice(0, 2)
        .map((query) => query.has("unread")),
    ).toEqual([false, true]);
  });

  it("starts once for two presses before the page has rendered the first", async () => {
    const list = serveList([read(1), unread(2), unread(3)]);
    await openThread();
    const held = holdList(list);
    act(() => {
      press("]");
      press("]");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.asked()).toBe(1);
    held.release();
    await landedOn(2);
  });

  it("archives nothing with e while it is finding the thread below", async () => {
    const list = serveList([read(1), unread(2)]);
    await openThread();
    const held = holdList(list);
    press("]");
    await waitFor(() => expect(held.asked()).toBe(1));
    press("e");
    held.release();
    await landedOn(2);
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
  });

  it("walks a grouped list kept to the unread as it is, where a read thread would lift a group", async () => {
    // Without the filter, read thread 4 would place its group, holding
    // thread 2, ahead of this thread.
    page.api.on("GET", "/threads", (call: Call) => {
      const threads = call.url.searchParams.has("unread")
        ? [unread(1), unread(2), unread(3)]
        : [read(4), unread(2), unread(1), unread(3)];
      return { body: { threads, total: threads.length } };
    });
    for (const number of [2, 3]) {
      page.api.on("GET", threadPath(number), { body: threadAnswer(unread(number), [message(1)]) });
      page.api.on("POST", `${threadPath(number)}/read`, {
        body: { cursors: { requester: 1, audience: 1 } },
      });
    }
    await openThread({}, "/?unread=true&group=session");
    press("]");
    await landedOn(2);
    expect(
      walked()
        .slice(0, 2)
        .map((query) => query.has("unread")),
    ).toEqual([true, true]);
  });

  it("opens with ] typed with AltGr, which Windows reports as Ctrl and Alt, and not with Ctrl and Alt alone", async () => {
    serveList([read(1), unread(2)]);
    await openThread();
    const opened = walked().length;
    press("]", { ctrlKey: true, altKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(walked().length).toBe(opened);
    press("]", { ctrlKey: true, altKey: true, modifierAltGraph: true } as KeyboardEventInit);
    await landedOn(2);
    // One press found it, and the page it opened read the list once.
    await waitFor(() => expect(walked().length).toBe(opened + 2));
  });

  it("follows a thread the list does not hold with the list's first thread", async () => {
    serveList([read(2), unread(3), unread(4)]);
    await openThread();
    press("]");
    await landedOn(2);
  });

  it("goes back to the list when it holds no other thread, and the list says so", async () => {
    serveList([unread(1)]);
    await openThread({ unread: 1 });
    press("]");
    expect(await listSays()).toBe(noOtherThread);
    expect(window.location.pathname).toBe("/");
  });

  it("says so and stays when finding the thread below fails", async () => {
    page.api.on("GET", "/threads", { status: 502, text: "<h1>Bad gateway</h1>" });
    await openThread();
    fireEvent.click(belowButton());
    await headFailed();
    expect(window.location.pathname).toBe(path);
    // Chosen again, it looks again, at the list as it stands.
    serveList([read(1), unread(2)]);
    fireEvent.click(belowButton());
    await landedOn(2);
  });
});

describe("Thread above", () => {
  it("opens the row above this one in the list it returns to, as a new entry, reading no further than every thread ahead", async () => {
    serveList([unread(4), read(2), read(3), read(1), unread(5), unread(6)]);
    await openThread({}, "/?sort=latest&group=session");
    const opened = walked().length;
    const length = window.history.length;
    fireEvent.click(aboveButton());
    await landedOn(3);
    expect(window.history.length).toBe(length + 1);
    expect(window.history.state).toMatchObject({ from: "/?sort=latest&group=session" });
    // The press read the first two pages, which hold every thread ahead, and
    // not the third.
    const press = walked().slice(opened, opened + 2);
    expect(press.map((query) => query.get("cursor"))).toEqual([null, "2"]);
    expect(press.every((query) => query.get("group") === "session")).toBe(true);
    expect(
      walked()
        .slice(opened)
        .filter((query) => query.get("cursor") === "4"),
    ).toHaveLength(0);
  });

  it("goes round past the start of the list to its last thread, reading the list to its end", async () => {
    serveList([read(1), unread(2), unread(3), unread(4), unread(5)]);
    await openThread();
    press("[");
    await landedOn(5);
  });

  it("goes on from where the thread stood when it opened, though the page moved it since", async () => {
    const list = serveList([unread(2), unread(3), read(1), unread(4)]);
    await openThread();
    // Answering here moved this thread to the top.
    list.threads = [read(1), unread(2), unread(3), unread(4)];
    press("[");
    await landedOn(3);
  });

  it("passes over a thread gone from the list since the thread opened", async () => {
    const list = serveList([unread(2), unread(3), read(1), unread(4)]);
    await openThread();
    // Thread 3 was archived on another device.
    list.threads = [unread(2), read(1), unread(4)];
    press("[");
    await landedOn(2);
  });

  it("counts a thread new since the thread opened where it stands now, above it or not", async () => {
    const list = serveList([unread(2), read(1), unread(8), unread(9)]);
    list.threads = [unread(2), read(1)];
    await openThread();
    // Thread 9 arrived at the top, and thread 8 just below where this thread
    // sits.
    list.threads = [unread(9), unread(2), unread(8), read(1)];
    press("[");
    await landedOn(2);
  });

  it("takes the last of the threads ahead as the list orders them now, though one moved in among them", async () => {
    // Under the priority order, thread 4 rose in among those ahead.
    const list = serveList([unread(2), unread(3), read(1), unread(4)]);
    await openThread({}, "/?sort=priority");
    list.threads = [unread(2), unread(4), unread(3), read(1)];
    press("[");
    await landedOn(3);
  });

  it("goes on from where the thread stood under the unread filter, though read threads ahead left that list", async () => {
    // Thread 2 and this one are read, so the unread list holds neither.
    page.api.on("GET", "/threads", (call: Call) => {
      const threads = call.url.searchParams.has("unread")
        ? [unread(3), unread(4)]
        : [read(2), unread(3), read(1), unread(4)];
      return { body: { threads, total: threads.length } };
    });
    for (const number of [3, 4]) {
      page.api.on("GET", threadPath(number), { body: threadAnswer(unread(number), [message(1)]) });
      page.api.on("POST", `${threadPath(number)}/read`, {
        body: { cursors: { requester: 1, audience: 1 } },
      });
    }
    await openThread({}, "/?unread=true");
    press("[");
    await landedOn(3);
    expect(window.history.state).toMatchObject({ from: "/?unread=true" });
    expect(
      walked()
        .slice(0, 2)
        .map((query) => query.has("unread")),
    ).toEqual([false, true]);
  });

  it("abandons its walk when the page closes meanwhile", async () => {
    const list = serveList([read(1), ...[2, 3, 4, 5, 6, 7, 8].map(unread)]);
    await openThread();
    const held = holdList(list);
    // Going round from the first row reads to the list's end, four pages.
    press("[");
    await waitFor(() => expect(held.asked()).toBe(1));
    cleanup();
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held.asked()).toBe(1);
  });

  it("gives no thread it found before its most pages while a thread ahead may lie further on", async () => {
    const list = serveList([read(2), read(5), read(1)]);
    await openThread();
    // Thread 5 left the list, which now goes on past the most pages a walk
    // reads, so a later page could hold a thread ahead lower than thread 2.
    list.threads = [];
    page.api.on("GET", "/threads", (call: Call) => {
      const at = Number(call.url.searchParams.get("cursor") ?? "0");
      return {
        body: {
          threads: at === 0 ? [read(2), read(1)] : [unread(100 + at)],
          total: 1000,
          next: String(at + 1),
        },
      };
    });
    const opened = walked().length;
    press("[");
    await headFailed();
    expect(walked().length - opened).toBe(mostPages);
    expect(window.location.pathname).toBe(path);
  });

  it("follows a thread the list does not hold with the list's last thread", async () => {
    serveList([read(2), unread(3), unread(4)]);
    await openThread();
    press("[");
    await landedOn(4);
  });

  it("goes back to the list when it holds no other thread, and the list says so", async () => {
    serveList([unread(1)]);
    await openThread({ unread: 1 });
    press("[");
    expect(await listSays()).toBe(noOtherThread);
    expect(window.location.pathname).toBe("/");
  });

  it("stops at its most pages going round a list that goes on, and says it could not find the thread above rather than that none is left", async () => {
    serveEndless();
    await openThread();
    press("[");
    await headFailed();
    expect(walked()).toHaveLength(1 + mostPages);
    expect(window.location.pathname).toBe(path);
  });
});

describe("Archive & move on", () => {
  it("archives all of the thread once it shows every message, then opens the thread above in its place", async () => {
    const list = serveList([read(2), read(1), unread(3)]);
    const messages = Array.from({ length: 120 }, (_, index) =>
      message(index + 1, { text: `Message ${index + 1}` }),
    );
    await openThread({ last_seq: 120, unread: 100 }, "/", messages);
    const length = window.history.length;
    page.api.on("POST", `${path}/archive`, () => {
      expect(shownMessages().at(-1)).toBe(120);
      // Archived, the thread leaves the list.
      list.threads = [read(2), unread(3)];
      return { body: { marks: { read_through: 120, archived_through: 120 } } };
    });
    fireEvent.click(archiveAndMoveOn());
    await landedOn(2);
    expect(page.api.callsTo("POST", `${path}/archive`).map((call) => call.body)).toEqual([
      { through: 120 },
    ]);
    expect(window.history.length).toBe(length);
  });

  it("opens the thread below in its place once this device moves on to it", async () => {
    moveOnTo("below");
    const list = serveList([read(2), read(1), unread(3)]);
    await openThread();
    page.api.on("POST", `${path}/archive`, () => {
      list.threads = [read(2), unread(3)];
      return { body: { marks: { read_through: 1, archived_through: 1 } } };
    });
    press("E");
    await landedOn(3);
  });

  it("goes round past the start of the list to its last thread, moving on above", async () => {
    serveList([read(1), unread(2), unread(3)]);
    page.api.on("POST", `${path}/archive`, {
      body: { marks: { read_through: 1, archived_through: 1 } },
    });
    await openThread();
    press("E");
    await landedOn(3);
  });

  it("goes back to the list once archived when it holds no other thread, and the list says so", async () => {
    serveList([unread(1)]);
    await openThread({ unread: 1 });
    press("E");
    expect(await listSays()).toBe(noOtherThread);
    expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1);
  });

  it("neither archives nor moves on while an ask is open to you, and says why", async () => {
    serveList([read(1), unread(2)]);
    await openThread(
      { open_asks: { asks: [{ number: 1, seq: 1 }], count: 1, blocking: true, overdue: false } },
      "/",
      [message(1, { asks: [ask()] })],
    );
    expect(archiveAndMoveOn().disabled).toBe(true);
    const hint = document.getElementById(archiveAndMoveOn().getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).not.toBe("");
    press("E");
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
    expect(window.location.pathname).toBe(path);
  });

  it("stays and says why when the server refuses the archive for an ask open to you", async () => {
    serveList([read(1), unread(2)]);
    await openThread();
    // An ask the page has not seen yet opened before the archive landed.
    page.api.on(
      "POST",
      `${path}/archive`,
      failure("invalid_input", "ask 2 is open to you; answer or decline it before archiving"),
    );
    fireEvent.click(archiveAndMoveOn());
    await headFailed();
    expect(window.location.pathname).toBe(path);
  });

  it("finds the thread again in the list as it now stands when the list changed while the archive was under way", async () => {
    moveOnTo("below");
    serveList([read(1), unread(2), unread(3)]);
    await openThread();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    page.api.on("POST", `${path}/archive`, async () => {
      await released;
      return { body: { marks: { read_through: 1, archived_through: 1 } } };
    });
    fireEvent.click(archiveAndMoveOn());
    await waitFor(() => expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1));
    // Thread 2 was found next in the whole list; the narrowed one leaves it out.
    const releaseLists = holdLists();
    toNarrowed();
    release();
    releaseLists();
    await landedOn(3);
    expect(window.history.state).toMatchObject({ from: narrowed });
  });

  it("stays on the thread, archived, and says so when finding the thread again fails after the list changed", async () => {
    moveOnTo("below");
    serveList([read(1), unread(2), unread(3)]);
    await openThread();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    page.api.on("POST", `${path}/archive`, async () => {
      await released;
      return { body: { marks: { read_through: 1, archived_through: 1 } } };
    });
    fireEvent.click(archiveAndMoveOn());
    await waitFor(() => expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1));
    page.api.on("GET", "/threads", { status: 502, text: "<h1>Bad gateway</h1>" });
    toNarrowed();
    release();
    await headFailed();
    expect(window.location.pathname).toBe(path);
    expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1);
  });

  it("archives nothing when it cannot look through the whole list for the thread above", async () => {
    serveEndless();
    await openThread();
    fireEvent.click(archiveAndMoveOn());
    await headFailed();
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
  });

  it("archives nothing when finding the thread above fails", async () => {
    page.api.on("GET", "/threads", { status: 502, text: "<h1>Bad gateway</h1>" });
    await openThread();
    fireEvent.click(archiveAndMoveOn());
    await headFailed();
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
    expect(window.location.pathname).toBe(path);
  });
});
