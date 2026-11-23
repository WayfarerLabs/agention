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
import { mostPages } from "./next-thread.ts";
import { path, shownMessages, ThreadPageTest } from "./thread-test-support.tsx";
import { noneNeedsYou } from "./ThreadView.tsx";

// Next and Archive & next on a thread's page: the thread open is builder/main
// #1, and the list it returns to is served a few threads a page, so finding
// the next walks its pages.

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
const blocked = (number: number) =>
  threadSummary({
    number,
    title: `Thread ${number}`,
    unread: 0,
    open_asks: { asks: [], count: 1, blocking: true, overdue: false },
  });

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

// serveEndless answers the list with a page that always has another after it.
function serveEndless(): void {
  page.api.on("GET", "/threads", (call: Call) => ({
    body: {
      threads: [read(2)],
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
// for the page to have walked the list for its next thread.
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

const nextButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Next thread" });
const archiveAndNext = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: "Archive & next" });
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

describe("Next", () => {
  it("opens the next thread after this one that is unread or blocked on you, in the list it returns to, as a new entry", async () => {
    serveList([unread(4), read(1), read(2), blocked(3), unread(5)]);
    await openThread({}, "/?sort=latest&group=session");
    const length = window.history.length;
    fireEvent.click(nextButton());
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

  it("goes round past the end of the list to the first thread that needs you", async () => {
    serveList([read(2), unread(4), read(1), read(3)]);
    await openThread();
    press("]");
    await landedOn(4);
  });

  it("goes on from where the thread stood when it opened, though the page moved it since", async () => {
    const list = serveList([unread(2), read(1), unread(3)]);
    await openThread();
    // Answering here moved this thread ahead of thread 2.
    list.threads = [read(1), unread(2), unread(3)];
    press("]");
    await landedOn(3);
  });

  it("finds a thread that needs you since the thread opened, and skips one dealt with elsewhere", async () => {
    const list = serveList([read(1), unread(2), read(3), unread(4)]);
    await openThread();
    // Thread 2 was read on another device, and an agent wrote to thread 3.
    list.threads = [read(1), read(2), unread(3), unread(4)];
    press("]");
    await landedOn(3);
  });

  it("counts a thread new since the thread opened where it stands now", async () => {
    const list = serveList([read(1), unread(3), unread(9)]);
    list.threads = [read(1), unread(3)];
    await openThread();
    list.threads = [unread(9), read(1), unread(3)];
    press("]");
    await landedOn(9);
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

  it("starts once for a press made again while it is finding the next thread", async () => {
    const list = serveList([read(1), unread(2), unread(3)]);
    await openThread();
    const held = holdList(list);
    const length = window.history.length;
    press("]");
    await waitFor(() => expect(held.asked()).toBe(1));
    expect(nextButton().getAttribute("aria-busy")).toBe("true");
    press("]");
    fireEvent.click(nextButton());
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

    it("while the press walks it for the next thread", async () => {
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

  it("stops at its most pages in a list that goes on, and says it could not find the next rather than that none is left", async () => {
    serveEndless();
    await openThread();
    await waitFor(() => expect(walked()).toHaveLength(mostPages));
    press("]");
    expect((await within(threadHeader()).findByRole("alert")).textContent).toMatch(
      /^Finding the next thread/,
    );
    expect(walked()).toHaveLength(2 * mostPages);
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

  it("archives nothing with e while it is finding the next thread", async () => {
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

  it("follows a thread the list does not hold with the list's first thread that needs you", async () => {
    serveList([read(2), unread(3), unread(4)]);
    await openThread();
    press("]");
    await landedOn(3);
  });

  it("goes back to the list when no other thread needs you, and the list says so", async () => {
    serveList([read(2), unread(1), read(3)]);
    await openThread({ unread: 1 });
    press("]");
    expect(await listSays()).toBe(noneNeedsYou);
    expect(window.location.pathname).toBe("/");
  });

  it("says so and stays when finding the next thread fails", async () => {
    page.api.on("GET", "/threads", { status: 502, text: "<h1>Bad gateway</h1>" });
    await openThread();
    fireEvent.click(nextButton());
    // Only its words say which action on the thread failed.
    expect((await within(threadHeader()).findByRole("alert")).textContent).toMatch(
      /^Finding the next thread/,
    );
    expect(window.location.pathname).toBe(path);
    // Chosen again, it looks again, at the list as it stands.
    serveList([read(1), unread(2)]);
    fireEvent.click(nextButton());
    await landedOn(2);
  });
});

describe("Archive & next", () => {
  it("archives all of the thread once it shows every message, then opens what came after it in its place", async () => {
    const list = serveList([read(1), read(2), unread(3)]);
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
    fireEvent.click(archiveAndNext());
    await landedOn(3);
    expect(page.api.callsTo("POST", `${path}/archive`).map((call) => call.body)).toEqual([
      { through: 120 },
    ]);
    expect(window.history.length).toBe(length);
  });

  it("goes back to the list once archived when no other thread needs you, and the list says so", async () => {
    serveList([unread(1), read(2)]);
    await openThread({ unread: 1 });
    press("E");
    expect(await listSays()).toBe(noneNeedsYou);
    expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1);
  });

  it("neither archives nor moves on while an ask is open to you, and says why", async () => {
    serveList([read(1), unread(2)]);
    await openThread(
      { open_asks: { asks: [{ number: 1, seq: 1 }], count: 1, blocking: true, overdue: false } },
      "/",
      [message(1, { asks: [ask()] })],
    );
    expect(archiveAndNext().disabled).toBe(true);
    const hint = document.getElementById(archiveAndNext().getAttribute("aria-describedby") ?? "");
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
    fireEvent.click(archiveAndNext());
    expect((await within(threadHeader()).findByRole("alert")).textContent).toMatch(
      /^Archiving this thread/,
    );
    expect(window.location.pathname).toBe(path);
  });

  it("finds the next again in the list as it now stands when the list changed while the archive was under way", async () => {
    serveList([read(1), unread(2), unread(3)]);
    await openThread();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    page.api.on("POST", `${path}/archive`, async () => {
      await released;
      return { body: { marks: { read_through: 1, archived_through: 1 } } };
    });
    fireEvent.click(archiveAndNext());
    await waitFor(() => expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1));
    // Thread 2 was found next in the whole list; the narrowed one leaves it out.
    const releaseLists = holdLists();
    toNarrowed();
    release();
    releaseLists();
    await landedOn(3);
    expect(window.history.state).toMatchObject({ from: narrowed });
  });

  it("stays on the thread, archived, and says so when finding the next again fails after the list changed", async () => {
    serveList([read(1), unread(2), unread(3)]);
    await openThread();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    page.api.on("POST", `${path}/archive`, async () => {
      await released;
      return { body: { marks: { read_through: 1, archived_through: 1 } } };
    });
    fireEvent.click(archiveAndNext());
    await waitFor(() => expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1));
    page.api.on("GET", "/threads", { status: 502, text: "<h1>Bad gateway</h1>" });
    toNarrowed();
    release();
    expect((await within(threadHeader()).findByRole("alert")).textContent).toMatch(
      /^Finding the next thread/,
    );
    expect(window.location.pathname).toBe(path);
    expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1);
  });

  it("archives nothing when it cannot look through the whole list for the next thread", async () => {
    serveEndless();
    await openThread();
    await waitFor(() => expect(walked()).toHaveLength(mostPages));
    fireEvent.click(archiveAndNext());
    expect((await within(threadHeader()).findByRole("alert")).textContent).toMatch(
      /^Finding the next thread/,
    );
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
  });

  it("archives nothing when finding the next thread fails", async () => {
    page.api.on("GET", "/threads", { status: 502, text: "<h1>Bad gateway</h1>" });
    await openThread();
    fireEvent.click(archiveAndNext());
    expect((await within(threadHeader()).findByRole("alert")).textContent).toMatch(
      /^Finding the next thread/,
    );
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
    expect(window.location.pathname).toBe(path);
  });
});
