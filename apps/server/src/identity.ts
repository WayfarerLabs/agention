import { holdsScope, type Scope, scopes } from "@wayfarerlabs/agention-api";
import type { Database } from "./database/database.ts";
import {
  agentUnauthenticated,
  type ApiError,
  apiKeyUnauthenticated,
  notFound,
  unapprovedKey,
  unauthenticated,
} from "./errors.ts";

// The credential an identity was authenticated with: an agent's approved
// registration, the operator's browser session, or one of the operator's API
// keys. A browser session is looked up by its cookie's hash, and named
// everywhere else by its own id, which is not secret, and the passkey that
// signed it in.
export type Credential =
  | { kind: "registration"; registrationId: number }
  | { kind: "browser_session"; hash: Uint8Array; id: string; passkeyId: number }
  | { kind: "api_key"; id: number };

// The request an identity's call arrived as: the peer's address when it is
// known and usable, the user agent cut to 256 code units, the method, the
// routed path and the route's pattern, the mount, which the audit log names
// as the API's service, and the server's own origin, which a sign-in's event
// names as the service signed in to.
export interface RequestOrigin {
  ip: string | undefined;
  userAgent: string | undefined;
  method: "GET" | "HEAD" | "POST";
  path: string;
  route: string;
  service: "web" | "operator/v1" | "agent";
  serverOrigin: string;
}

// What an identity may act on: every session or the listed ones, and the
// scopes it holds there.
export interface Grants {
  sessions: "all" | readonly number[];
  scopes: readonly Scope[];
}

// Identity is who is acting, with what credential, what it may reach, and the
// request it arrived as. The actor is always taken from authentication, never
// from request content.
export interface Identity {
  actor: number;
  credential: Credential;
  grants: Grants;
  origin: RequestOrigin;
}

// identityForRegistration builds the identity of an agent credential: its
// actor is the session the registration was approved for, and it reaches that
// session only, to read and write its threads. A registration never approved
// has no identity.
export function identityForRegistration(
  db: Database,
  registrationId: number,
  origin: RequestOrigin,
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
    origin,
  };
}

// identityForBrowserSession builds the operator's identity from a browser
// session: every session, with every scope.
export function identityForBrowserSession(
  db: Database,
  hash: Uint8Array,
  origin: RequestOrigin,
): Identity | undefined {
  const row = db
    .prepare(
      `SELECT a.id AS actor_id, b.id, b.passkey_id
       FROM browser_sessions b JOIN actors a ON a.person_id = b.person_id
       WHERE b.hash = ?`,
    )
    .get(hash) as { actor_id: number; id: string; passkey_id: number } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    actor: row.actor_id,
    credential: { kind: "browser_session", hash, id: row.id, passkeyId: row.passkey_id },
    grants: { sessions: "all", scopes },
    origin,
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
// is refused as authentication would refuse it, and told to call register; an
// API key revoked or expired since is refused as authentication would refuse
// it too, its refusal naming the key and why for the audit log.
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
    const key = db
      .prepare("SELECT revoked_at, expires_at FROM api_keys WHERE id = ?")
      .get(credential.id) as { revoked_at: number | null; expires_at: number | null } | undefined;
    // A key deleted as dead no longer says why it is, so its refusal names no
    // key.
    if (key === undefined) {
      throw apiKeyUnauthenticated();
    }
    const code = keyRefusalCode(key, now);
    if (code !== undefined) {
      throw apiKeyUnauthenticated({ key: credential.id, code });
    }
    return key.expires_at ?? undefined;
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

// keyRefusalCode says why a key the server found is refused, revoked before
// expired, or undefined for a live one.
export function keyRefusalCode(
  key: { revoked_at: number | null; expires_at: number | null },
  now: number,
): "key_revoked" | "key_expired" | undefined {
  if (key.revoked_at !== null) {
    return "key_revoked";
  }
  return key.expires_at !== null && key.expires_at <= now ? "key_expired" : undefined;
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
    throw scopeRefused(identity);
  }
  return expiresAt;
}

// scopeRefused refuses an identity a scope it lacks, as not_found, naming
// field when given. A refusal of an API key names the key, for the audit log,
// which no answer shows.
export function scopeRefused(identity: Identity, field?: string): ApiError {
  const { credential } = identity;
  return notFound(
    field,
    credential.kind === "api_key" ? { key: credential.id, code: "scope" } : undefined,
  );
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
