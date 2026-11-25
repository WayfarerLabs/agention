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

// The list the thread page returns to: narrowed, in an order, and grouped.
const origin = { from: "/?unread=true&agent=builder&sort=latest&group=session" };

// The list each entry leads to: narrowed to it alone, in the order and
// grouping of the list the page returns to.
const pullList = "/?pull_request=acme/agention%23135&sort=latest&group=session";
const branchList = "/?branch=acme/agention:feat/links&sort=latest&group=session";

// openWith opens a thread of the messages, from the list above, whose
// roll-up lists the pull requests and branches given, its pull requests
// truncated when told.
function openWith(
  messages: Message[],
  rollup: { pulls?: PullRequestLink[]; branches?: BranchLink[]; truncated?: boolean } = {},
) {
  return page.open(
    {
      thread: threadSummary({ last_seq: messages.at(-1)?.seq ?? 1, unread: 0 }),
      messages,
      rollup: {
        pull_requests: { links: rollup.pulls ?? [], truncated: rollup.truncated ?? false },
        branches: { links: rollup.branches ?? [], truncated: false },
      },
    },
    origin,
  );
}

// targetsIn lists where each link within an element goes, in order.
const targetsIn = (element: HTMLElement) =>
  within(element)
    .queryAllByRole("link")
    .map((link) => link.getAttribute("href"));

// forgeLinks lists the links within an element that open another site, as
// their targets say.
const forgeLinks = (element: HTMLElement) =>
  within(element)
    .queryAllByRole("link")
    .filter((link) => link.getAttribute("target") === "_blank");

describe("a message's pull requests and branches", () => {
  it("show one entry on its own line, leading to the list filtered by it, its URL beside it", async () => {
    await openWith([
      message(1, { text: "A pull request.", pull_requests: [pull] }),
      message(2, { text: "A branch.", branches: [branch] }),
    ]);
    const line = article(1).querySelector<HTMLElement>(".code-links")!;
    expect(targetsIn(line)).toEqual([pullList, pull.url]);
    expect(forgeLinks(line).map((link) => link.getAttribute("href"))).toEqual([pull.url]);
    expect(forgeLinks(line)[0]?.getAttribute("rel")).toContain("noreferrer");
    expect(within(article(1)).queryByRole("button", { name: /pull request/ })).toBeNull();
    // Without a URL, it leads to its list alone.
    const other = article(2).querySelector<HTMLElement>(".code-links")!;
    expect(targetsIn(other)).toEqual([branchList]);
    expect(forgeLinks(other)).toEqual([]);
  });

  it("open the list filtered by the entry alone when followed", async () => {
    await openWith([message(1, { text: "A pull request.", pull_requests: [pull] })]);
    const line = article(1).querySelector<HTMLElement>(".code-links")!;
    const [entry] = within(line).getAllByRole("link");
    fireEvent.click(entry!);
    expect(window.location.pathname + window.location.search).toBe(pullList);
  });

  it("fold two or more to a count that unfolds to the list, each leading to its own", async () => {
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
    expect(items.map(targetsIn)).toEqual([
      [pullList, pull.url],
      ["/?pull_request=acme/agention%23136&sort=latest&group=session"],
      [branchList],
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

  it("fold under the head with their count, each leading to the list filtered by it", async () => {
    await openWith([message(1, { text: "Some." })], { pulls: [pull], branches: [branch] });
    const button = fold();
    expect(button?.textContent).toContain("(2)");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button!);
    const region = screen.getByRole("region", { name: "Pull requests and branches" });
    expect(within(region).getAllByRole("listitem").map(targetsIn)).toEqual([
      [pullList, pull.url],
      [branchList],
    ]);
    expect(region.querySelector(".hint")).toBeNull();
  });

  it("say when the oldest were left out", async () => {
    await openWith([message(1, { text: "Many." })], { pulls: [pull], truncated: true });
    fireEvent.click(fold()!);
    const region = screen.getByRole("region", { name: "Pull requests and branches" });
    expect(region.querySelector(".hint")).not.toBeNull();
  });
});
