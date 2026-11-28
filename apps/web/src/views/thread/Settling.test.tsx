import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerTo,
  ask,
  failure,
  message,
  operatorMessage,
  type Reply,
} from "../../test-support.tsx";
import { option, path, textBox, ThreadPageTest, written } from "./thread-test-support.tsx";

// The composer's Settle the thread: what it sends, what it needs, the
// server's refusal at it, and an edit or a change of a settling message
// keeping it.

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
});

const reply = () => within(screen.getByRole("region", { name: "Reply" }));
const settleBox = () => reply().getByRole<HTMLInputElement>("checkbox", { name: /^Settle/ });
const sendButton = () => reply().getByRole<HTMLButtonElement>("button", { name: "Send" });
const describedBy = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id));
// saysWhy says whether the toggle is marked invalid, with why beside it.
const saysWhy = () =>
  settleBox().getAttribute("aria-invalid") === "true" &&
  describedBy(settleBox()).some((each) => each?.classList.contains("field-error") === true);

async function send(): Promise<Record<string, unknown> | undefined> {
  const before = page.writes().length;
  fireEvent.click(sendButton());
  await waitFor(() => expect(page.writes()).toHaveLength(before + 1));
  return page.bodies().at(-1);
}

describe("Settle the thread", () => {
  it("sends the message as settling the thread, and is off again once it lands", async () => {
    await page.openWith([message(1)]);
    page.api.on("POST", `${path}/messages`, written(2));
    expect(settleBox().checked).toBe(false);
    fireEvent.change(textBox(), { target: { value: "Merged, so done." } });
    fireEvent.click(settleBox());
    expect(await send()).toMatchObject({ text: "Merged, so done.", settles: true });
    await waitFor(() => expect(settleBox().checked).toBe(false));
  });

  it("holds while a message sends, so the send landing cannot undo a choice made meanwhile", async () => {
    await page.openWith([message(1)]);
    let land = (): void => undefined;
    page.api.on(
      "POST",
      `${path}/messages`,
      () => new Promise<Reply>((resolve) => (land = () => resolve(written(2)))),
    );
    fireEvent.change(textBox(), { target: { value: "Merged, so done." } });
    fireEvent.click(settleBox());
    fireEvent.click(sendButton());
    await waitFor(() => expect(settleBox().disabled).toBe(true));
    land();
    await waitFor(() => expect(settleBox().disabled).toBe(false));
  });

  it("sends nothing of settling while it is off", async () => {
    await page.openWith([message(1)]);
    page.api.on("POST", `${path}/messages`, written(2));
    fireEvent.change(textBox(), { target: { value: "Thanks." } });
    expect(await send()).not.toHaveProperty("settles");
  });

  it("needs text, holding Send and saying why at the toggle", async () => {
    await page.openWith([message(1)]);
    fireEvent.click(settleBox());
    expect(saysWhy()).toBe(true);
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(textBox(), { target: { value: "Merged." } });
    expect(saysWhy()).toBe(false);
    expect(sendButton().disabled).toBe(false);
  });

  it("shows the server's refusal at the toggle, keeping the draft to send again", async () => {
    await page.openWith([message(1, { asks: [ask()] })], {
      open_asks: { asks: [{ number: 1, seq: 1 }], count: 1, blocking: false, overdue: false },
    });
    page.api.on(
      "POST",
      `${path}/messages`,
      failure("invalid_input", "ask 1 is open", { field: "settles" }),
    );
    fireEvent.change(textBox(), { target: { value: "Merged, so done." } });
    fireEvent.click(settleBox());
    await send();
    await waitFor(() => expect(saysWhy()).toBe(true));
    expect(textBox().value).toBe("Merged, so done.");
    expect(settleBox().checked).toBe(true);
    expect(document.querySelector(".composer .notice.danger")).toBeNull();
    // Changing the toggle answers the refusal, which shows nowhere then.
    fireEvent.click(settleBox());
    expect(saysWhy()).toBe(false);
    expect(document.querySelector(".composer .notice.danger")).toBeNull();
  });

  it("loads on with an edit of a settling message, so the replacement settles unless turned off", async () => {
    const messages = [message(1), operatorMessage(2, { text: "Merged.", settles: true })];
    await page.openWith(messages);
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(textBox().value).toBe("Merged."));
    expect(settleBox().checked).toBe(true);
    fireEvent.change(textBox(), { target: { value: "Merged, so done." } });
    page.api.on("POST", `${path}/messages`, written(3));
    expect(await send()).toMatchObject({ text: "Merged, so done.", settles: true, replaces: 2 });
  });

  it("sends an edit of a settling message without settling once turned off", async () => {
    await page.openWith([message(1), operatorMessage(2, { text: "Merged.", settles: true })]);
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(settleBox().checked).toBe(true));
    fireEvent.click(settleBox());
    fireEvent.change(textBox(), { target: { value: "Not merged after all." } });
    page.api.on("POST", `${path}/messages`, written(3));
    expect(await send()).not.toHaveProperty("settles");
  });

  it("loads on with a change of a settling message's answers, and off again once removed", async () => {
    const sqlite = { picks: [0], labels: ["SQLite"] };
    await page.openWith([
      message(1, { asks: [ask({ open: false, answer: { seq: 2, declined: false, ...sqlite } })] }),
      operatorMessage(2, { text: "Small data.", answers: [answerTo(sqlite)], settles: true }),
    ]);
    fireEvent.click(option(2, "Change answer"));
    await waitFor(() => expect(settleBox().checked).toBe(true));
    fireEvent.click(reply().getByRole("button", { name: "Remove" }));
    expect(settleBox().checked).toBe(false);
  });

  it("loads off with an edit of a settling message a later one followed", async () => {
    await page.openWith([
      message(1),
      operatorMessage(2, { text: "Merged.", settles: true }),
      message(3, { text: "Reopened." }),
    ]);
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(textBox().value).toBe("Merged."));
    expect(settleBox().checked).toBe(false);
  });

  it("holds Edit while it is checked, so an edit cannot overwrite it", async () => {
    await page.openWith([message(1), operatorMessage(2, { text: "Use SQLite." })]);
    fireEvent.click(settleBox());
    expect(option(2, "Edit")).toHaveProperty("disabled", true);
  });

  it("loads off with an edit of a message that does not settle", async () => {
    await page.openWith([message(1), operatorMessage(2, { text: "Use SQLite." })]);
    fireEvent.click(option(2, "Edit"));
    await waitFor(() => expect(textBox().value).toBe("Use SQLite."));
    expect(settleBox().checked).toBe(false);
  });
});
