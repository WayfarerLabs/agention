import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { request, requestTimeout } from "./api.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// hang makes fetch answer nothing until its request is aborted.
function hang() {
  const fetch = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("gives up on a request that gets no answer in time", async () => {
  hang();
  const settled = vi.fn();
  const answer = request("GET", "/threads");
  answer.catch(settled);
  await vi.advanceTimersByTimeAsync(requestTimeout - 1);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(answer).rejects.toMatchObject({
    code: "network",
    message: "Agention did not answer in time. Check the connection.",
  });
});

it("stops waiting once an answer arrives", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ threads: [] }));
  await expect(request("GET", "/threads")).resolves.toEqual({ threads: [] });
  expect(vi.getTimerCount()).toBe(0);
});
