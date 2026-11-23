import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prefixTimeout,
  type Shortcut,
  type ShortcutPlace,
  shortcuts,
  shortcutsChoice,
} from "./keyboard.tsx";
import { ask, message, renderAt, threadSummary, titleOf } from "./test-support.tsx";
import { path, textBox, ThreadPageTest } from "./views/thread/thread-test-support.tsx";

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

  it("opens the search with /, in the filter sheet, without typing it", async () => {
    await openList();
    press("/");
    const search = within(
      screen.getByRole("dialog", { name: "Filters" }),
    ).getByRole<HTMLInputElement>("searchbox");
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe("");
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

describe("the shortcuts declared", () => {
  // The keys of the shortcuts that act together: those of anywhere with
  // those of one page, and the composer's within its fields alone.
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
