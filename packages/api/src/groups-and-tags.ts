import { z } from "zod";
import { maxListed, sequence } from "./bounds.ts";
import { name } from "./names.ts";
import { singleLineText } from "./text.ts";

// The operator's session groups and tags, which organize their views and
// nothing else: no agent route reads or writes them, and they grant nothing.
// A group is a row of its own, which can be empty, renamed, recolored and
// moved in the operator's order, and a session sits in at most one. A tag is
// a row of its own too, a name and a color, which agents and sessions carry,
// and exists until the operator removes it; an agent's tags count for each of
// its sessions.

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

// The colors a group or a tag may have: a fixed palette of named tones, which
// each client draws as it suits its themes. A new group or tag that names no
// color takes the palette's colors in turn, each kind its own: the color
// after as many as there are groups, or tags, already.
export const color = z
  .enum(["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple"])
  .describe(
    "One of the palette's named colors. Created without one, a group takes the palette's " +
      "colors in turn by how many groups there are already, and a tag by how many tags.",
  );
export type Color = z.infer<typeof color>;
export const colors: readonly Color[] = color.options;

// The most groups an instance holds; the most tags it keeps, which every
// listing of them holds whole; and the most tags an agent or a session
// carries.
export const maxGroups = 200;
export const maxTagsKept = maxListed;
export const maxTags = 20;

// A group as the operator's views name it.
export const groupRef = z.object({ id: groupId, name: z.string() });
export type GroupRef = z.infer<typeof groupRef>;

// A group as creating and changing one answers it: its name and its color.
export const groupRead = groupRef.extend({ color });
export type GroupRead = z.infer<typeof groupRead>;

// A tag as creating and changing one answers it.
export const tagRead = z.object({ name: tagName, color });
export type TagRead = z.infer<typeof tagRead>;

// Creating a group takes its name, and its color, by default the next in
// turn. A new group goes last in the operator's order.
export const groupCreateInput = z.object({ name: groupName, color: color.optional() });
export type GroupCreateInput = z.infer<typeof groupCreateInput>;

// Renaming a group takes its new name.
export const groupNameInput = z.object({ name: groupName });
export type GroupNameInput = z.infer<typeof groupNameInput>;

// Creating a tag takes its name, and its color, by default the next in turn.
export const tagCreateInput = z.object({ name: tagName, color: color.optional() });
export type TagCreateInput = z.infer<typeof tagCreateInput>;

// Renaming a tag takes its new name.
export const tagNameInput = z.object({ name: tagName });
export type TagNameInput = z.infer<typeof tagNameInput>;

// Recoloring a group or a tag takes its new color.
export const colorInput = z.object({ color });
export type ColorInput = z.infer<typeof colorInput>;

// Ordering the groups gives every group's id, each once, in the order wanted,
// so a reorder is whole: one that does not name exactly the groups there are,
// as when another client created or removed one since, changes nothing.
export const groupOrderInput = z.object({
  groups: z
    .array(groupId)
    .max(maxGroups)
    .refine((groups) => new Set(groups).size === groups.length, "names a group twice")
    .describe("Every group's id, each once, in the order wanted."),
});
export type GroupOrderInput = z.infer<typeof groupOrderInput>;

// Setting a session's group names it by id, or null for no group.
export const sessionGroupInput = z.object({ group: groupId.nullable() });
export type SessionGroupInput = z.infer<typeof sessionGroupInput>;

// An agent's or a session's tags: the whole set, each name once, none
// clearing them. A name no tag has creates that tag, with the next color in
// turn.
export const tagList = z
  .array(tagName)
  .max(maxTags)
  .refine((tags) => new Set(tags).size === tags.length, "names a tag twice");

// Setting an agent's or a session's tags gives the whole set.
export const tagsInput = z.object({ tags: tagList });
export type TagsInput = z.infer<typeof tagsInput>;

// Every group, in the operator's order, with its color and how many sessions
// it holds; and every tag, in name order, with its color and how many agents
// and sessions carry it, none for a tag nothing carries, at most maxListed of
// them, saying when it leaves any out, which it does not while an instance
// keeps at most maxTagsKept, unless an upgrade carried more tags in use than
// that.
export const groupsAndTags = z.object({
  groups: z.array(groupRead.extend({ sessions: sequence })).max(maxGroups),
  tags: z.array(tagRead.extend({ agents: sequence, sessions: sequence })).max(maxListed),
  truncated: z.boolean(),
});
export type GroupsAndTags = z.infer<typeof groupsAndTags>;
