import {
  type GroupNameInput,
  type GroupRef,
  type GroupsAndTags,
  maxGroups,
  maxListed,
  type SessionGroupInput,
  type TagNameInput,
  type TagsInput,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import { ApiError, invalidInput, notFound } from "../errors.ts";
import { authorizeAdministration, type Identity } from "../identity.ts";
import { findAgentId, resolveSession } from "./directory.ts";
import type { Store } from "./store.ts";
import type { SessionTarget } from "./threads.ts";

// The operator's session groups and tags. Only the operator reaches them,
// through the administration their identity grants; to anyone else they do
// not exist. A group is a row of its own, so it can be empty and renamed, and
// a session sits in at most one, which a table keyed on the session holds. A
// tag is only a name on an agent or a session, so it exists while something
// carries it: renaming or removing one rewrites both tables in one
// transaction.

// conflict refuses a name another group or tag already has.
function conflict(what: string): ApiError {
  return new ApiError("conflict", `another ${what} already has this name`, { field: "name" });
}

// operate runs fn in a transaction once the identity is found to be the
// operator's.
function operate<T>(store: Store, identity: Identity, fn: (db: Database) => T): T {
  const { db } = store;
  return db.transaction(() => {
    authorizeAdministration(db, identity, store.clock());
    return fn(db);
  });
}

// listGroupsAndTags lists every group, in name order, with how many sessions
// it holds, and every tag carried, in name order, with how many agents and
// sessions carry it, at most maxListed of them, saying when it leaves any out.
export function listGroupsAndTags(store: Store, identity: Identity): GroupsAndTags {
  return operate(store, identity, (db) => {
    const groups = db
      .prepare(
        `SELECT g.id, g.name, count(m.session_id) AS sessions
         FROM session_groups g LEFT JOIN session_group_members m ON m.group_id = g.id
         GROUP BY g.id ORDER BY g.name, g.id`,
      )
      .all() as { id: number; name: string; sessions: number }[];
    const tags = db
      .prepare(
        `SELECT name, sum(agent) AS agents, sum(session) AS sessions FROM (
           SELECT name, 1 AS agent, 0 AS session FROM agent_tags
           UNION ALL SELECT name, 0, 1 FROM session_tags
         )
         GROUP BY name ORDER BY name LIMIT ?`,
      )
      .all(maxListed + 1) as { name: string; agents: number; sessions: number }[];
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

// createGroup creates an empty group, while the instance holds fewer than
// maxGroups.
export function createGroup(store: Store, identity: Identity, input: GroupNameInput): GroupRef {
  return operate(store, identity, (db) => {
    if (groupNamed(db, input.name) !== undefined) {
      throw conflict("group");
    }
    const { count } = db.prepare("SELECT count(*) AS count FROM session_groups").get() as {
      count: number;
    };
    if (count >= maxGroups) {
      throw invalidInput(undefined, `there are already ${maxGroups} groups, the most there can be`);
    }
    const { id } = db
      .prepare("INSERT INTO session_groups (name, created_at) VALUES (?, ?) RETURNING id")
      .get(input.name, store.clock()) as { id: number };
    return { id, name: input.name };
  });
}

// renameGroup names a group anew. Its sessions stay in it, and a filter by
// its id keeps working.
export function renameGroup(
  store: Store,
  identity: Identity,
  id: number,
  input: GroupNameInput,
): GroupRef {
  return operate(store, identity, (db) => {
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
    return { id, name: input.name };
  });
}

// removeGroup removes a group, which leaves its sessions in no group: the
// cascade takes its memberships in the same statement.
export function removeGroup(store: Store, identity: Identity, id: number): void {
  operate(store, identity, (db) => {
    if (db.prepare("DELETE FROM session_groups WHERE id = ?").run(id).changes !== 1) {
      throw notFound("id");
    }
  });
}

// tagCarried says whether anything carries a tag.
function tagCarried(db: Database, name: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM agent_tags WHERE name = :name
         UNION ALL SELECT 1 FROM session_tags WHERE name = :name LIMIT 1`,
      )
      .get({ name }) !== undefined
  );
}

// renameTag renames a tag everywhere it is carried, onto a name no tag has.
export function renameTag(
  store: Store,
  identity: Identity,
  tag: string,
  input: TagNameInput,
): void {
  operate(store, identity, (db) => {
    if (!tagCarried(db, tag)) {
      throw notFound("tag");
    }
    if (input.name === tag) {
      return;
    }
    if (tagCarried(db, input.name)) {
      throw conflict("tag");
    }
    db.prepare("UPDATE agent_tags SET name = ? WHERE name = ?").run(input.name, tag);
    db.prepare("UPDATE session_tags SET name = ? WHERE name = ?").run(input.name, tag);
  });
}

// removeTag takes a tag off everything that carries it.
export function removeTag(store: Store, identity: Identity, tag: string): void {
  operate(store, identity, (db) => {
    const removed = ["agent_tags", "session_tags"].map(
      (table) => db.prepare(`DELETE FROM ${table} WHERE name = ?`).run(tag).changes,
    );
    if (removed.every((changes) => changes === 0)) {
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

// setSessionGroup puts a session in a group, or in none.
export function setSessionGroup(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  input: SessionGroupInput,
): void {
  operate(store, identity, (db) => {
    const sessionId = sessionOf(db, target);
    if (input.group === null) {
      db.prepare("DELETE FROM session_group_members WHERE session_id = ?").run(sessionId);
      return;
    }
    if (db.prepare("SELECT 1 FROM session_groups WHERE id = ?").get(input.group) === undefined) {
      throw notFound("group");
    }
    db.prepare(
      `INSERT INTO session_group_members (session_id, group_id) VALUES (?, ?)
       ON CONFLICT (session_id) DO UPDATE SET group_id = excluded.group_id`,
    ).run(sessionId, input.group);
  });
}

// replaceTags makes the tags of one agent or session, a row of table keyed
// on column, exactly those given.
function replaceTags(
  db: Database,
  table: "agent_tags" | "session_tags",
  column: "agent_id" | "session_id",
  id: number,
  tags: readonly string[],
): void {
  db.prepare(
    `DELETE FROM ${table}
     WHERE ${column} = ? AND name NOT IN (SELECT value FROM json_each(?))`,
  ).run(id, JSON.stringify(tags));
  const insert = db.prepare(`INSERT OR IGNORE INTO ${table} (${column}, name) VALUES (?, ?)`);
  for (const tag of tags) {
    insert.run(id, tag);
  }
}

// setSessionTags sets the tags a session carries.
export function setSessionTags(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  input: TagsInput,
): void {
  operate(store, identity, (db) => {
    replaceTags(db, "session_tags", "session_id", sessionOf(db, target), input.tags);
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
  operate(store, identity, (db) => {
    const agentId = findAgentId(db, agent);
    if (agentId === undefined) {
      throw notFound();
    }
    replaceTags(db, "agent_tags", "agent_id", agentId, input.tags);
  });
}
