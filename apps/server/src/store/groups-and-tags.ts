import {
  type Color,
  type ColorInput,
  colors,
  type GroupCreateInput,
  type GroupNameInput,
  type GroupOrderInput,
  type GroupRead,
  type GroupsAndTags,
  maxGroups,
  maxListed,
  maxTagsKept,
  type Scope,
  type SessionGroupInput,
  type TagCreateInput,
  type TagNameInput,
  type TagRead,
  type TagsInput,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import { ApiError, invalidInput, notFound } from "../errors.ts";
import { authorizeScope, type Identity } from "../identity.ts";
import { findAgentId, resolveSession } from "./directory.ts";
import type { Store } from "./store.ts";
import type { SessionTarget } from "./threads.ts";

// The operator's session groups and tags. Only the operator reaches them,
// through the sessions scopes their identity holds: sessions:read to list
// them, sessions:write to change them; to anyone else they do not exist. A
// group is a row of its own, so it can be empty, renamed, recolored and
// moved, and a session sits in at most one, which a table keyed on the
// session holds. Groups keep the operator's order as unique positions, a new
// one last. A tag is a row of its own too, which agent_tags and session_tags
// name by a foreign key, so renaming one renames it everywhere it is carried
// and removing one takes it off everything, by cascades; a tag exists until it
// is removed, and setting an agent's or a session's tags creates any it names
// that does not exist yet.

// conflict refuses a name another group or tag already has.
function conflict(what: string): ApiError {
  return new ApiError("conflict", `another ${what} already has this name`, { field: "name" });
}

// operate runs fn in a transaction once the identity is found to hold the
// scope.
function operate<T>(store: Store, identity: Identity, scope: Scope, fn: (db: Database) => T): T {
  const { db } = store;
  return db.transaction(() => {
    authorizeScope(db, identity, scope, store.clock());
    return fn(db);
  });
}

// colorInTurn is the color a group or a tag created without one takes: the
// palette's colors in turn, by how many of its kind there are before it.
function colorInTurn(count: number): Color {
  return colors[count % colors.length] as Color;
}

// listGroupsAndTags lists every group, in the operator's order, with its color
// and how many sessions it holds, and every tag, in name order, with its color
// and how many agents and sessions carry it, at most maxListed of them, saying
// when it leaves any out.
export function listGroupsAndTags(store: Store, identity: Identity): GroupsAndTags {
  return operate(store, identity, "sessions:read", (db) => {
    const groups = db
      .prepare(
        `SELECT g.id, g.name, g.color, count(m.session_id) AS sessions
         FROM session_groups g LEFT JOIN session_group_members m ON m.group_id = g.id
         GROUP BY g.id ORDER BY g.position`,
      )
      .all() as { id: number; name: string; color: Color; sessions: number }[];
    const tags = db
      .prepare(
        `SELECT t.name, t.color,
           (SELECT count(*) FROM agent_tags a WHERE a.name = t.name) AS agents,
           (SELECT count(*) FROM session_tags s WHERE s.name = t.name) AS sessions
         FROM tags t ORDER BY t.name LIMIT ?`,
      )
      .all(maxListed + 1) as { name: string; color: Color; agents: number; sessions: number }[];
    return {
      groups: groups.map((group) => ({ ...group })),
      tags: tags.slice(0, maxListed).map((tag) => ({ ...tag })),
      truncated: tags.length > maxListed,
    };
  });
}

// groupNamed finds the group holding a name, ignoring the case of ASCII
// letters, as the name's uniqueness does.
function groupNamed(db: Database, name: string): number | undefined {
  const row = db.prepare("SELECT id FROM session_groups WHERE name = ?").get(name) as
    { id: number } | undefined;
  return row?.id;
}

// readGroup reads a group as its changes answer it, refusing one that does not
// exist as not found.
function readGroup(db: Database, id: number): GroupRead {
  const row = db.prepare("SELECT id, name, color FROM session_groups WHERE id = ?").get(id) as
    GroupRead | undefined;
  if (row === undefined) {
    throw notFound("id");
  }
  return { ...row };
}

// createGroup creates an empty group, last in the operator's order, with the
// color given or the next in turn, while the instance holds fewer than
// maxGroups.
export function createGroup(store: Store, identity: Identity, input: GroupCreateInput): GroupRead {
  return operate(store, identity, "sessions:write", (db) => {
    if (groupNamed(db, input.name) !== undefined) {
      throw conflict("group");
    }
    const { count, last } = db
      .prepare("SELECT count(*) AS count, COALESCE(max(position), 0) AS last FROM session_groups")
      .get() as { count: number; last: number };
    if (count >= maxGroups) {
      throw invalidInput(undefined, `there are already ${maxGroups} groups, the most there can be`);
    }
    const { id } = db
      .prepare(
        `INSERT INTO session_groups (name, color, position, created_at) VALUES (?, ?, ?, ?)
         RETURNING id`,
      )
      .get(input.name, input.color ?? colorInTurn(count), last + 1, store.clock()) as {
      id: number;
    };
    return readGroup(db, id);
  });
}

// renameGroup names a group anew. Its sessions stay in it, and a filter by
// its id keeps working.
export function renameGroup(
  store: Store,
  identity: Identity,
  id: number,
  input: GroupNameInput,
): GroupRead {
  return operate(store, identity, "sessions:write", (db) => {
    const holder = groupNamed(db, input.name);
    if (holder !== undefined && holder !== id) {
      throw conflict("group");
    }
    const renamed = db
      .prepare("UPDATE session_groups SET name = ? WHERE id = ?")
      .run(input.name, id);
    if (renamed.changes !== 1) {
      throw notFound("id");
    }
    return readGroup(db, id);
  });
}

// recolorGroup gives a group a new color.
export function recolorGroup(
  store: Store,
  identity: Identity,
  id: number,
  input: ColorInput,
): GroupRead {
  return operate(store, identity, "sessions:write", (db) => {
    db.prepare("UPDATE session_groups SET color = ? WHERE id = ?").run(input.color, id);
    return readGroup(db, id);
  });
}

// orderGroups puts the groups in the order given, which names every group
// exactly once: a list naming any other set, as when another client created
// or removed a group since, is refused and changes nothing. The positions are
// unique, so they move in two steps: every group past the highest position,
// then each to its place, neither step ever holding one position twice.
export function orderGroups(store: Store, identity: Identity, input: GroupOrderInput): void {
  operate(store, identity, "sessions:write", (db) => {
    const ids = (db.prepare("SELECT id FROM session_groups").all() as { id: number }[]).map(
      (row) => row.id,
    );
    const given = new Set(input.groups);
    if (ids.length !== given.size || ids.some((id) => !given.has(id))) {
      throw invalidInput(
        "groups",
        "must name every group there is, each once; reload the groups and order them again",
      );
    }
    db.prepare(
      "UPDATE session_groups SET position = position + (SELECT max(position) FROM session_groups)",
    ).run();
    const place = db.prepare("UPDATE session_groups SET position = ? WHERE id = ?");
    input.groups.forEach((id, index) => {
      place.run(index + 1, id);
    });
  });
}

// removeGroup removes a group, which leaves its sessions in no group: the
// cascade takes its memberships in the same statement.
export function removeGroup(store: Store, identity: Identity, id: number): void {
  operate(store, identity, "sessions:write", (db) => {
    if (db.prepare("DELETE FROM session_groups WHERE id = ?").run(id).changes !== 1) {
      throw notFound("id");
    }
  });
}

// tagExists says whether a tag of the name exists.
function tagExists(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM tags WHERE name = ?").get(name) !== undefined;
}

// readTag reads a tag as its changes answer it, refusing one that does not
// exist as not found.
function readTag(db: Database, name: string): TagRead {
  const row = db.prepare("SELECT name, color FROM tags WHERE name = ?").get(name) as
    TagRead | undefined;
  if (row === undefined) {
    throw notFound("tag");
  }
  return { ...row };
}

// insertTag creates a tag of a name no tag has, with the color given or the
// next in turn, while there are fewer than maxTagsKept.
function insertTag(db: Database, name: string, color: Color | undefined): void {
  const { count } = db.prepare("SELECT count(*) AS count FROM tags").get() as { count: number };
  if (count >= maxTagsKept) {
    throw invalidInput(undefined, `there are already ${maxTagsKept} tags, the most there can be`);
  }
  db.prepare("INSERT INTO tags (name, color) VALUES (?, ?)").run(name, color ?? colorInTurn(count));
}

// createTag creates a tag that nothing carries yet.
export function createTag(store: Store, identity: Identity, input: TagCreateInput): TagRead {
  return operate(store, identity, "sessions:write", (db) => {
    if (tagExists(db, input.name)) {
      throw conflict("tag");
    }
    insertTag(db, input.name, input.color);
    return readTag(db, input.name);
  });
}

// renameTag renames a tag, and so everywhere it is carried, onto a name no tag
// has.
export function renameTag(
  store: Store,
  identity: Identity,
  tag: string,
  input: TagNameInput,
): void {
  operate(store, identity, "sessions:write", (db) => {
    if (!tagExists(db, tag)) {
      throw notFound("tag");
    }
    if (input.name === tag) {
      return;
    }
    if (tagExists(db, input.name)) {
      throw conflict("tag");
    }
    db.prepare("UPDATE tags SET name = ? WHERE name = ?").run(input.name, tag);
  });
}

// recolorTag gives a tag a new color.
export function recolorTag(
  store: Store,
  identity: Identity,
  tag: string,
  input: ColorInput,
): TagRead {
  return operate(store, identity, "sessions:write", (db) => {
    db.prepare("UPDATE tags SET color = ? WHERE name = ?").run(input.color, tag);
    return readTag(db, tag);
  });
}

// removeTag removes a tag, which takes it off everything that carries it.
export function removeTag(store: Store, identity: Identity, tag: string): void {
  operate(store, identity, "sessions:write", (db) => {
    if (db.prepare("DELETE FROM tags WHERE name = ?").run(tag).changes !== 1) {
      throw notFound("tag");
    }
  });
}

// sessionOf resolves a session the operator names, refusing an unknown one as
// not found.
function sessionOf(db: Database, target: SessionTarget): number {
  const sessionId = resolveSession(db, target.agent, target.session);
  if (sessionId === undefined) {
    throw notFound();
  }
  return sessionId;
}

// putInGroup puts a session in a group, or in none, inside the caller's
// transaction, refusing a group that does not exist as not found, naming
// field.
export function putInGroup(
  db: Database,
  sessionId: number,
  group: number | null,
  field: string,
): void {
  if (group === null) {
    db.prepare("DELETE FROM session_group_members WHERE session_id = ?").run(sessionId);
    return;
  }
  if (db.prepare("SELECT 1 FROM session_groups WHERE id = ?").get(group) === undefined) {
    throw notFound(field);
  }
  db.prepare(
    `INSERT INTO session_group_members (session_id, group_id) VALUES (?, ?)
     ON CONFLICT (session_id) DO UPDATE SET group_id = excluded.group_id`,
  ).run(sessionId, group);
}

// setSessionGroup puts a session in a group, or in none.
export function setSessionGroup(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  input: SessionGroupInput,
): void {
  operate(store, identity, "sessions:write", (db) => {
    putInGroup(db, sessionOf(db, target), input.group, "group");
  });
}

// replaceTags makes the tags of one agent or session, a row of table keyed
// on column, exactly those given, inside the caller's transaction, creating
// each tag that does not exist yet.
function replaceTags(
  db: Database,
  table: "agent_tags" | "session_tags",
  column: "agent_id" | "session_id",
  id: number,
  tags: readonly string[],
): void {
  for (const tag of tags) {
    if (!tagExists(db, tag)) {
      insertTag(db, tag, undefined);
    }
  }
  db.prepare(
    `DELETE FROM ${table}
     WHERE ${column} = ? AND name NOT IN (SELECT value FROM json_each(?))`,
  ).run(id, JSON.stringify(tags));
  const insert = db.prepare(`INSERT OR IGNORE INTO ${table} (${column}, name) VALUES (?, ?)`);
  for (const tag of tags) {
    insert.run(id, tag);
  }
}

// tagSession makes a session's tags exactly those given, inside the caller's
// transaction.
export function tagSession(db: Database, sessionId: number, tags: readonly string[]): void {
  replaceTags(db, "session_tags", "session_id", sessionId, tags);
}

// setSessionTags sets the tags a session carries.
export function setSessionTags(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  input: TagsInput,
): void {
  operate(store, identity, "sessions:write", (db) => {
    tagSession(db, sessionOf(db, target), input.tags);
  });
}

// setAgentTags sets the tags an agent carries, which count for each of its
// sessions.
export function setAgentTags(
  store: Store,
  identity: Identity,
  agent: string,
  input: TagsInput,
): void {
  operate(store, identity, "sessions:write", (db) => {
    const agentId = findAgentId(db, agent);
    if (agentId === undefined) {
      throw notFound();
    }
    replaceTags(db, "agent_tags", "agent_id", agentId, input.tags);
  });
}
