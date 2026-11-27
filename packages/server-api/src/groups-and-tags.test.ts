import { describe, expect, it } from "vitest";
import {
  colorInput,
  colors,
  groupNameInput,
  groupOrderInput,
  maxTags,
  tagsInput,
} from "./groups-and-tags.ts";
import { approveInput } from "./registrations.ts";

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

describe("colorInput", () => {
  it("takes each of the palette's colors and nothing else", () => {
    for (const each of colors) {
      expect(colorInput.parse({ color: each })).toEqual({ color: each });
    }
    for (const each of ["pink", "Red", "#ff0000", "", undefined]) {
      expect(colorInput.safeParse({ color: each }).success).toBe(false);
    }
  });
});

describe("groupOrderInput", () => {
  it("takes ids each once, and an empty order", () => {
    expect(groupOrderInput.parse({ groups: [3, 1, 2] })).toEqual({ groups: [3, 1, 2] });
    expect(groupOrderInput.safeParse({ groups: [] }).success).toBe(true);
    expect(groupOrderInput.safeParse({ groups: [1, 1] }).success).toBe(false);
    expect(groupOrderInput.safeParse({ groups: [0] }).success).toBe(false);
  });
});

describe("approveInput", () => {
  const approval = { agent: { name: "builder", existing: true } };

  it("takes a session's group by id or none, and its tags", () => {
    for (const session of [
      { name: "main", existing: false },
      { name: "main", existing: false, group: 4, tags: ["infra"] },
      { name: "main", existing: true, group: null, tags: [] },
    ]) {
      expect(approveInput.parse({ ...approval, session })).toEqual({ ...approval, session });
    }
    for (const fields of [{ group: "Work" }, { group: 0 }, { tags: ["infra", "infra"] }]) {
      const session = { name: "main", existing: false, ...fields };
      expect(approveInput.safeParse({ ...approval, session }).success).toBe(false);
    }
  });
});
