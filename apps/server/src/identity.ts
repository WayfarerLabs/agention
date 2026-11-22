import { holdsScope, type Scope, scopes } from "@wayfarerlabs/agention-api";
import type { Database } from "./database/database.ts";
import {
  agentUnauthenticated,
  apiKeyUnauthenticated,
  notFound,
  unapprovedKey,
  unauthenticated,
} from "./errors.ts";

// The credential an identity was authenticated with: an agent's approved
// registration, the operator's browser session, or one of the operator's API
// keys.
export type Credential =
  | { kind: "registration"; registrationId: number }
  | { kind: "browser_session"; hash: Uint8Array }
  | { kind: "api_key"; id: number };

// What an identity may act on: every session or the listed ones, and the
// scopes it holds there.
export interface Grants {
  sessions: "all" | readonly number[];
  scopes: readonly Scope[];
}

// Identity is who is acting, with what credential, and what it may reach. The
// actor is always taken from authentication, never from request content.
export interface Identity {
  actor: number;
  credential: Credential;
  grants: Grants;
}

// identityForRegistration builds the identity of an agent credential: its
// actor is the session the registration was approved for, and it reaches that
// session only, to read and write its threads. A registration never approved
// has no identity.
export function identityForRegistration(
  db: Database,
  registrationId: number,
): Identity | undefined {
  const row = db
    .prepare(
      `SELECT r.session_id, a.id AS actor_id
       FROM registrations r JOIN actors a ON a.session_id = r.session_id
       WHERE r.id = ?`,
    )
    .get(registrationId) as { session_id: number; actor_id: number } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    actor: row.actor_id,
    credential: { kind: "registration", registrationId },
    grants: { sessions: [row.session_id], scopes: ["threads:write"] },
  };
}

// identityForBrowserSession builds the operator's identity from a browser
// session: every session, with every scope.
export function identityForBrowserSession(db: Database, hash: Uint8Array): Identity | undefined {
  const row = db
    .prepare(
      `SELECT a.id AS actor_id
       FROM browser_sessions b JOIN actors a ON a.person_id = b.person_id
       WHERE b.hash = ?`,
    )
    .get(hash) as { actor_id: number } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    actor: row.actor_id,
    credential: { kind: "browser_session", hash },
    grants: { sessions: "all", scopes },
  };
}

// checkCredential confirms the identity's credential is still live: the
// registration still approved, the browser session unexpired, the API key
// neither revoked nor expired. It answers when the credential will expire,
// undefined for one that lives until it is revoked, so an operation that
// waits ends when its credential does. Operations call it inside their
// transaction, so a revocation and the data it protects are read in one
// snapshot and no layer above re-checks. An agent whose registration stopped
// being approved during the request, as when a revocation ends its long poll,
// is refused as authentication would refuse it, and told to call register.
export function checkCredential(db: Database, identity: Identity, now: number): number | undefined {
  const { credential } = identity;
  if (credential.kind === "registration") {
    const registration = db
      .prepare("SELECT status FROM registrations WHERE id = ?")
      .get(credential.registrationId) as { status: string } | undefined;
    if (registration?.status !== "approved") {
      throw agentUnauthenticated(unapprovedKey(registration?.status));
    }
    return undefined;
  }
  if (credential.kind === "api_key") {
    const live = db
      .prepare(
        `SELECT expires_at FROM api_keys
         WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(credential.id, now) as { expires_at: number | null } | undefined;
    if (live === undefined) {
      throw apiKeyUnauthenticated();
    }
    return live.expires_at ?? undefined;
  }
  const live = db
    .prepare(
      `SELECT min(idle_expires_at, absolute_expires_at) AS expires_at FROM browser_sessions
       WHERE hash = ? AND idle_expires_at > ? AND absolute_expires_at > ?`,
    )
    .get(credential.hash, now, now) as { expires_at: number } | undefined;
  if (live === undefined) {
    throw unauthenticated();
  }
  return live.expires_at;
}

// authorize confirms the credential is live, holds the scope the operation
// requires, as authorizeScope does, and grants the session, which is
// undefined when the request named one that does not exist. Unknown and
// unauthorized sessions both fail as not_found, naming field when the session
// is one of several the request names.
export function authorize(
  db: Database,
  identity: Identity,
  scope: Scope,
  sessionId: number | undefined,
  now: number,
  field?: string,
): number {
  authorizeScope(db, identity, scope, now);
  const { sessions } = identity.grants;
  if (sessionId === undefined || (sessions !== "all" && !sessions.includes(sessionId))) {
    throw notFound(field);
  }
  return sessionId;
}

// holds says whether the identity holds a scope, directly or by inclusion.
export function holds(identity: Identity, scope: Scope): boolean {
  return holdsScope(identity.grants.scopes, scope);
}

// authorizeScope confirms the credential is live and holds the scope the
// operation requires, and answers when the credential will expire, as
// checkCredential does. Every store operation an API key or an agent can reach
// calls it, or authorize, inside its transaction, so the store holds every adapter to the
// same scopes; the mounts also refuse before reading any input. To an
// identity without the scope the operation does not exist.
export function authorizeScope(
  db: Database,
  identity: Identity,
  scope: Scope,
  now: number,
): number | undefined {
  const expiresAt = checkCredential(db, identity, now);
  if (!holds(identity, scope)) {
    throw notFound();
  }
  return expiresAt;
}

// sessionScope binds the sessions an identity reaches into queries that read
// across sessions: `(:all_sessions = 1 OR session_id IN (SELECT value FROM
// json_each(:session_ids)))`.
export function sessionScope(identity: Identity): { all_sessions: number; session_ids: string } {
  const { sessions } = identity.grants;
  return sessions === "all"
    ? { all_sessions: 1, session_ids: "[]" }
    : { all_sessions: 0, session_ids: JSON.stringify(sessions) };
}
