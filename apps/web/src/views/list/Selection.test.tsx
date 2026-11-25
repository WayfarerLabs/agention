import type { ThreadActionResult, ThreadSummary } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  csrf,
  FakeApi,
  failure,
  message,
  renderAt,
  threadAnswer,
  threadSummary,
  titled,
} from "../../test-support.tsx";
import { longPress } from "./selection.tsx";

let api: FakeApi;
let threads: ThreadSummary[];
let total: number;
// The list's as_of, which each answer of the list carries.
let asOf: string;

const first = threadSummary({ number: 1, title: "Choose a database", last_seq: 3 });
const second = threadSummary({
  number: 2,
  title: "Pick a port",
  last_seq: 5,
  open_asks: {
    asks: [
      { number: 1, seq: 4 },
      { number: 2, seq: 5 },
    ],
    count: 2,
    blocking: false,
    overdue: false,
  },
  status: "open",
});
const third = threadSummary({ number: 3, title: "Ship it", unread: 0, last_seq: 2 });

const done: ThreadActionResult = { acted: [], declined: [], kept: [] };

beforeEach(() => {
  api = new FakeApi();
  threads = [first, second, third];
  total = 3;
  asOf = "as-of-1";
  api.on("GET", "/threads", () => ({ body: { threads, total, as_of: asOf } }));
  api.on("POST", "/threads/actions", { body: done });
  api.on("POST", "/threads/actions/matching", { body: done });
  // A thread a row opens.
  for (const thread of threads) {
    api.on("GET", `/s/builder/main/threads/${thread.number}`, {
      body: threadAnswer(thread, [message(1)]),
    });
  }
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

// onTouch makes the device's primary pointer a finger.
function onTouch() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: query === "(pointer: coarse)",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

// The link of the row headed by a title.
const shown = (title: string) =>
  screen.getByRole("heading", { name: titled(title) }).closest("a") as HTMLAnchorElement;
const checkbox = (title: string) =>
  screen.getByRole<HTMLInputElement>("checkbox", { name: titled(title) });
const rowCheckboxes = () =>
  screen
    .queryAllByRole<HTMLInputElement>("checkbox")
    .filter((box) => box.classList.contains("row-select"));
const selectAll = () => screen.getByRole<HTMLInputElement>("checkbox", { name: "Select all" });
// The toolbar, a group named by how many are selected.
const toolbar = () => screen.queryByRole("group", { name: / selected$/ });
const action = (name: string) =>
  within(screen.getByRole("group", { name: / selected$/ })).getByRole("button", { name });
const actionCalls = () => api.callsTo("POST", "/threads/actions");
const said = () => waitFor(() => expect(screen.getByRole("status").textContent).not.toBe(""));
const through = (thread: ThreadSummary) => ({
  agent: thread.agent,
  session: thread.session,
  thread: thread.number,
  through: thread.last_seq,
});

// press holds a finger on an element for as long as a press takes, then
// lifts it.
async function press(element: Element) {
  fireEvent.pointerDown(element, { pointerType: "touch", isPrimary: true });
  await new Promise((resolve) => setTimeout(resolve, longPress + 50));
  fireEvent.pointerUp(element, { pointerType: "touch", isPrimary: true });
}

describe("selecting with a mouse", () => {
  it("gives each row a checkbox named by its heading, and shows the toolbar once one is checked", async () => {
    renderAt("/");
    await screen.findByText("Choose a database");
    expect(rowCheckboxes()).toHaveLength(3);
    expect(toolbar()).toBeNull();
    fireEvent.click(checkbox("Pick a port"));
    expect(checkbox("Pick a port").checked).toBe(true);
    expect(toolbar()).not.toBeNull();
    // Archive all read gives way to the toolbar.
    expect(screen.queryByRole("button", { name: "Archive all read" })).toBeNull();
    // A row's link still opens its thread.
    fireEvent.click(shown("Choose a database"));
    expect(window.location.pathname).toBe("/s/builder/main/threads/1");
  });

  it("marks the threads selected read through the latest message each showed", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Choose a database") }));
    fireEvent.click(checkbox("Ship it"));
    fireEvent.click(action("Mark read"));
    await said();
    expect(actionCalls()).toHaveLength(1);
    expect(actionCalls()[0]?.headers["x-csrf-token"]).toBe(csrf);
    expect(actionCalls()[0]?.body).toEqual({
      action: "read",
      threads: [through(first), through(third)],
    });
    // Done, the selection clears.
    await waitFor(() => expect(toolbar()).toBeNull());
    expect(checkbox("Choose a database").checked).toBe(false);
  });

  it.each([
    ["Mark unread", "unread"],
    ["Mark read and archive", "read_and_archive"],
  ])("%s acts at once", async (name, chosen) => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Ship it") }));
    fireEvent.click(action(name));
    await said();
    expect(actionCalls()[0]?.body).toEqual({ action: chosen, threads: [through(third)] });
  });

  it("declines only once confirmed, and offers declining only while a thread selected has an open ask", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Ship it") }));
    const decline = "Decline, mark read and archive";
    expect(within(toolbar() as HTMLElement).queryByRole("button", { name: decline })).toBeNull();
    fireEvent.click(checkbox("Pick a port"));
    fireEvent.click(action(decline));
    // It asks first, and Cancel sends nothing, returning focus to the action.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(actionCalls()).toHaveLength(0);
    expect(document.activeElement).toBe(action(decline));
    fireEvent.click(action(decline));
    fireEvent.click(screen.getByRole("button", { name: decline }));
    await said();
    expect(actionCalls()[0]?.body).toEqual({
      action: "decline_read_and_archive",
      threads: [through(second), through(third)],
    });
  });

  it("selects every thread loaded from the header checkbox, then every one that matches", async () => {
    total = 40;
    renderAt("/?agent=builder&unread=true");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
    expect(rowCheckboxes().every((box) => box.checked)).toBe(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "Select all 40 threads that match" }),
    );
    // Acting on all of them asks first, then sends the list's filters.
    fireEvent.click(action("Mark read"));
    expect(api.callsTo("POST", "/threads/actions/matching")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await said();
    expect(api.callsTo("POST", "/threads/actions/matching")[0]?.body).toMatchObject({
      action: "read",
      filters: { agent: ["builder"], unread: true, include_archived: false },
      as_of: "as-of-1",
      expected: 40,
    });
    expect(actionCalls()).toHaveLength(0);
  });

  it("sends every thread that matches as the list stood when chosen, though it refreshed before the confirmation", async () => {
    total = 40;
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Select all 40 threads that match" }),
    );
    fireEvent.click(action("Mark read"));
    total = 41;
    asOf = "as-of-2";
    fireEvent.focus(window);
    await screen.findByText(/All 41 threads that match/);
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await said();
    expect(api.callsTo("POST", "/threads/actions/matching")[0]?.body).toMatchObject({
      as_of: "as-of-1",
      expected: 40,
    });
  });

  it("loads the list afresh and asks again when the threads that match changed in number", async () => {
    total = 40;
    let refused = false;
    api.on("POST", "/threads/actions/matching", () => {
      if (refused) {
        return { body: done };
      }
      refused = true;
      // Another thread came to match since the list was read.
      total = 41;
      asOf = "as-of-2";
      return failure("stale", "the filters keep 41 threads, not the 40 expected", {
        field: "expected",
      });
    });
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Select all 40 threads that match" }),
    );
    fireEvent.click(action("Mark read"));
    const loads = api.callsTo("GET", "/threads").length;
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    // Asked again, once the list has loaded as it now stands.
    await waitFor(() => expect(api.callsTo("GET", "/threads").length).toBeGreaterThan(loads));
    await screen.findByRole("button", { name: "Cancel" });
    expect(toolbar()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(api.callsTo("POST", "/threads/actions/matching")).toHaveLength(2));
    expect(api.callsTo("POST", "/threads/actions/matching")[1]?.body).toMatchObject({
      as_of: "as-of-2",
      expected: 41,
    });
  });

  it("goes back to the threads shown, and from every one that matches to all shown but one unchecked", async () => {
    total = 40;
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Select all 40 threads that match" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select only the 3 shown" }));
    expect(
      await screen.findByRole("button", { name: "Select all 40 threads that match" }),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Select all 40 threads that match" }),
    );
    fireEvent.click(checkbox("Ship it"));
    expect(selectAll().indeterminate).toBe(true);
    fireEvent.click(action("Mark read"));
    await said();
    expect(actionCalls()[0]?.body).toEqual({
      action: "read",
      threads: [through(first), through(second)],
    });
  });

  it("offers no selecting of every thread that matches beyond the most one action takes", async () => {
    total = 501;
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
    expect(screen.queryByRole("button", { name: /that match$/ })).toBeNull();
  });

  // holdActions holds the answers to actions on named threads until released.
  function holdActions() {
    let release = () => {};
    api.on(
      "POST",
      "/threads/actions",
      () =>
        new Promise((resolve) => {
          release = () => resolve({ body: { ...done, acted: [through(first)] } });
        }),
    );
    return () => release();
  }

  it("leaves a selection made while an action was under way when it lands", async () => {
    const release = holdActions();
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Choose a database") }));
    fireEvent.click(action("Mark read"));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    fireEvent.click(action("Done"));
    fireEvent.click(checkbox("Ship it"));
    release();
    await said();
    expect(checkbox("Ship it").checked).toBe(true);
    expect(toolbar()).not.toBeNull();
  });

  it("leaves the selection when a row was selected while the action was under way", async () => {
    const release = holdActions();
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Choose a database") }));
    fireEvent.click(action("Mark read"));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    fireEvent.click(checkbox("Pick a port"));
    release();
    await said();
    expect([checkbox("Choose a database").checked, checkbox("Pick a port").checked]).toEqual([
      true,
      true,
    ]);
  });

  it("clears the selection on Escape and on Done", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Ship it") }));
    fireEvent.keyDown(checkbox("Ship it"), { key: "Escape" });
    expect(toolbar()).toBeNull();
    expect(checkbox("Ship it").checked).toBe(false);
    fireEvent.click(checkbox("Ship it"));
    action("Done").focus();
    fireEvent.click(action("Done"));
    expect(toolbar()).toBeNull();
    // Focus leaves the toolbar for the header checkbox.
    expect(document.activeElement).toBe(selectAll());
  });

  it("keeps the selection through a refresh, dropping a thread that left the list", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Choose a database") }));
    fireEvent.click(checkbox("Ship it"));
    threads = [first, second];
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByText("Ship it")).toBeNull());
    expect(checkbox("Choose a database").checked).toBe(true);
    fireEvent.click(action("Mark read"));
    await said();
    expect(actionCalls()[0]?.body).toEqual({ action: "read", threads: [through(first)] });
  });

  it("forgets a thread that left the list, so it comes back unselected", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Ship it") }));
    fireEvent.click(checkbox("Choose a database"));
    threads = [first, second];
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByText("Ship it")).toBeNull());
    threads = [first, second, third];
    fireEvent.focus(window);
    await screen.findByText("Ship it");
    expect(checkbox("Ship it").checked).toBe(false);
    expect(checkbox("Choose a database").checked).toBe(true);
  });

  it("answers the question with Cancel on Escape, keeping the selection", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Pick a port") }));
    const decline = "Decline, mark read and archive";
    fireEvent.click(action(decline));
    fireEvent.keyDown(screen.getByRole("button", { name: decline }), { key: "Escape" });
    expect(toolbar()).not.toBeNull();
    expect(checkbox("Pick a port").checked).toBe(true);
    expect(actionCalls()).toHaveLength(0);
  });

  it("sends what was selected as the question was asked, though the list refreshed since", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Pick a port") }));
    const decline = "Decline, mark read and archive";
    fireEvent.click(action(decline));
    threads = [first, { ...second, last_seq: 6 }, third];
    fireEvent.focus(window);
    await waitFor(() => expect(api.callsTo("GET", "/threads").length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: decline }));
    await said();
    expect(actionCalls()[0]?.body).toEqual({
      action: "decline_read_and_archive",
      threads: [through(second)],
    });
  });

  it("selects and unselects the current row with x", async () => {
    renderAt("/");
    await screen.findByText("Pick a port");
    shown("Pick a port").focus();
    fireEvent.keyDown(shown("Pick a port"), { key: "x" });
    expect(checkbox("Pick a port").checked).toBe(true);
    fireEvent.keyDown(shown("Pick a port"), { key: "x" });
    expect(checkbox("Pick a port").checked).toBe(false);
  });
});

describe("selecting on a touch screen", () => {
  it("selects a row held down, then a tap selects or unselects in place of opening", async () => {
    onTouch();
    renderAt("/");
    await screen.findByText("Choose a database");
    expect(rowCheckboxes()).toHaveLength(0);
    await press(shown("Pick a port"));
    // The click that may follow the press does nothing, though the list
    // moved another row under the finger as the selection began.
    fireEvent.click(shown("Choose a database"));
    expect(window.location.pathname).toBe("/");
    expect(checkbox("Choose a database").checked).toBe(false);
    expect(checkbox("Pick a port").checked).toBe(true);
    expect(toolbar()).not.toBeNull();
    fireEvent.click(shown("Ship it"));
    expect(window.location.pathname).toBe("/");
    expect(checkbox("Ship it").checked).toBe(true);
    fireEvent.click(shown("Pick a port"));
    expect(checkbox("Pick a port").checked).toBe(false);
    fireEvent.click(action("Mark read"));
    await said();
    expect(actionCalls()[0]?.body).toEqual({ action: "read", threads: [through(third)] });
    // With nothing selected, a tap opens the thread again, and the
    // checkboxes are gone.
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(0));
    fireEvent.click(shown("Ship it"));
    expect(window.location.pathname).toBe("/s/builder/main/threads/3");
  });

  it("selects nothing when the finger lifts, or moves away, before the press is long enough", async () => {
    onTouch();
    renderAt("/");
    await screen.findByText("Choose a database");
    const link = shown("Choose a database");
    fireEvent.pointerDown(link, { pointerType: "touch", isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(link, { pointerType: "touch", clientX: 0, clientY: 40 });
    await new Promise((resolve) => setTimeout(resolve, longPress + 50));
    fireEvent.pointerDown(link, { pointerType: "touch", isPrimary: true });
    fireEvent.pointerUp(link, { pointerType: "touch", isPrimary: true });
    await new Promise((resolve) => setTimeout(resolve, longPress + 50));
    expect(toolbar()).toBeNull();
  });
});
