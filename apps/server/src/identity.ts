import type { Database } from "./database/database.ts";
import { agentUnauthenticated, notFound, unapprovedKey, unauthenticated } from "./errors.ts";

// The credential an identity was authenticated with: an agent's approved
// registration, or the operator's browser session.
export type Credential =
  { kind: "registration"; registrationId: number } | { kind: "browser_session"; hash: Uint8Array };

// What an identity may act on: every session or the listed ones, and whether it
// may administer registrations.
export interface Grants {
  sessions: "all" | readonly number[];
  administration: boolean;
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
// session only. A registration never approved has no identity.
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
    grants: { sessions: [row.session_id], administration: false },
  };
}

// identityForBrowserSession builds the operator's identity from a browser
// session: every session, plus administration.
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
    grants: { sessions: "all", administration: true },
  };
}

// checkCredential confirms the identity's credential is still live: the
// registration still approved, the browser session unexpired. Operations call
// it inside their transaction, so a revocation and the data it protects are
// read in one snapshot and no layer above re-checks. An agent whose
// registration stopped being approved during the request, as when a revocation
// ends its long poll, is refused as authentication would refuse it, and told to
// call register.
export function checkCredential(db: Database, identity: Identity, now: number): void {
  const { credential } = identity;
  if (credential.kind === "registration") {
    const registration = db
      .prepare("SELECT status FROM registrations WHERE id = ?")
      .get(credential.registrationId) as { status: string } | undefined;
    if (registration?.status !== "approved") {
      throw agentUnauthenticated(unapprovedKey(registration?.status));
    }
    return;
  }
  const live = db
    .prepare(
      `SELECT 1 FROM browser_sessions
       WHERE hash = ? AND idle_expires_at > ? AND absolute_expires_at > ?`,
    )
    .get(credential.hash, now, now);
  if (live === undefined) {
    throw unauthenticated();
  }
}

// authorize confirms the credential is live and grants the session, which is
// undefined when the request named one that does not exist. Unknown and
// unauthorized sessions both fail as not_found, naming field when the session
// is one of several the request names.
export function authorize(
  db: Database,
  identity: Identity,
  sessionId: number | undefined,
  now: number,
  field?: string,
): number {
  checkCredential(db, identity, now);
  const { sessions } = identity.grants;
  if (sessionId === undefined || (sessions !== "all" && !sessions.includes(sessionId))) {
    throw notFound(field);
  }
  return sessionId;
}

// authorizeAdministration confirms the credential is live and may administer
// registrations; to anything else, administration does not exist.
export function authorizeAdministration(db: Database, identity: Identity, now: number): void {
  checkCredential(db, identity, now);
  if (!identity.grants.administration) {
    throw notFound();
  }
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
