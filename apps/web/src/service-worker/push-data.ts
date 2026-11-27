import type { PushPayload, PushReason, PushThread } from "@wayfarerlabs/agention-api";
import { matchRoute, threadHref } from "../routes.ts";

// What the service worker reads, checked by hand, since it loads no schema
// library: a push's data, and the thread a notification it showed names. A
// thread is checked by the route the UI has for it. This module does nothing
// as it loads, so the worker's checks are tested apart from the worker.

// The words a notification says why the thread needs the operator in.
export const reasonWords: Record<PushReason, string> = {
  blocking: "Blocking ask",
  urgent: "Urgent ask",
  open: "Open ask",
  message: "New message",
};

export const isReason = (value: unknown): value is PushReason =>
  typeof value === "string" && Object.hasOwn(reasonWords, value);

// threadOf reads the thread a value names, or nothing when it names none: an
// agent's and a session's name and a thread's number whose route the UI
// has.
export function threadOf(value: unknown): PushThread | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { agent, session, thread } = value as Record<string, unknown>;
  return typeof agent === "string" &&
    typeof session === "string" &&
    typeof thread === "number" &&
    matchRoute(threadHref(agent, session, thread)).name === "thread"
    ? { agent, session, thread }
    : undefined;
}

// payloadOf reads a push's data as a notification: a thread, its title, and
// why it needs the operator. A field it does not know is ignored.
export function payloadOf(data: Pick<PushMessageData, "text"> | null): PushPayload | undefined {
  let value: unknown;
  try {
    value = data === null ? undefined : JSON.parse(data.text());
  } catch {
    return undefined;
  }
  const thread = threadOf(value);
  if (thread === undefined) {
    return undefined;
  }
  const { title, why } = value as Record<string, unknown>;
  return typeof title === "string" && isReason(why) ? { ...thread, title, why } : undefined;
}
