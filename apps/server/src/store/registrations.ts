import {
  type AgentsPage,
  type AgentsQuery,
  type ApproveInput,
  formatTimestamp,
  maxListed,
  type PublicKey,
  type Registration,
  type RegistrationResult,
  type RegistrationsPage,
  type RegistrationsQuery,
  type RegistrationState,
  type RegistrationStatus,
  type RegistrationSubmitInput,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import type { Database } from "../database/database.ts";
import { invalidInput, notFound } from "../errors.ts";
import { authorizeAdministration, type Identity } from "../identity.ts";
import { findAgentId, findSessionId, insertAgent, insertSession } from "./directory.ts";
import { pageOf } from "./thread-reads.ts";
import { decodeCursor, encodeCursor } from "./opaque-cursors.ts";
import type { Store } from "./store.ts";

// A registration the operator has not decided expires an hour after it was
// submitted, and can then no longer be approved.
export const registrationLifetime = 60 * 60 * 1000;

// Registrations that expired while pending are deleted whenever the table is
// next written, inside the writer's transaction: nothing refers to them, and a
// flood of submits cannot accumulate. Decided registrations are kept.
function deleteExpiredPending(db: Database, now: number): void {
  db.prepare("DELETE FROM registrations WHERE status = 'pending' AND expires_at <= ?").run(now);
}

// The statuses a registration row stores; expired is shown, not stored.
type StoredStatus = Exclude<RegistrationStatus, "expired">;

interface RegistrationRow {
  id: number;
  public_key: PublicKey;
  proposed_agent: string;
  proposed_session: string;
  status: RegistrationStatus;
  session_id: number | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  revoked_at: number | null;
  granted_agent: string | null;
  granted_session: string | null;
  credential_active: number;
}

// Registrations with their status as shown (a pending one past its expiry is
// expired) and the session they were approved for. Bind :now.
const registrationsShown = `
  WITH shown AS (
    SELECT r.id, r.public_key, r.proposed_agent, r.proposed_session, r.session_id,
      r.created_at, r.expires_at, r.decided_at, r.revoked_at,
      CASE WHEN r.status = 'pending' AND r.expires_at <= :now THEN 'expired' ELSE r.status END
        AS status,
      g.name AS granted_agent, s.name AS granted_session,
      EXISTS (
        SELECT 1 FROM registrations o WHERE o.session_id = r.session_id AND o.status = 'approved'
      ) AS credential_active
    FROM registrations r
    LEFT JOIN sessions s ON s.id = r.session_id
    LEFT JOIN agents g ON g.id = s.agent_id
  )`;

function readRegistration(db: Database, id: number, now: number): RegistrationRow | undefined {
  return db
    .prepare(`${registrationsShown} SELECT * FROM shown WHERE id = :id`)
    .get({ id, now }) as unknown as RegistrationRow | undefined;
}

function toRegistration(row: RegistrationRow): Registration {
  return {
    id: row.id,
    code: registrationCode(row.public_key),
    status: row.status,
    proposed_agent: row.proposed_agent,
    proposed_session: row.proposed_session,
    created_at: formatTimestamp(row.created_at),
    expires_at: formatTimestamp(row.expires_at),
    ...(row.decided_at === null ? {} : { decided_at: formatTimestamp(row.decided_at) }),
    ...(row.revoked_at === null ? {} : { revoked_at: formatTimestamp(row.revoked_at) }),
    ...(row.granted_agent === null || row.granted_session === null
      ? {}
      : {
          granted: {
            agent: row.granted_agent,
            session: row.granted_session,
            credential_active: row.credential_active === 1,
          },
        }),
  };
}

function toState(row: RegistrationRow): RegistrationState {
  return {
    status: row.status,
    code: registrationCode(row.public_key),
    expires_at: formatTimestamp(row.expires_at),
    ...(row.status === "approved" && row.granted_agent !== null && row.granted_session !== null
      ? { agent: row.granted_agent, session: row.granted_session }
      : {}),
  };
}

// findRegistrationByKey looks a registration up by its public key, the one
// indexed read that authenticating an agent's token needs.
export function findRegistrationByKey(
  db: Database,
  publicKey: PublicKey,
): { id: number; status: StoredStatus } | undefined {
  return db.prepare("SELECT id, status FROM registrations WHERE public_key = ?").get(publicKey) as
    { id: number; status: StoredStatus } | undefined;
}

// submitRegistration records a new key as a pending registration with the
// proposed names, or reports the state of a key already known without changing
// anything, so a retry is harmless and the same call reports progress. The
// caller has verified that the request was signed by the key.
//
// A new key whose code equals another pending registration's is refused: the
// genuine registration holds its code while it is pending, so a key found to
// match a code an agent relayed cannot even be submitted.
export function submitRegistration(
  store: Store,
  publicKey: PublicKey,
  input: RegistrationSubmitInput,
): RegistrationState {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const known = findRegistrationByKey(db, publicKey);
    if (known !== undefined) {
      return toState(readRegistration(db, known.id, now) as RegistrationRow);
    }
    deleteExpiredPending(db, now);
    const code = registrationCode(publicKey);
    const pending = db
      .prepare("SELECT public_key FROM registrations WHERE status = 'pending' AND expires_at > ?")
      .all(now) as { public_key: PublicKey }[];
    if (pending.some((other) => registrationCode(other.public_key) === code)) {
      throw invalidInput(
        undefined,
        "another pending registration has this key's code; generate a new key and register again",
      );
    }
    const { id } = db
      .prepare(
        `INSERT INTO registrations (public_key, proposed_agent, proposed_session, status,
           created_at, expires_at)
         VALUES (?, ?, ?, 'pending', ?, ?) RETURNING id`,
      )
      .get(publicKey, input.agent, input.session, now, now + registrationLifetime) as {
      id: number;
    };
    return toState(readRegistration(db, id, now) as RegistrationRow);
  });
}

// listRegistrations pages through registrations, newest first, optionally of
// one status as shown.
export function listRegistrations(
  store: Store,
  identity: Identity,
  query: RegistrationsQuery,
): RegistrationsPage {
  const { db } = store;
  const [before] =
    query.cursor === undefined
      ? [null]
      : decodeCursor("registrations", query.cursor, ["number"], "cursor");
  return db.transaction(() => {
    const now = store.clock();
    authorizeAdministration(db, identity, now);
    const rows = db
      .prepare(
        `${registrationsShown}
         SELECT * FROM shown
         WHERE (:status IS NULL OR status = :status) AND (:before IS NULL OR id < :before)
         ORDER BY id DESC LIMIT :limit`,
      )
      .all({
        now,
        status: query.status ?? null,
        before,
        limit: query.limit + 1,
      }) as unknown as RegistrationRow[];
    const page = pageOf(rows, query.limit);
    const last = page.rows.at(-1);
    return {
      registrations: page.rows.map(toRegistration),
      ...(page.more && last !== undefined
        ? { next: encodeCursor("registrations", [last.id]) }
        : {}),
    };
  });
}

// decide runs one registration decision for the operator: it loads the
// registration, requires the status shown to be the one the decision starts
// from, and applies it.
function decide(
  store: Store,
  identity: Identity,
  id: number,
  from: RegistrationStatus,
  apply: (db: Database, row: RegistrationRow, now: number) => void,
): RegistrationRow {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    authorizeAdministration(db, identity, now);
    const row = readRegistration(db, id, now);
    if (row === undefined) {
      throw notFound();
    }
    if (row.status !== from) {
      throw invalidInput(undefined, `the registration is ${row.status}, not ${from}`);
    }
    apply(db, row, now);
    deleteExpiredPending(db, now);
    return readRegistration(db, id, now) as RegistrationRow;
  });
}

// approveRegistration grants a pending registration a session. The request
// says whether the agent and the session it names already exist, and a
// mismatch is refused, so granting an existing session's whole history is
// always deliberate. The names may differ from the proposed ones, and a session
// may hold several approved credentials.
export function approveRegistration(
  store: Store,
  identity: Identity,
  id: number,
  input: ApproveInput,
): RegistrationResult {
  const row = decide(store, identity, id, "pending", (db, _, now) => {
    const existingAgent = findAgentId(db, input.agent.name);
    if (input.agent.existing !== (existingAgent !== undefined)) {
      throw invalidInput(
        "agent.name",
        input.agent.existing ? "names no existing agent" : "names an agent that already exists",
      );
    }
    const existingSession =
      existingAgent === undefined
        ? undefined
        : findSessionId(db, existingAgent, input.session.name);
    if (input.session.existing !== (existingSession !== undefined)) {
      throw invalidInput(
        "session.name",
        input.session.existing
          ? "names no existing session of the agent"
          : "names a session the agent already has",
      );
    }
    const agentId = existingAgent ?? insertAgent(db, input.agent.name, now);
    const sessionId = existingSession ?? insertSession(db, agentId, input.session.name, now);
    db.prepare(
      "UPDATE registrations SET status = 'approved', session_id = ?, decided_at = ? WHERE id = ?",
    ).run(sessionId, now, id);
  });
  return { registration: toRegistration(row) };
}

// rejectRegistration refuses a pending registration.
export function rejectRegistration(
  store: Store,
  identity: Identity,
  id: number,
): RegistrationResult {
  const row = decide(store, identity, id, "pending", (db, _, now) => {
    db.prepare("UPDATE registrations SET status = 'rejected', decided_at = ? WHERE id = ?").run(
      now,
      id,
    );
  });
  return { registration: toRegistration(row) };
}

// revokeRegistration ends an approved credential at once. The session, its
// threads and its other credentials stay, and the session's long polls wake
// so a poll on the revoked credential ends now.
export function revokeRegistration(
  store: Store,
  identity: Identity,
  id: number,
): RegistrationResult {
  const row = decide(store, identity, id, "approved", (db, _, now) => {
    db.prepare("UPDATE registrations SET status = 'revoked', revoked_at = ? WHERE id = ?").run(
      now,
      id,
    );
  });
  if (row.session_id !== null) {
    store.notifier.notify(row.session_id);
  }
  return { registration: toRegistration(row) };
}

// listAgents pages through the agents in name order, each with its sessions
// in name order, at most maxListed of them, for the operator's approval
// choices.
export function listAgents(store: Store, identity: Identity, query: AgentsQuery): AgentsPage {
  const { db } = store;
  const position =
    query.cursor === undefined
      ? undefined
      : decodeCursor("agents", query.cursor, ["string"], "cursor");
  return db.transaction(() => {
    const now = store.clock();
    authorizeAdministration(db, identity, now);
    const agents = db
      .prepare(
        `SELECT id, name FROM agents WHERE :after = 0 OR name > :agent ORDER BY name LIMIT :limit`,
      )
      .all({
        after: position === undefined ? 0 : 1,
        agent: position?.[0] ?? "",
        limit: query.limit + 1,
      }) as { id: number; name: string }[];
    const page = pageOf(agents, query.limit);
    const sessionsOf = db.prepare(
      `SELECT s.name AS session,
         EXISTS (
           SELECT 1 FROM registrations r WHERE r.session_id = s.id AND r.status = 'approved'
         ) AS credential_active
       FROM sessions s WHERE s.agent_id = ? ORDER BY s.name LIMIT ?`,
    );
    const last = page.rows.at(-1);
    return {
      agents: page.rows.map((agent) => {
        const sessions = sessionsOf.all(agent.id, maxListed + 1) as {
          session: string;
          credential_active: number;
        }[];
        return {
          agent: agent.name,
          sessions: sessions.slice(0, maxListed).map((row) => ({
            session: row.session,
            credential_active: row.credential_active === 1,
          })),
          truncated: sessions.length > maxListed,
        };
      }),
      ...(page.more && last !== undefined ? { next: encodeCursor("agents", [last.name]) } : {}),
    };
  });
}
