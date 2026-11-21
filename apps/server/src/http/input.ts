import {
  groupId,
  invalidInputBody,
  name,
  passkeyId,
  queryNumber,
  registrationId,
  tagName,
  threadNumber,
} from "@wayfarerlabs/agention-api";
import type { Context } from "hono";
import { ApiError } from "../errors.ts";
import type { SessionTarget, ThreadTarget } from "../store/index.ts";

// Every route reads its input, path, query and body alike, through the shared
// schemas, so a request breaking a bound fails as invalid_input before any
// operation runs, naming the input at fault.

// The part of a zod schema the routes use.
export interface Schema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: Parameters<typeof invalidInputBody>[0] };
}

export function parse<T>(schema: Schema<T>, value: unknown, prefix?: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const { error } = invalidInputBody(result.error);
  const field = [prefix, error.field].filter((part) => part !== undefined).join(".");
  throw new ApiError("invalid_input", error.message, field === "" ? {} : { field });
}

// parseQuery reads the query string: a parameter given once as its text, and
// one given several times, as a filter of several values is, as the list of
// them, which a schema that takes one value refuses.
export function parseQuery<T>(c: Context, schema: Schema<T>): T {
  const values = Object.entries(c.req.queries()).map(([key, all]) => [
    key,
    all.length === 1 ? all[0] : all,
  ]);
  return parse(schema, Object.fromEntries(values));
}

// The decoder for request bodies, which refuses bytes that are not UTF-8
// rather than replacing them, and keeps a byte order mark for JSON to refuse.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// parseBody reads a JSON body. Its size was bounded before the route ran.
export async function parseBody<T>(c: Context, schema: Schema<T>): Promise<T> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json(;|$)/i.test(type)) {
    throw new ApiError("invalid_input", "send the body as application/json");
  }
  let text: string;
  try {
    text = utf8.decode(await c.req.arrayBuffer());
  } catch {
    throw new ApiError("invalid_input", "the body is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError("invalid_input", "the body is not valid JSON");
  }
  return parse(schema, value);
}

export function sessionTarget(c: Context): SessionTarget {
  return {
    agent: parse(name, c.req.param("agent"), "agent"),
    session: parse(name, c.req.param("session"), "session"),
  };
}

export function threadTarget(c: Context): ThreadTarget {
  return {
    ...sessionTarget(c),
    thread: parse(queryNumber(threadNumber), c.req.param("n"), "thread"),
  };
}

export function registrationOf(c: Context): number {
  return parse(queryNumber(registrationId), c.req.param("id"), "id");
}

export function passkeyOf(c: Context): number {
  return parse(queryNumber(passkeyId), c.req.param("id"), "id");
}

export function groupOf(c: Context): number {
  return parse(queryNumber(groupId), c.req.param("id"), "id");
}

export function tagOf(c: Context): string {
  return parse(tagName, c.req.param("tag"), "tag");
}

export function agentOf(c: Context): string {
  return parse(name, c.req.param("agent"), "agent");
}
