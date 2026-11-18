import type { Database } from "../database/database.ts";
import type { Store } from "../store/index.ts";
import { hashOfSecret, newSecret } from "./secrets.ts";

// A passkey link, which `agention passkey-link` issues on the server's
// machine, registers the operator's passkey in place of any they hold: the
// first time it creates the operator, with the name it carries, and later it
// replaces their passkeys. Links come only from that local command, so
// holding a passkey never yields one. A link works once, for a short while,
// and issuing one revokes every unused one.

export const passkeyLinkLifetime = 15 * 60 * 1000;

// Expired links are deleted whenever the table is next written.
function deleteExpired(db: Database, now: number): void {
  db.prepare("DELETE FROM passkey_links WHERE expires_at <= ?").run(now);
}

// issuePasskeyLink issues a link, revoking every unused one, and returns its
// token. operatorName is the name the operator gets if the link creates them.
export function issuePasskeyLink(store: Store, operatorName: string): string {
  const { db } = store;
  return db.transaction(() => {
    const secret = newSecret();
    db.prepare("DELETE FROM passkey_links").run();
    db.prepare("INSERT INTO passkey_links (hash, operator_name, expires_at) VALUES (?, ?, ?)").run(
      secret.hash,
      operatorName,
      store.clock() + passkeyLinkLifetime,
    );
    return secret.token;
  });
}

export interface PasskeyLink {
  hash: Buffer;
  // The name the operator gets if the link creates them.
  operatorName: string;
}

// findPasskeyLink returns the unexpired link a token names.
export function findPasskeyLink(db: Database, token: string, now: number): PasskeyLink | undefined {
  const hash = hashOfSecret(token);
  if (hash === undefined) {
    return undefined;
  }
  const row = db
    .prepare("SELECT operator_name FROM passkey_links WHERE hash = ? AND expires_at > ?")
    .get(hash, now) as { operator_name: string } | undefined;
  return row === undefined ? undefined : { hash, operatorName: row.operator_name };
}

// consumePasskeyLink deletes the link, inside the caller's transaction, and
// returns the operator's name it carries if it was still there and unexpired:
// a link answers at most one ceremony.
export function consumePasskeyLink(db: Database, hash: Buffer, now: number): string | undefined {
  deleteExpired(db, now);
  const row = db
    .prepare("DELETE FROM passkey_links WHERE hash = ? RETURNING operator_name")
    .get(hash) as { operator_name: string } | undefined;
  return row?.operator_name;
}
