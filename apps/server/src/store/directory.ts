import type { Author } from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";

// People, agents, sessions and their actors. The insert functions run inside a
// caller's transaction, so they compose with the operation that needs them.

export interface Operator {
  personId: number;
  actorId: number;
  name: string;
}

// findOperator returns the one person v1 has, once the first passkey link has
// created them.
export function findOperator(db: Database): Operator | undefined {
  const row = db
    .prepare(
      `SELECT p.id AS person_id, a.id AS actor_id, p.name
       FROM people p JOIN actors a ON a.person_id = p.id`,
    )
    .get() as { person_id: number; actor_id: number; name: string } | undefined;
  return row === undefined
    ? undefined
    : { personId: row.person_id, actorId: row.actor_id, name: row.name };
}

// insertOperator creates the operator and their actor. The schema allows one
// person, so a second insert fails.
export function insertOperator(db: Database, name: string, now: number): Operator {
  const person = db
    .prepare("INSERT INTO people (name, created_at) VALUES (?, ?) RETURNING id")
    .get(name, now) as { id: number };
  const actor = db
    .prepare("INSERT INTO actors (person_id) VALUES (?) RETURNING id")
    .get(person.id) as { id: number };
  return { personId: person.id, actorId: actor.id, name };
}

export function findAgentId(db: Database, name: string): number | undefined {
  const row = db.prepare("SELECT id FROM agents WHERE name = ?").get(name) as
    { id: number } | undefined;
  return row?.id;
}

export function insertAgent(db: Database, name: string, now: number): number {
  const row = db
    .prepare("INSERT INTO agents (name, created_at) VALUES (?, ?) RETURNING id")
    .get(name, now) as { id: number };
  return row.id;
}

export function findSessionId(db: Database, agentId: number, name: string): number | undefined {
  const row = db
    .prepare("SELECT id FROM sessions WHERE agent_id = ? AND name = ?")
    .get(agentId, name) as { id: number } | undefined;
  return row?.id;
}

// insertSession creates a session and its actor.
export function insertSession(db: Database, agentId: number, name: string, now: number): number {
  const session = db
    .prepare("INSERT INTO sessions (agent_id, name, created_at) VALUES (?, ?, ?) RETURNING id")
    .get(agentId, name, now) as { id: number };
  db.prepare("INSERT INTO actors (session_id) VALUES (?)").run(session.id);
  return session.id;
}

// resolveSession finds a session by its agent and session names.
export function resolveSession(db: Database, agent: string, session: string): number | undefined {
  const row = db
    .prepare(
      `SELECT s.id FROM sessions s JOIN agents a ON a.id = s.agent_id
       WHERE a.name = ? AND s.name = ?`,
    )
    .get(agent, session) as { id: number } | undefined;
  return row?.id;
}

export function sessionActorId(db: Database, sessionId: number): number {
  const row = db.prepare("SELECT id FROM actors WHERE session_id = ?").get(sessionId) as {
    id: number;
  };
  return row.id;
}

// authorOf names an actor as the API shows it: a session by its agent and
// session names, a person by name.
export function authorOf(db: Database, actorId: number): Author {
  const row = db
    .prepare(
      `SELECT g.name AS agent, s.name AS session, p.name AS person
       FROM actors a
       LEFT JOIN sessions s ON s.id = a.session_id
       LEFT JOIN agents g ON g.id = s.agent_id
       LEFT JOIN people p ON p.id = a.person_id
       WHERE a.id = ?`,
    )
    .get(actorId) as { agent: string | null; session: string | null; person: string | null };
  return row.person !== null
    ? { kind: "person", name: row.person }
    : { kind: "session", agent: row.agent ?? "", session: row.session ?? "" };
}
