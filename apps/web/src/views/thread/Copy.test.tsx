import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, message } from "../../test-support.tsx";
import { detailOf, ThreadPageTest } from "./thread-test-support.tsx";

const text = "**Ship** it today.";
const detail = "## Plan\n\n- Tag the release";

const refusal = () => new DOMException("denied", "NotAllowedError");

function install(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

// clipboard stands in for the browser's clipboard, landing each write or
// refusing them all.
function clipboard(refuse = false) {
  const writeText = vi.fn((_text: string) =>
    refuse ? Promise.reject(refusal()) : Promise.resolve(),
  );
  install(writeText);
  return writeText;
}

// heldClipboard stands in for a clipboard whose writes each wait until the
// test lands or refuses them.
function heldClipboard() {
  const writes: { land(): void; refuse(): void }[] = [];
  install(
    () =>
      new Promise<void>((resolve, reject) => {
        writes.push({ land: resolve, refuse: () => reject(refusal()) });
      }),
  );
  return writes;
}

const copyButton = (seq: number) =>
  screen.getByRole<HTMLButtonElement>("button", { name: `Copy message ${seq}` });
const article = (seq: number) => document.getElementById(`message-${seq}`) as HTMLElement;
// What the live region beside the message's Copy, among its head's
// controls, says, empty while it says nothing.
const confirmation = (seq: number) =>
  article(seq).querySelector(".head-controls [aria-live]")?.textContent ?? "";
// Whether the message says the copy was refused, in the note that follows its
// head rather than any its content holds.
const refused = (seq: number) =>
  article(seq).querySelector('.message-head ~ [role="status"]') !== null;

describe("copying a message", () => {
  let page: ThreadPageTest;

  beforeEach(() => {
    page = new ThreadPageTest();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "clipboard");
    expect(page.api.unhandled).toEqual([]);
  });

  it("copies the text, a blank line and the detail while the details are open, and the text alone while folded", async () => {
    const writeText = clipboard();
    await page.openWith([message(1, { text, detail })]);
    fireEvent.click(detailOf(1));
    fireEvent.click(copyButton(1));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith(`${text}\n\n${detail}`);
    fireEvent.click(detailOf(1));
    fireEvent.click(copyButton(1));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith(text);
  });

  it("confirms a copy briefly, then reverts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    clipboard();
    await page.openWith([message(1, { text })]);
    expect(confirmation(1)).toBe("");
    fireEvent.click(copyButton(1));
    await waitFor(() => expect(confirmation(1)).not.toBe(""));
    expect(refused(1)).toBe(false);
    act(() => vi.advanceTimersByTime(2_000));
    expect(confirmation(1)).toBe("");
  });

  it("says so under the message where the clipboard refuses, and keeps saying it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = clipboard(true);
    await page.openWith([message(1, { text })]);
    fireEvent.click(copyButton(1));
    await waitFor(() => expect(refused(1)).toBe(true));
    expect(writeText).toHaveBeenCalledWith(text);
    expect(confirmation(1)).toBe("");
    act(() => vi.advanceTimersByTime(10_000));
    expect(refused(1)).toBe(true);
  });

  it("says so where the browser has no clipboard", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await page.openWith([message(1, { text })]);
    fireEvent.click(copyButton(1));
    await waitFor(() => expect(refused(1)).toBe(true));
    act(() => vi.advanceTimersByTime(2_000));
    expect(refused(1)).toBe(true);
  });

  it("clears a refusal while the next try runs", async () => {
    clipboard(true);
    await page.openWith([message(1, { text })]);
    fireEvent.click(copyButton(1));
    await waitFor(() => expect(refused(1)).toBe(true));
    const writes = heldClipboard();
    fireEvent.click(copyButton(1));
    expect(writes).toHaveLength(1);
    expect(refused(1)).toBe(false);
    await act(async () => writes[0]?.land());
    expect(confirmation(1)).not.toBe("");
  });

  it("goes by the latest copy when an earlier one settles after it", async () => {
    const writes = heldClipboard();
    await page.openWith([message(1, { text })]);
    fireEvent.click(copyButton(1));
    fireEvent.click(copyButton(1));
    expect(writes).toHaveLength(2);
    await act(async () => writes[1]?.land());
    expect(confirmation(1)).not.toBe("");
    await act(async () => writes[0]?.refuse());
    expect(refused(1)).toBe(false);
    expect(confirmation(1)).not.toBe("");
  });

  it("is offered only on a message with text, on a replaced one too", async () => {
    await page.openWith([
      message(1, { text: "Old.", live: false, replaced_by: 2 }),
      message(2, { replaces: 1, asks: [ask()] }),
    ]);
    expect(screen.queryByRole("button", { name: "Copy message 2" })).toBeNull();
    fireEvent.click(document.querySelector("#message-1 summary") as Element);
    await waitFor(() => copyButton(1));
  });
});
