import {
  type GroupsAndTags,
  noGroup,
  type SessionGroupsFilter,
  type ThreadList,
  type ThreadSummary,
} from "@wayfarerlabs/agention-api";

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

// A thread as the operator's list shows it, with its session's group.
export type ListedThread = ThreadList["threads"][number];

// distinct keeps each thread once: one that moved between two pages as they
// loaded comes back on both.
export function distinct<T extends ThreadSummary>(threads: T[]): T[] {
  const seen = new Set<string>();
  return threads.filter((thread) => {
    const key = `${thread.agent}/${thread.session}/${thread.number}`;
    const first = !seen.has(key);
    seen.add(key);
    return first;
  });
}

// removedGroup is what groupNamed gives for a group no longer there: a value
// no group's name can be, so a group named "removed" is not taken for one.
export const removedGroup = Symbol("removed group");

// What the group filter's value names, as the operator's groups and tags
// say, while they are known: no group; a group, by its name now; or
// removedGroup for a group no longer there.
export function groupNamed(
  value: SessionGroupsFilter[number],
  known: GroupsAndTags | undefined,
): string | typeof removedGroup | undefined {
  if (value === noGroup) {
    return "No group";
  }
  if (known === undefined) {
    return undefined;
  }
  return known.groups.find((group) => group.id === value)?.name ?? removedGroup;
}

// tagKept says whether a tag is there, not removed, as the operator's groups
// and tags say, which list every tag, those nothing carries among them; while
// they are not known, or leave tags out, it is taken to be.
export function tagKept(tag: string, known: GroupsAndTags | undefined): boolean {
  return known === undefined || known.truncated || known.tags.some((each) => each.name === tag);
}
