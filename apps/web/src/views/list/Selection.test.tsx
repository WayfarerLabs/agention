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
// The selection's actions in the bar at the list's foot, a group named by
// how many are selected.
const selected = () => screen.queryByRole("group", { name: / selected$/ });
const action = (name: string) =>
  within(screen.getByRole("group", { name: / selected$/ })).getByRole<HTMLButtonElement>("button", {
    name,
  });
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

describe("the bar at the list's foot", () => {
  const bar = () => screen.getByRole("region", { name: "List actions" });
  const names = (within_: HTMLElement) =>
    within(within_)
      .getAllByRole("button")
      .map((each) => each.getAttribute("aria-label") ?? each.textContent);

  it("acts on every thread loaded while none is selected, and on those selected while any are, the same bar staying", async () => {
    renderAt("/");
    await screen.findByText("Choose a database");
    const shownBar = bar();
    const loaded = within(shownBar).getByRole("group", { name: "Threads shown" });
    expect(names(loaded)).toEqual(["Archive all read", "Mark all read"]);
    // It is the last of the list's body, after its rows, so it never stands
    // over the last of them.
    const rows = document.querySelector("ul.threads");
    expect(rows?.compareDocumentPosition(shownBar)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(shownBar.parentElement?.lastElementChild).toBe(shownBar);
    // Selecting changes what it holds, and leaves focus where it was.
    checkbox("Pick a port").focus();
    fireEvent.click(checkbox("Pick a port"));
    expect(document.activeElement).toBe(checkbox("Pick a port"));
    expect(bar()).toBe(shownBar);
    expect(shownBar.contains(selected())).toBe(true);
    expect(within(shownBar).queryByRole("group", { name: "Threads shown" })).toBeNull();
    // Clear leads, then every action, Decline among them; each short label
    // is a part of its full name.
    expect(names(selected() as HTMLElement)).toEqual([
      "Clear selection",
      "Mark read",
      "Mark unread",
      "Mark read and archive",
      "Decline, mark read and archive",
    ]);
    for (const button of within(selected() as HTMLElement).getAllByRole("button")) {
      const label = button.querySelector(".bar-label")?.textContent?.toLowerCase() ?? "";
      expect(label).not.toBe("");
      expect(button.getAttribute("aria-label")?.toLowerCase()).toContain(label);
    }
    fireEvent.click(action("Clear selection"));
    expect(selected()).toBeNull();
    expect(bar()).toBe(shownBar);
    expect(within(shownBar).getByRole("group", { name: "Threads shown" })).toBeTruthy();
  });

  it("disables every action but Clear while more are selected than one action takes", async () => {
    threads = Array.from({ length: 501 }, (_, index) =>
      threadSummary({ number: index + 1, title: `Thread ${index + 1}` }),
    );
    total = 501;
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
    const disabled = within(selected() as HTMLElement)
      .getAllByRole<HTMLButtonElement>("button")
      .map((each) => each.disabled);
    expect(disabled).toEqual([false, true, true, true, true]);
  });
});

describe("focus and the bar's one action", () => {
  const listBar = () => screen.getByRole("region", { name: "List actions" });
  const bulk = (name: string) => within(listBar()).getByRole<HTMLButtonElement>("button", { name });
  // holdAll holds the answers to actions on named threads until released.
  function holdAll() {
    let release = () => {};
    api.on(
      "POST",
      "/threads/actions",
      () => new Promise((resolve) => (release = () => resolve({ body: done }))),
    );
    return () => release();
  }

  it("returns focus to the action pressed once, and leaves it where it is moved after", async () => {
    // A read thread holding no ask, which the list keeps showing, so Archive
    // all read can act again once it is done.
    threads = [first, third];
    renderAt("/");
    await screen.findByText("Ship it");
    bulk("Archive all read").focus();
    fireEvent.click(bulk("Archive all read"));
    await said();
    await waitFor(() => expect(bulk("Archive all read").disabled).toBe(false));
    expect(document.activeElement).toBe(bulk("Archive all read"));
    // Moved within the bar, or off everything, focus stays as the list
    // refreshes.
    for (const moveTo of [
      () => bulk("Mark all read").focus(),
      () => bulk("Mark all read").blur(),
    ]) {
      moveTo();
      const before = document.activeElement;
      const loads = api.callsTo("GET", "/threads").length;
      fireEvent.focus(window);
      await waitFor(() => expect(api.callsTo("GET", "/threads").length).toBeGreaterThan(loads));
      await screen.findByText("Ship it");
      expect(document.activeElement).toBe(before);
    }
  });

  it("on a touch screen, moves focus that an action left to the page's heading without scrolling", async () => {
    onTouch();
    api.on("POST", "/threads/actions", () => {
      threads = threads.map((thread) => ({ ...thread, unread: 0 }));
      return { body: done };
    });
    renderAt("/");
    await screen.findByText("Ship it");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    bulk("Mark all read").focus();
    fireEvent.click(bulk("Mark all read"));
    await waitFor(() => expect(bulk("Mark all read").disabled).toBe(true));
    const heading = screen.getByRole("heading", { level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const onHeading = focus.mock.contexts.flatMap((context, index) =>
      context === heading ? [focus.mock.calls[index]] : [],
    );
    expect(onHeading).toEqual([[{ preventScroll: true }]]);
  });

  it("returns focus to the action that failed while the selection stays, asked first or not", async () => {
    api.on("POST", "/threads/actions", { status: 502, text: "<h1>Bad gateway</h1>" });
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Pick a port") }));
    action("Mark read").focus();
    fireEvent.click(action("Mark read"));
    // As a browser does once the button pressed is disabled.
    action("Mark read").blur();
    await within(listBar()).findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(action("Mark read")));
    const decline = "Decline, mark read and archive";
    fireEvent.click(action(decline));
    fireEvent.click(screen.getByRole("button", { name: decline }));
    await waitFor(() => expect(action(decline).disabled).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(action(decline)));
  });

  it("leaves focus where the operator put it while an action was under way", async () => {
    const release = holdAll();
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Ship it") }));
    action("Mark read").focus();
    fireEvent.click(action("Mark read"));
    shown("Choose a database").focus();
    release();
    await said();
    await waitFor(() => expect(selected()).toBeNull());
    expect(document.activeElement).toBe(shown("Choose a database"));
  });

  // holdLists holds the answers to the list's loads while held, until
  // released.
  function holdLists() {
    let held = false;
    const waiting: (() => void)[] = [];
    const answer = () => ({ body: { threads, total, as_of: asOf } });
    api.on("GET", "/threads", () =>
      held ? new Promise((resolve) => waiting.push(() => resolve(answer()))) : answer(),
    );
    return {
      hold: () => {
        held = true;
      },
      release: () => {
        held = false;
        for (const each of waiting.splice(0)) {
          each();
        }
      },
    };
  }

  it("moves focus to the page's heading when an action empties the list", async () => {
    threads = [third];
    api.on("POST", "/threads/actions", () => {
      threads = [];
      return { body: done };
    });
    renderAt("/");
    await screen.findByText("Ship it");
    bulk("Archive all read").focus();
    fireEvent.click(bulk("Archive all read"));
    // As a browser does once the button pressed is disabled.
    bulk("Archive all read").blur();
    await screen.findByText("No threads to show.");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })),
    );
  });

  it("keeps both buttons disabled until the list has loaded afresh after the action", async () => {
    const lists = holdLists();
    api.on("POST", "/threads/actions", () => {
      lists.hold();
      return { body: done };
    });
    renderAt("/");
    await screen.findByText("Ship it");
    const loads = api.callsTo("GET", "/threads").length;
    fireEvent.click(bulk("Mark all read"));
    await waitFor(() => expect(api.callsTo("GET", "/threads").length).toBeGreaterThan(loads));
    expect([bulk("Archive all read").disabled, bulk("Mark all read").disabled]).toEqual([
      true,
      true,
    ]);
    lists.release();
    await waitFor(() => expect(bulk("Mark all read").disabled).toBe(false));
  });

  it("keeps the selection and its actions held until the list has loaded afresh after one", async () => {
    const lists = holdLists();
    api.on("POST", "/threads/actions", () => {
      lists.hold();
      threads = [first, second];
      return { body: { ...done, acted: [through(third)] } };
    });
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Ship it") }));
    const loads = api.callsTo("GET", "/threads").length;
    fireEvent.click(action("Mark read and archive"));
    await waitFor(() => expect(api.callsTo("GET", "/threads").length).toBeGreaterThan(loads));
    expect(selected()).not.toBeNull();
    expect(action("Mark read and archive").disabled).toBe(true);
    lists.release();
    // Then the selection clears over the list as it now stands.
    await waitFor(() => expect(selected()).toBeNull());
    expect(screen.queryByText("Ship it")).toBeNull();
    expect(bulk("Mark all read").disabled).toBe(false);
  });

  it("leaves focus on a row it was moved to during the action, though the row then goes", async () => {
    const release = holdAll();
    renderAt("/");
    await screen.findByText("Ship it");
    bulk("Archive all read").focus();
    fireEvent.click(bulk("Archive all read"));
    shown("Ship it").focus();
    threads = [first, second];
    release();
    await waitFor(() => expect(screen.queryByText("Ship it")).toBeNull());
    await waitFor(() => expect(bulk("Archive all read").disabled).toBe(true));
    expect(document.activeElement).not.toBe(bulk("Archive all read"));
    expect(document.activeElement).not.toBe(bulk("Mark all read"));
  });

  it("leaves focus elsewhere in the list where it was moved during the action", async () => {
    const release = holdAll();
    renderAt("/");
    await screen.findByText("Ship it");
    bulk("Mark all read").focus();
    fireEvent.click(bulk("Mark all read"));
    const filters = screen.getByRole("button", { name: /^Filters/ });
    filters.focus();
    release();
    await said();
    await waitFor(() => expect(bulk("Mark all read").disabled).toBe(false));
    expect(document.activeElement).toBe(filters);
  });

  it("names the action that failed, and shows a failure that lands after the bar changed state", async () => {
    let fail = () => {};
    api.on(
      "POST",
      "/threads/actions",
      () =>
        new Promise(
          (resolve) => (fail = () => resolve({ status: 502, text: "<h1>Bad gateway</h1>" })),
        ),
    );
    renderAt("/");
    await screen.findByText("Ship it");
    const name = bulk("Mark all read").textContent ?? "";
    fireEvent.click(bulk("Mark all read"));
    fireEvent.click(checkbox("Ship it"));
    fail();
    // It shows above the selection's actions, naming the action of the
    // other state.
    const alert = await within(listBar()).findByRole("alert");
    expect(alert.textContent).toContain(name);
    expect(selected()).not.toBeNull();
    // It stays as the bar changes state again, until another action starts.
    fireEvent.click(action("Clear selection"));
    expect(within(listBar()).getByRole("alert")).toBe(alert);
    fireEvent.click(bulk("Mark all read"));
    await waitFor(() => expect(within(listBar()).queryByRole("alert")).toBeNull());
    fail();
    await within(listBar()).findByRole("alert");
  });

  it.each(["shown", "selected"])(
    "loads the list afresh after an action on the threads %s fails, since the server may have acted",
    async (state) => {
      api.on("POST", "/threads/actions", () => {
        threads = [first, second];
        return { status: 502, text: "<h1>Bad gateway</h1>" };
      });
      renderAt("/");
      await screen.findByText("Ship it");
      if (state === "shown") {
        fireEvent.click(bulk("Mark all read"));
      } else {
        fireEvent.click(checkbox("Ship it"));
        fireEvent.click(action("Mark read"));
      }
      await within(listBar()).findByRole("alert");
      await waitFor(() => expect(screen.queryByText("Ship it")).toBeNull());
    },
  );

  it("starts no action in one state while one started in the other is under way", async () => {
    const release = holdAll();
    renderAt("/");
    await screen.findByText("Ship it");
    fireEvent.click(bulk("Mark all read"));
    fireEvent.click(checkbox("Ship it"));
    for (const each of within(selected() as HTMLElement).getAllByRole<HTMLButtonElement>(
      "button",
    )) {
      expect(each.disabled).toBe(each.getAttribute("aria-label") !== "Clear selection");
    }
    release();
    await said();
    await waitFor(() => expect(action("Mark read").disabled).toBe(false));
    const releaseAgain = holdAll();
    fireEvent.click(action("Mark read"));
    fireEvent.click(action("Clear selection"));
    expect(bulk("Mark all read").disabled).toBe(true);
    expect(bulk("Archive all read").disabled).toBe(true);
    releaseAgain();
    await said();
  });
});

describe("selecting with a mouse", () => {
  it("gives each row a checkbox named by its heading, and shows the selection's actions once one is checked", async () => {
    renderAt("/");
    await screen.findByText("Choose a database");
    expect(rowCheckboxes()).toHaveLength(3);
    expect(selected()).toBeNull();
    fireEvent.click(checkbox("Pick a port"));
    expect(checkbox("Pick a port").checked).toBe(true);
    expect(selected()).not.toBeNull();
    // The bar at the list's foot acting on every thread loaded gives way to
    // the selection's actions, in its place.
    expect(screen.queryByRole("group", { name: "Threads shown" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive all read" })).toBeNull();
    // A row's link still opens its thread.
    fireEvent.click(shown("Choose a database"));
    expect(window.location.pathname).toBe("/s/builder/main/threads/1");
  });

  it("marks the threads selected read through the latest message each showed", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Choose a database") }));
    fireEvent.click(checkbox("Ship it"));
    action("Mark read").focus();
    fireEvent.click(action("Mark read"));
    await said();
    expect(actionCalls()).toHaveLength(1);
    expect(actionCalls()[0]?.headers["x-csrf-token"]).toBe(csrf);
    expect(actionCalls()[0]?.body).toEqual({
      action: "read",
      threads: [through(first), through(third)],
    });
    // Done, the selection clears, and focus the action left in the bar
    // moves to the header checkbox.
    await waitFor(() => expect(selected()).toBeNull());
    expect(checkbox("Choose a database").checked).toBe(false);
    expect(document.activeElement).toBe(selectAll());
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
    // Without an ask open in what is selected it stays in its place,
    // disabled.
    expect(action(decline).disabled).toBe(true);
    fireEvent.click(checkbox("Pick a port"));
    expect(action(decline).disabled).toBe(false);
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
    expect(selected()).toBeNull();
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
    fireEvent.click(action("Clear selection"));
    fireEvent.click(checkbox("Ship it"));
    release();
    await said();
    expect(checkbox("Ship it").checked).toBe(true);
    expect(selected()).not.toBeNull();
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

  it("clears the selection on Escape and on Clear", async () => {
    renderAt("/");
    fireEvent.click(await screen.findByRole("checkbox", { name: titled("Ship it") }));
    fireEvent.keyDown(checkbox("Ship it"), { key: "Escape" });
    expect(selected()).toBeNull();
    expect(checkbox("Ship it").checked).toBe(false);
    fireEvent.click(checkbox("Ship it"));
    action("Clear selection").focus();
    fireEvent.click(action("Clear selection"));
    expect(selected()).toBeNull();
    // Focus leaves the bar for the header checkbox, not for a button acting
    // on every thread shown.
    await waitFor(() => expect(document.activeElement).toBe(selectAll()));
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
    expect(selected()).not.toBeNull();
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
    expect(selected()).not.toBeNull();
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
    expect(selected()).toBeNull();
  });
});
