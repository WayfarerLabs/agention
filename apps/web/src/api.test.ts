import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readTextStart, request, requestTimeout } from "./api.ts";

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

it("reads a text file's start as UTF-8, leaving out a character the range cut", async () => {
  vi.useRealTimers();
  // "aé" is 3 bytes; a range of 2 cuts the é in half.
  const bytes = new TextEncoder().encode("a\u00e9");
  vi.stubGlobal("fetch", async () => new Response(bytes, { status: 206 }));
  await expect(readTextStart("/file", 2)).resolves.toBe("a");
  await expect(readTextStart("/file", 3)).resolves.toBe("a\u00e9");
  // Invalid bytes read as replacement characters.
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array([0x61, 0xff]), { status: 200 }));
  await expect(readTextStart("/file", 10)).resolves.toBe("a\ufffd");
});
