import {
  type Message,
  maxAnswers,
  maxMessageDetail,
  maxMessageText,
} from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { otherLabel, quoted } from "../../format.tsx";
import {
  type Ask,
  answerTo,
  ask,
  csrf,
  failure,
  message,
  operatorMessage,
  type Reply,
  renderAt,
  threadSummary,
} from "../../test-support.tsx";
import { goBackChoice } from "./Composer.tsx";
import {
  detailsBox,
  detailsFold,
  openDetails,
  option,
  optionNames,
  path,
  range,
  type State,
  textBox,
  ThreadPageTest,
  written,
} from "./thread-test-support.tsx";

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
});

// openAsks says which asks are open: each by its number, on the message of
// the same sequence unless given as [number, seq].
const openAsks = (...asks: (number | [number, number])[]) => ({
  open_asks: {
    asks: asks.map((each) =>
      typeof each === "number" ? { number: each, seq: each } : { number: each[0], seq: each[1] },
    ),
    count: asks.length,
    blocking: true,
    overdue: false,
  },
});

// card finds an ask's card by the number it leads with.
const card = (number = 1) => screen.getByRole("region", { name: new RegExp(`^Ask ${number}\\b`) });
// choice finds a suggested answer, or Other, on a card: a radio button where
// the ask allows one answer, a checkbox where it allows several.
const choice = (name: RegExp | string, number?: number) =>
  within(card(number)).getByRole<HTMLInputElement>(
    within(card(number)).queryAllByRole("checkbox").length > 0 ? "checkbox" : "radio",
    { name },
  );
const choices = (number?: number) => [
  ...within(card(number)).queryAllByRole<HTMLInputElement>("radio"),
  ...within(card(number)).queryAllByRole<HTMLInputElement>("checkbox"),
];
const sendButton = () =>
  within(screen.getByRole("region", { name: "Reply" })).getByRole<HTMLButtonElement>("button", {
    name: "Send",
  });
// The line above the box naming what Send carries besides the text.
const stagedLine = () => document.querySelector(".staged");
// The answers it names one by one, each with its own Remove.
const stagedAnswers = () => Array.from(document.querySelectorAll(".staged > li"));
// removeAnswer removes the answer to one ask from what Send carries.
const removeAnswer = (number: number) =>
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`\\bask ${number}$`) }));
// The hint that closes a card's answer group while its choices are
// unavailable, saying why.
const heldHint = (group: HTMLElement) =>
  group.querySelector<HTMLElement>(":scope > .hint:last-child");
const describedBy = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id));

// opening opens a thread whose message 1 asks ask 1, open to the operator.
function opening(overrides: Partial<Ask> = {}) {
  return page.openWith([message(1, { asks: [ask(overrides)] })], openAsks(1));
}

const three = {
  multiple: true,
  suggestions: [
    { label: "Fast", description: "" },
    { label: "Cheap", description: "" },
    { label: "Good", description: "" },
  ],
};

async function send(): Promise<Record<string, unknown> | undefined> {
  const before = page.writes().length;
  fireEvent.click(sendButton());
  await waitFor(() => expect(page.writes()).toHaveLength(before + 1));
  return page.bodies().at(-1);
}

describe("Send", () => {
  it("is unavailable until there is something to send, then sends the text", async () => {
    await page.openWith([message(1)]);
    page.api.on("POST", `${path}/messages`, written(2));
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(textBox(), { target: { value: "  " } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(textBox(), { target: { value: "Seen, thanks." } });
    expect(sendButton().disabled).toBe(false);
    expect(await send()).toEqual({
      text: "Seen, thanks.",
      request_id: expect.stringMatching(/^web-/),
      seen_through: 1,
    });
    expect(page.writes()[0]?.headers["x-csrf-token"]).toBe(csrf);
    await screen.findByRole("status");
    expect(textBox().value).toBe("");
    expect(sendButton().disabled).toBe(true);
  });

  it("sends text without an answer while an ask is open, without asking to confirm", async () => {
    await opening();
    page.api.on("POST", `${path}/messages`, written(2));
    fireEvent.change(textBox(), { target: { value: "Looking into it." } });
    expect(await send()).toMatchObject({ text: "Looking into it." });
    expect(page.bodies()[0]).not.toHaveProperty("answers");
  });

  it("ties the server's refusal to the box when it names the text", async () => {
    await page.openWith([message(1)]);
    page.api.on(
      "POST",
      `${path}/messages`,
      failure("invalid_input", "must be at most 1000 characters", { field: "text" }),
    );
    fireEvent.change(textBox(), { target: { value: "x" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(textBox().getAttribute("aria-invalid")).toBe("true"));
    expect(describedBy(textBox()).some((hint) => hint?.classList.contains("field-error"))).toBe(
      true,
    );
  });

  it("labels the box apart while an answer is written beside it", async () => {
    await opening();
    const label = () => textBox().labels?.[0]?.textContent;
    const plain = label();
    fireEvent.click(choice(/^Postgres/));
    expect(label()).not.toBe(plain);
    removeAnswer(1);
    expect(label()).toBe(plain);
  });
});

describe("the Details box", () => {
  // saysWhy says whether a box is marked invalid, with why beside it.
  const saysWhy = (box: HTMLElement) =>
    box.getAttribute("aria-invalid") === "true" &&
    describedBy(box).some((hint) => hint?.classList.contains("field-error"));
  // Four bytes of UTF-8 and two UTF-16 code units each, but one code point.
  const astral = (n: number) => "\u{1F600}".repeat(n);

  it("folds under the message box until opened, and goes with the text as one message", async () => {
    await page.openWith([message(1)]);
    page.api.on("POST", `${path}/messages`, written(2));
    const fold = detailsFold() as HTMLButtonElement;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(textBox().compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(fold);
    expect(document.activeElement).toBe(detailsBox());
    fireEvent.change(textBox(), { target: { value: "Go with SQLite." } });
    fireEvent.change(detailsBox(), { target: { value: "## Why\n\nOne file, no server." } });
    expect(await send()).toEqual({
      text: "Go with SQLite.",
      detail: "## Why\n\nOne file, no server.",
      request_id: expect.stringMatching(/^web-/),
      seen_through: 1,
    });
    await screen.findByRole("status");
    // Sent, the draft empties and the box folds again.
    expect(textBox().value).toBe("");
    expect(detailsFold()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("sends no detail that is blank", async () => {
    await page.openWith([message(1)]);
    page.api.on("POST", `${path}/messages`, written(2));
    fireEvent.change(openDetails(), { target: { value: " \n " } });
    fireEvent.change(textBox(), { target: { value: "Seen." } });
    expect(await send()).not.toHaveProperty("detail");
  });

  it("cuts nothing typed into either box, and holds Send while one is over its bound, saying why there", async () => {
    await page.openWith([message(1)]);
    // Each box counts code points, as the server does.
    fireEvent.change(textBox(), { target: { value: astral(maxMessageText) } });
    expect(sendButton().disabled).toBe(false);
    expect(saysWhy(textBox())).toBe(false);
    const over = astral(maxMessageText + 1);
    fireEvent.change(textBox(), { target: { value: over } });
    expect(textBox().value).toBe(over);
    expect(sendButton().disabled).toBe(true);
    expect(saysWhy(textBox())).toBe(true);
    fireEvent.change(textBox(), { target: { value: "Summary." } });
    fireEvent.change(openDetails(), { target: { value: astral(maxMessageDetail) } });
    expect(sendButton().disabled).toBe(false);
    expect(saysWhy(detailsBox())).toBe(false);
    const overDetail = astral(maxMessageDetail + 1);
    fireEvent.change(detailsBox(), { target: { value: overDetail } });
    expect(detailsBox().value).toBe(overDetail);
    expect(sendButton().disabled).toBe(true);
    expect(saysWhy(detailsBox())).toBe(true);
    expect(saysWhy(textBox())).toBe(false);
    // Neither box sets a length the browser would cut typing or pasting at.
    expect([textBox().maxLength, detailsBox().maxLength]).toEqual([-1, -1]);
  });

  it.each([
    ["alone", () => page.openWith([message(1)])],
    [
      "beside an answer",
      async () => {
        await opening();
        fireEvent.click(choice(/^Postgres/));
      },
    ],
  ])("holds Send while it has detail but no text, %s, saying why there", async (_, start) => {
    await start();
    fireEvent.change(openDetails(), { target: { value: "At length." } });
    expect(sendButton().disabled).toBe(true);
    expect(saysWhy(detailsBox())).toBe(true);
    fireEvent.change(textBox(), { target: { value: " " } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(textBox(), { target: { value: "In short." } });
    expect(sendButton().disabled).toBe(false);
    expect(saysWhy(detailsBox())).toBe(false);
  });

  it("ties the server's refusal to the box when it names the detail", async () => {
    await page.openWith([message(1)]);
    page.api.on(
      "POST",
      `${path}/messages`,
      failure("invalid_input", "must contain a character other than white space", {
        field: "detail",
      }),
    );
    fireEvent.change(textBox(), { target: { value: "x" } });
    fireEvent.change(openDetails(), { target: { value: "y" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(saysWhy(detailsBox())).toBe(true));
    expect(saysWhy(textBox())).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("answering on the card", () => {
  it("answers an ask that allows one with a radio button, the box's text going beside it", async () => {
    await opening();
    page.api.on("POST", `${path}/messages`, written(2));
    expect(within(card()).queryAllByRole("checkbox")).toEqual([]);
    fireEvent.click(choice(/^SQLite/));
    fireEvent.click(choice(/^Postgres/));
    expect(choice(/^Postgres/).checked).toBe(true);
    expect(choice(/^SQLite/).checked).toBe(false);
    expect(stagedLine()).not.toBeNull();
    expect(sendButton().disabled).toBe(false);
    fireEvent.change(textBox(), { target: { value: "Room to grow." } });
    expect(await send()).toEqual({
      text: "Room to grow.",
      answers: [{ ask: 1, picks: [1] }],
      request_id: expect.stringMatching(/^web-/),
      seen_through: 1,
    });
    await screen.findByRole("status");
    expect(stagedLine()).toBeNull();
  });

  it("answers an ask that allows several with checkboxes, Other combining with the picks", async () => {
    await opening(three);
    page.api.on("POST", `${path}/messages`, written(2));
    expect(within(card()).queryAllByRole("radio")).toEqual([]);
    fireEvent.click(choice("Good"));
    fireEvent.click(choice("Fast"));
    fireEvent.click(choice("Other"));
    const words = within(card()).getByRole<HTMLTextAreaElement>("textbox", { name: "Other" });
    // Other chosen without words is an answer started but not complete.
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(words, { target: { value: "And reliable,\nabove all." } });
    expect(words.maxLength).toBe(4_000);
    expect((await send())?.answers).toEqual([
      { ask: 1, picks: [0, 2], text: "And reliable,\nabove all." },
    ]);
    expect(page.bodies()[0]).not.toHaveProperty("text");
  });

  it("names what is staged in the card's terms: the picks and Other, or an answer written", async () => {
    await opening(three);
    fireEvent.click(choice("Cheap"));
    fireEvent.click(choice("Other"));
    fireEvent.change(within(card()).getByRole("textbox", { name: "Other" }), {
      target: { value: "Quietly." },
    });
    expect(stagedLine()?.textContent).toContain(`${quoted(["Cheap"])}, ${otherLabel}`);
    cleanup();
    page = new ThreadPageTest();
    await opening({ suggestions: [] });
    fireEvent.change(within(card()).getByRole("textbox"), { target: { value: "Sessions." } });
    expect(stagedLine()?.textContent).not.toContain(otherLabel);
  });

  it("says own words are missing only once their field is left without them", async () => {
    await opening();
    fireEvent.click(choice("Other"));
    const words = within(card()).getByRole<HTMLTextAreaElement>("textbox", { name: "Other" });
    // Choosing Other moves to its field, to write in.
    expect(document.activeElement).toBe(words);
    expect(words.getAttribute("aria-invalid")).toBeNull();
    fireEvent.blur(words);
    expect(words.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(words)[0]?.classList.contains("field-error")).toBe(true);
    fireEvent.change(words, { target: { value: "Files." } });
    expect(words.getAttribute("aria-invalid")).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it("keeps own words when Other is unchecked, staging nothing only once nothing is left", async () => {
    await opening(three);
    fireEvent.click(choice("Cheap"));
    fireEvent.click(choice("Other"));
    const words = () => within(card()).getByRole<HTMLTextAreaElement>("textbox", { name: "Other" });
    fireEvent.change(words(), { target: { value: "Quietly." } });
    choice("Cheap").focus();
    fireEvent.click(choice("Other"));
    // Unchecking Other leaves focus where it was.
    expect(document.activeElement).toBe(choice("Cheap"));
    fireEvent.click(choice("Cheap"));
    // Nothing is chosen, but the words are kept: the answer stays, not yet sendable.
    expect(stagedLine()).not.toBeNull();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(choice("Other"));
    expect(words().value).toBe("Quietly.");
    fireEvent.change(words(), { target: { value: "" } });
    fireEvent.click(choice("Other"));
    expect(stagedLine()).toBeNull();
  });

  it("clears the card, own words included, when the answer is removed, and returns to the box", async () => {
    await opening(three);
    fireEvent.click(choice("Other"));
    fireEvent.change(within(card()).getByRole("textbox", { name: "Other" }), {
      target: { value: "Quietly." },
    });
    removeAnswer(1);
    expect(stagedLine()).toBeNull();
    expect(document.activeElement).toBe(textBox());
    fireEvent.click(choice("Other"));
    expect(within(card()).getByRole<HTMLTextAreaElement>("textbox", { name: "Other" }).value).toBe(
      "",
    );
  });

  it("ties the server's refusal of the own words to their field", async () => {
    await opening();
    page.api.on(
      "POST",
      `${path}/messages`,
      failure("invalid_input", "must be at most 4000 characters", { field: "answers.0.text" }),
    );
    fireEvent.click(choice("Other"));
    const words = within(card()).getByRole<HTMLTextAreaElement>("textbox", { name: "Other" });
    fireEvent.change(words, { target: { value: "Files." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(words.getAttribute("aria-invalid")).toBe("true"));
    expect(describedBy(words)[0]?.classList.contains("field-error")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops the refusal of own words once the answer it refused changes or goes", async () => {
    await page.openWith(
      [
        message(1, { asks: [ask({ multiple: true })] }),
        message(2, { asks: [ask({ number: 2, question: "And the cache?", suggestions: [] })] }),
      ],
      openAsks(1, 2),
    );
    page.api.on(
      "POST",
      `${path}/messages`,
      failure("invalid_input", "must not hold control characters", { field: "answers.0.text" }),
    );
    const words = () => within(card()).getByRole<HTMLTextAreaElement>("textbox", { name: "Other" });
    const refuse = async () => {
      fireEvent.click(sendButton());
      await waitFor(() => expect(words().getAttribute("aria-invalid")).toBe("true"));
    };
    fireEvent.click(choice("Other"));
    fireEvent.change(words(), { target: { value: "Files." } });
    await refuse();
    // Choosing Other again is a new answer.
    fireEvent.click(choice("Other"));
    fireEvent.click(choice("Other"));
    expect(words().getAttribute("aria-invalid")).toBeNull();
    await refuse();
    // Removed, the refused answer takes its refusal with it.
    removeAnswer(1);
    const cache = within(card(2)).getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(cache, { target: { value: "Files." } });
    expect(cache.getAttribute("aria-invalid")).toBeNull();
  });

  it("answers in the operator's own words with Other, in place of a pick where one is allowed", async () => {
    await opening();
    page.api.on("POST", `${path}/messages`, written(2));
    fireEvent.click(choice(/^SQLite/));
    fireEvent.click(choice("Other"));
    expect(choice(/^SQLite/).checked).toBe(false);
    fireEvent.change(within(card()).getByRole("textbox", { name: "Other" }), {
      target: { value: "Neither; use files." },
    });
    expect((await send())?.answers).toEqual([{ ask: 1, text: "Neither; use files." }]);
  });

  it("answers an ask without suggested answers in a text field alone", async () => {
    await opening({ suggestions: [] });
    page.api.on("POST", `${path}/messages`, written(2));
    expect(choices()).toEqual([]);
    const field = within(card()).getByRole("textbox");
    fireEvent.change(field, { target: { value: "Sessions only." } });
    expect(stagedLine()).not.toBeNull();
    fireEvent.change(field, { target: { value: "" } });
    expect(stagedLine()).toBeNull();
    fireEvent.change(field, { target: { value: " " } });
    expect(stagedLine()).not.toBeNull();
    expect(sendButton().disabled).toBe(true);
    fireEvent.blur(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(field, { target: { value: "Sessions only." } });
    expect((await send())?.answers).toEqual([{ ask: 1, text: "Sessions only." }]);
  });

  it("declines apart from the choices, setting them aside until undone", async () => {
    await opening();
    page.api.on("POST", `${path}/messages`, written(2));
    const decline = () => within(card()).getByRole("button", { name: "Decline to answer" });
    fireEvent.click(choice(/^SQLite/));
    fireEvent.click(decline());
    expect(choices()).toEqual([]);
    // Saying so, and moving focus to the control that undoes it.
    expect(within(card()).getByRole("status")).toBeTruthy();
    const undo = within(card()).getByRole("button", { name: "Undo" });
    expect(document.activeElement).toBe(undo);
    // Undo names what it undoes, so moving to it says so.
    expect(describedBy(undo)).toEqual([within(card()).getByRole("status")]);
    fireEvent.click(undo);
    expect(choice(/^SQLite/).checked).toBe(true);
    expect(document.activeElement).toBe(decline());
    fireEvent.click(decline());
    const body = await send();
    expect(body?.answers).toEqual([{ ask: 1, declined: true }]);
    expect(body).not.toHaveProperty("text");
  });

  it.each([
    ["a pick where the ask allows one", {}, () => fireEvent.click(choice(/^SQLite/))],
    [
      "picks and Other's words where it allows several",
      three,
      () => {
        fireEvent.click(choice("Fast"));
        fireEvent.click(choice("Other"));
        fireEvent.change(within(card()).getByRole("textbox", { name: "Other" }), {
          target: { value: "Quietly." },
        });
      },
    ],
    [
      "a decline",
      {},
      () => {
        fireEvent.click(choice(/^SQLite/));
        fireEvent.click(within(card()).getByRole("button", { name: "Decline to answer" }));
      },
    ],
  ])(
    "clears %s from the card as Remove does, moving focus to the card",
    async (_, shape, answer) => {
      await opening(shape);
      const clear = () => within(card()).queryByRole("button", { name: "Clear" });
      expect(clear()).toBeNull();
      answer();
      expect(stagedLine()).not.toBeNull();
      fireEvent.click(clear() as HTMLElement);
      expect(stagedLine()).toBeNull();
      expect(clear()).toBeNull();
      expect(document.activeElement).toBe(card());
      // The card is as it was before anything was chosen, own words included.
      expect(choices().length).toBeGreaterThan(0);
      expect(choices().some((input) => input.checked)).toBe(false);
      fireEvent.click(choice("Other"));
      expect(
        within(card()).getByRole<HTMLTextAreaElement>("textbox", { name: "Other" }).value,
      ).toBe("");
    },
  );

  it("clears one card, leaving the answers staged on the others", async () => {
    await page.openWith(
      [message(1, { asks: [ask(), ask({ number: 2, question: "And the cache?" })] })],
      openAsks([1, 1], [2, 1]),
    );
    fireEvent.click(choice(/^SQLite/, 1));
    fireEvent.click(choice(/^Postgres/, 2));
    fireEvent.click(within(card(1)).getByRole("button", { name: "Clear" }));
    expect(stagedAnswers()).toHaveLength(1);
    expect(stagedAnswers()[0]?.textContent).toContain("2");
    expect(choice(/^Postgres/, 2).checked).toBe(true);
  });

  it("holds answers on several asks' cards, sending them all with the text as one message", async () => {
    await page.openWith(
      [
        message(1, {
          asks: [ask(), ask({ number: 2, question: "And the cache?" })],
        }),
        message(2, { asks: [ask({ number: 3, question: "Where?", suggestions: [] })] }),
      ],
      openAsks([1, 1], [2, 1], 3),
    );
    page.api.on("POST", `${path}/messages`, written(3));
    fireEvent.change(within(card(3)).getByRole("textbox"), { target: { value: "Close by." } });
    fireEvent.click(choice(/^Postgres/, 1));
    fireEvent.click(within(card(2)).getByRole("button", { name: "Decline to answer" }));
    // Named one by one in ask number order, none holding another.
    expect(stagedAnswers().map((item) => item.textContent)).toEqual([
      expect.stringContaining("1"),
      expect.stringContaining("2"),
      expect.stringContaining("3"),
    ]);
    expect([...choices(1), ...choices(2)].every((input) => !input.disabled)).toBe(true);
    // Removing one clears its card and leaves the others.
    removeAnswer(2);
    expect(stagedAnswers()).toHaveLength(2);
    expect(choices(2).some((input) => input.checked)).toBe(false);
    expect(choices(2).length).toBeGreaterThan(0);
    expect(choice(/^Postgres/, 1).checked).toBe(true);
    fireEvent.change(textBox(), { target: { value: "Both settled." } });
    expect(await send()).toEqual({
      text: "Both settled.",
      answers: [
        { ask: 1, picks: [1] },
        { ask: 3, text: "Close by." },
      ],
      request_id: expect.stringMatching(/^web-/),
      seen_through: 2,
    });
  });

  it("is unavailable to send while any answer staged is incomplete", async () => {
    await page.openWith(
      [message(1, { asks: [ask(), ask({ number: 2 })] })],
      openAsks([1, 1], [2, 1]),
    );
    fireEvent.click(choice(/^SQLite/, 1));
    fireEvent.click(choice("Other", 2));
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(within(card(2)).getByRole("textbox", { name: "Other" }), {
      target: { value: "Files." },
    });
    expect(sendButton().disabled).toBe(false);
  });

  it("holds the other cards once answers fill a message, until one is sent or removed", async () => {
    const numbers = range(1, maxAnswers + 1);
    await page.openWith(
      [message(1, { asks: numbers.map((number) => ask({ number })) })],
      openAsks(...numbers.map((number): [number, number] => [number, 1])),
    );
    for (const number of numbers.slice(0, -1)) {
      fireEvent.click(choice(/^SQLite/, number));
    }
    const last = maxAnswers + 1;
    const group = within(card(last)).getByRole("group");
    expect(choices(last).every((input) => input.disabled)).toBe(true);
    expect(describedBy(group)).toContain(heldHint(group));
    removeAnswer(1);
    expect(choices(last).every((input) => !input.disabled)).toBe(true);
    expect(heldHint(group)).toBeNull();
  });

  it("changes an answer, loading its picks, own words, text and detail, and sends it as a replacement", async () => {
    const answer = { declined: false, picks: [0], labels: ["SQLite"], text: "Also files." };
    await page.openWith([
      message(1, { asks: [ask({ multiple: true, open: false, answer: { seq: 2, ...answer } })] }),
      operatorMessage(2, {
        text: "Small data.",
        detail: "Under a gigabyte a year.",
        answers: [answerTo(answer)],
      }),
    ]);
    // An answered ask shows its answer, and takes no answer until it is changed.
    expect(within(card()).getByText("Also files.")).toBeTruthy();
    expect(choices()).toEqual([]);
    // The answers are changed from the message carrying them, which is not
    // edited as a plain message.
    expect(optionNames(1)).not.toContain("Change answer");
    expect(optionNames(2)).not.toContain("Edit");
    fireEvent.click(option(2, "Change answer"));
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    expect(detailsBox().value).toBe("Under a gigabyte a year.");
    expect(choice(/^SQLite/).checked).toBe(true);
    expect(choice("Other").checked).toBe(true);
    expect(within(card()).getByRole<HTMLTextAreaElement>("textbox", { name: "Other" }).value).toBe(
      "Also files.",
    );
    fireEvent.click(choice(/^SQLite/));
    fireEvent.click(choice(/^Postgres/));
    page.api.on("POST", `${path}/messages`, written(3));
    expect(await send()).toMatchObject({
      text: "Small data.",
      detail: "Under a gigabyte a year.",
      answers: [{ ask: 1, picks: [1], text: "Also files." }],
      replaces: 2,
    });
    await waitFor(() => expect(textBox().value).toBe(""));
  });

  it("changes every answer a message carries at once, holding the other cards, and removes them whole", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    await page.openWith(
      [
        message(1, {
          asks: [
            ask({ open: false, answer: { seq: 2, declined: false, ...sqlite } }),
            ask({ number: 2, open: false, answer: { seq: 2, declined: true } }),
          ],
        }),
        operatorMessage(2, {
          answers: [answerTo(sqlite), answerTo({ ask: 2, declined: true })],
        }),
        message(3, { asks: [ask({ number: 3 })] }),
      ],
      openAsks(3),
    );
    fireEvent.click(option(2, "Change answer"));
    await waitFor(() => expect(choice(/^SQLite/, 1).checked).toBe(true));
    // Focus moves to the first card turned back into choices, in an effect.
    await waitFor(() => expect(document.activeElement).toBe(card(1)));
    expect(within(card(2)).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(choices(3).every((input) => input.disabled)).toBe(true);
    // The change goes whole: one Remove, and no answer removed apart, nor
    // cleared from its card.
    expect(stagedAnswers()).toEqual([]);
    expect(within(stagedLine() as HTMLElement).getAllByRole("button")).toHaveLength(1);
    for (const number of [1, 2]) {
      expect(within(card(number)).queryByRole("button", { name: "Clear" })).toBeNull();
    }
    fireEvent.click(within(card(2)).getByRole("button", { name: "Undo" }));
    fireEvent.click(choice(/^Postgres/, 2));
    page.api.on("POST", `${path}/messages`, written(4));
    expect(await send()).toMatchObject({
      answers: [
        { ask: 1, picks: [0] },
        { ask: 2, picks: [1] },
      ],
      replaces: 2,
    });
  });

  it("changes the answers to live asks only, the others staying with the message, and says so", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    await page.openWith([
      message(1, { asks: [ask({ open: false, answer: { seq: 3, declined: false, ...sqlite } })] }),
      message(2, { live: false, replaced_by: 4, asks: [ask({ number: 2, open: false })] }),
      operatorMessage(3, {
        text: "Small data.",
        answers: [
          answerTo(sqlite),
          answerTo({ ask: 2, ask_seq: 2, declined: true, ask_live: false }),
        ],
      }),
      message(4, { replaces: 2, asks: [ask({ number: 3 })] }),
    ]);
    fireEvent.click(option(3, "Change answer"));
    await waitFor(() => expect(choice(/^SQLite/, 1).checked).toBe(true));
    expect(stagedLine()?.querySelector(".dropped")).not.toBeNull();
    fireEvent.click(choice(/^Postgres/, 1));
    page.api.on("POST", `${path}/messages`, written(5));
    const body = await send();
    expect(body).toMatchObject({
      text: "Small data.",
      answers: [{ ask: 1, picks: [1] }],
      replaces: 3,
    });
  });

  it("edits a message whose every answered ask died, as its text alone, which it needs", async () => {
    await page.openWith([
      message(1, { live: false, replaced_by: 3, asks: [ask({ open: false })] }),
      operatorMessage(2, {
        text: "Small data.",
        answers: [answerTo({ declined: true, ask_live: false })],
      }),
      message(3, { replaces: 1 }),
    ]);
    expect(optionNames(2)).not.toContain("Change answer");
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    fireEvent.change(textBox(), { target: { value: " " } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(textBox(), { target: { value: "Small data, after all." } });
    page.api.on("POST", `${path}/messages`, written(4));
    const body = await send();
    expect(body).toMatchObject({ text: "Small data, after all.", replaces: 2 });
    expect(body).not.toHaveProperty("answers");
  });

  it("keeps a changed answer staged with every choice taken back, unavailable to send until removed", async () => {
    const both = { declined: false, picks: [0, 1], labels: ["SQLite", "Postgres"] };
    await page.openWith([
      message(1, { asks: [ask({ multiple: true, open: false, answer: { seq: 2, ...both } })] }),
      operatorMessage(2, { text: "Both.", answers: [answerTo(both)] }),
    ]);
    fireEvent.click(option(2, "Change answer"));
    await waitFor(() => expect(textBox().value).toBe("Both."));
    fireEvent.click(choice(/^SQLite/));
    fireEvent.click(choice(/^Postgres/));
    expect(stagedLine()).not.toBeNull();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(stagedLine()).toBeNull();
    expect(textBox().value).toBe("");
    expect(option(2, "Change answer")).toHaveProperty("disabled", false);
  });

  it("keeps a changed answer staged with its own words cleared, unavailable to send", async () => {
    const answer = { declined: false, text: "Sessions only." };
    await page.openWith([
      message(1, { asks: [ask({ suggestions: [], open: false, answer: { seq: 2, ...answer } })] }),
      operatorMessage(2, { answers: [answerTo(answer)] }),
    ]);
    fireEvent.click(option(2, "Change answer"));
    const field = await within(card()).findByRole<HTMLTextAreaElement>("textbox");
    await waitFor(() => expect(field.value).toBe("Sessions only."));
    fireEvent.change(field, { target: { value: "" } });
    expect(stagedLine()).not.toBeNull();
    expect(sendButton().disabled).toBe(true);
    fireEvent.blur(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("editing", () => {
  const thread = () =>
    page.openWith([message(1), operatorMessage(2, { text: "Use SQLite." }), message(3)]);

  const edit = () => option(2, "Edit");

  it("stages a replacement of the operator's message with its text loaded", async () => {
    await thread();
    expect(optionNames(1)).not.toContain("Edit");
    fireEvent.click(edit());
    await waitFor(() => expect(textBox().value).toBe("Use SQLite."));
    expect(stagedLine()).not.toBeNull();
    fireEvent.change(textBox(), { target: { value: "Use SQLite for now." } });
    page.api.on("POST", `${path}/messages`, written(4));
    expect(await send()).toMatchObject({ text: "Use SQLite for now.", replaces: 2 });
    await waitFor(() => expect(textBox().value).toBe(""));
  });

  it("never sends a replacement without text, which would retract the message", async () => {
    await thread();
    fireEvent.click(edit());
    await waitFor(() => expect(textBox().value).toBe("Use SQLite."));
    fireEvent.change(textBox(), { target: { value: " " } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(sendButton());
    expect(page.writes()).toEqual([]);
  });

  it("is unavailable while the composer holds a draft, saying why", async () => {
    await thread();
    fireEvent.change(textBox(), { target: { value: "My draft." } });
    expect(edit()).toHaveProperty("disabled", true);
    expect(describedBy(edit())[0]).not.toBeNull();
    fireEvent.change(textBox(), { target: { value: "" } });
    expect(edit()).toHaveProperty("disabled", false);
    expect(edit().getAttribute("aria-describedby")).toBeNull();
    // Details alone are a draft too.
    fireEvent.change(openDetails(), { target: { value: "At length." } });
    expect(edit()).toHaveProperty("disabled", true);
  });

  it("loads the message's detail with its text, and sends the replacement with both", async () => {
    await page.openWith([
      message(1),
      operatorMessage(2, { text: "Use SQLite.", detail: "One file, no server." }),
      message(3),
    ]);
    expect(detailsFold()).not.toBeNull();
    fireEvent.click(edit());
    await waitFor(() => expect(textBox().value).toBe("Use SQLite."));
    expect(detailsBox().value).toBe("One file, no server.");
    fireEvent.change(detailsBox(), { target: { value: "One file." } });
    page.api.on("POST", `${path}/messages`, written(4));
    expect(await send()).toMatchObject({ text: "Use SQLite.", detail: "One file.", replaces: 2 });
    await waitFor(() => expect(textBox().value).toBe(""));
    expect(detailsFold()).not.toBeNull();
  });

  it("keeps the Details box, and focus in it, when the detail it loaded is emptied", async () => {
    await page.openWith([
      message(1),
      operatorMessage(2, { text: "Use SQLite.", detail: "One file, no server." }),
      message(3),
    ]);
    fireEvent.click(edit());
    await waitFor(() => expect(detailsBox().value).toBe("One file, no server."));
    const box = detailsBox();
    box.focus();
    fireEvent.change(box, { target: { value: "" } });
    expect(detailsBox()).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(detailsFold()).toBeNull();
  });

  it("sends a replacement without the detail emptied from its box, which drops it", async () => {
    await page.openWith([
      message(1),
      operatorMessage(2, { text: "Use SQLite.", detail: "One file, no server." }),
      message(3),
    ]);
    fireEvent.click(edit());
    await waitFor(() => expect(detailsBox().value).toBe("One file, no server."));
    fireEvent.change(detailsBox(), { target: { value: "" } });
    page.api.on("POST", `${path}/messages`, written(4));
    const body = await send();
    expect(body).toMatchObject({ text: "Use SQLite.", replaces: 2 });
    expect(body).not.toHaveProperty("detail");
  });

  it("clears the detail it loaded when removed, folding the box again", async () => {
    await page.openWith([
      message(1),
      operatorMessage(2, { text: "Use SQLite.", detail: "One file, no server." }),
      message(3),
    ]);
    fireEvent.click(edit());
    await waitFor(() => expect(detailsBox().value).toBe("One file, no server."));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(textBox().value).toBe("");
    expect(detailsFold()?.getAttribute("aria-expanded")).toBe("false");
    expect(edit()).toHaveProperty("disabled", false);
  });

  it("holds the composer until sent or removed, and removing it clears what it loaded", async () => {
    await page.openWith(
      [operatorMessage(1, { text: "Use SQLite." }), message(2, { asks: [ask()] })],
      openAsks([1, 2]),
    );
    fireEvent.click(option(1, "Edit"));
    await waitFor(() => expect(textBox().value).toBe("Use SQLite."));
    expect(choices().every((input) => input.disabled)).toBe(true);
    expect(
      within(card()).getByRole<HTMLButtonElement>("button", { name: "Decline to answer" }).disabled,
    ).toBe(true);
    const group = within(card()).getByRole("group");
    expect(describedBy(group)).toContain(heldHint(group));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(textBox().value).toBe("");
    expect(stagedLine()).toBeNull();
    expect(choices().every((input) => !input.disabled)).toBe(true);
  });

  // The ask is on message 1, before the opening page, which starts at the
  // first unread message, 2; the answer is on the page, on message 3.
  const declined = { declined: true };
  const beforeThePage = (open: Message) => [
    message(1, { asks: [ask({ open: false, answer: { seq: 3, ...declined } })] }),
    message(2),
    operatorMessage(3, { text: "Not now.", answers: [answerTo(declined)] }),
    ...range(4, 49).map((seq) => message(seq)),
    open,
    ...range(51, 60).map((seq) => message(seq)),
  ];

  // holdAsks holds the load of the message at seq, an ask's off the page,
  // until the test lets it arrive.
  function holdAsks(state: State, seq: number): () => void {
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    page.api.on("GET", path, async (call) => {
      if (call.url.searchParams.get("after") === String(seq - 1)) {
        await arrived;
      }
      return page.threadReply(state, call);
    });
    return arrive;
  }

  // changingWhileStale starts a change of the answers message 3 carries
  // while a message is under way, the box emptied after it, and gives a way
  // to answer that write as stale, with the missed messages landed, and to
  // let the asks arrive; later writes land.
  async function changingWhileStale(state: State): Promise<{
    stale: (missed: Message[]) => Promise<void>;
    arrive: () => void;
  }> {
    const arrive = holdAsks(state, 1);
    let answer: (reply: Reply) => void = () => {};
    page.api.on("POST", `${path}/messages`, () =>
      page.writes().length === 1
        ? new Promise<Reply>((resolve) => (answer = resolve))
        : written(state.thread.last_seq + 1),
    );
    fireEvent.change(textBox(), { target: { value: "One more thing." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.change(textBox(), { target: { value: "" } });
    fireEvent.click(option(3, "Change answer"));
    await waitFor(() => expect(textBox()).toHaveProperty("disabled", true));
    const stale = async (missed: Message[]) => {
      const replaced = new Map(missed.map((each) => [each.replaces, each.seq]));
      state.thread = { ...state.thread, last_seq: missed.at(-1)?.seq ?? state.thread.last_seq };
      state.messages = [
        ...state.messages.map((each) =>
          replaced.has(each.seq)
            ? { ...each, live: false, replaced_by: replaced.get(each.seq) }
            : each,
        ),
        ...missed,
      ];
      answer(failure("stale", "other messages landed after the latest one you saw", { missed }));
      await screen.findByRole("alert");
    };
    return { stale, arrive };
  }

  it("holds the composer, Change answer and the other asks while the asks it changes load", async () => {
    const state = await page.openWith(
      beforeThePage(message(50, { asks: [ask({ number: 2, question: "And the cache?" })] })),
      { unread: 59, ...openAsks([2, 50]) },
    );
    const arrive = holdAsks(state, 1);
    fireEvent.click(option(3, "Change answer"));
    await waitFor(() => expect(textBox()).toHaveProperty("disabled", true));
    expect(sendButton()).toHaveProperty("disabled", true);
    expect(option(3, "Change answer")).toHaveProperty("disabled", true);
    expect(choices(2).every((input) => input.disabled)).toBe(true);
    arrive();
    await waitFor(() => expect(textBox().value).toBe("Not now."));
    expect(textBox()).toHaveProperty("disabled", false);
    // The page shows the changed ask's card, and moves focus to it.
    await waitFor(() => expect(document.activeElement).toBe(card(1)));
    expect(within(card(1)).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("stages nothing when the asks it changes fail to load, and says so", async () => {
    const state = await page.openWith(beforeThePage(message(50)), { unread: 59 });
    page.api.on("GET", path, (call) =>
      call.url.searchParams.get("after") === "0"
        ? failure("internal", "internal error")
        : page.threadReply(state, call),
    );
    fireEvent.click(option(3, "Change answer"));
    await screen.findByRole("alert");
    expect(stagedLine()).toBeNull();
    expect(textBox().value).toBe("");
  });

  it("stages nothing when a stale write learns, while the asks it changes load, that the message was replaced", async () => {
    const state = await page.openWith(beforeThePage(message(50)), { unread: 59 });
    const { stale, arrive } = await changingWhileStale(state);
    // Another device replaced message 3 meanwhile.
    await stale([operatorMessage(61, { replaces: 3, answers: [answerTo({ picks: [0] })] })]);
    arrive();
    await waitFor(() => expect(textBox()).toHaveProperty("disabled", false));
    expect(stagedLine()).toBeNull();
    expect(textBox().value).toBe("");
  });

  it("stages nothing when a refresh shows, while the asks it changes load, that the message was replaced", async () => {
    // The thread is read to its end, so the page shows its latest messages:
    // the ask is on message 5, off the page, and the answer on message 15.
    const sqlite = { picks: [0], labels: ["SQLite"] };
    const state = await page.openWith(
      [
        ...range(1, 4).map((seq) => message(seq)),
        message(5, {
          asks: [ask({ open: false, answer: { seq: 15, declined: false, ...sqlite } })],
        }),
        ...range(6, 14).map((seq) => message(seq)),
        operatorMessage(15, {
          text: "Small data.",
          answers: [answerTo({ ask_seq: 5, ...sqlite })],
        }),
        ...range(16, 60).map((seq) => message(seq)),
      ],
      { unread: 0 },
    );
    const arrive = holdAsks(state, 5);
    fireEvent.click(option(15, "Change answer"));
    await waitFor(() => expect(textBox()).toHaveProperty("disabled", true));
    // Another device replaced message 15 meanwhile, which a refresh shows.
    state.thread = { ...state.thread, last_seq: 61 };
    state.messages = [
      ...state.messages.map((each) =>
        each.seq === 15 ? { ...each, live: false, replaced_by: 61 } : each,
      ),
      operatorMessage(61, { text: "Elsewhere.", replaces: 15 }),
    ];
    fireEvent.focus(window);
    await screen.findByText("Elsewhere.");
    arrive();
    await waitFor(() => expect(textBox()).toHaveProperty("disabled", false));
    expect(stagedLine()).toBeNull();
    expect(textBox().value).toBe("");
  });

  it("stages nothing when a refresh shows, while the asks it changes load, the message replaced by one beyond the page", async () => {
    const state = await page.openWith(beforeThePage(message(50)), { unread: 59 });
    const arrive = holdAsks(state, 1);
    fireEvent.click(option(3, "Change answer"));
    await waitFor(() => expect(textBox()).toHaveProperty("disabled", true));
    // Another device replaced message 3 with 61, which the page, showing 2
    // to 51, learns only from message 3 itself.
    state.thread = { ...state.thread, last_seq: 61 };
    state.messages = [
      ...state.messages.map((each) =>
        each.seq === 3 ? { ...each, live: false, replaced_by: 61 } : each,
      ),
      operatorMessage(61, { text: "Elsewhere.", replaces: 3 }),
    ];
    fireEvent.focus(window);
    await waitFor(() =>
      expect(document.getElementById("message-3")?.classList.contains("replaced")).toBe(true),
    );
    arrive();
    await waitFor(() => expect(textBox()).toHaveProperty("disabled", false));
    expect(stagedLine()).toBeNull();
    expect(textBox().value).toBe("");
  });

  it.each([
    ["loaded off the page", 1, 2],
    ["shown on the page by a refresh", 2, 1],
  ])(
    "stages a change without the answer to an ask whose message, %s, was revised beyond the page while the asks load",
    async (_, revised, kept) => {
      const sqlite = { picks: [0], labels: ["SQLite"] };
      // Ask 1 is on message 1, before the page; ask 2 on message 2, on it.
      const state = await page.openWith(
        [
          message(1, {
            asks: [ask({ open: false, answer: { seq: 3, declined: false, ...sqlite } })],
          }),
          message(2, {
            asks: [ask({ number: 2, open: false, answer: { seq: 3, declined: false, ...sqlite } })],
          }),
          operatorMessage(3, {
            text: "Small data.",
            answers: [answerTo(sqlite), answerTo({ ask: 2, ask_seq: 2, ...sqlite })],
          }),
          ...range(4, 60).map((seq) => message(seq)),
        ],
        { unread: 59 },
      );
      const arrive = holdAsks(state, 1);
      page.api.on("POST", `${path}/messages`, written(62));
      fireEvent.click(option(3, "Change answer"));
      await waitFor(() => expect(textBox()).toHaveProperty("disabled", true));
      // The agent revised the ask's message with 61, beyond the page.
      state.thread = { ...state.thread, last_seq: 61 };
      state.messages = [
        ...state.messages.map((each) =>
          each.seq === revised ? { ...each, live: false, replaced_by: 61 } : each,
        ),
        message(61, { replaces: revised, asks: [ask({ number: 3 })] }),
      ];
      if (revised === 2) {
        fireEvent.focus(window);
        await waitFor(() =>
          expect(document.getElementById("message-2")?.classList.contains("replaced")).toBe(true),
        );
      }
      arrive();
      await waitFor(() => expect(textBox().value).toBe("Small data."));
      expect(stagedLine()?.querySelector(".dropped")).not.toBeNull();
      expect(await send()).toMatchObject({ answers: [{ ask: kept, picks: [0] }], replaces: 3 });
      expect(page.bodies()[0]?.answers).toHaveLength(1);
    },
  );

  it("stages a change without the answer to an ask a stale write learns was revised while the asks load", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    // Ask 1 is on message 1, before the page; ask 2 on message 2, on it.
    const state = await page.openWith(
      [
        message(1, {
          asks: [ask({ open: false, answer: { seq: 3, declined: false, ...sqlite } })],
        }),
        message(2, {
          asks: [ask({ number: 2, open: false, answer: { seq: 3, declined: false, ...sqlite } })],
        }),
        operatorMessage(3, {
          text: "Small data.",
          answers: [answerTo(sqlite), answerTo({ ask: 2, ask_seq: 2, ...sqlite })],
        }),
        ...range(4, 60).map((seq) => message(seq)),
      ],
      { unread: 59 },
    );
    const { stale, arrive } = await changingWhileStale(state);
    // The agent revised ask 1 meanwhile.
    await stale([message(61, { replaces: 1, asks: [ask({ number: 3 })] })]);
    arrive();
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    // Ask 1's answer stays with message 3, and focus moves to ask 2's card.
    expect(stagedLine()?.querySelector(".dropped")).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(card(2)));
    // The change is what the draft now holds, so it goes once they are read.
    fireEvent.click(screen.getByRole("button", { name: "Mark these read and send again" }));
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({
      answers: [{ ask: 2, picks: [0] }],
      replaces: 3,
      seen_through: 61,
    });
    expect(page.bodies()[1]?.answers).toHaveLength(1);
  });

  it("stages an edit when a stale write learns, while the asks load, that every ask the change answers was revised", async () => {
    const state = await page.openWith(beforeThePage(message(50)), { unread: 59 });
    const { stale, arrive } = await changingWhileStale(state);
    // The agent revised ask 1, the only one message 3 answers, meanwhile.
    await stale([message(61, { replaces: 1, asks: [ask({ number: 2 })] })]);
    arrive();
    await waitFor(() => expect(textBox().value).toBe("Not now."));
    expect(stagedLine()).not.toBeNull();
    expect(stagedAnswers()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Mark these read and send again" }));
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({ text: "Not now.", replaces: 3, seen_through: 61 });
    expect(page.bodies()[1]).not.toHaveProperty("answers");
  });
});

describe("retries", () => {
  it("retry a write whose answer was lost with the same request id, and a changed one with a new id", async () => {
    await page.openWith([message(1)]);
    let attempts = 0;
    page.api.on("POST", `${path}/messages`, () =>
      attempts++ < 2 ? { status: 502, text: "<h1>Bad gateway</h1>" } : written(2),
    );
    fireEvent.change(textBox(), { target: { value: "Answer" } });
    fireEvent.click(sendButton());
    await screen.findByRole("alert");
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    fireEvent.change(textBox(), { target: { value: "Answer, revised" } });
    fireEvent.click(sendButton());
    await screen.findByRole("status");
    const ids = page.bodies().map((body) => body.request_id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it("give a retry a new request id once the thread shows messages the attempt had not seen", async () => {
    const state = await page.openWith([message(1)]);
    let attempts = 0;
    page.api.on("POST", `${path}/messages`, () =>
      attempts++ === 0 ? { status: 502, text: "<h1>Bad gateway</h1>" } : written(3),
    );
    fireEvent.change(textBox(), { target: { value: "Answer" } });
    fireEvent.click(sendButton());
    await screen.findByRole("alert");
    state.thread = { ...state.thread, last_seq: 2, unread: 1 };
    state.messages = [...state.messages, message(2, { text: "Agent note" })];
    fireEvent.focus(window);
    await screen.findByText("Agent note");
    fireEvent.click(sendButton());
    await screen.findByRole("status");
    const [first, second] = page.bodies();
    expect(second?.request_id).not.toBe(first?.request_id);
    // The draft was still started before the agent's note.
    expect(second?.seen_through).toBe(1);
  });

  it("keep what was typed while a write was under way", async () => {
    await page.openWith([message(1)]);
    let answer: (reply: Reply) => void = () => {};
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise<Reply>((resolve) => (answer = resolve)),
    );
    fireEvent.change(textBox(), { target: { value: "First." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.change(textBox(), { target: { value: "First. And second." } });
    answer(written(2));
    await screen.findByRole("status");
    expect(textBox().value).toBe("First. And second.");
  });

  it("keep a detail typed while a write was under way, in its box still shown", async () => {
    await page.openWith([message(1)]);
    let answer: (reply: Reply) => void = () => {};
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise<Reply>((resolve) => (answer = resolve)),
    );
    fireEvent.change(textBox(), { target: { value: "First." } });
    fireEvent.change(openDetails(), { target: { value: "At length." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.change(detailsBox(), { target: { value: "At length, and more." } });
    answer(written(2));
    await screen.findByRole("status");
    expect(textBox().value).toBe("");
    expect(detailsBox().value).toBe("At length, and more.");
  });
});

describe("a write that lands", () => {
  // holdingFirst holds the first write until the test answers it, and
  // answers a later one as landed at seq next.
  function holdingFirst(next: number): (reply: Reply) => void {
    let answer: (reply: Reply) => void = () => {};
    page.api.on("POST", `${path}/messages`, () =>
      page.writes().length === 1
        ? new Promise<Reply>((resolve) => (answer = resolve))
        : written(next),
    );
    return (reply) => answer(reply);
  }

  it("drops a change of answers picked again while it was under way", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    await page.openWith([
      message(1, { asks: [ask({ open: false, answer: { seq: 2, declined: false, ...sqlite } })] }),
      operatorMessage(2, { text: "Small data.", answers: [answerTo(sqlite)] }),
    ]);
    const land = holdingFirst(4);
    fireEvent.click(option(2, "Change answer"));
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.click(choice(/^Postgres/));
    land(written(3));
    await screen.findByRole("status");
    expect(stagedLine()).toBeNull();
    fireEvent.change(textBox(), { target: { value: "One more thing." } });
    expect(await send()).not.toHaveProperty("replaces");
  });

  it("drops the answers to the asks it answered, keeping one staged while it was under way", async () => {
    await page.openWith(
      [message(1, { asks: [ask(), ask({ number: 2 })] })],
      openAsks([1, 1], [2, 1]),
    );
    const land = holdingFirst(3);
    fireEvent.click(choice(/^SQLite/, 1));
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.click(choice(/^Postgres/, 1));
    fireEvent.click(choice(/^Postgres/, 2));
    land(written(2));
    await screen.findByRole("status");
    expect(stagedAnswers()).toHaveLength(1);
    expect((await send())?.answers).toEqual([{ ask: 2, picks: [1] }]);
  });

  it("keeps an edit of another message staged while it was under way", async () => {
    await page.openWith([
      operatorMessage(1, { text: "First" }),
      operatorMessage(2, { text: "Second" }),
    ]);
    const land = holdingFirst(4);
    fireEvent.click(option(1, "Edit"));
    fireEvent.change(textBox(), { target: { value: "First, edited." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.click(
      within(screen.getByRole("region", { name: "Reply" })).getByRole("button", { name: "Remove" }),
    );
    fireEvent.click(option(2, "Edit"));
    fireEvent.change(textBox(), { target: { value: "Second, edited." } });
    land(written(3));
    await screen.findByRole("status");
    expect(await send()).toMatchObject({ text: "Second, edited.", replaces: 2 });
  });

  it("keeps a change of answers staged as the write lands, before the page shows it", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    await page.openWith([
      message(1, { asks: [ask({ open: false, answer: { seq: 2, declined: false, ...sqlite } })] }),
      operatorMessage(2, { text: "Small data.", answers: [answerTo(sqlite)] }),
      operatorMessage(3, { text: "Third" }),
    ]);
    const land = holdingFirst(5);
    fireEvent.click(option(3, "Edit"));
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.click(
      within(screen.getByRole("region", { name: "Reply" })).getByRole("button", { name: "Remove" }),
    );
    // The change loads after a wait of its own, so the write's answer comes
    // before the page shows what it staged.
    fireEvent.click(option(2, "Change answer"));
    land(written(4));
    await screen.findByRole("status");
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    expect(stagedLine()).not.toBeNull();
    expect(await send()).toMatchObject({ text: "Small data.", replaces: 2 });
  });
});

describe("the draft's starting point", () => {
  it("ends when the composer is emptied, so a message seen since is not missed", async () => {
    const state = await page.openWith([message(1)]);
    page.serveWrites(state);
    fireEvent.change(textBox(), { target: { value: "Thinking" } });
    fireEvent.change(textBox(), { target: { value: "" } });
    state.thread = { ...state.thread, last_seq: 2, unread: 1 };
    state.messages = [...state.messages, message(2, { text: "Agent note" })];
    fireEvent.focus(window);
    await screen.findByText("Agent note");
    fireEvent.change(textBox(), { target: { value: "Noted." } });
    expect(await send()).toMatchObject({ text: "Noted.", seen_through: 2 });
  });

  it("starts again from the operator's own message once a write lands, the log having shown it first", async () => {
    const state = await page.openWith([message(1)]);
    // The write lands at once, and its answer is held while the log shows it.
    let answer: (reply: Reply) => void = () => {};
    page.api.on("POST", `${path}/messages`, () => {
      state.thread = { ...state.thread, last_seq: 2 };
      state.messages = [...state.messages, operatorMessage(2, { text: "Sent first." })];
      return new Promise<Reply>((resolve) => (answer = resolve));
    });
    fireEvent.change(textBox(), { target: { value: "First." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.change(textBox(), { target: { value: "First. And second." } });
    fireEvent.focus(window);
    await screen.findByText("Sent first.");
    answer(written(2));
    await screen.findByRole("status");
    state.thread = { ...state.thread, last_seq: 3, unread: 1 };
    state.messages = [...state.messages, message(3, { text: "Agent note" })];
    fireEvent.focus(window);
    await screen.findByText("Agent note");
    page.serveWrites(state);
    // The agent's note landed while the second draft was under way, so it
    // was missed.
    expect(await send()).toMatchObject({ text: "First. And second.", seen_through: 2 });
  });

  it.each([
    ["typed after the write lands", false],
    ["typed again before the write lands", true],
  ])(
    "ends with a composer emptied while a write was under way, so a draft %s misses nothing shown",
    async (_, before) => {
      const state = await page.openWith([message(1)]);
      // The write lands at once, and its answer is held while the log shows
      // it and an agent's note after it.
      let answer: (reply: Reply) => void = () => {};
      page.api.on("POST", `${path}/messages`, () => {
        state.thread = { ...state.thread, last_seq: 3, unread: 1 };
        state.messages = [
          ...state.messages,
          operatorMessage(2, { text: "Sent first." }),
          message(3, { text: "Agent note" }),
        ];
        return new Promise<Reply>((resolve) => (answer = resolve));
      });
      fireEvent.change(textBox(), { target: { value: "First." } });
      fireEvent.click(sendButton());
      await waitFor(() => expect(page.writes()).toHaveLength(1));
      fireEvent.change(textBox(), { target: { value: "" } });
      fireEvent.focus(window);
      await screen.findByText("Agent note");
      if (before) {
        fireEvent.change(textBox(), { target: { value: "Noted." } });
      }
      answer(written(2));
      await screen.findByRole("status");
      fireEvent.change(textBox(), { target: { value: "Noted." } });
      page.serveWrites(state);
      expect(await send()).toMatchObject({ text: "Noted.", seen_through: 3 });
    },
  );
});

describe("a stale write", () => {
  // landing answers the first write as stale, the agent having written the
  // missed messages first, and later writes as landed.
  function landing(state: State, missed: Message[]) {
    page.api.on("POST", `${path}/messages`, (call) => {
      if (
        (call.body as { seen_through: number }).seen_through <
          state.thread.last_seq + missed.length &&
        missed.length > 0
      ) {
        const last = missed.at(-1)?.seq ?? state.thread.last_seq;
        state.thread = {
          ...state.thread,
          last_seq: last,
          unread: last - state.thread.last_seq,
          open_asks: { ...state.thread.open_asks, asks: [] },
        };
        state.messages = [...state.messages, ...missed];
        const shown = missed;
        missed = [];
        return failure("stale", "other messages landed after the latest one you saw", {
          missed: shown,
        });
      }
      return written(state.thread.last_seq + 1);
    });
  }

  const staleNotice = () => screen.findByRole("alert");

  it("keeps the draft, shows what was missed, and sends again after reading it", async () => {
    const state = await page.openWith([message(1)]);
    landing(state, [message(2, { text: "I changed my mind about the timeline." })]);
    fireEvent.change(textBox(), { target: { value: "Go ahead." } });
    fireEvent.change(openDetails(), { target: { value: "Ship it on Friday." } });
    fireEvent.click(sendButton());
    const panel = await staleNotice();
    expect(within(panel).getByText("I changed my mind about the timeline.")).toBeTruthy();
    expect(textBox().value).toBe("Go ahead.");
    expect(detailsBox().value).toBe("Ship it on Friday.");
    // The missed messages come above the draft.
    expect(
      panel.compareDocumentPosition(textBox()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Mark these read and send again" }));
    await screen.findByRole("status");
    expect(page.reads()).toContain(2);
    const [first, second] = page.bodies();
    expect(first).toMatchObject({ text: "Go ahead.", detail: "Ship it on Friday." });
    // The stale write was recorded nowhere, so its resend keeps its request id.
    expect(second).toEqual({ ...first, seen_through: 2 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends the draft as it stands when sent again, with what changed since", async () => {
    const state = await opening();
    landing(state, [message(2, { text: "Any news?" })]);
    state.thread = { ...state.thread, ...openAsks(1) };
    fireEvent.change(textBox(), { target: { value: "Looking." } });
    fireEvent.click(sendButton());
    const panel = await staleNotice();
    fireEvent.change(textBox(), { target: { value: "Looking; Postgres it is." } });
    fireEvent.click(choice(/^Postgres/));
    fireEvent.click(within(panel).getByRole("button", { name: "Mark these read and send again" }));
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({
      text: "Looking; Postgres it is.",
      answers: [{ ask: 1, picks: [1] }],
      seen_through: 2,
    });
  });

  it.each([
    ["answered", [operatorMessage(2, { answers: [answerTo({ declined: true })] })]],
    ["revised", [message(2, { replaces: 1, asks: [ask({ number: 2 })] })]],
    ["withdrawn", [message(2, { withdrawals: [{ ask: 1, reason: "Settled elsewhere." }] })]],
  ])(
    "drops an answer to an ask %s meanwhile, clearing its card, keeping the text, and sends nothing",
    async (_, missed) => {
      const state = await opening();
      landing(state, missed);
      fireEvent.click(choice(/^SQLite/));
      fireEvent.change(textBox(), { target: { value: "Small data." } });
      fireEvent.click(sendButton());
      const panel = await staleNotice();
      expect(within(panel).queryByRole("button", { name: /send again/ })).toBeNull();
      expect(stagedLine()).toBeNull();
      expect(choice(/^SQLite/).checked).toBe(false);
      expect(textBox().value).toBe("Small data.");
      fireEvent.click(within(panel).getByRole("button", { name: "Mark these read" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(page.writes()).toHaveLength(1);
      expect(page.reads().at(-1)).toBe(2);
      // What is left of the draft can still go, as a message.
      fireEvent.click(sendButton());
      await screen.findByRole("status");
      expect(page.bodies()[1]).toMatchObject({ text: "Small data.", seen_through: 2 });
      expect(page.bodies()[1]).not.toHaveProperty("answers");
    },
  );

  it("drops only the answers whose asks were answered meanwhile, and keeps the rest", async () => {
    const state = await page.openWith(
      [message(1, { asks: [ask(), ask({ number: 2 })] })],
      openAsks([1, 1], [2, 1]),
    );
    landing(state, [operatorMessage(2, { answers: [answerTo({ declined: true })] })]);
    fireEvent.click(choice(/^SQLite/, 1));
    fireEvent.click(choice(/^Postgres/, 2));
    fireEvent.click(sendButton());
    const panel = await staleNotice();
    expect(within(panel).queryByRole("button", { name: /send again/ })).toBeNull();
    expect(stagedAnswers()).toHaveLength(1);
    expect(choice(/^SQLite/, 1).checked).toBe(false);
    expect(choice(/^Postgres/, 2).checked).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Mark these read" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(sendButton());
    await screen.findByRole("status");
    expect(page.bodies()[1]).toMatchObject({ answers: [{ ask: 2, picks: [1] }], seen_through: 2 });
  });

  it("keeps a staged change of answers without the answer to an ask revised meanwhile", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    const state = await page.openWith([
      message(1, {
        asks: [
          ask({ open: false, answer: { seq: 3, declined: false, ...sqlite } }),
          ask({ number: 2 }),
        ],
      }),
      message(2, { asks: [ask({ number: 3, open: false, answer: { seq: 3, declined: true } })] }),
      operatorMessage(3, {
        text: "Small data.",
        answers: [answerTo(sqlite), answerTo({ ask: 3, ask_seq: 2, declined: true })],
      }),
    ]);
    landing(state, [message(4, { replaces: 2, asks: [ask({ number: 4 })] })]);
    fireEvent.click(option(3, "Change answer"));
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    fireEvent.click(sendButton());
    const panel = await staleNotice();
    expect(within(panel).queryByRole("button", { name: /send again/ })).toBeNull();
    expect(stagedLine()?.querySelector(".dropped")).not.toBeNull();
    expect(textBox().value).toBe("Small data.");
    fireEvent.click(within(panel).getByRole("button", { name: "Mark these read" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({
      text: "Small data.",
      answers: [{ ask: 1, picks: [0] }],
      replaces: 3,
      seen_through: 4,
    });
    expect(page.bodies()[1]?.answers).toHaveLength(1);
  });

  it("turns a staged change into an edit when every ask it answers again was revised meanwhile", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    const state = await page.openWith([
      message(1, { asks: [ask({ open: false, answer: { seq: 2, declined: false, ...sqlite } })] }),
      operatorMessage(2, { text: "Small data.", answers: [answerTo(sqlite)] }),
    ]);
    landing(state, [message(3, { replaces: 1, asks: [ask({ number: 2 })] })]);
    fireEvent.click(option(2, "Change answer"));
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    fireEvent.click(sendButton());
    const panel = await staleNotice();
    fireEvent.click(within(panel).getByRole("button", { name: "Mark these read" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(stagedAnswers()).toEqual([]);
    expect(stagedLine()).not.toBeNull();
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({ text: "Small data.", replaces: 2, seen_through: 3 });
    expect(page.bodies()[1]).not.toHaveProperty("answers");
  });

  it("drops a staged change of answers whole when the message it changes was replaced", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    const state = await page.openWith([
      message(1, { asks: [ask({ open: false, answer: { seq: 2, declined: false, ...sqlite } })] }),
      operatorMessage(2, { text: "Small data.", answers: [answerTo(sqlite)] }),
    ]);
    landing(state, [operatorMessage(3, { replaces: 2, answers: [answerTo({ declined: true })] })]);
    fireEvent.click(option(2, "Change answer"));
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    fireEvent.click(sendButton());
    const panel = await staleNotice();
    expect(within(panel).queryByRole("button", { name: /send again/ })).toBeNull();
    expect(stagedLine()).toBeNull();
    expect(textBox().value).toBe("Small data.");
  });

  it("drops a staged edit of a message replaced meanwhile", async () => {
    const state = await page.openWith([operatorMessage(1, { text: "Draft." })]);
    landing(state, [operatorMessage(2, { replaces: 1, text: "Edited elsewhere." })]);
    fireEvent.click(option(1, "Edit"));
    fireEvent.change(textBox(), { target: { value: "Edited here." } });
    fireEvent.click(sendButton());
    const panel = await staleNotice();
    expect(within(panel).queryByRole("button", { name: /send again/ })).toBeNull();
    expect(stagedLine()).toBeNull();
    expect(textBox().value).toBe("Edited here.");
  });

  // holding holds the first write until the test answers it as stale, the
  // missed messages having landed meanwhile, and answers later writes as
  // landed.
  function holding(state: State): (missed: Message[]) => void {
    let answer: (reply: Reply) => void = () => {};
    page.api.on("POST", `${path}/messages`, () =>
      page.writes().length === 1
        ? new Promise<Reply>((resolve) => (answer = resolve))
        : written(state.thread.last_seq + 1),
    );
    return (missed) => {
      const last = missed.at(-1)?.seq ?? state.thread.last_seq;
      state.thread = { ...state.thread, last_seq: last };
      state.messages = [...state.messages, ...missed];
      answer(failure("stale", "other messages landed after the latest one you saw", { missed }));
    };
  }

  it("judges the edit staged when the answer comes, not one set aside while it was under way", async () => {
    const state = await page.openWith([
      operatorMessage(1, { text: "First" }),
      operatorMessage(2, { text: "Second" }),
    ]);
    const stale = holding(state);
    fireEvent.click(option(1, "Edit"));
    fireEvent.change(textBox(), { target: { value: "First, edited." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    // The operator sets that edit aside, and edits message 2 instead.
    fireEvent.click(
      within(screen.getByRole("region", { name: "Reply" })).getByRole("button", { name: "Remove" }),
    );
    fireEvent.click(option(2, "Edit"));
    fireEvent.change(textBox(), { target: { value: "Second, edited." } });
    // Another device replaced message 1 meanwhile, which leaves the edit of
    // message 2 to send.
    stale([operatorMessage(3, { replaces: 1, text: "Elsewhere" })]);
    const panel = await staleNotice();
    expect(stagedLine()).not.toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Mark these read and send again" }));
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({
      text: "Second, edited.",
      replaces: 2,
      seen_through: 3,
    });
  });

  it("drops a change of answers picked again while under way, when the message it changes was replaced", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    const state = await page.openWith([
      message(1, { asks: [ask({ open: false, answer: { seq: 2, declined: false, ...sqlite } })] }),
      operatorMessage(2, { text: "Small data.", answers: [answerTo(sqlite)] }),
    ]);
    const stale = holding(state);
    fireEvent.click(option(2, "Change answer"));
    await waitFor(() => expect(textBox().value).toBe("Small data."));
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.click(choice(/^Postgres/));
    stale([operatorMessage(3, { replaces: 2, answers: [answerTo({ declined: true })] })]);
    const panel = await staleNotice();
    expect(stagedLine()).toBeNull();
    expect(textBox().value).toBe("Small data.");
    fireEvent.click(within(panel).getByRole("button", { name: "Mark these read" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(2));
    expect(page.bodies()[1]).toMatchObject({ text: "Small data.", seen_through: 3 });
    expect(page.bodies()[1]).not.toHaveProperty("replaces");
    expect(page.bodies()[1]).not.toHaveProperty("answers");
  });

  it("sends an answer again when the missed messages leave it standing", async () => {
    const state = await opening();
    landing(state, [message(2, { text: "Any news?" })]);
    state.thread = { ...state.thread, ...openAsks(1) };
    fireEvent.click(choice(/^SQLite/));
    fireEvent.click(sendButton());
    const panel = await staleNotice();
    fireEvent.click(within(panel).getByRole("button", { name: "Mark these read and send again" }));
    await screen.findByRole("status");
    expect(page.bodies()[1]).toMatchObject({
      answers: [{ ask: 1, picks: [0] }],
      seen_through: 2,
    });
  });
});

describe("going back after sending", () => {
  const goBack = () =>
    within(screen.getByRole("region", { name: "Reply" })).getByRole<HTMLInputElement>("checkbox");
  const where = () => `${window.location.pathname}${window.location.search}`;
  const list = "/?unread=true&include_archived=true";

  // opened opens a thread from a list, with this device's choice as given.
  async function opened(choice: "true" | "false" | undefined): Promise<State> {
    if (choice === undefined) {
      window.localStorage.removeItem(goBackChoice);
    } else {
      window.localStorage.setItem(goBackChoice, choice);
    }
    const state = await page.open(
      {
        thread: threadSummary({ unread: 0, ...openAsks(1) }),
        messages: [message(1, { asks: [ask()] })],
      },
      { from: list },
    );
    page.serveWrites(state);
    return state;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // holdWrites answers writes only once released.
  function holdWrites() {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    page.api.on("POST", `${path}/messages`, async () => {
      await held;
      return written(2);
    });
    return () => release();
  }

  // listSays reads what the list's status region says.
  const listSays = () => screen.getByRole("status").textContent;

  it.each([
    ["a message", () => fireEvent.change(textBox(), { target: { value: "Noted." } })],
    ["an answer", () => fireEvent.click(choice(/^SQLite/))],
  ])(
    "returns to the list as it was left once the server accepts %s, by default",
    async (_, write) => {
      await opened(undefined);
      expect(goBack().checked).toBe(true);
      const entries = window.history.length;
      write();
      fireEvent.click(sendButton());
      await waitFor(() => expect(where()).toBe(list));
      // In place of the thread page, so Back does not reopen it, and saying
      // what was sent.
      expect(window.history.length).toBe(entries);
      await waitFor(() => expect(listSays()).not.toBe(""));
    },
  );

  it("goes back by the choice as it stands when the write lands", async () => {
    await opened(undefined);
    const release = holdWrites();
    fireEvent.change(textBox(), { target: { value: "Noted." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.click(goBack());
    release();
    await waitFor(() => expect(textBox().value).toBe(""));
    expect(where()).toBe(path);
  });

  it("neither goes back nor leaves a notice when the write lands after the page was left", async () => {
    await opened(undefined);
    const release = holdWrites();
    fireEvent.change(textBox(), { target: { value: "Noted." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("link", { name: "Back to threads" })[0] as HTMLElement);
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(where()).toBe(list);
    expect(listSays()).toBe("");
    // No notice waits for a later list either.
    cleanup();
    renderAt("/");
    await waitFor(() => expect(document.querySelector(".empty")).not.toBeNull());
    expect(listSays()).toBe("");
  });

  it("stays on the page when unchecked, a choice this device keeps", async () => {
    await opened(undefined);
    fireEvent.click(goBack());
    expect(goBack().checked).toBe(false);
    fireEvent.change(textBox(), { target: { value: "Noted." } });
    fireEvent.click(sendButton());
    await screen.findByRole("status");
    expect(where()).toBe(path);
    cleanup();
    renderAt(path);
    await screen.findByRole("heading", { level: 1 });
    expect(goBack().checked).toBe(false);
  });

  it.each([
    ["refused", failure("invalid_input", "must not hold control characters", { field: "text" })],
    ["stale", failure("stale", "other messages landed", { missed: [message(2)] })],
  ])("stays on the page with the draft when the write is %s", async (_, refusal) => {
    await opened("true");
    page.api.on("POST", `${path}/messages`, refusal);
    fireEvent.change(textBox(), { target: { value: "Noted." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(where()).toBe(path);
    expect(textBox().value).toBe("Noted.");
  });

  it("goes back by default where the browser refuses storage, and holds a choice while open", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled.", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled.", "SecurityError");
    });
    const state = await page.open(
      { thread: threadSummary({ unread: 0 }), messages: [message(1)] },
      { from: list },
    );
    page.serveWrites(state);
    expect(goBack().checked).toBe(true);
    fireEvent.click(goBack());
    expect(goBack().checked).toBe(false);
    fireEvent.change(textBox(), { target: { value: "Noted." } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(page.writes()).toHaveLength(1));
    await waitFor(() => expect(textBox().value).toBe(""));
    expect(where()).toBe(path);
    expect(goBack().checked).toBe(false);
  });
});
