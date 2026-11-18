import type { ThreadSummary } from "@wayfarerlabs/agention-api";

// The sessions and topics the list names, and the threads it loads.

// The session a path written agent/session names.
export function sessionOf(path: string): { agent: string; session: string } {
  const [agent = "", session = ""] = path.split("/");
  return { agent, session };
}

// topicShown writes a topic, named by a path written agent/session/topic,
// as it shows standing apart from its session: session/topic, its agent
// left out, as a session is shown without its own.
export function topicShown(path: string): string {
  const [, session = "", topic = ""] = path.split("/");
  return `${session}/${topic}`;
}

// distinct keeps each thread once: one that moved between two pages as they
// loaded comes back on both.
export function distinct(threads: ThreadSummary[]): ThreadSummary[] {
  const seen = new Set<string>();
  return threads.filter((thread) => {
    const key = `${thread.agent}/${thread.session}/${thread.number}`;
    const first = !seen.has(key);
    seen.add(key);
    return first;
  });
}
