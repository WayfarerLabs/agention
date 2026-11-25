import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../session.tsx";
import { FakeApi, type FakeUpload, installUploads, uploadAnswer } from "../test-support.tsx";
import { useDraftFiles } from "./attach.ts";

// useDraftFiles on its own, for what no writer's page reaches today: two
// sends on their way carrying the same file.

let api: FakeApi;
let uploads: FakeUpload[];

beforeEach(() => {
  api = new FakeApi();
  uploads = installUploads();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api.unhandled).toEqual([]);
});

const ref = "A".repeat(22);
const removal = `/s/builder/main/uploads/${ref}/remove`;

// A send a test settles: as landed or not.
function pendingSend() {
  let settle: (landed: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => (settle = resolve));
  return { promise, settle };
}

describe("a file two sends carry", () => {
  it("stays carried until the last of them settles without landing", async () => {
    api.on("POST", removal, { body: {} });
    const { result, unmount } = renderHook(
      () => useDraftFiles({ agent: "builder", session: "main" }),
      { wrapper: SessionProvider },
    );
    act(() => result.current.add([{ file: new File(["x"], "a.png"), name: "a.png" }]));
    await waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0]?.respond(uploadAnswer(ref, "a.png", 1));
    await waitFor(() => expect(result.current.files[0]?.kind).toBe("added"));
    await waitFor(() =>
      expect(result.current.files[0]?.kind === "added" && result.current.files[0].state.kind).toBe(
        "uploaded",
      ),
    );
    const id = result.current.files[0]!.id;
    const first = pendingSend();
    const second = pendingSend();
    let carrying: Promise<unknown>[] = [];
    act(() => {
      carrying = [
        result.current.carry(
          [id],
          () => first.promise,
          (landed) => landed,
        ),
        result.current.carry(
          [id],
          () => second.promise,
          (landed) => landed,
        ),
      ];
    });
    // The first fails; the second still carries the file, so leaving keeps
    // its upload, and Remove waits.
    await act(async () => {
      first.settle(false);
      await carrying[0];
    });
    expect(result.current.carried.has(id)).toBe(true);
    act(() => result.current.remove(id));
    expect(result.current.files).toHaveLength(1);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.callsTo("POST", removal)).toEqual([]);
    // Once the second fails too, nothing carries it, and the writer is gone.
    second.settle(false);
    await carrying[1];
    await waitFor(() => expect(api.callsTo("POST", removal)).toHaveLength(1));
  });
});
