import type { BranchLink, Message, PullRequestLink } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { message, threadSummary } from "../../test-support.tsx";
import { ThreadPageTest } from "./thread-test-support.tsx";

let page: ThreadPageTest;

beforeEach(() => {
  page = new ThreadPageTest();
});

afterEach(() => {
  cleanup();
  expect(page.api.unhandled).toEqual([]);
});

const pull = {
  repo: "acme/agention",
  number: 135,
  url: "https://github.com/acme/agention/pull/135",
};
const branch = { repo: "acme/agention", branch: "feat/links" };

const article = (seq: number) =>
  screen.getByRole("article", { name: new RegExp(`^Message ${seq} `) });

// openWith opens a thread of the messages, whose roll-up lists the pull
// requests and branches given, its pull requests truncated when told.
function openWith(
  messages: Message[],
  rollup: { pulls?: PullRequestLink[]; branches?: BranchLink[]; truncated?: boolean } = {},
) {
  return page.open({
    thread: threadSummary({ last_seq: messages.at(-1)?.seq ?? 1, unread: 0 }),
    messages,
    rollup: {
      pull_requests: { links: rollup.pulls ?? [], truncated: rollup.truncated ?? false },
      branches: { links: rollup.branches ?? [], truncated: false },
    },
  });
}

describe("a message's pull requests and branches", () => {
  it("show one entry on its own line, by its short form, linked when it has a URL", async () => {
    await openWith([
      message(1, { text: "A pull request.", pull_requests: [pull] }),
      message(2, { text: "A branch.", branches: [branch] }),
    ]);
    const link = within(article(1)).getByRole("link", { name: "acme/agention#135" });
    expect(link.getAttribute("href")).toBe(pull.url);
    expect(within(article(1)).queryByRole("button", { name: /pull request/ })).toBeNull();
    // Without a URL, its short form is text.
    expect(within(article(2)).getByText("acme/agention:feat/links")).toBeTruthy();
    expect(within(article(2)).queryByRole("link", { name: /feat\/links/ })).toBeNull();
  });

  it("fold two or more to a count that unfolds to the list", async () => {
    await openWith([
      message(1, {
        text: "Several.",
        pull_requests: [pull, { repo: "acme/agention", number: 136 }],
        branches: [branch],
      }),
    ]);
    const fold = within(article(1)).getByRole("button", { name: "2 pull requests, 1 branch" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(within(article(1)).queryByText("acme/agention#136")).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    const items = within(article(1)).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("acme/agention#135"),
      "acme/agention#136",
      "acme/agention:feat/links",
    ]);
  });

  it("make a message that carries nothing else, which replacing another does not retract", async () => {
    await openWith([
      message(1, { text: "About #135.", live: false, replaced_by: 2 }),
      message(2, { replaces: 1, branches: [branch] }),
    ]);
    expect(within(article(1)).getByText(/replaced by #2/)).toBeTruthy();
  });
});

describe("a thread's pull requests and branches", () => {
  const fold = () => screen.queryByRole("button", { name: /^Pull requests and branches/ });

  it("show nothing while the thread names none", async () => {
    await openWith([message(1, { text: "None." })]);
    expect(fold()).toBeNull();
  });

  it("fold under the head with their count, listing them once unfolded", async () => {
    await openWith([message(1, { text: "Some." })], { pulls: [pull], branches: [branch] });
    const button = fold();
    expect(button?.textContent).toContain("(2)");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button!);
    const region = screen.getByRole("region", { name: "Pull requests and branches" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
    expect(within(region).getByRole("link", { name: "acme/agention#135" })).toBeTruthy();
    expect(within(region).getByText("acme/agention:feat/links")).toBeTruthy();
    expect(region.querySelector(".hint")).toBeNull();
  });

  it("say when the oldest were left out", async () => {
    await openWith([message(1, { text: "Many." })], { pulls: [pull], truncated: true });
    fireEvent.click(fold()!);
    const region = screen.getByRole("region", { name: "Pull requests and branches" });
    expect(region.querySelector(".hint")).not.toBeNull();
  });
});
