import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { message } from "../test-support.tsx";
import { ThreadPageTest } from "../views/thread/thread-test-support.tsx";

// Attach on a device with a mouse, which opens the one picker, and on a phone
// or a tablet, which opens a menu of where files come from. What a picker
// adds goes on as AttachList.test.tsx tests, and the browser tests add a
// file from the menu.

let page: ThreadPageTest;
// The pickers clicked, in order; jsdom opens no chooser.
let clicked: HTMLInputElement[];

beforeEach(() => {
  page = new ThreadPageTest();
  clicked = [];
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
    this: HTMLInputElement,
  ) {
    clicked.push(this);
  });
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
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

const composer = () => screen.getByRole("region", { name: "Reply" });
const attachButton = () =>
  within(composer()).getByRole<HTMLButtonElement>("button", { name: "Attach files" });
const pickers = () => [...composer().querySelectorAll<HTMLInputElement>('input[type="file"]')];
const menuItems = () =>
  [...composer().querySelectorAll<HTMLButtonElement>(".options-menu button")].map(
    (item) => item.textContent,
  );
const item = (name: string) => within(composer()).getByRole("button", { name });
// What a picker asks the device for.
const asks = (input: HTMLInputElement) => ({
  accept: input.getAttribute("accept"),
  capture: input.getAttribute("capture"),
  multiple: input.multiple,
});

async function opened() {
  await page.openWith([message(1, { text: "Hello" })]);
}

describe("Attach with a mouse", () => {
  it("opens its one picker of any files, with no menu", async () => {
    await opened();
    expect(pickers().map(asks)).toEqual([{ accept: null, capture: null, multiple: true }]);
    fireEvent.click(attachButton());
    expect(clicked).toEqual(pickers());
    expect(attachButton().getAttribute("aria-expanded")).toBeNull();
    expect(menuItems()).toEqual([]);
  });
});

describe("Attach on a phone", () => {
  beforeEach(onTouch);

  it("opens a menu of four sources, opening no picker", async () => {
    await opened();
    fireEvent.click(attachButton());
    expect(attachButton().getAttribute("aria-expanded")).toBe("true");
    expect(menuItems()).toEqual([
      "Take a photo",
      "Record a video",
      "Photos and videos",
      "Other files",
    ]);
    expect(clicked).toEqual([]);
  });

  it("opens each source's own picker, closing the menu with focus on Attach", async () => {
    await opened();
    const opens = [];
    for (const name of ["Take a photo", "Record a video", "Photos and videos", "Other files"]) {
      fireEvent.click(attachButton());
      fireEvent.click(item(name));
      expect(attachButton().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(attachButton());
      opens.push(asks(clicked.at(-1)!));
    }
    expect(clicked).toHaveLength(4);
    expect(new Set(clicked).size).toBe(4);
    expect(opens).toEqual([
      { accept: "image/*", capture: "environment", multiple: false },
      { accept: "video/*", capture: "environment", multiple: false },
      { accept: "image/*,video/*", capture: null, multiple: true },
      { accept: "application/*,text/*", capture: null, multiple: true },
    ]);
  });
});
