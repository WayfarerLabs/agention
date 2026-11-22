import {
  type ApiKeyCreated,
  type ApiKeyCreateInput,
  type ApiKeyExpiry,
  type ApiKeyList,
  apiKeyPrefix,
  type ApiKeyRevoked,
  apiKeyScopes,
  apiKeySecret,
  type ApiKeySummary,
  formatTimestamp,
  maxApiKeyLifetimeDays,
  maxApiKeys,
  parseTimestamp,
  type Scope,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import { apiKeyUnauthenticated, invalidInput, notFound } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { everySession, type Store } from "../store/index.ts";
import { requireRecentSignIn, signedInSession } from "./browser-sessions.ts";
import { hashOfSecret, newSecret } from "./secrets.ts";

// The operator's API keys. A key acts as the operator over every session,
// within the scopes it holds, until it expires or is revoked. Only its hash is
// stored. Keys are created, listed and revoked only through a browser
// session, and creating or revoking one needs a recent sign-in, as changing
// passkeys does; no key can manage keys.

const hour = 60 * 60 * 1000;
const day = 24 * hour;

// Use is recorded at most this often, so a client that polls does not write
// to the database on every request.
const lastUsedStep = hour;

interface KeyRow {
  id: number;
  person_id: number;
  name: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

// The scopes column, as our own code wrote it. A row read back is persisted
// state, so it is checked rather than trusted.
function scopesOf(row: KeyRow): Scope[] {
  return apiKeyScopes.parse(JSON.parse(row.scopes));
}

function isLive(row: KeyRow, now: number): boolean {
  return row.revoked_at === null && (row.expires_at === null || row.expires_at > now);
}

function summaryOf(row: KeyRow, now: number): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    scopes: scopesOf(row),
    status: row.revoked_at !== null ? "revoked" : isLive(row, now) ? "active" : "expired",
    created_at: formatTimestamp(row.created_at),
    ...(row.expires_at === null ? {} : { expires_at: formatTimestamp(row.expires_at) }),
    ...(row.last_used_at === null ? {} : { last_used_at: formatTimestamp(row.last_used_at) }),
    ...(row.revoked_at === null ? {} : { revoked_at: formatTimestamp(row.revoked_at) }),
  };
}

// Revoked and expired keys are deleted when the operator next creates or
// revokes a key, inside that transaction, before its own change, so the list
// shows them until then. Recording a key's use deletes none.
function deleteDead(db: Database, now: number): void {
  db.prepare(
    "DELETE FROM api_keys WHERE revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?)",
  ).run(now);
}

// expiryOf reads the expiry the operator chose as the time the key expires,
// null for none.
function expiryOf(expiry: ApiKeyExpiry, now: number): number | null {
  switch (expiry.kind) {
    case "days":
      return now + expiry.days * day;
    case "date": {
      const at = parseTimestamp(expiry.at);
      if (at <= now || at > now + maxApiKeyLifetimeDays * day) {
        throw invalidInput(
          "expiry.at",
          `must be after now and at most ${maxApiKeyLifetimeDays} days away`,
        );
      }
      return at;
    }
    case "none":
      return null;
  }
}

const selectKeys = `SELECT id, person_id, name, scopes, created_at, expires_at, last_used_at,
  revoked_at FROM api_keys`;

// listApiKeys lists the operator's keys, newest first, with whether this
// browser signed in recently enough to create or revoke one.
export function listApiKeys(store: Store, identity: Identity): ApiKeyList {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const session = signedInSession(db, identity, now);
    const rows = db
      .prepare(`${selectKeys} WHERE person_id = ? ORDER BY id DESC`)
      .all(session.personId) as unknown as KeyRow[];
    return { keys: rows.map((row) => summaryOf(row, now)), recent: session.recent };
  });
}

// createApiKey creates a key while the operator holds fewer than maxApiKeys
// live ones, and answers its secret, which is never available again.
export function createApiKey(
  store: Store,
  identity: Identity,
  input: ApiKeyCreateInput,
): ApiKeyCreated {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const session = signedInSession(db, identity, now);
    requireRecentSignIn(session);
    const expiresAt = expiryOf(input.expiry, now);
    deleteDead(db, now);
    const { count } = db
      .prepare("SELECT count(*) AS count FROM api_keys WHERE person_id = ?")
      .get(session.personId) as { count: number };
    if (count >= maxApiKeys) {
      throw invalidInput(
        undefined,
        `you already have ${maxApiKeys} API keys, the most there can be; revoke one first`,
      );
    }
    const secret = newSecret(apiKeyPrefix);
    const row = db
      .prepare(
        `INSERT INTO api_keys (person_id, name, scopes, hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id, person_id, name, scopes, created_at, expires_at, last_used_at, revoked_at`,
      )
      .get(
        session.personId,
        input.name,
        JSON.stringify(input.scopes),
        secret.hash,
        now,
        expiresAt,
      ) as unknown as KeyRow;
    return { key: summaryOf(row, now), secret: secret.token };
  });
}

// revokeApiKey revokes one of the operator's live keys, which stops working
// at once: the waits across sessions wake, so one the key holds ends now. A
// key already revoked or expired is gone by then, so revoking it again is
// not_found.
export function revokeApiKey(store: Store, identity: Identity, id: number): ApiKeyRevoked {
  const { db } = store;
  const revoked = db.transaction(() => {
    const now = store.clock();
    const session = signedInSession(db, identity, now);
    deleteDead(db, now);
    const found = db
      .prepare("SELECT 1 FROM api_keys WHERE id = ? AND person_id = ?")
      .get(id, session.personId);
    if (found === undefined) {
      throw notFound("id");
    }
    requireRecentSignIn(session);
    const row = db
      .prepare(
        `UPDATE api_keys SET revoked_at = ? WHERE id = ?
         RETURNING id, person_id, name, scopes, created_at, expires_at, last_used_at, revoked_at`,
      )
      .get(now, id) as unknown as KeyRow;
    return { key: summaryOf(row, now) };
  });
  store.notifier.notify(everySession);
  return revoked;
}

// authenticateApiKey authenticates an Authorization header carrying a key as
// a bearer token: the key must exist, unrevoked and unexpired. Every refusal
// is the same, so it tells no one whether a key ever existed. Its use is
// recorded at most hourly. Operations still confirm the key in their own
// transaction.
export function authenticateApiKey(
  store: Store,
  authorization: string | undefined,
): { identity: Identity; keyId: number } {
  const { db } = store;
  const presented = apiKeySecret.safeParse(/^Bearer (\S+)$/i.exec(authorization ?? "")?.[1]);
  if (!presented.success) {
    throw apiKeyUnauthenticated();
  }
  const now = store.clock();
  const row = db
    .prepare(`${selectKeys} WHERE hash = ?`)
    .get(hashOfSecret(presented.data) ?? null) as unknown as KeyRow | undefined;
  const actor =
    row === undefined
      ? undefined
      : (db.prepare("SELECT id FROM actors WHERE person_id = ?").get(row.person_id) as
          { id: number } | undefined);
  if (row === undefined || actor === undefined || !isLive(row, now)) {
    throw apiKeyUnauthenticated();
  }
  if (row.last_used_at === null || now - row.last_used_at >= lastUsedStep) {
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }
  return {
    identity: {
      actor: actor.id,
      credential: { kind: "api_key", id: row.id },
      grants: { sessions: "all", scopes: scopesOf(row) },
    },
    keyId: row.id,
  };
}
