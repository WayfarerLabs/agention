import { describe, expect, it } from "vitest";
import { readAttributedRows } from "./attributed-rows.ts";

const escape = "\u001b[";

describe("reading rows with their attributes", () => {
  it("gives each row's text without its escapes or trailing spaces, and the faint runs on it", () => {
    expect(
      readAttributedRows([
        `> ${escape}2mapproved, check again${escape}0m${escape}39m${escape}49m   `,
        `${escape}38;5;246m-- INSERT --${escape}39m plain`,
      ]),
    ).toEqual({
      lines: ["> approved, check again", "-- INSERT -- plain"],
      faint: [{ row: 0, from: 2, to: 23 }],
    });
  });

  it("ends faint text at SGR 22 or 0, combined with others, and carries it to the next row", () => {
    const { lines, faint } = readAttributedRows([
      `a${escape}1;2mbc${escape}22md${escape}2mef`,
      `gh${escape}mi`,
    ]);
    expect(lines).toEqual(["abcdef", "ghi"]);
    expect(faint).toEqual([
      { row: 0, from: 1, to: 3 },
      { row: 0, from: 4, to: 6 },
      { row: 1, from: 0, to: 2 },
    ]);
  });

  it("never reads a color's parameters as faint, nor counts another escape as text", () => {
    const { lines, faint } = readAttributedRows([
      `${escape}38;2;2;2;2mone ${escape}48;5;2mtwo ${escape}38:2::2:2:2mthree ` +
        `\u001b]8;;https://a.example\u0007link\u001b]8;;\u001b\\ \u001b(Bend`,
    ]);
    expect(lines).toEqual(["one two three link end"]);
    expect(faint).toEqual([]);
  });

  it("counts a row's runs in code points", () => {
    expect(readAttributedRows([`❯ ${escape}2m𝑥y`]).faint).toEqual([{ row: 0, from: 2, to: 4 }]);
  });
});
