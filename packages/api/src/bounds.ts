import { z } from "zod";

// Message sequences, and the counts derived from them: integers JavaScript
// represents exactly.
export const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// Thread numbers count from 1 within a session and share the sequences' bound.
export const threadNumber = sequence;

// Ask numbers count from 1 within a thread and share the sequences' bound.
export const askNumber = sequence.min(1);

// A client-chosen identifier that makes a write safe to retry.
export const requestId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, "must be 1 to 64 of A-Z, a-z, 0-9, '.', '_', ':' and '-'");

// A position in a list, opaque to clients: they pass back what they were given.
// It has room for a grouped list's position, three sets of a thread's keys.
export const cursor = z.string().min(1).max(1_024);

// The size of every page and bulk list.
export const pageLimit = z.number().int().min(1).max(100).default(50);

// Lists that come whole rather than in pages, of agents, sessions and topics,
// hold at most this many and say when they leave any out.
export const maxListed = 500;

// Query string values arrive as text. These read the text into the value the
// wrapped schema validates, and leave anything else for it to refuse, so query
// bounds are the same schemas as body bounds.
export function queryNumber<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value),
    schema,
  );
}

export function queryBoolean<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    schema,
  );
}

// A query parameter that takes several values repeats, once for each; the
// server reads one that appears once as its text, and wraps it in a list here.
export function queryList<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (typeof value === "string" ? [value] : value), schema);
}
