import type { Database } from "../database/database.ts";
import { notAllowed, notFound } from "../errors.ts";
import { checkCredential, type Identity, identityForBrowserSession } from "../identity.ts";
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
  // The cookie value, which only the browser keeps.
  token: string;
  csrfToken: string;
  // Seconds until the session's absolute expiry, for the cookie's Max-Age.
  maxAge: number;
}

// openBrowserSession opens a session for the person, signed in with the
// passkey, inside the caller's transaction.
export function openBrowserSession(
  db: Database,
  personId: number,
  passkeyId: number,
  now: number,
): OpenedBrowserSession {
  deleteExpired(db, now);
  const session = newSecret();
  const csrfToken = newSecret().token;
  db.prepare(
    `INSERT INTO browser_sessions (hash, person_id, passkey_id, csrf_token, created_at,
       idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.hash,
    personId,
    passkeyId,
    csrfToken,
    now,
    now + browserSessionIdleLifetime,
    now + browserSessionLifetime,
  );
  return { token: session.token, csrfToken, maxAge: browserSessionLifetime / 1000 };
}

// closeBrowserSession ends the session a cookie names, if it exists, inside the
// caller's transaction, and says whether it did, so the caller wakes the waits
// across sessions once that transaction commits.
export function closeBrowserSession(
  db: Database,
  cookie: string | undefined,
  now: number,
): boolean {
  deleteExpired(db, now);
  const hash = hashOfSecret(cookie);
  return (
    hash !== undefined &&
    db.prepare("DELETE FROM browser_sessions WHERE hash = ?").run(hash).changes === 1
  );
}

// signOut ends the session a cookie names, if it exists.
export function signOut(store: Store, cookie: string | undefined): void {
  const closed = store.db.transaction(() => closeBrowserSession(store.db, cookie, store.clock()));
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
  const identity = row === undefined ? undefined : identityForBrowserSession(db, hash);
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
  personId: number;
  passkeyId: number;
  recent: boolean;
}

// signedInSession reads the browser session an identity was authenticated
// with, inside the caller's transaction, once its credential is confirmed live.
export function signedInSession(db: Database, identity: Identity, now: number): SignedInSession {
  checkCredential(db, identity, now);
  const { credential } = identity;
  const row =
    credential.kind === "browser_session"
      ? (db
          .prepare("SELECT person_id, passkey_id, created_at FROM browser_sessions WHERE hash = ?")
          .get(credential.hash) as
          { person_id: number; passkey_id: number; created_at: number } | undefined)
      : undefined;
  if (row === undefined) {
    throw notFound();
  }
  return {
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
