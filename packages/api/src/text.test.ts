import { describe, expect, it } from "vitest";
import { codePointLength, multilineText, quoted, singleLineText } from "./text.ts";

const astral = "\u{1F600}";
const loneSurrogate = String.fromCharCode(0xd800);
const lineSeparator = String.fromCharCode(0x2028);
const nextLine = String.fromCharCode(0x85);
const zeroWidthSpace = String.fromCharCode(0x200b);
const rightToLeftOverride = String.fromCharCode(0x202e);
const byteOrderMark = String.fromCharCode(0xfeff);
const paragraphSeparator = String.fromCharCode(0x2029);

describe("codePointLength", () => {
  it("counts a character outside the Basic Multilingual Plane once", () => {
    expect(codePointLength(`a${astral}b`)).toBe(3);
    expect(codePointLength(loneSurrogate)).toBe(1);
  });
});

describe("singleLineText", () => {
  const schema = singleLineText({ min: 1, max: 3 });

  it("bounds code points, not UTF-16 units", () => {
    expect(schema.safeParse(astral.repeat(3)).success).toBe(true);
    expect(schema.safeParse(astral.repeat(4)).success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
  });

  it.each([
    ["a line feed", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a tab", "a\tb"],
    ["DEL", "a\u007fb"],
    ["next line", `a${nextLine}b`],
    ["a line separator", `a${lineSeparator}b`],
    ["a paragraph separator", `a${paragraphSeparator}b`],
    ["a zero-width space", `a${zeroWidthSpace}b`],
    ["a bidirectional override", `a${rightToLeftOverride}b`],
    ["a bidirectional isolate", "a\u2066b\u2069"],
    ["a word joiner", "a\u2060b"],
    ["a byte order mark", `${byteOrderMark}ab`],
    ["NUL", "a\u0000b"],
    ["an unpaired surrogate", `a${loneSurrogate}`],
  ])("refuses %s", (_, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["an emoji sequence with joiners", "\u{1F3F3}\uFE0F\u200D\u{1F308}"],
    ["a zero-width non-joiner", "\u0645\u06CC\u200C\u0634"],
    ["a soft hyphen", "a\u00ADb"],
  ])("keeps %s", (_, value) => {
    expect(singleLineText({ min: 1, max: 10 }).safeParse(value).success).toBe(true);
  });

  it("advertises its bounds in JSON Schema", () => {
    expect(schema.toJSONSchema()).toMatchObject({ type: "string", minLength: 1, maxLength: 3 });
  });
});

describe("multilineText", () => {
  const schema = multilineText({ min: 0, max: 10 });

  it("keeps line breaks, tabs and format characters", () => {
    expect(schema.safeParse(`a\r\nb\n\tc${zeroWidthSpace}`).success).toBe(true);
  });

  it.each([
    ["NUL", "a\u0000b"],
    ["an unpaired surrogate", `a${loneSurrogate}`],
  ])("refuses %s", (_, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe("quoted", () => {
  it("quotes a short value whole", () => {
    expect(quoted('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("keeps the first 100 characters of a longer one, counting code points", () => {
    expect(quoted("\u{1D518}".repeat(150))).toBe(`"${"\u{1D518}".repeat(100)}\u2026"`);
  });
});
