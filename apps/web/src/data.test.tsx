import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, requestTimeout } from "./api.ts";
import { refreshInterval, useResource } from "./data.ts";
import { type Session, SessionProvider, useSession } from "./session.tsx";
import { FakeApi, type Reply, signedIn } from "./test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Probe({ load }: { load: (signal: AbortSignal) => Promise<string> }) {
  const resource = useResource(load);
  return (
    <>
      <p>{resource.data ?? "nothing"}</p>
      {resource.failure !== undefined && <p role="alert">failed</p>}
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

  // Holder hands the test the resource's refresh, to read what it returns.
  function Holder({
    load,
    take,
  }: {
    load: () => Promise<string>;
    take: (refresh: () => Promise<boolean>) => void;
  }) {
    const resource = useResource(load);
    take(resource.refresh);
    return <p>{resource.data ?? "nothing"}</p>;
  }

  it("settles a refresh, as bringing data, once a newer load's answer passed its own over", async () => {
    const answers: ((value: string) => void)[] = [];
    const load = () => new Promise<string>((resolve) => answers.push(resolve));
    let refresh = (): Promise<boolean> => Promise.resolve(false);
    render(
      <SessionProvider>
        <Holder load={load} take={(each) => (refresh = each)} />
      </SessionProvider>,
    );
    await flush();
    let settled: boolean | undefined;
    await act(async () => {
      void refresh().then((brought) => {
        settled = brought;
      });
      void refresh();
    });
    expect(answers).toHaveLength(3);
    await act(async () => {
      answers[2]?.("newest");
    });
    expect(screen.getByText("newest")).toBeTruthy();
    await act(async () => {
      answers[1]?.("older");
    });
    expect(settled).toBe(true);
    expect(screen.getByText("newest")).toBeTruthy();
  });

  it("settles a refresh as older when a newer load failed and passed its own over", async () => {
    const answers: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
    const load = () => new Promise<string>((resolve, reject) => answers.push({ resolve, reject }));
    let refresh = (): Promise<boolean> => Promise.resolve(true);
    render(
      <SessionProvider>
        <Holder load={load} take={(each) => (refresh = each)} />
      </SessionProvider>,
    );
    await flush();
    await act(async () => {
      answers[0]?.resolve("first");
    });
    let settled: boolean | undefined;
    await act(async () => {
      void refresh().then((brought) => {
        settled = brought;
      });
      void refresh();
    });
    await act(async () => {
      answers[2]?.reject(new Error("unreachable"));
    });
    await act(async () => {
      answers[1]?.resolve("passed over");
    });
    // What is shown is older than the load: the first answer still.
    expect(settled).toBe(false);
    expect(screen.getByText("first")).toBeTruthy();
  });

  it("settles a refresh, as bringing nothing rather than failing, once its load fails", async () => {
    let fail = false;
    const load = async () => {
      if (fail) {
        throw new Error("unreachable");
      }
      return "loaded";
    };
    let refresh = (): Promise<boolean> => Promise.resolve(false);
    render(
      <SessionProvider>
        <Holder load={load} take={(each) => (refresh = each)} />
      </SessionProvider>,
    );
    await flush();
    let outcome = "pending";
    const settle = () =>
      refresh().then(
        (brought) => {
          outcome = brought ? "brought" : "kept";
        },
        () => {
          outcome = "failed";
        },
      );
    await act(settle);
    expect(outcome).toBe("brought");
    fail = true;
    await act(settle);
    expect(outcome).toBe("kept");
    expect(screen.getByText("loaded")).toBeTruthy();
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

  it("asks nothing while an ending holds it, and again once every hold is released or the session signed out and in", async () => {
    setVisibility("visible");
    const load = vi.fn(async (_signal: AbortSignal) => "loaded");
    let session: Session | undefined;
    function Capture() {
      session = useSession();
      return null;
    }
    render(
      <SessionProvider>
        <Probe load={load} />
        <Capture />
      </SessionProvider>,
    );
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    const current = () => {
      if (session === undefined) {
        throw new Error("no session");
      }
      return session;
    };
    const asked = async () => {
      window.dispatchEvent(new Event("focus"));
      await flush();
      return load.mock.calls.length;
    };

    // Two endings at once, such as removing this browser's passkey and then
    // signing out: the first to fail leaves the other's hold.
    const removal = current().signingOut();
    const signOut = current().signingOut();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * refreshInterval);
    });
    expect(await asked()).toBe(1);
    removal();
    removal();
    expect(await asked()).toBe(1);
    signOut();
    expect(await asked()).toBe(2);
    // A load once every hold is released can be stopped by the next ending,
    // not one already over.
    expect(load.mock.calls.at(-1)?.[0].aborted).toBe(false);

    // A sign-out that landed leaves nothing held once the operator signs in
    // again, though its release never came.
    current().signingOut();
    act(() => current().update({ signed_in: false, operator_exists: true }));
    act(() => current().update(signedIn));
    await flush();
    const before = load.mock.calls.length;
    expect(await asked()).toBe(before + 1);
  });

  it("aborts a load under way once an ending starts, quietly", async () => {
    let signal: AbortSignal | undefined;
    const load = vi.fn(
      (given: AbortSignal) =>
        new Promise<string>((_, reject) => {
          signal = given;
          given.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    let session: Session | undefined;
    function Capture() {
      session = useSession();
      return null;
    }
    render(
      <SessionProvider>
        <Probe load={load} />
        <Capture />
      </SessionProvider>,
    );
    await flush();
    expect(signal?.aborted).toBe(false);
    act(() => {
      session?.signingOut();
    });
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
