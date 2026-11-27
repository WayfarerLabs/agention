import type { ThreadSummary } from "@wayfarerlabs/agention-api";
import type {
  ThreadAction,
  ThreadActionInput,
  ThreadActionResult,
} from "@wayfarerlabs/agention-server-api";
import { request } from "../../api.ts";
import { plural } from "../../format.tsx";

// The list's actions on many threads at once, which the bar at its foot
// takes in both its states.

// Each action's name, as its control and a failure of it say.
export const actionLabel: Record<ThreadAction, string> = {
  read: "Mark read",
  unread: "Mark unread",
  read_and_archive: "Mark read and archive",
  decline_read_and_archive: "Decline, mark read and archive",
};

// targetsOf names threads as an action takes them, each through the latest
// message the list showed, so a message that arrived since stays unread and
// keeps its thread in the list.
export function targetsOf(threads: readonly ThreadSummary[]): ThreadActionInput["threads"] {
  return threads.map((thread) => ({
    agent: thread.agent,
    session: thread.session,
    thread: thread.number,
    through: thread.last_seq,
  }));
}

// actOn does an action to the threads named, in one request.
export function actOn(
  action: ThreadAction,
  threads: ThreadActionInput["threads"],
  csrf: string | undefined,
): Promise<ThreadActionResult> {
  return request<ThreadActionResult>("POST", "/threads/actions", {
    csrf,
    body: { action, threads } satisfies ThreadActionInput,
  });
}

// outcome says what an action did.
export function outcome(action: ThreadAction, done: ThreadActionResult): string {
  const acted = done.acted.length;
  switch (action) {
    case "read":
      return `Marked ${plural(acted, "thread")} read.`;
    case "unread":
      return `Marked ${plural(acted, "thread")} unread.`;
    case "read_and_archive":
      return (
        `Archived ${plural(acted, "thread")}.` +
        (done.kept.length === 0
          ? ""
          : ` Kept ${plural(done.kept.length, "thread")} with an ask open to you.`)
      );
    case "decline_read_and_archive": {
      const asks = done.declined.reduce((sum, each) => sum + each.asks.length, 0);
      return (
        (asks === 0
          ? ""
          : `Declined ${plural(asks, "ask")} in ${plural(done.declined.length, "thread")}. `) +
        `Archived ${plural(acted, "thread")}.` +
        (done.kept.length === 0
          ? ""
          : ` Kept ${plural(done.kept.length, "thread")} with a message you have not seen.`)
      );
    }
  }
}
