import { describe, expect, it } from "vitest";
import { formatTimestamp, parseTimestamp, timestamp } from "./time.ts";

describe("timestamp", () => {
  it.each([
    ["2026-10-27T12:00:00Z", Date.UTC(2026, 9, 27, 12)],
    ["2026-10-27T14:30:00+02:30", Date.UTC(2026, 9, 27, 12)],
    ["2026-10-27T05:00:00-07:00", Date.UTC(2026, 9, 27, 12)],
    ["2026-10-27T12:00:00.5Z", Date.UTC(2026, 9, 27, 12, 0, 0, 500)],
    ["2026-10-27T12:00:00.123456789Z", Date.UTC(2026, 9, 27, 12, 0, 0, 123)],
    ["2028-02-29T00:00:00Z", Date.UTC(2028, 1, 29)],
    ["2000-01-01T00:00:00Z", Date.UTC(2000, 0, 1)],
    ["1999-12-31T23:30:00-01:00", Date.UTC(2000, 0, 1, 0, 30)],
    ["9999-12-31T23:59:59.999Z", Date.UTC(9999, 11, 31, 23, 59, 59, 999)],
  ])("accepts %s", (value, milliseconds) => {
    expect(timestamp.safeParse(value).success).toBe(true);
    expect(parseTimestamp(value)).toBe(milliseconds);
  });

  it.each([
    "2026-10-27T12:00:00",
    "2026-10-27t12:00:00z",
    "2026-10-27",
    "2026-10-27 12:00:00Z",
    "2026-10-27T12:00Z",
    "1999-12-31T23:59:59Z",
    "2000-01-01T00:30:00+01:00",
    "9999-12-31T23:59:59-01:00",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-10-27T24:00:00Z",
    "2026-12-31T23:59:60Z",
    "2026-10-27T12:00:00+24:00",
    "2026-10-27T12:00:00+0200",
    " 2026-10-27T12:00:00Z",
  ])("refuses %j", (value) => {
    expect(timestamp.safeParse(value).success).toBe(false);
  });

  it("writes every accepted instant back out as one it accepts", () => {
    for (const value of ["2000-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z"]) {
      const written = formatTimestamp(parseTimestamp(value));
      expect(timestamp.safeParse(written).success).toBe(true);
      expect(parseTimestamp(written)).toBe(parseTimestamp(value));
    }
  });
});
