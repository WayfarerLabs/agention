import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { message, threadSummary } from "../../test-support.tsx";
import { range, ThreadPageTest } from "./thread-test-support.tsx";

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
});

const fold = () => screen.getByRole("button", { name: /archived message/ });

// divider says what the archived divider leads, if it shows: the message
// just below it, or "end" where nothing is. It is a separator with a name,
// and the one separator on the page.
function divider(): number | "end" | undefined {
  const log = screen.getByRole("region", { name: "Messages" });
  const separators = within(log).queryAllByRole("separator");
  const [separator] = separators;
  if (separator === undefined) {
    return undefined;
  }
  expect(separators).toEqual([within(log).getByRole("separator", { name: /\S/ })]);
  const below = within(log)
    .queryAllByRole("article", { name: /^Message \d+/ })
    .find(
      (article) =>
        (separator.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
  return below === undefined
    ? "end"
    : Number(/^Message (\d+)/.exec(below.getAttribute("aria-label") ?? "")?.[1]);
}

describe("the archived divider", () => {
  it("shows nowhere while nothing is archived", async () => {
    await page.openWith([message(1), message(2), message(3)]);
    expect(divider()).toBeUndefined();
  });

  it("sets the messages after the archive mark apart from those archived once they unfold", async () => {
    await page.open({
      thread: threadSummary({ last_seq: 4, unread: 0 }),
      messages: range(1, 4).map((seq) => message(seq)),
      archived: 2,
    });
    // Folded, the fold alone marks where they end.
    expect(divider()).toBeUndefined();
    fireEvent.click(fold());
    expect(divider()).toBe(3);
    fireEvent.click(fold());
    expect(divider()).toBeUndefined();
  });

  it("shows nowhere while the whole thread is archived", async () => {
    await page.open({
      thread: threadSummary({ last_seq: 3, unread: 0, archived: true }),
      messages: range(1, 3).map((seq) => message(seq)),
      archived: 3,
    });
    expect(divider()).toBeUndefined();
    fireEvent.click(fold());
    expect(divider()).toBeUndefined();
  });
});
