import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLinkableUrl, reference, referenceList } from "./references.ts";

const linkable = [
  "https://example.com",
  "HTTPS://Example.com/path?q=1#frag",
  "https://example.com:8443/a/b",
  "https://bücher.example/",
  `https://example.com/${"a".repeat(2028)}`,
];

const notLinkable = [
  "http://example.com",
  "javascript:alert(1)",
  "data:text/html,hi",
  "https:example.com",
  "https:/example.com",
  "//example.com",
  "/relative",
  "https://",
  "https://user@example.com",
  "https://user:secret@example.com",
  "https://example.com/a b",
  "https://example.com/\nx",
  " https://example.com",
  `https://example.com/${String.fromCharCode(0xd800)}`,
  `https://example.com/${"a".repeat(2029)}`,
];

describe("isLinkableUrl", () => {
  it.each(linkable)("accepts %s", (value) => {
    expect(isLinkableUrl(value)).toBe(true);
  });

  it.each(notLinkable)("refuses %j", (value) => {
    expect(isLinkableUrl(value)).toBe(false);
  });
});

// The web UI runs the rule in browsers that lack URL.parse.
describe("isLinkableUrl without URL.parse", () => {
  const parse = Object.getOwnPropertyDescriptor(URL, "parse");

  beforeEach(() => {
    Reflect.deleteProperty(URL, "parse");
  });

  afterEach(() => {
    if (parse !== undefined) {
      Object.defineProperty(URL, "parse", parse);
    }
  });

  it("decides every case as it does with it", () => {
    expect("parse" in URL).toBe(false);
    expect(linkable.filter((value) => !isLinkableUrl(value))).toEqual([]);
    expect(notLinkable.filter((value) => isLinkableUrl(value))).toEqual([]);
  });
});

describe("reference", () => {
  it("needs an identifier, a URL or a thread", () => {
    expect(reference.safeParse({ label: "PR" }).success).toBe(false);
    expect(reference.safeParse({ label: "PR", identifier: "", url: "" }).success).toBe(false);
    expect(reference.safeParse({ label: "PR", identifier: "#12" }).success).toBe(true);
    expect(reference.safeParse({ label: "PR", url: "https://example.com/pr/12" }).success).toBe(
      true,
    );
    expect(reference.safeParse({ label: "Earlier", thread: 3 }).success).toBe(true);
    expect(reference.safeParse({ label: "Earlier", thread: 1.5 }).success).toBe(false);
    // Thread numbers count from 1.
    expect(reference.safeParse({ label: "Earlier", thread: 0 }).success).toBe(false);
  });

  it("refuses a URL that is not linkable", () => {
    const result = reference.safeParse({ label: "PR", url: "http://example.com" });
    expect(result.error?.issues[0]?.path).toEqual(["url"]);
  });

  it("holds at most 20 references", () => {
    const one = { label: "x", identifier: "y" };
    expect(referenceList.safeParse(Array(20).fill(one)).success).toBe(true);
    expect(referenceList.safeParse(Array(21).fill(one)).success).toBe(false);
  });
});
