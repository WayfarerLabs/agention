import { cursor } from "@wayfarerlabs/agention-api";
import { threadGrouping, threadSort } from "@wayfarerlabs/agention-server-api";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./opaque-cursors.ts";

describe("opaque cursors", () => {
  it("read back the values written for the same list", () => {
    const values = [0, -1, 1, 127, -128, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
    const kinds = values.map(() => "number" as const);
    expect(decodeCursor("threads", encodeCursor("threads", values), kinds, "cursor")).toEqual(
      values,
    );
    const mixed = encodeCursor("agents", ["builder", "", "zoë", 42]);
    expect(
      decodeCursor("agents", mixed, ["string", "string", "string", "number"], "cursor"),
    ).toEqual(["builder", "", "zoë", 42]);
  });

  it.each([
    ["another list", encodeCursor("registrations", [1]), ["number"]],
    ["a value of another kind", encodeCursor("threads", ["one"]), ["number"]],
    ["fewer values", encodeCursor("threads", [1]), ["number", "number"]],
    ["more values", encodeCursor("threads", [1, 2]), ["number"]],
    ["text that is no position", "not a cursor", ["number"]],
    [
      "a cut-off position",
      encodeCursor("threads", [Number.MAX_SAFE_INTEGER]).slice(0, -2),
      ["number"],
    ],
  ] as const)("refuse %s", (_, text, kinds) => {
    expect(() => decodeCursor("threads", text, kinds, "cursor")).toThrow(
      expect.objectContaining({ code: "invalid_input", field: "cursor" }),
    );
  });

  it("keep a grouped list's position within a cursor's bound, every key at its widest", () => {
    // Three sets of the nine keys a thread is ordered by, each written as
    // wide as a key can be, under each order and grouping's name.
    const position = Array<number>(27).fill(-Number.MAX_SAFE_INTEGER);
    for (const sort of threadSort.options) {
      for (const group of threadGrouping.options) {
        expect(cursor.safeParse(encodeCursor(`threads.${sort}.${group}`, position)).success).toBe(
          true,
        );
      }
    }
  });
});
