import type { ThreadSummary } from "@wayfarerlabs/agention-api";
import type { ThreadCounts } from "@wayfarerlabs/agention-server-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeApi, noCounts, renderAt, threadSummary } from "../../test-support.tsx";

// The thread list's filters on pull requests and branches, their chips and
// address, and what a row shows of them.

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const pull = {
  repo: "acme/agention",
  number: 135,
  url: "https://github.com/acme/agention/pull/135",
};
const branch = { repo: "acme/agention", branch: "feat/links" };

const counts: ThreadCounts = {
  ...noCounts,
  pull_request: {
    pull_requests: [
      { repo: "acme/agention", number: 136, total: 2 },
      { repo: "acme/agention", number: 135, total: 3 },
    ],
    truncated: false,
  },
  branch: { branches: [{ ...branch, total: 4 }], truncated: false },
};

function serve(threads: ThreadSummary[]) {
  api.on("GET", "/threads", { body: { threads, total: threads.length } });
  api.on("GET", "/threads/counts", { body: counts });
}

const address = () => window.location.pathname + window.location.search;
const lastQuery = () => api.callsTo("GET", "/threads").at(-1)?.url.searchParams;
const sheet = () => screen.getByRole<HTMLDialogElement>("dialog", { hidden: true });
const chips = () => Array.from(document.querySelectorAll<HTMLElement>("button.chip"));

async function openSheet() {
  await screen.findByRole("heading", { level: 1 });
  fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  await waitFor(() => expect(api.callsTo("GET", "/threads/counts")).toHaveLength(1));
}

// The multi-select of the sheet whose label starts with the name given: its
// button, and the boxes of its popup once opened, each read as checked or
// not, its value and its count.
type Filter = "Pull request" | "Branch";
const picker = (name: Filter) =>
  within(sheet()).getByRole("button", { name: new RegExp(`^${name} `) });
function options(name: Filter): string[] {
  const popup = document.getElementById(picker(name).getAttribute("aria-controls") ?? "");
  return within(popup!)
    .getAllByRole<HTMLInputElement>("checkbox")
    .map((box) => `${box.checked ? "+" : "-"} ${box.closest("label")?.textContent}`);
}
const box = (name: Filter, value: string) => {
  const popup = document.getElementById(picker(name).getAttribute("aria-controls") ?? "");
  return within(popup!).getByRole("checkbox", { name: new RegExp(`^${value},`) });
};

describe("the pull request and branch choices", () => {
  it("offer each entry the counts list, most recently named first, with its count", async () => {
    serve([]);
    renderAt("/");
    await openSheet();
    fireEvent.click(picker("Pull request"));
    expect(options("Pull request")).toEqual(["- acme/agention#136 (2)", "- acme/agention#135 (3)"]);
    fireEvent.click(picker("Branch"));
    expect(options("Branch")).toEqual(["- acme/agention:feat/links (4)"]);
  });

  it("choose any number, each checked box adding to the address and the list's query", async () => {
    serve([]);
    renderAt("/?unread=true");
    await openSheet();
    fireEvent.click(picker("Pull request"));
    fireEvent.click(box("Pull request", "acme/agention#135"));
    await waitFor(() => expect(address()).toBe("/?unread=true&pull_request=acme/agention%23135"));
    fireEvent.click(box("Pull request", "acme/agention#136"));
    await waitFor(() =>
      expect(address()).toBe(
        "/?unread=true&pull_request=acme/agention%23135&pull_request=acme/agention%23136",
      ),
    );
    fireEvent.click(picker("Branch"));
    fireEvent.click(box("Branch", "acme/agention:feat/links"));
    await waitFor(() =>
      expect(lastQuery()?.getAll("branch")).toEqual(["acme/agention:feat/links"]),
    );
    expect(lastQuery()?.getAll("pull_request")).toEqual(["acme/agention#135", "acme/agention#136"]);
  });

  it("check a chosen entry written otherwise, and offer one the counts leave out", async () => {
    serve([]);
    renderAt("/?pull_request=Acme/Agention%23135&pull_request=acme/agention%239");
    await openSheet();
    fireEvent.click(picker("Pull request"));
    expect(options("Pull request")).toEqual([
      "- acme/agention#136 (2)",
      "+ acme/agention#135 (3)",
      "+ acme/agention#9 (0)",
    ]);
    // Unchecking it takes the entry out, whichever way it was written.
    fireEvent.click(box("Pull request", "acme/agention#135"));
    await waitFor(() => expect(address()).toBe("/?pull_request=acme/agention%239"));
  });
});

describe("the pull request and branch chips", () => {
  it("show each filter on, with the branch icon, each removing its own", async () => {
    serve([]);
    renderAt(
      "/?pull_request=acme/agention%23135&branch=acme/agention:a&branch=acme/agention:b&sort=latest",
    );
    await screen.findByRole("heading", { level: 1 });
    expect(chips()).toHaveLength(2);
    for (const chip of chips()) {
      expect(chip.querySelector("svg.icon")).not.toBeNull();
    }
    expect(chips()[0]?.textContent).toContain("acme/agention#135");
    fireEvent.click(chips()[1]!);
    await waitFor(() => expect(address()).toBe("/?pull_request=acme/agention%23135&sort=latest"));
    expect(lastQuery()?.getAll("branch")).toEqual([]);
  });

  it("cut a long one short at its front, keeping its end, and name it whole", async () => {
    serve([]);
    const long = "acme/agention:feat/the-longest-branch-yet";
    renderAt(`/?branch=${long}`);
    await screen.findByRole("heading", { level: 1 });
    const [chip] = chips();
    const shown = chip?.textContent?.replace(/ ×$/, "") ?? "";
    expect(shown.startsWith("…")).toBe(true);
    expect(long.endsWith(shown.slice(1))).toBe(true);
    expect(shown.length).toBeLessThan(long.length);
    expect(chip?.getAttribute("title")).toContain(long);
  });
});

describe("the address", () => {
  it("opens the list narrowed to the pull requests and branches it names", async () => {
    serve([]);
    renderAt("/?pull_request=acme/agention%23135&pull_request=acme/agention%23136&branch=a/b:c");
    await waitFor(() =>
      expect(lastQuery()?.getAll("pull_request")).toEqual([
        "acme/agention#135",
        "acme/agention#136",
      ]),
    );
    expect(lastQuery()?.getAll("branch")).toEqual(["a/b:c"]);
  });

  it("leaves out a filter it cannot read, as the server would refuse it", async () => {
    serve([]);
    renderAt("/?pull_request=acme/agention&branch=a/b:c..d&unread=true");
    await waitFor(() => expect(lastQuery()?.get("unread")).toBe("true"));
    expect(lastQuery()?.has("pull_request")).toBe(false);
    expect(lastQuery()?.has("branch")).toBe(false);
  });
});

describe("a row's pull requests and branches", () => {
  const rowOf = (title: string) =>
    screen.getByText(title).closest<HTMLElement>("li.thread-row") as HTMLElement;
  const entryLine = (row: HTMLElement) => row.querySelector<HTMLElement>(".row-code-links");
  const targetsOf = (element: HTMLElement) =>
    within(element)
      .queryAllByRole("link")
      .map((link) => link.getAttribute("href"));

  const one = threadSummary({
    number: 1,
    title: "About one",
    links: { pull_requests: 1, branches: 0, pull_request: pull },
  });
  const several = threadSummary({
    number: 2,
    title: "About several",
    links: { pull_requests: 2, branches: 1 },
  });
  const none = threadSummary({ number: 3, title: "About none" });

  it("show its one entry beside the row's link, adding its filter to the list on screen", async () => {
    serve([one, several, none]);
    renderAt("/?unread=true&sort=latest");
    await screen.findByText("About one");
    const line = entryLine(rowOf("About one"));
    expect(line).not.toBeNull();
    // Beside the thread's own link, not within it, and with no forge link,
    // though the entry has a URL.
    expect(line?.closest("a")).toBeNull();
    expect(targetsOf(line!)).toEqual([
      "/?unread=true&pull_request=acme/agention%23135&sort=latest",
    ]);
    expect(entryLine(rowOf("About none"))).toBeNull();
    expect(entryLine(rowOf("About several"))).toBeNull();
  });

  it("choose its filter on the list in place when followed", async () => {
    serve([one]);
    renderAt("/?unread=true");
    await screen.findByText("About one");
    const [entry] = within(entryLine(rowOf("About one"))!).getAllByRole("link");
    fireEvent.click(entry!);
    await waitFor(() => expect(address()).toBe("/?unread=true&pull_request=acme/agention%23135"));
    expect(lastQuery()?.getAll("pull_request")).toEqual(["acme/agention#135"]);
  });

  it("show one mark counting several among the row's marks, within its link", async () => {
    serve([several, one, none]);
    renderAt("/");
    await screen.findByText("About several");
    const link = rowOf("About several").querySelector<HTMLElement>("a.thread-link")!;
    // The marks showing how many entries there are: no other mark of these
    // rows shows 3.
    const counted = (row: HTMLElement) =>
      Array.from(row.querySelectorAll(".marks .mark")).filter(
        (mark) => mark.querySelector("span[aria-hidden='true']")?.textContent === "3",
      );
    expect(counted(link)).toHaveLength(1);
    expect(link.querySelector(".code-link")).toBeNull();
    // A row naming one or none carries no such mark.
    expect(counted(rowOf("About one"))).toEqual([]);
    expect(counted(rowOf("About none"))).toEqual([]);
  });

  it("lead from a grouped list's rows to the list on screen too", async () => {
    serve([one]);
    renderAt("/?group=session");
    await screen.findByText("About one");
    expect(targetsOf(entryLine(rowOf("About one"))!)).toEqual([
      "/?pull_request=acme/agention%23135&group=session",
    ]);
  });
});
