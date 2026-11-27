import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useFolds } from "./device.ts";

afterEach(cleanup);

const key = "agention.test.folds";

describe("useFolds", () => {
  it("keeps the names every part of a page folds under one key", () => {
    // Two parts of a page folding under one key, as two groups' agents do.
    const { result } = renderHook(() => [useFolds(key), useFolds(key)] as const);
    act(() => result.current[0].toggle("a"));
    act(() => result.current[1].toggle("b"));
    for (const folds of result.current) {
      expect(["a", "b"].map((name) => folds.has(name))).toEqual([true, true]);
    }
    expect(JSON.parse(window.localStorage.getItem(key) ?? "[]")).toEqual(["a", "b"]);
    // A page shown afresh reads them back.
    cleanup();
    const again = renderHook(() => useFolds(key));
    expect(["a", "b"].map((name) => again.result.current.has(name))).toEqual([true, true]);
  });
});
