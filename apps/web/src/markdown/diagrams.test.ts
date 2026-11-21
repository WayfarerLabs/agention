import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramDrawer, drawTimeout, loadTimeout } from "./diagrams.ts";

// The drawer against frames that answer as the tests say: the browser tests
// drive the real frame.

let drawer: DiagramDrawer;

beforeEach(() => {
  drawer = new DiagramDrawer(document);
});

afterEach(() => {
  for (const frame of document.querySelectorAll("iframe")) {
    frame.remove();
  }
  vi.useRealTimers();
});

const frames = () => [...document.querySelectorAll("iframe")];

// loaded fires the load event of the page's one frame, and returns its
// window, with what the page posts to it recorded.
function loaded(): { window: Window; posted: unknown[] } {
  const [frame] = frames();
  const window = frame?.contentWindow;
  if (frame === undefined || window === null || window === undefined) {
    throw new Error("the page holds no frame");
  }
  const posted: unknown[] = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
  frame.dispatchEvent(new Event("load"));
  return { window, posted };
}

// answer delivers a message to the page as if source posted it.
function answer(data: unknown, source: Window | null): void {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

// settled waits for the promises the drawer chains to run.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the diagram drawer", () => {
  it("draws through one sandboxed frame, one diagram at a time, in order", async () => {
    const signal = new AbortController().signal;
    const first = drawer.draw("flowchart LR\n  A --> B", "default", signal);
    const second = drawer.draw("sequenceDiagram\n  A->>B: hi", "dark", signal);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frames()[0]?.getAttribute("src")).toBe("/diagram-frame");

    const frame = loaded();
    await settled();
    expect(frame.posted).toEqual([{ id: 1, source: "flowchart LR\n  A --> B", theme: "default" }]);
    answer({ id: 1, svg: "<svg/>", title: "Flow", description: "A to B" }, frame.window);
    expect(await first).toEqual({ svg: "<svg/>", title: "Flow", description: "A to B" });

    await settled();
    expect(frame.posted).toHaveLength(2);
    expect(frame.posted[1]).toMatchObject({ id: 2, theme: "dark" });
    answer({ id: 2, error: "Parse error" }, frame.window);
    expect(await second).toBeUndefined();
    expect(frames()).toHaveLength(1);
  });

  it("takes an answer only from its frame's window, to the diagram it is drawing", async () => {
    const drawn = drawer.draw("flowchart LR\n  A --> B", "default", new AbortController().signal);
    const frame = loaded();
    await settled();
    let settledWith: unknown = "pending";
    void drawn.then((drawing) => (settledWith = drawing));

    for (const [data, source] of [
      [{ id: 1, svg: "<svg/>" }, window],
      [{ id: 1, svg: "<svg/>" }, null],
      [{ id: 2, svg: "<svg/>" }, frame.window],
      [{ id: 1, svg: 7 }, frame.window],
      [{ id: 1, svg: "<svg/>", title: ["Flow"] }, frame.window],
      ["<svg/>", frame.window],
    ] as const) {
      answer(data, source);
    }
    await settled();
    expect(settledWith).toBe("pending");

    answer({ id: 1, svg: "<svg/>" }, frame.window);
    await settled();
    expect(settledWith).toEqual({ svg: "<svg/>" });
  });

  it("throws away a frame that does not answer in time, and draws the next in a new one", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const first = drawer.draw("flowchart LR\n  A --> B", "default", signal);
    const second = drawer.draw("flowchart LR\n  C --> D", "default", signal);
    const stuck = loaded();
    await vi.advanceTimersByTimeAsync(drawTimeout - 1);
    expect(frames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBeUndefined();

    // The stuck frame is gone, and its late answers count for nothing.
    expect(frames()).toHaveLength(1);
    const fresh = loaded();
    expect(fresh.window).not.toBe(stuck.window);
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.posted).toEqual([{ id: 2, source: "flowchart LR\n  C --> D", theme: "default" }]);
    answer({ id: 2, svg: "<svg/>" }, stuck.window);
    answer({ id: 2, svg: "<svg id='new'/>" }, fresh.window);
    expect(await second).toEqual({ svg: "<svg id='new'/>" });
  });

  it("throws away a frame that never loads, and draws the next in a new one", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const first = drawer.draw("flowchart LR\n  A --> B", "default", signal);
    const second = drawer.draw("flowchart LR\n  C --> D", "default", signal);
    const [unloaded] = frames();
    let failed = false;
    void first.then(() => (failed = true));
    await vi.advanceTimersByTimeAsync(loadTimeout - 1);
    expect([failed, frames()]).toEqual([false, [unloaded]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBeUndefined();
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).not.toBe(unloaded);
    const fresh = loaded();
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.posted).toEqual([{ id: 2, source: "flowchart LR\n  C --> D", theme: "default" }]);
    answer({ id: 2, svg: "<svg/>" }, fresh.window);
    expect(await second).toEqual({ svg: "<svg/>" });
  });

  it("draws through a frame that loads slowly, timing the draw from when it is posted", async () => {
    vi.useFakeTimers();
    const drawn = drawer.draw("flowchart LR\n  A --> B", "default", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(drawTimeout * 3);
    const slow = loaded();
    await vi.advanceTimersByTimeAsync(drawTimeout - 1);
    expect(slow.posted).toEqual([{ id: 1, source: "flowchart LR\n  A --> B", theme: "default" }]);
    answer({ id: 1, svg: "<svg/>" }, slow.window);
    expect(await drawn).toEqual({ svg: "<svg/>" });
    expect(frames()).toHaveLength(1);
  });

  it("drops a draw that is aborted while it waits, and never settles it", async () => {
    const waiting = new AbortController();
    const first = drawer.draw("flowchart LR\n  A --> B", "default", new AbortController().signal);
    let dropped: unknown = "pending";
    void drawer
      .draw("flowchart LR\n  C --> D", "default", waiting.signal)
      .then((drawing) => (dropped = drawing));
    const third = drawer.draw("flowchart LR\n  E --> F", "default", new AbortController().signal);
    waiting.abort();

    const frame = loaded();
    await settled();
    answer({ id: 1, svg: "<svg/>" }, frame.window);
    await first;
    await settled();
    expect(frame.posted).toHaveLength(2);
    expect(frame.posted[1]).toMatchObject({ id: 3 });
    answer({ id: 3, svg: "<svg/>" }, frame.window);
    expect(await third).toEqual({ svg: "<svg/>" });
    expect(dropped).toBe("pending");
  });
});
