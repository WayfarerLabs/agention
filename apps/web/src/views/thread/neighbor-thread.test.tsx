import type { ThreadNeighbors, ThreadSummary } from "@wayfarerlabs/agention-api";
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
import { endOfList } from "./leaving.ts";
import { autoAdvanceChoice, type Direction } from "./neighbor-thread.ts";
import { path, shownMessages, ThreadPageTest } from "./thread-test-support.tsx";

// Thread above and Thread below, and where Archive all goes, on a thread's
// page: the thread open is builder/main #1, and the server answers which
// threads are above and below it in the list.

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
});

const threadPath = (number: number) => `/s/builder/main/threads/${number}`;
const thread = (number: number) => threadSummary({ number, title: `Thread ${number}`, unread: 0 });
const neighborsPath = `${path}/neighbors`;

// answerOf is the server's answer naming the threads above and below, by
// number.
const answerOf = (numbers: { above?: number; below?: number }): ThreadNeighbors => ({
  ...(numbers.above === undefined ? {} : { above: thread(numbers.above) }),
  ...(numbers.below === undefined ? {} : { below: thread(numbers.below) }),
});

// serveNeighbors answers which threads are above and below this one, and
// serves those threads.
function serveNeighbors(numbers: { above?: number; below?: number }): void {
  for (const number of [numbers.above, numbers.below]) {
    if (number !== undefined) {
      page.api.on("GET", threadPath(number), {
        body: threadAnswer(thread(number), [message(1)]),
      });
      page.api.on("POST", `${threadPath(number)}/read`, {
        body: { cursors: { requester: 1, audience: 1 } },
      });
    }
  }
  page.api.on("GET", neighborsPath, { body: answerOf(numbers) });
}

// holdNeighbors serves them as serveNeighbors does, holding each answer until
// released, and counts the requests.
function holdNeighbors(numbers: { above?: number; below?: number }) {
  serveNeighbors(numbers);
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let count = 0;
  page.api.on("GET", neighborsPath, async () => {
    count += 1;
    await released;
    return { body: answerOf(numbers) };
  });
  return { release, asked: () => count };
}

// The questions the page asked, each its address.
const asked = () => page.api.callsTo("GET", neighborsPath).map((call: Call) => call.url);

// openThread opens builder/main #1, returning to the list given, or opened
// from a link with no list behind it.
function openThread(
  overrides: Partial<ThreadSummary> = {},
  from: string | undefined = "/",
  messages = [message(1)],
) {
  return page.open(
    { thread: threadSummary({ unread: 0, last_seq: messages.length, ...overrides }), messages },
    from === undefined ? null : { from },
  );
}

const button = (direction: Direction) =>
  screen.getByRole<HTMLButtonElement>("button", {
    name: direction === "above" ? "Thread above" : "Thread below",
  });
const archiveAll = () => screen.getByRole<HTMLButtonElement>("button", { name: "Archive all" });
// canArchive waits for Archive all to be available, once the page's read on
// opening has landed.
const canArchive = () => waitFor(() => expect(archiveAll().disabled).toBe(false));
const threadHeader = () =>
  screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
// The head shows a failure.
const headFailed = () => within(threadHeader()).findByRole("alert");

// press presses a key where focus is, as the keyboard does.
function press(key: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
}

// landedOn waits for the page to open thread number, focus on its heading.
async function landedOn(number: number) {
  await waitFor(() => expect(window.location.pathname).toBe(threadPath(number)));
  await waitFor(() =>
    expect(titleOf(screen.getByRole("heading", { level: 1 }))).toBe(`Thread ${number}`),
  );
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
}

// The list's polite status, once the page went back to it.
async function listSays(): Promise<string | null> {
  await screen.findByRole("heading", { level: 1, name: "Threads" });
  return screen.getByRole("status").textContent;
}

describe("Thread above and Thread below", () => {
  it("open the thread the server finds in the list the thread returns to, as a new entry", async () => {
    serveNeighbors({ above: 4, below: 3 });
    await openThread({}, "/?unread=true&sort=latest&group=session");
    const length = window.history.length;
    fireEvent.click(button("below"));
    await landedOn(3);
    expect(window.history.length).toBe(length + 1);
    expect(window.history.state).toMatchObject({
      from: "/?unread=true&sort=latest&group=session",
    });
    // It asked with the list's filters, order and grouping.
    const query = asked()[0]?.searchParams;
    expect(query?.get("sort")).toBe("latest");
    expect(query?.get("group")).toBe("session");
    expect(query?.get("unread")).toBe("true");
  });

  it("open the thread above with [", async () => {
    serveNeighbors({ above: 4, below: 3 });
    await openThread();
    press("[");
    await landedOn(4);
  });

  for (const direction of ["above", "below"] as const) {
    it(`go back to the list at its end ${direction}, which says so`, async () => {
      serveNeighbors({});
      await openThread({}, "/?sort=created");
      press(direction === "above" ? "[" : "]");
      expect(await listSays()).toBe(endOfList[direction]);
      expect(`${window.location.pathname}${window.location.search}`).toBe("/?sort=created");
    });
  }

  it("ask in the list with no filters for a thread opened from a link", async () => {
    serveNeighbors({ below: 3 });
    await openThread({}, undefined);
    press("]");
    await landedOn(3);
    expect([...(asked()[0]?.searchParams.keys() ?? [])]).toEqual([]);
    expect(window.history.state).toMatchObject({ from: "/" });
  });

  it("ask in the list as it stands, which the list beside the thread can change", async () => {
    serveNeighbors({ below: 3 });
    await openThread();
    act(() => showList(listViewOf(new URLSearchParams("search=three"))));
    press("]");
    await landedOn(3);
    expect(asked()[0]?.searchParams.get("search")).toBe("three");
    expect(window.history.state).toMatchObject({ from: "/?search=three" });
  });

  it("start once for presses made again while finding the thread, and find again in a list changed meanwhile", async () => {
    const held = holdNeighbors({ above: 4, below: 2 });
    await openThread();
    const length = window.history.length;
    act(() => {
      press("]");
      press("]");
    });
    await waitFor(() => expect(held.asked()).toBe(1));
    expect(button("below").disabled).toBe(true);
    expect(button("above").disabled).toBe(true);
    press("[");
    fireEvent.click(button("below"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.asked()).toBe(1);
    // The operator searches the list beside the thread while the server
    // answers, which the page keeps, finding the thread there instead.
    act(() => showList(listViewOf(new URLSearchParams("search=two"))));
    held.release();
    await landedOn(2);
    expect(held.asked()).toBe(2);
    expect(asked()[1]?.searchParams.get("search")).toBe("two");
    expect(window.history.state).toMatchObject({ from: "/?search=two" });
    expect(window.history.length).toBe(length + 1);
  });

  it("stay and say so when the list beside changes on every answer", async () => {
    serveNeighbors({ below: 2 });
    let changes = 0;
    page.api.on("GET", neighborsPath, () => {
      changes += 1;
      showList(listViewOf(new URLSearchParams(`search=change${changes}`)));
      return { body: answerOf({ below: 2 }) };
    });
    await openThread();
    const length = window.history.length;
    press("]");
    await headFailed();
    expect(changes).toBe(3);
    expect(window.location.pathname).toBe(threadPath(1));
    expect(window.history.length).toBe(length);
  });

  it("stay where the operator went when the thread is found after they left", async () => {
    const held = holdNeighbors({ below: 2 });
    await openThread({}, "/?sort=created");
    press("]");
    await waitFor(() => expect(held.asked()).toBe(1));
    press("u");
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?sort=created");
  });

  it("act once for a key held down, not as it repeats", async () => {
    serveNeighbors({ below: 2 });
    await openThread();
    press("]", { repeat: true });
    press("[", { repeat: true });
    press("e", { repeat: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked()).toEqual([]);
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
    press("]");
    await landedOn(2);
  });

  for (const key of ["[", "]"]) {
    it(`open with ${key} typed with AltGr, which Windows reports as Ctrl and Alt, and not with Ctrl and Alt alone`, async () => {
      serveNeighbors({ above: 3, below: 2 });
      await openThread();
      press(key, { ctrlKey: true, altKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(asked()).toEqual([]);
      press(key, { ctrlKey: true, altKey: true, modifierAltGraph: true } as KeyboardEventInit);
      await landedOn(key === "[" ? 3 : 2);
    });
  }

  it("stay with Ctrl and Alt and Escape, which Windows reports as AltGr too", async () => {
    await openThread();
    press("Escape", { ctrlKey: true, altKey: true, modifierAltGraph: true } as KeyboardEventInit);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.pathname).toBe(path);
  });

  it("archive nothing with Ctrl and Alt and e, which Windows reports as AltGr too", async () => {
    window.localStorage.setItem(autoAdvanceChoice, "list");
    await openThread();
    await canArchive();
    press("e", { ctrlKey: true, altKey: true, modifierAltGraph: true } as KeyboardEventInit);
    press("e", { ctrlKey: true, altKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
    expect(window.location.pathname).toBe(path);
  });

  it("say so and stay when finding the thread fails, and ask again when chosen again", async () => {
    page.api.on("GET", neighborsPath, { status: 502, text: "<h1>Bad gateway</h1>" });
    await openThread();
    fireEvent.click(button("below"));
    await headFailed();
    expect(window.location.pathname).toBe(path);
    serveNeighbors({ below: 2 });
    fireEvent.click(button("below"));
    await landedOn(2);
  });

  it("let e archive nothing while finding the thread", async () => {
    const held = holdNeighbors({ below: 2 });
    await openThread();
    press("]");
    await waitFor(() => expect(held.asked()).toBe(1));
    press("e");
    held.release();
    await landedOn(2);
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
  });
});

describe("Archive all and Auto-advance", () => {
  it("archives all of the thread once it shows every message, then opens the thread that was above it in its place, unless chosen otherwise", async () => {
    window.localStorage.removeItem(autoAdvanceChoice);
    serveNeighbors({ above: 2, below: 3 });
    const messages = Array.from({ length: 120 }, (_, index) =>
      message(index + 1, { text: `Message ${index + 1}` }),
    );
    await openThread({ last_seq: 120, unread: 100 }, "/", messages);
    await canArchive();
    const length = window.history.length;
    page.api.on("POST", `${path}/archive`, () => {
      expect(shownMessages().at(-1)).toBe(120);
      // Archived first, before the page asked where the thread stands.
      expect(asked()).toEqual([]);
      return { body: { marks: { read_through: 120, archived_through: 120 } } };
    });
    fireEvent.click(archiveAll());
    await landedOn(2);
    expect(page.api.callsTo("POST", `${path}/archive`).map((call) => call.body)).toEqual([
      { through: 120 },
    ]);
    expect(asked()).toHaveLength(1);
    expect(window.history.length).toBe(length);
  });

  it("opens the thread that was below it in its place with e once Auto-advance says so", async () => {
    window.localStorage.setItem(autoAdvanceChoice, "below");
    serveNeighbors({ above: 2, below: 3 });
    await openThread();
    await canArchive();
    const length = window.history.length;
    press("e");
    await landedOn(3);
    expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1);
    expect(window.history.length).toBe(length);
  });

  it("goes back to the list in its place once Auto-advance says so, asking nothing", async () => {
    window.localStorage.setItem(autoAdvanceChoice, "list");
    await openThread({}, "/?sort=created");
    await canArchive();
    const length = window.history.length;
    press("e");
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?sort=created");
    expect(window.history.length).toBe(length);
    expect(asked()).toEqual([]);
  });

  it("goes back to the list once archived at the end of the list that way, and the list says so", async () => {
    window.localStorage.removeItem(autoAdvanceChoice);
    serveNeighbors({ below: 2 });
    await openThread({ unread: 1 });
    await canArchive();
    press("e");
    expect(await listSays()).toBe(endOfList.above);
    expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1);
  });

  it("neither archives nor moves on while an ask is open to you, and says why", async () => {
    window.localStorage.removeItem(autoAdvanceChoice);
    await openThread(
      { open_asks: { asks: [{ number: 1, seq: 1 }], count: 1, blocking: true, overdue: false } },
      "/",
      [message(1, { asks: [ask()] })],
    );
    // It waits, though it keeps its place and focus, and says why, as e
    // does, without archiving or moving on.
    expect(archiveAll().disabled).toBe(false);
    expect(archiveAll().getAttribute("aria-disabled")).toBe("true");
    const hint = document.getElementById(archiveAll().getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).not.toBe("");
    expect(hint?.hidden).toBe(true);
    press("e");
    expect(hint?.hidden).toBe(false);
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
    expect(window.location.pathname).toBe(path);
  });

  it("stays, asking nothing, and says why when the server refuses the archive for an ask open to you", async () => {
    window.localStorage.removeItem(autoAdvanceChoice);
    await openThread();
    // An ask the page has not seen yet opened before the archive landed.
    page.api.on(
      "POST",
      `${path}/archive`,
      failure("invalid_input", "ask 2 is open to you; answer or decline it before archiving"),
    );
    await canArchive();
    fireEvent.click(archiveAll());
    await headFailed();
    expect(window.location.pathname).toBe(path);
    expect(asked()).toEqual([]);
  });

  it("stays on the thread, archived, and says so when finding the thread fails", async () => {
    window.localStorage.removeItem(autoAdvanceChoice);
    page.api.on("GET", neighborsPath, { status: 502, text: "<h1>Bad gateway</h1>" });
    await openThread();
    await canArchive();
    fireEvent.click(archiveAll());
    await headFailed();
    expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1);
    expect(window.location.pathname).toBe(path);
  });

  it("asks in the list as it stands once archived, though the list beside it changed meanwhile", async () => {
    window.localStorage.setItem(autoAdvanceChoice, "below");
    serveNeighbors({ below: 3 });
    await openThread();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    page.api.on("POST", `${path}/archive`, async () => {
      await released;
      return { body: { marks: { read_through: 1, archived_through: 1 } } };
    });
    await canArchive();
    fireEvent.click(archiveAll());
    await waitFor(() => expect(page.api.callsTo("POST", `${path}/archive`)).toHaveLength(1));
    act(() => showList(listViewOf(new URLSearchParams("search=three"))));
    release();
    await landedOn(3);
    expect(asked()[0]?.searchParams.get("search")).toBe("three");
    expect(window.history.state).toMatchObject({ from: "/?search=three" });
  });
});
