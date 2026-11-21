import { z } from "zod";
import { maxListed, sequence } from "./bounds.ts";
import { name } from "./names.ts";
import { singleLineText } from "./text.ts";

// The operator's session groups and tags, which organize their views and
// nothing else: no agent route reads or writes them, and they grant nothing.
// A group is a row of its own, which can be empty and renamed, and a session
// sits in at most one. A tag is only a name on an agent or a session, as a
// topic is a name on a thread, and exists while something carries it; an
// agent's tags count for each of its sessions.

export const groupId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export type GroupId = z.infer<typeof groupId>;

// A group's name: plain text on one line, trimmed, 1 to 100 characters, and
// unique among groups ignoring the case of ASCII letters.
export const groupName = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  singleLineText({ min: 1, max: 100 }),
);

// A tag's name is a name, as a topic's is.
export const tagName = name;

// The most groups an instance holds, and the most tags an agent or a session
// carries.
export const maxGroups = 200;
export const maxTags = 20;

// A group as the operator's views name it.
export const groupRef = z.object({ id: groupId, name: z.string() });
export type GroupRef = z.infer<typeof groupRef>;

// Creating a group, and renaming one, take its name.
export const groupNameInput = z.object({ name: groupName });
export type GroupNameInput = z.infer<typeof groupNameInput>;

// Renaming a tag takes its new name.
export const tagNameInput = z.object({ name: tagName });
export type TagNameInput = z.infer<typeof tagNameInput>;

// Setting a session's group names it by id, or null for no group.
export const sessionGroupInput = z.object({ group: groupId.nullable() });
export type SessionGroupInput = z.infer<typeof sessionGroupInput>;

// Setting an agent's or a session's tags gives the whole set, each name once,
// none clearing them.
export const tagsInput = z.object({
  tags: z
    .array(tagName)
    .max(maxTags)
    .refine((tags) => new Set(tags).size === tags.length, "names a tag twice"),
});
export type TagsInput = z.infer<typeof tagsInput>;

// Every group, in name order, with how many sessions it holds; and every tag
// carried, in name order, with how many agents and sessions carry it, at most
// maxListed of them, saying when it leaves any out.
export const groupsAndTags = z.object({
  groups: z.array(groupRef.extend({ sessions: sequence })).max(maxGroups),
  tags: z.array(z.object({ name: tagName, agents: sequence, sessions: sequence })).max(maxListed),
  truncated: z.boolean(),
});
export type GroupsAndTags = z.infer<typeof groupsAndTags>;
