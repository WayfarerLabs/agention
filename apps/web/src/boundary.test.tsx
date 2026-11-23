import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeApi, renderAt, threadSummary } from "./test-support.tsx";

// Views that fail to render, standing in for any failure the views do not
// foresee: the sessions view always, and the thread list or a thread when a
// test says so.
const failing = vi.hoisted(() => ({ list: false, thread: undefined as number | undefined }));

vi.mock("./views/Sessions.tsx", () => ({
  Sessions: () => {
    throw new Error("the view failed");
  },
}));

vi.mock("./views/ThreadList.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./views/ThreadList.tsx")>();
  return {
    ThreadList: () => {
      if (failing.list) {
        throw new Error("the list failed");
      }
      return <actual.ThreadList />;
    },
  };
});

vi.mock("./views/thread/ThreadView.tsx", () => ({
  ThreadView: ({ thread }: { thread: number }) => {
    if (thread === failing.thread) {
      throw new Error("the thread failed");
    }
    return <h1 tabIndex={-1}>Thread {thread}</h1>;
  },
}));

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
  failing.list = false;
  failing.thread = undefined;
  // React reports the error it caught.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  expect(api.unhandled).toEqual([]);
});

it("keeps the navigation when a view fails to render, and starts afresh elsewhere", async () => {
  renderAt("/sessions");
  await screen.findByRole("heading", { name: "Something went wrong" });
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Threads" }));
  await screen.findByRole("heading", { name: "Threads" });
  expect(screen.queryByRole("heading", { name: "Something went wrong" })).toBeNull();
});

describe("side by side, at a desktop's width", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      matches: query === "(min-width: 64rem)",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const threads = [
      threadSummary({ number: 1, title: "First", unread: 0 }),
      threadSummary({ number: 2, title: "Second", unread: 0 }),
    ];
    api.on("GET", "/threads", { body: { threads, total: threads.length } });
  });

  const pane = (name: string) => screen.getByRole("region", { name });

  it("keeps the list when a thread fails to render beside it, and starts afresh on another", async () => {
    failing.thread = 1;
    renderAt("/");
    fireEvent.click(await screen.findByRole("link", { name: /^#1 First/ }));
    await within(pane("Thread")).findByRole("heading", { name: "Something went wrong" });
    expect(within(pane("Thread list")).getByRole("link", { name: /^#2 Second/ })).toBeTruthy();
    fireEvent.click(within(pane("Thread list")).getByRole("link", { name: /^#2 Second/ }));
    await within(pane("Thread")).findByRole("heading", { name: "Thread 2" });
    expect(screen.queryByRole("heading", { name: "Something went wrong" })).toBeNull();
  });

  it("keeps the thread when the list beside it fails to render", async () => {
    failing.list = true;
    renderAt("/s/builder/main/threads/1");
    await within(await screen.findByRole("region", { name: "Thread list" })).findByRole("heading", {
      name: "Something went wrong",
    });
    expect(within(pane("Thread")).getByRole("heading", { name: "Thread 1" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
  });
});
