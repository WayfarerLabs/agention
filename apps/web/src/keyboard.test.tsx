import type { Message } from "@wayfarerlabs/agention-api";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enterSendsChoice,
  KeyboardProvider,
  prefixTimeout,
  type Shortcut,
  type ShortcutPlace,
  shortcuts,
  shortcutsChoice,
  useShortcuts,
} from "./keyboard.tsx";
import {
  ask,
  message,
  operatorMessage,
  renderAt,
  threadSummary,
  titleOf,
} from "./test-support.tsx";
import {
  openDetails,
  path,
  type State,
  textBox,
  ThreadPageTest,
} from "./views/thread/thread-test-support.tsx";

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  expect(page.api.unhandled).toEqual([]);
});

// press presses a key where focus is, as the keyboard does.
function press(key: string, init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
}

const heading = () => screen.getByRole("heading", { level: 1 });

// The list's rows: one read, one unread and one blocked on the operator.
const rows = [
  threadSummary({ number: 1, title: "Read one", unread: 0, last_seq: 1 }),
  threadSummary({ number: 2, title: "Unread one", unread: 1, last_seq: 1 }),
  threadSummary({ number: 3, title: "Read two", unread: 0, last_seq: 1 }),
  threadSummary({
    number: 4,
    title: "Blocked one",
    unread: 0,
    last_seq: 1,
    open_asks: { asks: [], count: 1, blocking: true, overdue: false },
  }),
];

async function openList() {
  page.api.on("GET", "/threads", { body: { threads: rows, total: rows.length } });
  renderAt("/");
  await screen.findByRole("heading", { level: 2, name: /Read one/ });
}

// The title of the row whose link has focus.
const selected = () => {
  const link = document.activeElement;
  const title = link?.closest("a.thread-link")?.querySelector("h2");
  return title === null || title === undefined ? undefined : titleOf(title);
};

describe("on the thread list", () => {
  it("moves through the rows with j and k, moving focus, and stops at either end", async () => {
    await openList();
    press("j");
    expect(selected()).toBe("Read one");
    press("j");
    press("j");
    expect(selected()).toBe("Read two");
    press("k");
    expect(selected()).toBe("Unread one");
    press("j");
    press("j");
    press("j");
    expect(selected()).toBe("Blocked one");
    press("k");
    press("k");
    press("k");
    press("k");
    expect(selected()).toBe("Read one");
  });

  it("moves to the next and previous thread unread or blocked on the operator with n and N, going round", async () => {
    await openList();
    press("n");
    expect(selected()).toBe("Unread one");
    press("n");
    expect(selected()).toBe("Blocked one");
    press("n");
    expect(selected()).toBe("Unread one");
    press("N", { shiftKey: true });
    expect(selected()).toBe("Blocked one");
  });

  it("opens the selected thread with o", async () => {
    await openList();
    page.serve({ thread: rows[0] ?? threadSummary(), messages: [message(1)] });
    press("j");
    press("o");
    await waitFor(() => expect(heading().textContent).toBe("#1 Read one"));
  });

  it("puts focus in the list's search box with /, without typing it or opening the sheet", async () => {
    await openList();
    press("/");
    const search = screen.getByRole<HTMLInputElement>("searchbox", { name: "Search threads" });
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe("");
    expect(screen.getByRole("dialog", { hidden: true }).hasAttribute("open")).toBe(false);
  });

  it("puts focus back in the search field already open with /, selecting what it holds", async () => {
    await openList();
    press("/");
    const search = screen.getByRole<HTMLInputElement>("searchbox", { name: "Search threads" });
    fireEvent.change(search, { target: { value: "release" } });
    search.setSelectionRange(7, 7);
    screen.getByRole("link", { name: /Read one/ }).focus();
    press("/");
    expect(document.activeElement).toBe(search);
    expect([search.selectionStart, search.selectionEnd]).toEqual([0, "release".length]);
  });

  it("opens the filters with f and the grouping's choice with b, while the head shows them", async () => {
    await openList();
    const sheet = () => screen.getByRole("dialog", { hidden: true });
    const grouping = screen.getByRole("combobox", { name: "Group" });
    press("b");
    expect(document.activeElement).toBe(grouping);
    screen.getByRole("link", { name: /Read one/ }).focus();
    press("f");
    expect(sheet().hasAttribute("open")).toBe(true);
    fireEvent.click(within(sheet()).getByRole("button", { name: /^Show / }));
    expect(sheet().hasAttribute("open")).toBe(false);
    // While the search field takes the head's row, none of them acts.
    press("/");
    screen.getByRole("link", { name: /Read one/ }).focus();
    press("f");
    press("s");
    press("b");
    expect(sheet().hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("link", { name: /Read one/ }));
  });

  it("chooses the order with s alone, while g then s still goes to Sessions", async () => {
    page.api.on("GET", "/registrations", { body: { registrations: [] } });
    await openList();
    press("s");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Sort" }));
    screen.getByRole("link", { name: /Read one/ }).focus();
    press("g");
    press("s");
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
  });

  it("opens the grouping's picker with b where the browser can, leaving focus on it where it cannot", async () => {
    const showPicker = vi.fn();
    const own = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "showPicker");
    Object.defineProperty(HTMLSelectElement.prototype, "showPicker", {
      configurable: true,
      value: showPicker,
    });
    try {
      await openList();
      const grouping = screen.getByRole("combobox", { name: "Group" });
      press("b");
      expect(showPicker.mock.contexts).toEqual([grouping]);
      expect(document.activeElement).toBe(grouping);
      showPicker.mockImplementation(() => {
        throw new DOMException("Not allowed", "NotAllowedError");
      });
      screen.getByRole("link", { name: /Read one/ }).focus();
      press("b");
      expect(showPicker).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(grouping);
    } finally {
      if (own === undefined) {
        Reflect.deleteProperty(HTMLSelectElement.prototype, "showPicker");
      } else {
        Object.defineProperty(HTMLSelectElement.prototype, "showPicker", own);
      }
    }
  });

  it("selects the search already on with /, so typing replaces it", async () => {
    page.api.on("GET", "/threads", { body: { threads: rows, total: rows.length } });
    renderAt("/?search=release");
    await screen.findByRole("heading", { level: 2, name: /Read one/ });
    press("/");
    const search = screen.getByRole<HTMLInputElement>("searchbox", { name: "Search threads" });
    expect(document.activeElement).toBe(search);
    expect([search.selectionStart, search.selectionEnd]).toEqual([0, "release".length]);
  });
});

describe("on a thread's page", () => {
  const open = (overrides: Parameters<typeof threadSummary>[0] = {}) =>
    page.openWith([message(1, { text: "Hello" })], overrides);

  it("goes back to the list with u and with Escape", async () => {
    await open();
    press("u");
    await waitFor(() => expect(heading().textContent).toBe("Threads"));
    window.history.back();
    await waitFor(() => expect(heading().textContent).toMatch(/^#1 /));
    press("Escape");
    await waitFor(() => expect(heading().textContent).toBe("Threads"));
  });

  it("writes in the composer with r, typing nothing, and leaves it with Escape", async () => {
    await open();
    press("r");
    expect(document.activeElement).toBe(textBox());
    expect(textBox().value).toBe("");
    // Within the box, single keys type, and Escape leaves it for the
    // composer's heading, where the page's shortcuts act again.
    expect(press("u")).toBe(true);
    press("Escape");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Reply" }));
    expect(heading().textContent).toMatch(/^#1 /);
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
  ])("sends with %s+Enter, and only once there is something to send", async (_, init) => {
    const state = await open();
    page.serveWrites(state);
    press("r");
    press("Enter", init);
    expect(page.writes()).toEqual([]);
    fireEvent.change(textBox(), { target: { value: "On it." } });
    press("Enter", init);
    await waitFor(() => expect(page.bodies().map((body) => body.text)).toEqual(["On it."]));
  });

  it("sends nothing with Shift or Alt held beside Ctrl and Enter", async () => {
    const state = await open();
    page.serveWrites(state);
    press("r");
    fireEvent.change(textBox(), { target: { value: "On it." } });
    press("Enter", { ctrlKey: true, shiftKey: true });
    press("Enter", { ctrlKey: true, altKey: true });
    press("Enter", { metaKey: true, ctrlKey: true });
    expect(page.writes()).toEqual([]);
  });

  it("leaves Escape to an open options menu, which closes, the page staying on the thread", async () => {
    await open();
    const options = screen.getByRole("button", { name: "Options for message 1" });
    options.focus();
    fireEvent.click(options);
    expect(options.getAttribute("aria-expanded")).toBe("true");
    press("Escape");
    expect(options.getAttribute("aria-expanded")).toBe("false");
    expect(heading().textContent).toMatch(/^#1 /);
    expect(window.location.pathname).toBe(path);
  });

  it("leaves Escape that the composer took to the composer, the page staying on the thread", async () => {
    await open();
    // A control of the composer that takes no text, where the page's own
    // shortcuts would act too.
    within(screen.getByRole("region", { name: "Reply" }))
      .getByRole("button", { name: "Details" })
      .focus();
    press("Escape");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Reply" }));
    expect(window.location.pathname).toBe(path);
  });

  it("keeps the draft when leaving with u after Escape, to find it on opening the thread again", async () => {
    const thread = threadSummary({ unread: 0 });
    page.api.on("GET", "/threads", { body: { threads: [thread], total: 1 } });
    await page.openWith([message(1, { text: "Hello" })]);
    press("r");
    fireEvent.change(textBox(), { target: { value: "Half a reply" } });
    press("Escape");
    press("u");
    await screen.findByRole("heading", { level: 2, name: /Choose a database/ });
    press("j");
    press("o");
    await waitFor(() => expect(heading().textContent).toMatch(/^#1 /));
    expect(textBox().value).toBe("Half a reply");
  });

  it("archives all of the thread with e, and returns to the list as Archive all does", async () => {
    await open();
    press("e");
    const archived = () => page.api.callsTo("POST", `${path}/archive`).map((call) => call.body);
    await waitFor(() => expect(archived()).toEqual([{ through: 1 }]));
    await screen.findByRole("heading", { level: 1, name: "Threads" });
  });

  it("archives nothing with e while an ask is open", async () => {
    await page.openWith([message(1, { asks: [ask()] })], {
      open_asks: { asks: [{ number: 1, seq: 1 }], count: 1, blocking: true, overdue: false },
    });
    press("e");
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
    expect(heading().textContent).toMatch(/^#1 /);
  });

  it("chooses the first open ask's suggestions by number, then the ask that has focus", async () => {
    await page.openWith(
      [
        message(1, { asks: [ask()] }),
        message(2, {
          asks: [
            ask({
              number: 2,
              question: "Which region?",
              suggestions: [
                { label: "East", description: "" },
                { label: "West", description: "" },
              ],
            }),
          ],
        }),
      ],
      {
        open_asks: {
          asks: [
            { number: 1, seq: 1 },
            { number: 2, seq: 2 },
          ],
          count: 2,
          blocking: true,
          overdue: false,
        },
      },
    );
    const card = (name: RegExp) => screen.getByRole("group", { name });
    const choice = (name: RegExp, label: string) =>
      within(card(name)).getByRole<HTMLInputElement>("radio", { name: new RegExp(`^${label}`) });
    press("2");
    expect(choice(/Which database/, "Postgres").checked).toBe(true);
    expect(document.activeElement).toBe(choice(/Which database/, "Postgres"));
    // A number past the suggestions chooses nothing.
    press("3");
    expect(choice(/Which database/, "Postgres").checked).toBe(true);
    choice(/Which region/, "West").focus();
    press("1");
    expect(choice(/Which region/, "East").checked).toBe(true);
    expect(choice(/Which database/, "Postgres").checked).toBe(true);
  });

  describe("marks the thread unread with U and returns to the list, as Mark unread from here does", () => {
    const marked = () => page.api.callsTo("POST", `${path}/unread`).map((call) => call.body);
    beforeEach(() => {
      page.api.on("POST", `${path}/unread`, { body: { cursors: { requester: 3, audience: 1 } } });
    });

    // openReading opens a thread whose last two messages are unread, holding
    // the page's read mark of them until released, and gives what it serves.
    async function openReading(
      messages: Message[],
    ): Promise<{ release: () => void; state: State }> {
      const state = page.serve({ thread: threadSummary({ last_seq: 3, unread: 2 }), messages });
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      page.api.on("POST", `${path}/read`, async () => {
        await held;
        return { body: { cursors: { requester: 3, audience: 3 } } };
      });
      renderAt(path);
      await screen.findByRole("heading", { level: 1 });
      await waitFor(() => expect(page.reads()).toEqual([3]));
      return { release, state };
    }

    it("from the first message unread as the page opened, once its read mark has landed", async () => {
      const { release } = await openReading([message(1), message(2), message(3)]);
      press("U", { shiftKey: true });
      await act(() => Promise.resolve());
      expect(marked()).toEqual([]);
      release();
      await screen.findByRole("heading", { level: 1, name: "Threads" });
      expect(marked()).toEqual([{ from: 2 }]);
      expect(page.reads()).toEqual([3]);
    });

    it("from the first live one of those, passing over one replaced since", async () => {
      const { release, state } = await openReading([message(1), message(2), message(3)]);
      // Replaced while the page shows it, which then loads it again as the
      // read mark lands.
      state.messages = [message(1), message(2, { live: false, replaced_by: 3 }), message(3)];
      release();
      await waitFor(() =>
        expect(document.getElementById("message-2")?.classList.contains("replaced")).toBe(true),
      );
      press("U", { shiftKey: true });
      await screen.findByRole("heading", { level: 1, name: "Threads" });
      expect(marked()).toEqual([{ from: 3 }]);
    });

    it.each([
      ["the first", true],
      ["the second", false],
    ])(
      "only once every read mark under way has landed, %s of two landing first",
      async (_, firstFirst) => {
        const { release, state } = await openReading([message(1), message(2), message(3)]);
        // A message arrives while the first read mark is under way, and the
        // page starts a second, through it.
        let releaseSecond = () => {};
        const second = new Promise<void>((resolve) => (releaseSecond = resolve));
        page.api.on("POST", `${path}/read`, async () => {
          await second;
          return { body: { cursors: { requester: 4, audience: 4 } } };
        });
        state.messages = [...state.messages, message(4)];
        state.thread = { ...state.thread, last_seq: 4, unread: 3 };
        fireEvent.focus(window);
        await waitFor(() => expect(page.reads()).toEqual([3, 4]));
        press("U", { shiftKey: true });
        const [landsFirst, landsLast] = firstFirst
          ? [release, releaseSecond]
          : [releaseSecond, release];
        const loads = page.api.callsTo("GET", path).length;
        landsFirst();
        await waitFor(() => expect(page.api.callsTo("GET", path).length).toBeGreaterThan(loads));
        await act(() => Promise.resolve());
        expect(marked()).toEqual([]);
        landsLast();
        await screen.findByRole("heading", { level: 1, name: "Threads" });
        expect(marked()).toEqual([{ from: 2 }]);
      },
    );

    it("not once the message no longer offers it, the page reading on", async () => {
      const { release, state } = await openReading([message(1), message(2), message(3)]);
      document.getElementById("message-2")?.focus();
      press("U", { shiftKey: true });
      // Replaced while the read mark is under way, which the page loads.
      state.messages = [message(1), message(2, { live: false, replaced_by: 3 }), message(3)];
      fireEvent.focus(window);
      await waitFor(() =>
        expect(document.getElementById("message-2")?.classList.contains("replaced")).toBe(true),
      );
      release();
      // A message arriving after is read as the page shows it.
      state.messages = [...state.messages, message(4)];
      state.thread = { ...state.thread, last_seq: 4, unread: 3 };
      fireEvent.focus(window);
      await waitFor(() => expect(page.reads()).toEqual([3, 4]));
      expect(marked()).toEqual([]);
      expect(heading().textContent).toMatch(/^#1 /);
    });

    it("from the message that has focus", async () => {
      const { release } = await openReading([message(1), message(2), message(3)]);
      document.getElementById("message-1")?.focus();
      press("U", { shiftKey: true });
      release();
      await screen.findByRole("heading", { level: 1, name: "Threads" });
      expect(marked()).toEqual([{ from: 1 }]);
    });

    it("once, though pressed again while the first is under way", async () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      page.api.on("POST", `${path}/unread`, async () => {
        await held;
        return { body: { cursors: { requester: 3, audience: 1 } } };
      });
      await page.openWith([message(1), message(2)]);
      press("U", { shiftKey: true });
      press("U", { shiftKey: true });
      await waitFor(() => expect(marked()).toEqual([{ from: 2 }]));
      press("U", { shiftKey: true });
      release();
      await screen.findByRole("heading", { level: 1, name: "Threads" });
      expect(marked()).toEqual([{ from: 2 }]);
    });

    it("from the agent's latest message, with none unread", async () => {
      await page.openWith([message(1), message(2), operatorMessage(3)]);
      press("U", { shiftKey: true });
      await screen.findByRole("heading", { level: 1, name: "Threads" });
      expect(marked()).toEqual([{ from: 2 }]);
    });
  });

  it("jumps to the next unread message with n", async () => {
    await page.openWith([message(1), message(2, { text: "New" })], { unread: 1 });
    press("n");
    await waitFor(() => expect(document.activeElement?.id).toBe("message-2"));
  });

  it("chooses by number only on the ask n jumped to, which may offer nothing to choose", async () => {
    await page.openWith(
      [
        message(1, { asks: [ask()] }),
        message(2, { asks: [ask({ number: 2, question: "Anything else?", suggestions: [] })] }),
      ],
      {
        open_asks: {
          asks: [
            { number: 1, seq: 1 },
            { number: 2, seq: 2 },
          ],
          count: 2,
          blocking: true,
          overdue: false,
        },
      },
    );
    const sqlite = () =>
      within(screen.getByRole("group", { name: /Which database/ })).getByRole<HTMLInputElement>(
        "radio",
        { name: /^SQLite/ },
      );
    press("n");
    await waitFor(() => expect(document.activeElement?.id).toBe("ask-1"));
    press("n");
    await waitFor(() => expect(document.activeElement?.id).toBe("ask-2"));
    // Ask 2 suggests nothing, so the key chooses nothing, and ask 1 stays
    // unanswered.
    press("1");
    expect(sqlite().checked).toBe(false);
    expect(document.activeElement?.id).toBe("ask-2");
    // Declining ask 1 leaves its card nothing to choose either.
    fireEvent.click(
      within(screen.getByRole("group", { name: /Which database/ })).getByRole("button", {
        name: "Decline to answer",
      }),
    );
    expect(document.activeElement?.closest("section")?.id).toBe("ask-1");
    press("1");
    expect(screen.queryByRole("radio", { name: /^SQLite/ })).toBeNull();
  });
});

describe("anywhere", () => {
  it("goes to each tab with g and a second key", async () => {
    page.api.on("GET", "/registrations", { body: { registrations: [] } });
    page.api.on("GET", "/passkeys", { body: { passkeys: [], recent: true } });
    await openList();
    press("g");
    press("s");
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    press("g");
    press(",");
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    press("g");
    press("t");
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("lets the second key of two follow the first only for a moment", async () => {
    await openList();
    vi.useFakeTimers();
    press("g");
    act(() => vi.advanceTimersByTime(prefixTimeout + 1));
    press("s");
    expect(window.location.pathname).toBe("/");
    // Another key between them ends the wait too.
    press("g");
    press("x");
    press("s");
    expect(window.location.pathname).toBe("/");
  });

  it("shows every shortcut in a dialog with ?, closing it back to where focus was", async () => {
    await openList();
    press("j");
    const row = document.activeElement;
    press("?", { shiftKey: true });
    const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(help.hasAttribute("open")).toBe(true);
    const listed = Array.from(help.querySelectorAll("dd")).map((each) => each.textContent);
    expect(listed.sort()).toEqual(
      Object.values(shortcuts)
        .map((each) => each.description)
        .sort(),
    );
    const keys = Array.from(help.querySelectorAll("dt")).map(
      (each) => Array.from(each.querySelectorAll("kbd")).length,
    );
    expect(keys.reduce((sum, count) => sum + count, 0)).toBe(
      Object.values(shortcuts)
        .flatMap((each) => each.keys)
        .reduce((sum, key) => sum + key.split(" ").length, 0),
    );
    // No shortcut acts while it is open.
    press("j");
    expect(document.activeElement).not.toBe(row);
    fireEvent.click(within(help).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("leads from the dialog to the setting that turns them off", async () => {
    await openList();
    press("?", { shiftKey: true });
    const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.click(within(help).getByRole("link", { name: /Settings/ }));
    await screen.findByRole("heading", { level: 2, name: "Keyboard" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });
});

describe("a page as it shows", () => {
  // Rendered outside act, as the browser renders, so React leaves the effects
  // it may run later until after the page shows; the key is pressed the moment
  // it does, as a quick hand can, before them.
  it("acts on a key pressed the moment the page shows", async () => {
    const pressed: string[] = [];
    function SessionPage() {
      useShortcuts("Session", { backToSessions: (key) => pressed.push(key) });
      return <h1>A session</h1>;
    }
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const shows = new MutationObserver(() => {
      if (container.querySelector("h1") !== null) {
        shows.disconnect();
        press("u");
      }
    });
    shows.observe(container, { childList: true, subtree: true });
    try {
      root.render(
        <KeyboardProvider>
          <SessionPage />
        </KeyboardProvider>,
      );
      await waitFor(() => expect(container.querySelector("h1")).not.toBeNull());
      expect(pressed).toEqual(["u"]);
    } finally {
      root.unmount();
      container.remove();
    }
  });
});

describe("keys the page keeps", () => {
  it("does nothing with a key typed into a text field, a select or editable content", async () => {
    await openList();
    const field = document.createElement("input");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "");
    const editableChild = document.createElement("span");
    editable.append(editableChild);
    document.body.append(field, select, editable);
    try {
      for (const element of [field, select, editableChild]) {
        expect(fireEvent.keyDown(element, { key: "j" })).toBe(true);
        expect(selected()).toBeUndefined();
        expect(fireEvent.keyDown(element, { key: "?" })).toBe(true);
        expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
      }
    } finally {
      field.remove();
      select.remove();
      editable.remove();
    }
  });

  it("sends nothing with Ctrl+Enter that is part of a composition", async () => {
    const state = await page.openWith([message(1)]);
    page.serveWrites(state);
    fireEvent.change(textBox(), { target: { value: "On it." } });
    textBox().focus();
    expect(press("Enter", { ctrlKey: true, isComposing: true })).toBe(true);
    expect(page.writes()).toEqual([]);
  });

  it("sends nothing with Ctrl+Enter while Attach's menu is open in the composer", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      matches: query === "(pointer: coarse)",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    try {
      const state = await page.openWith([message(1)]);
      page.serveWrites(state);
      fireEvent.change(textBox(), { target: { value: "On it." } });
      const attach = screen.getByRole("button", { name: "Attach files" });
      fireEvent.click(attach);
      expect(attach.getAttribute("aria-expanded")).toBe("true");
      attach.focus();
      press("Enter", { ctrlKey: true });
      expect(page.writes()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does nothing with Ctrl, Alt or Meta held", async () => {
    await openList();
    for (const held of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(press("j", held)).toBe(true);
      expect(selected()).toBeUndefined();
    }
  });

  it("does nothing while an options menu or a dialog is open", async () => {
    await page.openWith([message(1, { text: "Hello" })]);
    fireEvent.click(screen.getByRole("button", { name: "Options for message 1" }));
    press("u");
    press("r");
    expect(heading().textContent).toMatch(/^#1 /);
    expect(document.activeElement).not.toBe(textBox());
    cleanup();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    press("j");
    expect(selected()).toBeUndefined();
  });

  it("does nothing once turned off in Settings, which this browser keeps, and acts again once on", async () => {
    renderAt("/settings/keyboard");
    const toggle = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: "Keyboard shortcuts",
    });
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(window.localStorage.getItem(shortcutsChoice)).toBe("false");
    document.body.focus();
    press("g");
    press("t");
    press("?", { shiftKey: true });
    expect(window.location.pathname).toBe("/settings/keyboard");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    cleanup();

    // Kept, and still off in a page opened later, the composer's keys too.
    const state = await page.openWith([message(1)]);
    page.serveWrites(state);
    fireEvent.change(textBox(), { target: { value: "On it." } });
    textBox().focus();
    press("Enter", { ctrlKey: true });
    press("u");
    expect(page.writes()).toEqual([]);
    expect(heading().textContent).toMatch(/^#1 /);
    cleanup();

    renderAt("/settings/keyboard");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Keyboard shortcuts" }));
    document.body.focus();
    press("g");
    press("t");
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("shows the shortcuts from Settings, while they are off too", async () => {
    window.localStorage.setItem(shortcutsChoice, "false");
    renderAt("/settings/keyboard");
    fireEvent.click(await screen.findByRole("button", { name: "Show the shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" }).hasAttribute("open")).toBe(
      true,
    );
  });
});

describe("Enter in the composer", () => {
  // openTyped opens a thread with "On it." typed in the composer's message
  // box, which has focus.
  async function openTyped() {
    const state = await page.openWith([message(1)]);
    page.serveWrites(state);
    fireEvent.change(textBox(), { target: { value: "On it." } });
    textBox().focus();
  }

  it("leaves Enter to the box, for a new line, unless chosen in Settings, which this browser keeps", async () => {
    await openTyped();
    expect(press("Enter")).toBe(true);
    expect(page.writes()).toEqual([]);
    cleanup();

    renderAt("/settings/keyboard");
    const toggle = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Enter sends" });
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(window.localStorage.getItem(enterSendsChoice)).toBe("true");
    cleanup();

    await openTyped();
    expect(press("Enter")).toBe(false);
    await waitFor(() => expect(page.bodies().map((body) => body.text)).toEqual(["On it."]));
  });

  it("says in each box's description, where focus lands, whether Enter sends", async () => {
    // describedBy reads a box's description from the elements it names.
    const describedBy = (box: HTMLElement) =>
      (box.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    await page.openWith([message(1)]);
    const off = [describedBy(textBox()), describedBy(openDetails())];
    cleanup();

    window.localStorage.setItem(enterSendsChoice, "true");
    await page.openWith([message(1)]);
    const on = [describedBy(textBox()), describedBy(openDetails())];
    on.forEach((each, index) => expect(each).not.toBe(off[index]));
  });

  describe("once chosen", () => {
    beforeEach(() => {
      window.localStorage.setItem(enterSendsChoice, "true");
    });

    it("leaves Shift+Enter to the box, for a new line", async () => {
      await openTyped();
      expect(press("Enter", { shiftKey: true })).toBe(true);
      expect(page.writes()).toEqual([]);
    });

    it("sends nothing with an Enter that is part of a composition", async () => {
      await openTyped();
      expect(press("Enter", { isComposing: true })).toBe(true);
      expect(press("Enter", { keyCode: 229 })).toBe(true);
      expect(page.writes()).toEqual([]);
    });

    it("sends from the Details box too, but leaves Enter to the form's buttons", async () => {
      await openTyped();
      const details = openDetails();
      fireEvent.change(details, { target: { value: "More." } });
      screen.getByRole("button", { name: "Attach files" }).focus();
      expect(press("Enter")).toBe(true);
      expect(page.writes()).toEqual([]);
      details.focus();
      expect(press("Enter")).toBe(false);
      await waitFor(() =>
        expect(page.bodies().map(({ text, detail }) => [text, detail])).toEqual([
          ["On it.", "More."],
        ]),
      );
    });

    it("still sends with Ctrl+Enter", async () => {
      await openTyped();
      press("Enter", { ctrlKey: true });
      await waitFor(() => expect(page.bodies().map((body) => body.text)).toEqual(["On it."]));
    });

    it("sends nothing as a held Enter repeats, its repeats typing nothing either", async () => {
      await openTyped();
      expect(press("Enter", { shiftKey: true })).toBe(true);
      // Shift let go while Enter repeats.
      expect(press("Enter", { repeat: true })).toBe(false);
      expect(press("Enter", { repeat: true })).toBe(false);
      expect(page.writes()).toEqual([]);
      expect(press("Enter")).toBe(false);
      await waitFor(() => expect(page.bodies().map((body) => body.text)).toEqual(["On it."]));
    });

    it("sends with the shortcuts off, which take Ctrl+Enter with them", async () => {
      window.localStorage.setItem(shortcutsChoice, "false");
      await openTyped();
      press("Enter", { ctrlKey: true });
      expect(page.writes()).toEqual([]);
      press("Enter");
      await waitFor(() => expect(page.bodies().map((body) => body.text)).toEqual(["On it."]));
    });
  });
});

describe("the shortcuts declared", () => {
  // The keys of the shortcuts that act together: those of anywhere with
  // those of one page, and the composer's within its fields alone. Side by
  // side, the list's and a thread's act together too, and a key both bind
  // acts by where focus is (views/Threads.test.tsx).
  const together: ShortcutPlace[][] = [
    ["Anywhere", "Thread list"],
    ["Anywhere", "Thread"],
    ["Composer"],
  ];
  const keysIn = (places: ShortcutPlace[]) =>
    Object.values(shortcuts)
      .filter((each: Shortcut) => places.includes(each.place))
      .flatMap((each: Shortcut) => each.keys);

  it.each(together)("bind no key twice where they act together: %s", (...places) => {
    const keys = keysIn(places);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never bind alone a key that starts two", () => {
    const keys = keysIn(["Anywhere", "Thread list", "Thread"]);
    const firsts = keys.filter((key) => key.includes(" ")).map((key) => key.split(" ")[0]);
    expect(keys.filter((key) => firsts.includes(key))).toEqual([]);
  });
});
