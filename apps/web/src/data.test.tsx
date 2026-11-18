import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, requestTimeout } from "./api.ts";
import { refreshInterval, useResource } from "./data.ts";
import { SessionProvider } from "./session.tsx";
import { FakeApi, type Reply } from "./test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Probe({ load }: { load: () => Promise<string> }) {
  const resource = useResource(load);
  return (
    <>
      <p>{resource.data ?? "nothing"}</p>
      <button type="button" onClick={resource.refresh}>
        Refresh
      </button>
    </>
  );
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useResource", () => {
  afterEach(() => setVisibility("visible"));

  it("refreshes on an interval while the page is visible, and on focus", async () => {
    setVisibility("visible");
    const load = vi.fn(async () => "loaded");
    render(
      <SessionProvider>
        <Probe load={load} />
      </SessionProvider>,
    );
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(refreshInterval);
    });
    expect(load).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * refreshInterval);
    });
    expect(load).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("never lets an older answer overwrite a newer one", async () => {
    const answers: ((value: string) => void)[] = [];
    const load = () => new Promise<string>((resolve) => answers.push(resolve));
    render(
      <SessionProvider>
        <Probe load={load} />
      </SessionProvider>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flush();
    expect(answers).toHaveLength(2);
    await act(async () => {
      answers[1]?.("newer");
    });
    expect(screen.getByText("newer")).toBeTruthy();
    await act(async () => {
      answers[0]?.("older");
    });
    expect(screen.getByText("newer")).toBeTruthy();
    expect(api.unhandled).toEqual([]);
  });

  it("skips a poll while a load is still under way, but not a refresh", async () => {
    const answers: ((value: string) => void)[] = [];
    const load = vi.fn(() => new Promise<string>((resolve) => answers.push(resolve)));
    render(
      <SessionProvider>
        <Probe load={load} />
      </SessionProvider>,
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * refreshInterval);
    });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      answers[0]?.("first");
      answers[1]?.("second");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(refreshInterval);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("polls again once a load that got no answer gives up", async () => {
    api.on("GET", "/slow", () => new Promise<Reply>(() => {}));
    const load = vi.fn(() => request<string>("GET", "/slow"));
    render(
      <SessionProvider>
        <Probe load={load} />
      </SessionProvider>,
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(requestTimeout - 1);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1 + refreshInterval);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
