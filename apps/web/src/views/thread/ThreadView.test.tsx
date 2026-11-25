import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  absoluteTime,
  conditionWords,
  effortLabel,
  impactLabel,
  otherLabel,
  priorityLabel,
  quoted,
} from "../../format.tsx";
import {
  answerTo,
  ask,
  csrf,
  message,
  observed,
  operatorMessage,
  type Reply,
  renderAt,
  threadAnswer,
  threadSummary,
  titled,
  titleOf,
} from "../../test-support.tsx";
import {
  detailOf,
  option,
  optionNames,
  optionsButton,
  optionsMenu,
  path,
  range,
  shownMessages,
  textBox,
  ThreadPageTest,
} from "./thread-test-support.tsx";

// The Markdown parser, watched, so a test can tell what the page parsed.
vi.mock(import("mdast-util-from-markdown"), async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, fromMarkdown: vi.fn(real.fromMarkdown) as typeof real.fromMarkdown };
});

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
});

// answerRead resolves once the page has read the answer to its next request
// to an API path, which is when an action awaiting it carries on.
function answerRead(pathname: string): Promise<void> {
  const fetch = globalThis.fetch;
  return new Promise((resolve) => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (new URL(String(input), window.location.origin).pathname === `/api/web${pathname}`) {
        const json = response.json.bind(response);
        response.json = async () => {
          const value: unknown = await json();
          resolve();
          return value;
        };
      }
      return response;
    });
  });
}

const messageArticle = (seq: number) =>
  screen.getByRole("article", { name: new RegExp(`^Message ${seq} by`) });

// unreadCards lists the messages whose cards are marked unread, as they were
// when they appeared.
const unreadCards = () =>
  Array.from(document.querySelectorAll("article.message.unread")).map((article) =>
    Number(/^Message (\d+)/.exec(article.getAttribute("aria-label") ?? "")?.[1]),
  );

// threadHeader is the thread page's head, where a failed action on the
// thread shows.
const threadHeader = () => document.querySelector<HTMLElement>(".thread-header") as HTMLElement;

// askCard finds an ask's card by the number it leads with.
const askCard = (number: number) =>
  screen.getByRole("region", { name: new RegExp(`^Ask ${number}\\b`) });

describe("the thread page", () => {
  it("shows the thread as written: plain fields as text, Markdown as formatting", async () => {
    await page.open({
      thread: threadSummary({
        title: "Pick **one** <b>now</b>",
        topic: "storage",
        last_seq: 3,
        unread: 0,
        credential_active: false,
        open_asks: { asks: [{ number: 1, seq: 2 }], count: 1, blocking: true, overdue: false },
      }),
      messages: [
        message(1, {
          text: "Context with a [link](https://example.com/ctx).",
          references: [
            { label: "Pull request", identifier: "#42", url: "https://example.com/pull/42" },
            { label: "Earlier thread", thread: 7 },
          ],
          topic: "storage",
        }),
        message(2, {
          asks: [
            ask({
              effort: "under_15m",
              answer_by: "2026-10-28T09:00:00.000Z",
              fallback: "Use SQLite.\nRevisit later.",
            }),
          ],
        }),
        operatorMessage(3, { text: "Looking." }),
      ],
      requester: 2,
    });
    expect(titleOf(screen.getByRole("heading", { level: 1 }))).toBe("Pick **one** <b>now</b>");
    const first = messageArticle(1);
    expect(within(first).getByRole("link", { name: "link" }).getAttribute("href")).toBe(
      "https://example.com/ctx",
    );
    expect(within(first).getByRole("link", { name: "Pull request" }).getAttribute("href")).toBe(
      "https://example.com/pull/42",
    );
    expect(within(first).getByRole("link", { name: "Earlier thread" }).getAttribute("href")).toBe(
      "/s/builder/main/threads/7",
    );
    // The topic it sets shows among its events.
    expect(Array.from(first.querySelectorAll(".event"), (event) => event.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("storage")]),
    );
    const card = askCard(1);
    // The card leads with the ask's number.
    expect(card.querySelector(".ask-number")?.textContent).toContain("1");
    expect(within(card).getByText("Open.")).toBeTruthy();
    const details = card.querySelector(".ask-details")?.textContent ?? "";
    for (const shown of [
      priorityLabel.normal,
      impactLabel.blocking,
      effortLabel.under_15m.shown,
      effortLabel.under_15m.spoken,
    ]) {
      expect(details).toContain(shown);
    }
    expect(within(card).getByRole("radio", { name: /SQLite.*One file\./ })).toBeTruthy();
    // Plain text keeps its line breaks, after the time it applies from.
    expect(card.querySelector(".fallback p")?.textContent).toContain(
      absoluteTime("2026-10-28T09:00:00.000Z"),
    );
    expect(card.querySelector(".fallback .plain")?.textContent).toBe("Use SQLite.\nRevisit later.");
    // A notice beneath the head names the session left without a credential.
    expect(document.querySelector(".thread-header ~ .notice")?.textContent).toContain(
      "builder/main",
    );
  });

  it("shows an answer's own words as plain text with its line breaks, beside Markdown text", async () => {
    const answer = {
      declined: false,
      picks: [1],
      labels: ["Postgres"],
      text: "**Not** SQLite.\nToo small.",
    };
    await page.openWith([
      message(1, { asks: [ask({ multiple: true, open: false, answer: { seq: 2, ...answer } })] }),
      operatorMessage(2, { text: "More **later**.", answers: [answerTo(answer)] }),
    ]);
    for (const article of [messageArticle(1), messageArticle(2)]) {
      const words = within(article).getByText(/Not\*\* SQLite/);
      expect(words.textContent).toBe("**Not** SQLite.\nToo small.");
      expect(words.querySelector("strong")).toBeNull();
    }
    expect(within(messageArticle(2)).getByText("later").tagName).toBe("STRONG");
  });

  it("marks what an answer picked on its ask, setting the rest apart, its own words as Other", async () => {
    const answer = { declined: false, picks: [1], labels: ["Postgres"], text: "Or both." };
    await page.openWith([
      message(1, { asks: [ask({ multiple: true, open: false, answer: { seq: 2, ...answer } })] }),
      operatorMessage(2, { answers: [answerTo(answer)] }),
    ]);
    const card = askCard(1);
    const items = within(card).getAllByRole("listitem");
    expect(items.map((item) => item.className)).toEqual(["unpicked", "picked", "picked"]);
    // Picked is drawn, and said in words too, for assistive technology.
    expect(items.map((item) => item.querySelector("svg[aria-hidden='true']") !== null)).toEqual([
      false,
      true,
      true,
    ]);
    expect(items.map((item) => item.querySelector(".visually-hidden") !== null)).toEqual([
      false,
      true,
      true,
    ]);
    expect(within(items[2] as HTMLElement).getByText("Or both.")).toBeTruthy();
  });

  it.each([
    [
      "the picks and Other",
      { multiple: true },
      { picks: [1], labels: ["Postgres"], text: "Or both." },
      [quoted(["Postgres"]), otherLabel],
    ],
    ["Other alone", {}, { text: "Neither." }, [otherLabel]],
    ["no choice, its words alone,", { suggestions: [] }, { text: "Sessions only." }, []],
  ])(
    "records an answer in the card's terms, naming %s on an ask with or without suggestions",
    async (_, shape, chosen, named) => {
      const answer = { declined: false, ...chosen };
      await page.openWith([
        message(1, { asks: [ask({ ...shape, open: false, answer: { seq: 2, ...answer } })] }),
        operatorMessage(2, { answers: [answerTo(answer)] }),
      ]);
      const record = messageArticle(2);
      const line = record.querySelector(".event")?.textContent ?? "";
      for (const name of named) {
        expect(line).toContain(name);
      }
      if (named.length === 0) {
        expect(line).not.toContain(otherLabel);
      }
      // The words follow beneath the line, as written.
      const words = record.querySelector(".own-words");
      expect(words?.textContent).toBe(answer.text);
      expect(record.querySelector(".event + .own-words")).toBe(words);
    },
  );

  it("records each of a message's answers by the number of the ask it answers", async () => {
    const postgres = { declined: false, picks: [1], labels: ["Postgres"] };
    await page.openWith([
      message(1, {
        asks: [
          ask({ open: false, answer: { seq: 2, declined: true } }),
          ask({ number: 2, open: false, answer: { seq: 2, ...postgres } }),
          ask({
            number: 3,
            suggestions: [],
            open: false,
            answer: { seq: 2, declined: false, text: "Soon." },
          }),
        ],
      }),
      operatorMessage(2, {
        answers: [
          answerTo({ declined: true }),
          answerTo({ ask: 2, ...postgres }),
          answerTo({ ask: 3, text: "Soon." }),
        ],
      }),
    ]);
    const record = messageArticle(2);
    const lines = Array.from(record.querySelectorAll(".event")).map((line) => line.textContent);
    expect(lines).toHaveLength(3);
    lines.forEach((line, index) => expect(line).toMatch(new RegExp(`\\b${index + 1}\\b`)));
    expect(lines[1]).toContain(quoted(["Postgres"]));
    // The third answer's words follow beneath its own line.
    expect(record.querySelector(".event:nth-of-type(3) + .own-words")?.textContent).toBe("Soon.");
  });

  it("shows a withdrawn ask's card with where and why, and lists each withdrawal on its message", async () => {
    const merged = "Merged at 14:02 by the release job.";
    await page.openWith([
      message(1, {
        asks: [
          ask({ open: false, withdrawal: { seq: 2, reason: merged } }),
          ask({
            number: 2,
            question: "And the docs?",
            open: false,
            withdrawal: { seq: 2, reason: "Moot." },
          }),
        ],
      }),
      message(2, {
        withdrawals: [
          { ask: 1, reason: merged },
          { ask: 2, reason: "Moot." },
        ],
      }),
    ]);
    expect(askCard(1).querySelector(".ask-state")?.textContent).toBe(`Withdrawn in #2: ${merged}`);
    // A withdrawn ask takes no answer.
    expect(within(askCard(1)).queryByRole("group")).toBeNull();
    const lines = Array.from(
      messageArticle(2).querySelectorAll(".event"),
      (line) => line.textContent,
    );
    expect(lines).toEqual([`Withdrew ask 1: ${merged}`, "Withdrew ask 2: Moot."]);
  });

  it("reads an ask its message's replacement withdrew as withdrawn, before revised", async () => {
    await page.openWith([
      message(1, {
        live: false,
        replaced_by: 2,
        asks: [
          ask({ open: false }),
          ask({
            number: 2,
            question: "And the docs?",
            open: false,
            withdrawal: { seq: 2, reason: "Moot." },
          }),
        ],
      }),
      message(2, {
        replaces: 1,
        asks: [ask({ number: 3, question: "Which database, now?" })],
        withdrawals: [{ ask: 2, reason: "Moot." }],
      }),
    ]);
    const replaced = messageArticle(1);
    const states = Array.from(
      replaced.querySelectorAll(".ask-state"),
      (state) => state.textContent,
    );
    expect(states).toEqual(["Revised in #2.", "Withdrawn in #2: Moot."]);
  });

  it("collapses a replaced message to a line naming its replacement or retraction, which expands", async () => {
    await page.openWith(
      [
        message(1, { live: false, replaced_by: 3, asks: [ask({ open: false })] }),
        message(2, { live: false, replaced_by: 4, text: "Draft." }),
        message(3, { replaces: 1, asks: [ask({ number: 2, question: "Which database, now?" })] }),
        message(4, { replaces: 2 }),
        operatorMessage(5, {
          live: true,
          answers: [answerTo({ declined: true, ask_live: false })],
        }),
      ],
      { open_asks: { asks: [{ number: 2, seq: 3 }], count: 1, blocking: true, overdue: false } },
    );
    const replaced = messageArticle(1);
    const summary = within(replaced).getByText("#1 by builder/main, replaced by #3");
    expect(summary.tagName).toBe("SUMMARY");
    expect(within(replaced).getByText("Revised in #3.")).toBeTruthy();
    // A replacement carrying nothing retracts its message.
    expect(within(messageArticle(2)).getByText("#2 by builder/main, retracted in #4")).toBeTruthy();
    expect(within(messageArticle(3)).getByText("Replaces #1.")).toBeTruthy();
    expect(within(messageArticle(4)).getByText("Retracted #2.")).toBeTruthy();
    const answer = messageArticle(5);
    // The decline, and that its ask is no longer live, each name ask 1.
    const events = Array.from(answer.querySelectorAll(".event"), (event) => event.textContent);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatch(/\b1\b/);
    }
  });

  it("opens a long log on the page holding the first unread message, and shows more", async () => {
    await page.openLog({ last_seq: 120, unread: 100 });
    expect(shownMessages()).toEqual(range(21, 70));
    expect(unreadCards()[0]).toBe(21);
    fireEvent.click(screen.getByRole("button", { name: "Show later messages" }));
    await screen.findByText("Message 120");
    expect(shownMessages()).toEqual(range(21, 120));
    fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await screen.findByText("Message 1");
    expect(shownMessages()).toEqual(range(1, 120));
    for (const call of page.api.callsTo("GET", path)) {
      expect(Number(call.url.searchParams.get("limit"))).toBeLessThanOrEqual(100);
    }
  });
});

describe("a message's detail", () => {
  const summary = "The cache misses after every deploy.";
  const detail = "## Found\n\nEach deploy **empties** the cache.";
  const withDetail = () =>
    page.openWith([
      message(1, { text: summary, detail, asks: [ask({ open: false })] }),
      message(2, { text: "Message 2" }),
    ]);
  // parsed says whether the page parsed a field's Markdown.
  const parsed = (text: string) =>
    vi.mocked(fromMarkdown).mock.calls.some(([value]) => value === text);
  // shownDetail finds the detail a fold opened, if it is open.
  const shownDetail = (fold: HTMLElement) =>
    document.getElementById(fold.getAttribute("aria-controls") ?? "");
  const precedes = (first: Node, second: Node) =>
    (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("folds into one line directly under its text, which opens and folds it in place", async () => {
    await withDetail();
    const fold = detailOf(1);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(shownDetail(fold)).toBeNull();
    expect(screen.queryByText("empties")).toBeNull();
    // Under the text, before the message's asks.
    expect(precedes(screen.getByText(summary), fold)).toBe(true);
    expect(precedes(fold, screen.getByRole("region", { name: /^Ask 1\b/ }))).toBe(true);
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    const shown = shownDetail(fold);
    expect(shown?.querySelector("strong")?.textContent).toBe("empties");
    expect(within(messageArticle(1)).getByText("empties")).toBeTruthy();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("empties")).toBeNull();
  });

  it("is never parsed while folded, though the text is", async () => {
    vi.mocked(fromMarkdown).mockClear();
    await withDetail();
    expect(parsed(summary)).toBe(true);
    expect(parsed(detail)).toBe(false);
    fireEvent.click(detailOf(1));
    expect(parsed(detail)).toBe(true);
  });

  it("stays open across refreshes", async () => {
    const state = await withDetail();
    fireEvent.click(detailOf(1));
    state.thread = { ...state.thread, last_seq: 3, unread: 1 };
    state.messages = [...state.messages, message(3, { text: "Agent note" })];
    fireEvent.focus(window);
    await screen.findByText("Agent note");
    expect(detailOf(1).getAttribute("aria-expanded")).toBe("true");
    expect(within(messageArticle(1)).getByText("empties")).toBeTruthy();
  });
});

describe("reading", () => {
  // marked lists the messages shown with the closed envelope, accented, that
  // says they were unread when they appeared.
  const marked = () =>
    screen
      .getAllByRole("article", { name: /^Message/ })
      .filter((article) => article.querySelector(".message-head .mark.accent") !== null)
      .map((article) =>
        Number(/^Message (\d+)/.exec(article.getAttribute("aria-label") ?? "")?.[1]),
      );

  it("reads what it shows on opening, and keeps the messages that were unread marked", async () => {
    const state = await page.openWith([message(1), message(2), message(3)], { unread: 2 });
    await waitFor(() => expect(page.reads()).toEqual([3]));
    expect(page.api.callsTo("POST", `${path}/read`)[0]?.headers["x-csrf-token"]).toBe(csrf);
    await waitFor(() => expect(page.api.callsTo("GET", path).length).toBeGreaterThan(2));
    expect(state.thread.unread).toBe(0);
    expect(marked()).toEqual([2, 3]);
    expect(unreadCards()).toEqual([2, 3]);
  });

  it("marks no replaced message unread", async () => {
    await page.openWith(
      [message(1), message(2, { live: false, replaced_by: 3, text: "Draft." }), message(3)],
      { unread: 2 },
    );
    expect(marked()).toEqual([3]);
    expect(unreadCards()).toEqual([3]);
  });

  it("marks each of the operator's messages the agent has not read, until it reads them", async () => {
    const state = await page.open({
      thread: threadSummary({ last_seq: 4, unread: 0 }),
      messages: [message(1), operatorMessage(2), message(3), operatorMessage(4)],
      requester: 3,
    });
    const tagged = () =>
      [1, 2, 3, 4].filter(
        (seq) => within(messageArticle(seq)).queryByText("Unread by agent") !== null,
      );
    // The open envelope says the agent has read the others.
    const readByAgent = () =>
      [1, 2, 3, 4].filter(
        (seq) => within(messageArticle(seq)).queryByText("Read by agent") !== null,
      );
    expect(tagged()).toEqual([4]);
    expect(readByAgent()).toEqual([2]);
    // The mark sits quietly at the card's foot, the word agent beside the
    // envelope for the eye.
    const foot = messageArticle(4).lastElementChild as HTMLElement;
    expect(within(foot).getByTitle("Unread by agent")).toBeTruthy();
    expect(within(foot).getByText("agent").getAttribute("aria-hidden")).toBe("true");
    // Only the envelope of an unread one is accented, never the word.
    expect(foot.classList.contains("unread")).toBe(true);
    expect(foot.querySelector(".mark.accent")).toBeNull();
    expect(messageArticle(2).lastElementChild?.classList.contains("unread")).toBe(false);
    // The head of each of the agent's messages says whether the operator had
    // read it; that of the operator's own carries no mark at all.
    const headMarked = (seq: number) =>
      messageArticle(seq).querySelector(".message-head .mark") !== null;
    expect([1, 2, 3, 4].filter(headMarked)).toEqual([1, 3]);
    state.requester = 4;
    fireEvent.focus(window);
    await waitFor(() => expect(tagged()).toEqual([]));
    expect(readByAgent()).toEqual([2, 4]);
  });

  it("marks no replaced message of the operator's as read or unread by the agent", async () => {
    await page.open({
      thread: threadSummary({ last_seq: 3, unread: 0 }),
      messages: [
        message(1),
        operatorMessage(2, { live: false, replaced_by: 3, text: "Draft." }),
        operatorMessage(3, { replaces: 2, text: "Final." }),
      ],
      requester: 1,
    });
    expect(within(messageArticle(3)).getByTitle("Unread by agent")).toBeTruthy();
    expect(within(messageArticle(2)).queryByTitle(/by agent/)).toBeNull();
  });

  it("reads only through the last message on screen, and further as more are shown", async () => {
    await page.openLog({ last_seq: 120, unread: 100 });
    await waitFor(() => expect(page.reads()).toEqual([70]));
    fireEvent.click(screen.getByRole("button", { name: "Show later messages" }));
    await waitFor(() => expect(page.reads()).toEqual([70, 120]));
  });

  it("reads the new messages a refresh shows, and marks them new", async () => {
    const state = await page.openWith([message(1), message(2)]);
    expect(page.reads()).toEqual([]);
    state.thread = { ...state.thread, last_seq: 3, unread: 1 };
    state.messages = [...state.messages, message(3, { text: "Agent note" })];
    fireEvent.focus(window);
    await screen.findByText("Agent note");
    await waitFor(() => expect(page.reads()).toEqual([3]));
    expect(marked()).toEqual([3]);
  });

  it("reads nothing while the page is hidden, and reads once it is visible", async () => {
    let visibility = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    try {
      await page.openWith([message(1), message(2)], { unread: 2 });
      await waitFor(() => expect(messageArticle(2)).toBeTruthy());
      expect(page.reads()).toEqual([]);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(page.reads()).toEqual([2]));
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("shows a failed mark, and tries again on the next refresh", async () => {
    const state = await page.openWith([message(1), message(2)]);
    let attempts = 0;
    page.api.on("POST", `${path}/read`, () =>
      attempts++ === 0
        ? { status: 502, text: "<h1>Bad gateway</h1>" }
        : { body: { cursors: { requester: 3, audience: 3 } } },
    );
    state.thread = { ...state.thread, last_seq: 3, unread: 1 };
    state.messages = [...state.messages, message(3, { text: "Agent note" })];
    fireEvent.focus(window);
    await within(threadHeader()).findByRole("alert");
    fireEvent.focus(window);
    await waitFor(() => expect(attempts).toBe(2));
  });
});

describe("the head", () => {
  const back = () => within(threadHeader()).getByRole("link", { name: "Back to threads" });

  it.each([
    ["opened directly", null, "/"],
    [
      "opened from a list with archived threads",
      { from: "/?include_archived=true" },
      "/?include_archived=true",
    ],
    [
      "opened from a filtered, narrowed, reversed, grouped list",
      {
        from:
          "/?search=notes&status=open&effort=quick&agent=builder&agent=reviewer" +
          "&session=builder/main&sort=due&reverse=true&group=agent",
      },
      "/?search=notes&status=open&effort=quick&agent=builder&agent=reviewer" +
        "&session=builder/main&sort=due&reverse=true&group=agent",
    ],
    ["given another page", { from: "/registrations" }, "/"],
    ["given another site", { from: "//example.com/" }, "/"],
  ])("leads with a back button to the list as it was left when %s", async (_, from, href) => {
    await page.open({ thread: threadSummary({ unread: 0 }), messages: [message(1)] }, from);
    expect(back().getAttribute("href")).toBe(href);
    // The back button comes first in the thread's head, and its name holds
    // the word it shows.
    expect(back().closest(".thread-header")?.querySelector("a, button")).toBe(back());
    const shown = back().textContent?.trim().toLowerCase() ?? "";
    expect(shown).not.toBe("");
    expect(back().getAttribute("aria-label")?.toLowerCase()).toContain(shown);
    expect(back().querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // The same button follows the composer, to the same list.
    const links = screen.getAllByRole("link", { name: "Back to threads" });
    expect(links).toHaveLength(2);
    const [, foot] = links;
    expect(foot?.getAttribute("href")).toBe(href);
    const composer = screen.getByRole("region", { name: "Reply" });
    expect(composer.contains(foot ?? null)).toBe(false);
    expect(
      composer.compareDocumentPosition(foot as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each([
    [
      "is quiet, saying when its agent was last seen",
      { presence: { last_seen_at: "2026-10-27T09:00:00.000Z", quiet: true } },
      (line: Element | null) => expect(line?.querySelector("time")).not.toBeNull(),
    ],
    [
      "is quiet, its agent never seen",
      { presence: { quiet: true } },
      (line: Element | null) => expect(line?.querySelector("time")).toBeNull(),
    ],
    [
      "is not connected",
      { presence: { last_seen_at: "2026-10-27T09:00:00.000Z", quiet: false, connected: false } },
      (line: Element | null) => {
        expect(line).not.toBeNull();
        expect(line?.querySelector("time")).toBeNull();
      },
    ],
    [
      "has stopped, saying how",
      {
        presence: {
          last_seen_at: "2026-10-27T09:00:00.000Z",
          quiet: true,
          state: "stopped" as const,
          outcome: "withdrawn" as const,
        },
      },
      (line: Element | null) => {
        expect(line?.textContent).toContain("withdrawn");
        expect(line?.querySelector("time")).toBeNull();
      },
    ],
    [
      "is quiet, saying what its terminal shows",
      {
        presence: {
          last_seen_at: "2026-10-27T09:00:00.000Z",
          quiet: true,
          connected: true,
          monitor: observed("at_prompt", { reason: "usage_limit" }),
        },
      },
      (line: Element | null) => {
        expect(line?.querySelector("time")).not.toBeNull();
        expect(line?.textContent).toContain(
          conditionWords(observed("at_prompt", { reason: "usage_limit" })),
        );
      },
    ],
  ])(
    "says, muted under where it is, why the thread is stranded when its session %s",
    async (_, why, says) => {
      await page.open({
        thread: threadSummary({ unread: 0, stranded: true, ...why }),
        messages: [message(1), operatorMessage(2)],
      });
      const line = threadHeader().querySelector(".stranded");
      expect(line?.previousElementSibling?.classList.contains("where")).toBe(true);
      expect(line?.classList.contains("muted")).toBe(true);
      says(line);
    },
  );

  it("leaves a session with no active credential that is not yet quiet to its tag", async () => {
    await page.open({
      thread: threadSummary({ unread: 0, stranded: true, credential_active: false }),
      messages: [message(1), operatorMessage(2)],
    });
    expect(threadHeader().querySelector(".stranded")).toBeNull();
    expect(within(threadHeader()).getByText("No active credential")).toBeTruthy();
  });

  it("says when the agent was last seen once a session with no active credential is quiet", async () => {
    await page.open({
      thread: threadSummary({
        unread: 0,
        stranded: true,
        credential_active: false,
        presence: { last_seen_at: "2026-10-27T09:00:00.000Z", quiet: true },
      }),
      messages: [message(1), operatorMessage(2)],
    });
    expect(threadHeader().querySelector(".stranded time")).not.toBeNull();
    expect(within(threadHeader()).getByText("No active credential")).toBeTruthy();
  });

  it("says nothing of a thread that is not stranded", async () => {
    await page.openWith([message(1)], { presence: { quiet: true } });
    expect(threadHeader().querySelector(".stranded")).toBeNull();
  });

  it.each([
    ["answered", {}, "Answered"],
    ["withdrawn", { withdrawal: { ask: 1, seq: 2, reason: "Merged." } }, "Withdrawn: Merged."],
  ] as const)("shows its status, muted under where it is, when %s", async (status, more, says) => {
    await page.openWith([message(1)], { status, ...more });
    const line = threadHeader().querySelector(".thread-status");
    expect(line?.previousElementSibling?.classList.contains("where")).toBe(true);
    expect(line?.classList.contains("muted")).toBe(true);
    expect(line?.textContent).toBe(says);
  });

  it("shows no status line while an ask is open or none was asked", async () => {
    await page.openWith([message(1)], { status: "none" });
    expect(threadHeader().querySelector(".thread-status")).toBeNull();
  });

  it("leads its heading with the thread's number", async () => {
    await page.openWith([message(1)]);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.querySelector(".thread-number")?.textContent).toBe("#1");
    expect(heading.textContent).toBe("#1 Choose a database");
    // The page's title names the thread alone.
    await waitFor(() => expect(document.title).toBe("Choose a database · Agention"));
  });

  it("names where the thread is, each part opening the list narrowed to it alone, in its order, direction and grouping", async () => {
    await page.open(
      { thread: threadSummary({ unread: 0, topic: "storage" }), messages: [message(1)] },
      {
        from:
          "/?unread=true&agent=reviewer&include_archived=true&sort=latest&reverse=true" +
          "&group=session",
      },
    );
    // Each part is a link named by its kind and its name, its badge for the
    // eye alone, and sets one filter, to it.
    const where = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    const kept = "sort=latest&reverse=true&group=session";
    expect(where("Agent builder")).toBe(`/?agent=builder&${kept}`);
    expect(where("Session main")).toBe(`/?session=builder/main&${kept}`);
    expect(where("Topic storage")).toBe(`/?topic=builder/main/storage&${kept}`);
    const badge = screen.getByRole("link", { name: "Topic storage" }).querySelector(".path-badge");
    expect([
      badge?.textContent,
      badge?.getAttribute("aria-hidden"),
      badge?.getAttribute("title"),
    ]).toEqual(["T", "true", "Topic"]);
  });

  it("keeps returning to the list first opened from across links between threads", async () => {
    page.api.on("GET", "/s/builder/main/threads/7", {
      body: threadAnswer(threadSummary({ number: 7, title: "An earlier thread", unread: 0 }), [
        message(1),
      ]),
    });
    await page.open(
      {
        thread: threadSummary({ unread: 0 }),
        messages: [message(1, { references: [{ label: "Earlier", thread: 7 }] })],
      },
      { from: "/?unread=true" },
    );
    fireEvent.click(screen.getByRole("link", { name: "Earlier" }));
    await screen.findByRole("heading", { level: 1, name: titled("An earlier thread") });
    expect(back().getAttribute("href")).toBe("/?unread=true");
  });

  it("archives all of the thread once it shows every message through the latest, and returns to the list", async () => {
    // The page shows the first unread message's page; archiving all first
    // shows every later one, loading them, then archives through the latest.
    await page.openLog({ last_seq: 120, unread: 100 });
    await waitFor(() => expect(page.reads()).toEqual([70]));
    const length = window.history.length;
    page.api.on("POST", `${path}/archive`, () => {
      expect(shownMessages().at(-1)).toBe(120);
      return { body: { marks: { read_through: 120, archived_through: 120 } } };
    });
    fireEvent.click(screen.getByRole("button", { name: "Archive all" }));
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    const [call] = page.api.callsTo("POST", `${path}/archive`);
    expect(call?.headers["x-csrf-token"]).toBe(csrf);
    expect(call?.body).toEqual({ through: 120 });
    expect(window.history.length).toBe(length);
  });

  it("stops archiving all when showing the later messages fails, says so, and waits to be chosen again", async () => {
    const state = await page.openLog({ last_seq: 120, unread: 100 });
    await waitFor(() => expect(page.reads()).toEqual([70]));
    page.api.on("GET", path, { status: 502, text: "<h1>Bad gateway</h1>" });
    const archiveAll = () => screen.getByRole<HTMLButtonElement>("button", { name: "Archive all" });
    fireEvent.click(archiveAll());
    await within(threadHeader()).findByRole("alert");
    await waitFor(() => expect(archiveAll().disabled).toBe(false));
    // A later refresh that succeeds archives nothing unasked.
    page.serve(state);
    fireEvent.focus(window);
    await waitFor(() => expect(shownMessages().at(-1)).toBe(120));
    expect(page.api.callsTo("POST", `${path}/archive`)).toEqual([]);
    // Chosen again, it archives through the latest.
    fireEvent.click(archiveAll());
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    expect(page.api.callsTo("POST", `${path}/archive`).map((call) => call.body)).toEqual([
      { through: 120 },
    ]);
  });

  it("keeps reading what it shows when archiving all fails", async () => {
    const state = await page.openWith([message(1), message(2)], { unread: 2 });
    await waitFor(() => expect(page.reads()).toEqual([2]));
    page.api.on("POST", `${path}/archive`, { status: 502, text: "<h1>Bad gateway</h1>" });
    fireEvent.click(screen.getByRole("button", { name: "Archive all" }));
    await within(threadHeader()).findByRole("alert");
    state.thread = { ...state.thread, last_seq: 3, unread: 1 };
    state.messages = [...state.messages, message(3, { text: "Agent note" })];
    fireEvent.focus(window);
    await screen.findByText("Agent note");
    await waitFor(() => expect(page.reads()).toEqual([2, 3]));
  });

  it("offers no archiving while an ask is open to the operator, and says why", async () => {
    await page.openWith([message(1, { asks: [ask()] })], {
      open_asks: { asks: [{ number: 1, seq: 1 }], count: 1, blocking: true, overdue: false },
    });
    const archive = screen.getByRole<HTMLButtonElement>("button", { name: "Archive all" });
    expect(archive.disabled).toBe(true);
    const hint = document.getElementById(archive.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).not.toBe("");
  });

  it("shows the archive box while the thread is archived for the operator", async () => {
    await page.openWith([message(1)], { archived: true });
    const head = screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
    expect(within(head).getByTitle("Archived").querySelector("svg")).not.toBeNull();
    cleanup();
    await page.openWith([message(1)]);
    expect(screen.queryByTitle("Archived")).toBeNull();
  });
});

describe("the jump to unread", () => {
  const jumpButton = () => screen.queryByRole("button", { name: /^Jump to/ });
  // jumpingTo says where the jump's name says it goes.
  const jumpingTo = () =>
    (["unread", "open ask"] as const).find(
      (to) => screen.queryByRole("button", { name: new RegExp(`^Jump to ${to}\\b`) }) !== null,
    );

  // press presses the jump, and waits for focus to reach where it should.
  async function press(reached: () => HTMLElement) {
    fireEvent.click(jumpButton() as HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(reached()));
  }

  // markedUnreadElsewhere opens a thread of 120 messages, read, so the page
  // shows 71 to 120, then marks it unread from message 31 as another tab
  // does, and refreshes the page.
  async function markedUnreadElsewhere() {
    const state = await page.openLog({ last_seq: 120, unread: 0 });
    expect(shownMessages()).toEqual(range(71, 120));
    state.thread = { ...state.thread, unread: 90 };
    fireEvent.focus(window);
    await waitFor(() => expect(jumpingTo()).toBe("unread"));
    return state;
  }

  it("goes to each unread message and each open ask, read or not, in thread order from the first unread, wrapping round and loading pages as needed", async () => {
    // Read through message 5, so the page opens on 6 to 55. Ask 1, read, is
    // on an earlier page, and asks 2 and 3 share an unread message on a later
    // one, listed most pressing first.
    await page.open({
      thread: threadSummary({
        last_seq: 60,
        unread: 55,
        open_asks: {
          asks: [
            { number: 2, seq: 58 },
            { number: 3, seq: 58 },
            { number: 1, seq: 2 },
          ],
          count: 3,
          blocking: true,
          overdue: false,
        },
      }),
      messages: range(1, 60).map((seq) =>
        seq === 2
          ? message(seq, { asks: [ask()] })
          : seq === 58
            ? message(seq, { asks: [ask({ number: 2 }), ask({ number: 3 })] })
            : message(seq, { text: `Message ${seq}` }),
      ),
    });
    expect(shownMessages()).toEqual(range(6, 55));
    expect(jumpingTo()).toBe("unread");
    // Each unread message is focused, from the first, and an open ask's card
    // stands for its message.
    for (const seq of range(6, 56)) {
      await press(() => messageArticle(seq));
    }
    // Past the messages loaded, the next page shows at once.
    expect(shownMessages().slice(-2)).toEqual([59, 60]);
    for (const stop of [
      () => messageArticle(57),
      () => askCard(2),
      () => askCard(3),
      () => messageArticle(59),
      () => messageArticle(60),
      // Round again, the ask read before the page opened comes first.
      () => askCard(1),
      () => messageArticle(6),
    ]) {
      await press(stop);
    }
  });

  it("goes back to the unread messages before those loaded, showing them all from the first", async () => {
    await markedUnreadElsewhere();
    expect(jumpButton()?.textContent).toMatch(/\b90\b/);
    // Nothing unread follows what had been read when the page opened, so the
    // first press goes round to the first unread message.
    await press(() => messageArticle(31));
    expect(shownMessages()).toEqual(range(31, 120));
    await press(() => messageArticle(32));
  });

  it("ends a press whose messages fail to load, says so, and moves focus nowhere once they do load", async () => {
    const state = await markedUnreadElsewhere();
    page.api.on("GET", path, { status: 502, text: "<h1>Bad gateway</h1>" });
    textBox().focus();
    fireEvent.click(jumpButton() as HTMLElement);
    await screen.findByRole("alert");
    // Pressed again while they fail, it is not left waiting either.
    fireEvent.click(jumpButton() as HTMLElement);
    // A later refresh that loads them leaves focus where the operator put it.
    page.serve(state);
    fireEvent.focus(window);
    await waitFor(() => expect(shownMessages()[0]).toBe(31));
    expect(document.activeElement).toBe(textBox());
    // Pressed again, it goes on.
    await press(() => messageArticle(31));
  });

  it("leaves out the messages archived on the page, which are never unread", async () => {
    await page.openWith([message(1), message(2), message(3), message(4)], { unread: 4 });
    await waitFor(() => expect(page.reads()).toEqual([4]));
    expect(jumpButton()?.textContent).toMatch(/\b4\b/);
    await waitFor(() => expect(option(2, "Archive through here").disabled).toBe(false));
    fireEvent.click(option(2, "Archive through here"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /archived message/ })),
    );
    expect(jumpButton()?.textContent).toMatch(/\b2\b/);
    for (const seq of [3, 4, 3]) {
      await press(() => messageArticle(seq));
    }
  });

  it("counts the unread messages, those not yet shown included, as the page reads them", async () => {
    await page.openLog({ last_seq: 120, unread: 100 });
    expect(jumpButton()?.textContent).toMatch(/\b100\b/);
    await waitFor(() => expect(page.reads()).toEqual([70]));
    await waitFor(() => expect(page.api.callsTo("GET", path).length).toBeGreaterThan(2));
    expect(jumpButton()?.textContent).toMatch(/\b100\b/);
  });

  it("goes round the open asks the summary lists, the most pressing, once nothing is unread, counting those", async () => {
    // Of 6 open asks, the summary lists only the most pressing, as the
    // server's does past its limit: here the latest 4, most pressing first.
    await page.openWith([message(1, { asks: range(1, 6).map((number) => ask({ number })) })], {
      open_asks: {
        asks: range(3, 6)
          .reverse()
          .map((number) => ({ number, seq: 1 })),
        count: 6,
        blocking: true,
        overdue: false,
      },
    });
    expect(jumpingTo()).toBe("open ask");
    expect(jumpButton()?.textContent).toMatch(/\b4\b/);
    expect(jumpButton()?.textContent).not.toMatch(/\b6\b/);
    // In the thread's order, going round past the last.
    for (const number of [...range(3, 6), 3]) {
      await press(() => askCard(number));
    }
  });

  it("goes to unread messages while there are any, then to open asks alone, and shows only while there is either", async () => {
    const openAsk = {
      open_asks: { asks: [{ number: 1, seq: 1 }], count: 1, blocking: true, overdue: false },
    };
    const state = await page.openWith([message(1, { asks: [ask()] }), message(2)], {
      ...openAsk,
      unread: 1,
    });
    expect(jumpingTo()).toBe("unread");
    // Read, the thread opens again with only its open ask to go to.
    await waitFor(() => expect(state.thread.unread).toBe(0));
    cleanup();
    await page.open(state);
    expect(jumpingTo()).toBe("open ask");
    // A message arriving on the page is unread.
    state.thread = { ...state.thread, last_seq: 3, unread: 1 };
    state.messages = [...state.messages, message(3, { text: "Agent note" })];
    fireEvent.focus(window);
    await waitFor(() => expect(jumpingTo()).toBe("unread"));
    cleanup();
    await page.openWith([message(1, { asks: [ask({ open: false })] }), message(2)]);
    expect(jumpButton()).toBeNull();
  });
});

describe("a message's options", () => {
  const answered = { declined: false, picks: [0], labels: ["SQLite"] };
  const thread = () =>
    page.openWith([
      message(1, { live: false, replaced_by: 2, text: "Draft." }),
      message(2, {
        replaces: 1,
        asks: [ask({ open: false, answer: { seq: 3, ...answered } })],
      }),
      operatorMessage(3, { answers: [answerTo({ ask_seq: 2, ...answered })] }),
      operatorMessage(4, { text: "One more thing." }),
    ]);

  it("are offered on every live message, by a button disclosing them", async () => {
    await thread();
    expect(screen.queryByRole("button", { name: "Options for message 1" })).toBeNull();
    expect(optionsButton(2).getAttribute("aria-expanded")).toBe("false");
    expect(optionNames(2)).toEqual(["Mark unread from here", "Archive through here"]);
    expect(optionsButton(2).getAttribute("aria-expanded")).toBe("true");
    expect(optionNames(3)).toEqual([
      "Mark unread from here",
      "Archive through here",
      "Change answer",
    ]);
    expect(optionNames(4)).toEqual(["Mark unread from here", "Archive through here", "Edit"]);
    // No message shows them outside its menu.
    fireEvent.click(optionsButton(4));
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change answer" })).toBeNull();
  });

  it("open one menu at a time, and close on a second press", async () => {
    await thread();
    optionsMenu(2);
    optionsMenu(4);
    expect(optionsButton(2).getAttribute("aria-expanded")).toBe("false");
    expect(optionsButton(4).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(optionsButton(4));
    expect(optionsButton(4).getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".options-menu")).toBeNull();
  });

  it("close on Escape, returning focus to their button", async () => {
    await thread();
    const item = option(4, "Edit");
    item.focus();
    fireEvent.keyDown(item, { key: "Escape" });
    expect(optionsButton(4).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(optionsButton(4));
  });

  it("close on a tap elsewhere, returning focus without scrolling unless the tap was on a control", async () => {
    await thread();
    const focus = vi.spyOn(optionsButton(4), "focus");
    // A tap on text, which gives focus to nothing, or to the main region
    // holding it, which takes focus only from script.
    option(4, "Edit").focus();
    fireEvent.click(screen.getByText("One more thing."));
    expect(optionsButton(4).getAttribute("aria-expanded")).toBe("false");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(optionsButton(4));
    // A tap on a control, or on its label, keeps whatever focus it gives,
    // which may be none.
    for (const control of [
      screen.getByRole("textbox"),
      optionsButton(2),
      screen.getByRole("combobox", { name: "After sending" }),
    ]) {
      optionsMenu(4);
      focus.mockClear();
      fireEvent.click(control);
      expect(optionsButton(4).getAttribute("aria-expanded")).toBe("false");
      expect(focus).not.toHaveBeenCalled();
    }
  });

  it("close when focus moves on to another control, as Tab past the last option does", async () => {
    await thread();
    const item = option(4, "Edit");
    item.focus();
    const box = screen.getByRole("textbox");
    fireEvent.blur(item, { relatedTarget: box });
    expect(optionsButton(4).getAttribute("aria-expanded")).toBe("false");
    // Focus moving within the menu leaves it open.
    const first = option(4, "Mark unread from here");
    fireEvent.blur(first, { relatedTarget: option(4, "Edit") });
    expect(optionsButton(4).getAttribute("aria-expanded")).toBe("true");
  });

  it("mark the thread unread from a message and return to the list, replacing the page", async () => {
    page.api.on("POST", `${path}/unread`, { body: { cursors: { requester: 4, audience: 1 } } });
    await thread();
    const length = window.history.length;
    fireEvent.click(option(2, "Mark unread from here"));
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    const [call] = page.api.callsTo("POST", `${path}/unread`);
    expect(call?.headers["x-csrf-token"]).toBe(csrf);
    expect(call?.body).toEqual({ from: 2 });
    expect(window.history.length).toBe(length);
    expect(page.reads()).toEqual([]);
  });

  it("say why marking unread failed by the message it started from, staying on the page", async () => {
    page.api.on("POST", `${path}/unread`, { status: 502, text: "<h1>Bad gateway</h1>" });
    await thread();
    fireEvent.click(option(3, "Mark unread from here"));
    const said = await within(messageArticle(3)).findByRole("alert");
    expect(screen.getAllByRole("alert")).toEqual([said]);
    expect(titleOf(screen.getByRole("heading", { level: 1 }))).toBe("Choose a database");
  });

  it("stop reading while marking unread, even what a refresh brings", async () => {
    let release: (reply: Reply) => void = () => {};
    page.api.on(
      "POST",
      `${path}/unread`,
      () => new Promise<Reply>((resolve) => (release = resolve)),
    );
    const state = await page.openWith([message(1), message(2)]);
    fireEvent.click(option(2, "Mark unread from here"));
    // While it is under way, neither it nor archiving can start again.
    expect(option(2, "Mark unread from here").disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Archive all" }).disabled).toBe(
      true,
    );
    state.thread = { ...state.thread, last_seq: 3, unread: 1 };
    state.messages = [...state.messages, message(3, { text: "Agent note" })];
    fireEvent.focus(window);
    await screen.findByText("Agent note");
    expect(page.reads()).toEqual([]);
    release({ body: { cursors: { requester: 3, audience: 1 } } });
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    expect(page.reads()).toEqual([]);
  });

  it.each([
    ["marking unread", "/unread", () => fireEvent.click(option(1, "Mark unread from here"))],
    [
      "archiving",
      "/archive",
      () => fireEvent.click(screen.getByRole("button", { name: "Archive all" })),
    ],
  ])(
    "leave the operator where they went when %s lands after they moved on",
    async (_, route, act) => {
      let release: (reply: Reply) => void = () => {};
      page.api.on(
        "POST",
        `${path}${route}`,
        () => new Promise<Reply>((resolve) => (release = resolve)),
      );
      page.api.on("GET", "/s/builder/main/threads/7", {
        body: threadAnswer(threadSummary({ number: 7, title: "An earlier thread", unread: 0 }), [
          message(1),
        ]),
      });
      await page.openWith([message(1, { references: [{ label: "Earlier", thread: 7 }] })]);
      const read = answerRead(`${path}${route}`);
      act();
      fireEvent.click(screen.getByRole("link", { name: "Earlier" }));
      await screen.findByRole("heading", { level: 1, name: titled("An earlier thread") });
      release({ body: {} });
      // Once the page has read the answer, the action finishes in promise
      // callbacks alone, so a task queued after them runs once it has.
      await read;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(titleOf(screen.getByRole("heading", { level: 1 }))).toBe("An earlier thread");
      expect(window.location.pathname).toBe("/s/builder/main/threads/7");
    },
  );

  it("hold marking unread while the page is still reading", async () => {
    let release: (reply: Reply) => void = () => {};
    page.serve({
      thread: threadSummary({ last_seq: 2, unread: 1 }),
      messages: [message(1), message(2)],
    });
    page.api.on("POST", `${path}/read`, () => new Promise<Reply>((resolve) => (release = resolve)));
    renderAt(path);
    await waitFor(() => expect(page.reads()).toEqual([2]));
    expect(option(2, "Mark unread from here").disabled).toBe(true);
    release({ body: { cursors: { requester: 2, audience: 2 } } });
    await waitFor(() => expect(option(2, "Mark unread from here").disabled).toBe(false));
  });
});

describe("archiving through a message", () => {
  const archives = () =>
    page.api.callsTo("POST", `${path}/archive`).map((call) => call.body as { through: number });
  const fold = () => screen.getByRole("button", { name: /archived message/ });

  it("archives that message and every earlier one, staying on the page with them folded", async () => {
    await page.openWith([message(1), message(2), message(3), message(4)]);
    fireEvent.click(option(2, "Archive through here"));
    await waitFor(() => expect(document.activeElement).toBe(fold()));
    expect(archives()).toEqual([{ through: 2 }]);
    expect(page.api.callsTo("POST", `${path}/archive`)[0]?.headers["x-csrf-token"]).toBe(csrf);
    expect(titleOf(screen.getByRole("heading", { level: 1 }))).toBe("Choose a database");
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(shownMessages()).toEqual([]);
    expect(
      screen
        .getAllByRole("article", { name: /^Message/ })
        .map((each) => each.getAttribute("aria-label")),
    ).toEqual(["Message 3 by builder/main", "Message 4 by builder/main"]);
    expect(optionNames(3)).toContain("Archive through here");
    // Unfolded, each archived message is marked so and, the archive mark
    // having reached it, offers neither archiving nor marking unread.
    fireEvent.click(fold());
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    for (const seq of [1, 2]) {
      expect(within(messageArticle(seq)).getByTitle("Archived")).toBeTruthy();
      expect(screen.queryByRole("button", { name: `Options for message ${seq}` })).toBeNull();
    }
    expect(within(messageArticle(3)).queryByTitle("Archived")).toBeNull();
    expect(optionNames(3)).toEqual(["Mark unread from here", "Archive through here"]);
  });

  it("marks a message it archives read, though it was unread when the page opened", async () => {
    await page.openWith([message(1), message(2), message(3)], { unread: 3 });
    await waitFor(() => expect(option(2, "Archive through here").disabled).toBe(false));
    fireEvent.click(option(2, "Archive through here"));
    await waitFor(() => expect(document.activeElement).toBe(fold()));
    fireEvent.click(fold());
    for (const seq of [1, 2]) {
      expect(messageArticle(seq).classList.contains("unread")).toBe(false);
      expect(within(messageArticle(seq)).queryByTitle("Unread")).toBeNull();
    }
    expect(messageArticle(3).classList.contains("unread")).toBe(true);
    expect(within(messageArticle(3)).getByTitle("Unread")).toBeTruthy();
  });

  it("archives the thread through a message followed only by the operator's reply, head and messages agreeing", async () => {
    await page.openWith([message(1), operatorMessage(2, { text: "Thanks." })]);
    const head = screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
    expect(within(head).queryByTitle("Archived")).toBeNull();
    fireEvent.click(option(1, "Archive through here"));
    await waitFor(() => expect(within(head).getByTitle("Archived")).toBeTruthy());
    expect(archives()).toEqual([{ through: 1 }]);
    fireEvent.click(fold());
    for (const seq of [1, 2]) {
      expect(within(messageArticle(seq)).getByTitle("Archived")).toBeTruthy();
    }
  });

  it("archives through the latest message too, staying on the page with every message folded", async () => {
    await page.openWith([message(1), message(2)]);
    fireEvent.click(option(2, "Archive through here"));
    await waitFor(() => expect(document.activeElement).toBe(fold()));
    expect(archives()).toEqual([{ through: 2 }]);
    expect(titleOf(screen.getByRole("heading", { level: 1 }))).toBe("Choose a database");
    expect(screen.queryAllByRole("article", { name: /^Message/ })).toEqual([]);
  });

  it("offers on an archived message of the operator's only what any of theirs offers", async () => {
    await page.open({
      thread: threadSummary({ last_seq: 3, unread: 0 }),
      messages: [message(1), operatorMessage(2, { text: "Mine." }), message(3)],
      archived: 2,
    });
    fireEvent.click(fold());
    expect(optionNames(2)).toEqual(["Edit"]);
    expect(optionNames(3)).toEqual(["Mark unread from here", "Archive through here"]);
  });

  it("waits while an ask open to the operator sits in the message or an earlier one, and names the earliest", async () => {
    await page.openWith(
      [
        message(1),
        message(2),
        message(3, { asks: [ask(), ask({ number: 2 })] }),
        message(4),
        message(5, { asks: [ask({ number: 3 })] }),
        operatorMessage(6),
      ],
      {
        // Most pressing first, as the summary lists them.
        open_asks: {
          asks: [
            { number: 3, seq: 5 },
            { number: 2, seq: 3 },
            { number: 1, seq: 3 },
          ],
          count: 3,
          earliest: { number: 1, seq: 3 },
          blocking: true,
          overdue: false,
        },
      },
    );
    for (const seq of [1, 2]) {
      expect(option(seq, "Archive through here").disabled).toBe(false);
    }
    for (const seq of [3, 4, 5, 6]) {
      const archive = option(seq, "Archive through here");
      expect(archive.disabled).toBe(true);
      const hint = document.getElementById(archive.getAttribute("aria-describedby") ?? "");
      expect(hint?.textContent).toMatch(/\b1\b/);
      expect(hint?.textContent).not.toMatch(/\b[2-6]\b/);
    }
  });

  it("names the earliest open ask though the summary lists only the most pressing", async () => {
    await page.openWith(
      [message(1, { asks: [ask()] }), message(2), message(3, { asks: [ask({ number: 2 })] })],
      {
        open_asks: {
          asks: [{ number: 2, seq: 3 }],
          count: 2,
          earliest: { number: 1, seq: 1 },
          blocking: true,
          overdue: false,
        },
      },
    );
    for (const seq of [1, 2, 3]) {
      const archive = option(seq, "Archive through here");
      expect(archive.disabled).toBe(true);
      const hint = document.getElementById(archive.getAttribute("aria-describedby") ?? "");
      expect(hint?.textContent).toMatch(/\b1\b/);
    }
  });

  it("says why archiving failed by the message it started from", async () => {
    await page.openWith([message(1), message(2), message(3)]);
    page.api.on("POST", `${path}/archive`, { status: 502, text: "<h1>Bad gateway</h1>" });
    fireEvent.click(option(2, "Archive through here"));
    const said = await within(messageArticle(2)).findByRole("alert");
    expect(screen.getAllByRole("alert")).toEqual([said]);
  });
});

describe("archived messages", () => {
  const fold = () => screen.getByRole("button", { name: /archived message/ });

  it("unfold when a change of answers reopens a card among them", async () => {
    const sqlite = { declined: false, picks: [0], labels: ["SQLite"] };
    await page.open({
      thread: threadSummary({ last_seq: 3, unread: 0 }),
      messages: [
        message(1, { asks: [ask({ open: false, answer: { seq: 3, ...sqlite } })] }),
        message(2, { text: "Message 2" }),
        operatorMessage(3, { answers: [answerTo(sqlite)] }),
      ],
      archived: 1,
    });
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(option(3, "Change answer"));
    await waitFor(() => expect(document.activeElement).toBe(askCard(1)));
    expect(fold().getAttribute("aria-expanded")).toBe("true");
  });

  it("keep a message the operator writes into an archived thread in view, archived with the rest", async () => {
    const state = await page.open({
      thread: threadSummary({ last_seq: 1, unread: 0, archived: true }),
      messages: [message(1, { text: "Message 1" })],
      archived: 1,
    });
    page.serveWrites(state);
    fireEvent.change(textBox(), { target: { value: "One more thing." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("One more thing.");
    await waitFor(() => expect(fold().textContent).toMatch(/\b1\b/));
    expect(within(messageArticle(2)).getByTitle("Archived")).toBeTruthy();
    const head = screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
    expect(within(head).getByTitle("Archived")).toBeTruthy();
  });

  it("fold into one line at the top, which unfolds them, the page opening below them", async () => {
    const state = {
      thread: threadSummary({ last_seq: 120, unread: 30 }),
      messages: range(1, 120).map((seq) => message(seq, { text: `Message ${seq}` })),
      archived: 100,
    };
    await page.open(state);
    // The first unread message after those archived leads the page.
    expect(shownMessages()).toEqual(range(101, 120));
    expect(unreadCards()[0]).toBe(101);
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
    fireEvent.click(fold());
    expect(shownMessages()).toEqual(range(71, 120));
    fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await screen.findByText("Message 21");
    expect(shownMessages()).toEqual(range(21, 120));
  });

  it("are never read while folded, and are once unfolded", async () => {
    await page.open({
      thread: threadSummary({ last_seq: 3, unread: 2 }),
      messages: [message(1), message(2), message(3)],
      archived: 3,
    });
    expect(shownMessages()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.reads()).toEqual([]);
    fireEvent.click(fold());
    await waitFor(() => expect(page.reads()).toEqual([3]));
    // An archived message is never unread, so none is marked unread.
    expect(unreadCards()).toEqual([]);
  });
});
