import { describe, expect, it } from "vitest";
import { groupNameInput, maxTags, tagsInput } from "./groups-and-tags.ts";

describe("groupNameInput", () => {
  it("trims a name and takes 1 to 100 characters on one line", () => {
    expect(groupNameInput.parse({ name: "  Work: billing  " })).toEqual({ name: "Work: billing" });
    expect(groupNameInput.safeParse({ name: "x".repeat(100) }).success).toBe(true);
    for (const name of ["", "   ", "x".repeat(101), "two\nlines"]) {
      expect(groupNameInput.safeParse({ name }).success).toBe(false);
    }
  });
});

describe("tagsInput", () => {
  it(`takes up to ${maxTags} names, each once, none clearing them`, () => {
    const tags = Array.from({ length: maxTags + 1 }, (_, index) => `t${index}`);
    expect(tagsInput.safeParse({ tags: [] }).success).toBe(true);
    expect(tagsInput.safeParse({ tags: tags.slice(0, maxTags) }).success).toBe(true);
    expect(tagsInput.safeParse({ tags }).success).toBe(false);
    expect(tagsInput.safeParse({ tags: ["a", "a"] }).success).toBe(false);
    expect(tagsInput.safeParse({ tags: ["Infra"] }).success).toBe(false);
  });
});
