import { z } from "zod";

// Timestamps are bounded to instants in the years 2000 to 9999 (UTC), so a
// timestamp written back out in UTC is always one the schema accepts.
const earliest = Date.UTC(2000, 0, 1);
const latest = Date.UTC(10000, 0, 1) - 1;

// parseTimestamp reads a date-time the timestamp schema accepted as Unix
// milliseconds. Digits beyond milliseconds are dropped.
export function parseTimestamp(value: string): number {
  return Date.parse(value);
}

// formatTimestamp writes Unix milliseconds as an RFC 3339 date-time in UTC.
export function formatTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

// An RFC 3339 date-time with an explicit offset (Z or +hh:mm), with an
// upper-case T and Z, for an instant in the years 2000 to 9999 (UTC).
export const timestamp = z.iso.datetime({ offset: true }).refine((value) => {
  const milliseconds = parseTimestamp(value);
  return milliseconds >= earliest && milliseconds <= latest;
}, "must be in the years 2000 to 9999 (UTC)");
