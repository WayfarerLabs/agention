import { randomBytes } from "node:crypto";
import { recordAudit } from "../audit/record.ts";
import type { Database } from "../database/database.ts";
import { notAllowed, notFound } from "../errors.ts";
import {
  checkCredential,
  type Identity,
  identityForBrowserSession,
  type RequestOrigin,
} from "../identity.ts";
import { everySession, findOperator, type Store } from "../store/index.ts";
import { hashOfSecret, newSecret } from "./secrets.ts";

// A browser session is the operator's sign-in on one browser, with the passkey
// that signed it in. It ends after seven days without use or thirty days after
// it opened, whichever comes first, when the operator signs out or signs in
// again on that browser, and when that passkey is removed or replaced. Each
// end but expiry wakes the waits across sessions once it commits, so a wait
// the session holds ends at once with its refusal, as one a revoked API key
// holds does; a wait polls again on its own when its credential expires.

const day = 24 * 60 * 60 * 1000;
export const browserSessionIdleLifetime = 7 * day;
export const browserSessionLifetime = 30 * day;

// Use extends the idle expiry at most this often, so a page that polls does
// not write to the database on every request.
const idleRefreshStep = 60 * 60 * 1000;

// Expired sessions are deleted whenever the table is next written.
function deleteExpired(db: Database, now: number): void {
  db.prepare(
    "DELETE FROM browser_sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?",
  ).run(now, now);
}

export interface OpenedBrowserSession {
  // The cookie value, which only the browser keeps, and the hash the session
  // is stored under.
  token: string;
  hash: Buffer;
  csrfToken: string;
  // The session's own id, which is not secret, and its absolute expiry.
  id: string;
  expiresAt: number;
  // Seconds until the session's absolute expiry, for the cookie's Max-Age.
  maxAge: number;
}

// openBrowserSession opens a session for the person, signed in with the
// passkey, inside the caller's transaction, with a new random id that names
// it where its cookie must not.
export function openBrowserSession(
  db: Database,
  personId: number,
  passkeyId: number,
  now: number,
): OpenedBrowserSession {
  deleteExpired(db, now);
  const session = newSecret();
  const csrfToken = newSecret().token;
  const id = randomBytes(16).toString("hex");
  const expiresAt = now + browserSessionLifetime;
  db.prepare(
    `INSERT INTO browser_sessions (hash, id, person_id, passkey_id, csrf_token, created_at,
       idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.hash,
    id,
    personId,
    passkeyId,
    csrfToken,
    now,
    now + browserSessionIdleLifetime,
    expiresAt,
  );
  return {
    token: session.token,
    hash: session.hash,
    csrfToken,
    id,
    expiresAt,
    maxAge: browserSessionLifetime / 1000,
  };
}

// closeBrowserSession ends the session a cookie names, if it exists, inside the
// caller's transaction, and answers the id of the session it ended, if any, so
// the caller wakes the waits across sessions once that transaction commits.
export function closeBrowserSession(
  db: Database,
  cookie: string | undefined,
  now: number,
): string | undefined {
  deleteExpired(db, now);
  const hash = hashOfSecret(cookie);
  if (hash === undefined) {
    return undefined;
  }
  const row = db.prepare("DELETE FROM browser_sessions WHERE hash = ? RETURNING id").get(hash) as
    { id: string } | undefined;
  return row?.id;
}

// liveSessionsOf lists the ids of the live browser sessions a passkey signed
// in, or a person holds, for the event of an action that ends them, read
// before it does.
export function liveSessionsOf(
  db: Database,
  of: { passkeyId: number } | { personId: number },
  now: number,
): string[] {
  const [column, value] =
    "passkeyId" in of ? ["passkey_id", of.passkeyId] : ["person_id", of.personId];
  return (
    db
      .prepare(
        `SELECT id FROM browser_sessions
         WHERE ${column} = ? AND idle_expires_at > ? AND absolute_expires_at > ? ORDER BY id`,
      )
      .all(value, now, now) as { id: string }[]
  ).map((row) => row.id);
}

// signOut ends the session a cookie names, the identity's, if it exists,
// recording that the operator signed out of the service, and ends the
// notifications of the device the session registered or last refreshed, as
// signing that device out does. A new sign-in on the same browser closes the
// old session without this, leaving its device for the next refresh to move.
export function signOut(store: Store, identity: Identity, cookie: string | undefined): void {
  const { db } = store;
  const closed = db.transaction(() => {
    const now = store.clock();
    const ended = closeBrowserSession(db, cookie, now);
    if (ended !== undefined) {
      db.prepare("DELETE FROM push_subscriptions WHERE session_id = ?").run(ended);
      recordAudit(store, now, { kind: "identity", identity }, "signOut", {});
    }
    return ended !== undefined;
  });
  if (closed) {
    store.notifier.notify(everySession);
  }
}

export interface ResumedBrowserSession {
  identity: Identity;
  csrfToken: string;
  operatorName: string;
}

// resumeBrowserSession authenticates a session cookie: the session must exist
// and be unexpired. Using it extends its idle expiry, never past its absolute
// one. Operations still confirm the session in their own transaction.
export function resumeBrowserSession(
  store: Store,
  cookie: string | undefined,
  origin: RequestOrigin,
): ResumedBrowserSession | undefined {
  const { db } = store;
  const hash = hashOfSecret(cookie);
  if (hash === undefined) {
    return undefined;
  }
  const now = store.clock();
  const row = db
    .prepare(
      `SELECT csrf_token, idle_expires_at, absolute_expires_at FROM browser_sessions
       WHERE hash = ? AND idle_expires_at > ? AND absolute_expires_at > ?`,
    )
    .get(hash, now, now) as
    { csrf_token: string; idle_expires_at: number; absolute_expires_at: number } | undefined;
  const identity = row === undefined ? undefined : identityForBrowserSession(db, hash, origin);
  const operator = findOperator(db);
  if (row === undefined || identity === undefined || operator === undefined) {
    return undefined;
  }
  const idleExpiry = Math.min(now + browserSessionIdleLifetime, row.absolute_expires_at);
  if (idleExpiry - row.idle_expires_at >= idleRefreshStep) {
    db.transaction(() => {
      deleteExpired(db, now);
      db.prepare("UPDATE browser_sessions SET idle_expires_at = ? WHERE hash = ?").run(
        idleExpiry,
        hash,
      );
    });
  }
  return { identity, csrfToken: row.csrf_token, operatorName: operator.name };
}

// A sign-in stays recent for ten minutes after it opened the session: adding
// a passkey and removing one need one, so a browser left signed in cannot
// change the operator's passkeys. Sessions are opened only by
// a user-verifying passkey ceremony, so a recent session means a recent
// verification.
export const recentSignIn = 10 * 60 * 1000;

export interface SignedInSession {
  // The session's id, which names it without its secret.
  id: string;
  personId: number;
  passkeyId: number;
  recent: boolean;
}

// signedInSession reads the browser session an identity was authenticated
// with, inside the caller's transaction, once its credential is confirmed live.
export function signedInSession(db: Database, identity: Identity, now: number): SignedInSession {
  checkCredential(db, identity, now);
  const { credential } = identity;
  if (credential.kind !== "browser_session") {
    throw notFound();
  }
  const row = db
    .prepare("SELECT person_id, passkey_id, created_at FROM browser_sessions WHERE hash = ?")
    .get(credential.hash) as
    { person_id: number; passkey_id: number; created_at: number } | undefined;
  if (row === undefined) {
    throw notFound();
  }
  return {
    id: credential.id,
    personId: row.person_id,
    passkeyId: row.passkey_id,
    recent: now - row.created_at < recentSignIn,
  };
}

// requireRecentSignIn refuses a change a sign-in this old cannot make.
export function requireRecentSignIn(session: SignedInSession): void {
  if (!session.recent) {
    throw notAllowed(
      undefined,
      "this needs a sign-in within the last 10 minutes; sign in again first",
    );
  }
}
