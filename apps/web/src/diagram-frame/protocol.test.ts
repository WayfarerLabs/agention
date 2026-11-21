import { describe, expect, it } from "vitest";
import { maxDiagramSource, tooLongToDraw } from "./protocol.ts";

describe("tooLongToDraw", () => {
  it("allows a source up to the limit and refuses one past it", () => {
    expect(tooLongToDraw("x".repeat(maxDiagramSource))).toBe(false);
    expect(tooLongToDraw("x".repeat(maxDiagramSource + 1))).toBe(true);
  });

  it("counts code points, not UTF-16 units", () => {
    // Each of these is one code point and two UTF-16 units.
    expect(tooLongToDraw("😀".repeat(maxDiagramSource))).toBe(false);
    expect(tooLongToDraw("😀".repeat(maxDiagramSource + 1))).toBe(true);
  });
});
