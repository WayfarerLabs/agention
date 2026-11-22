import { formatTimestamp, type PasskeyList, type PasskeyRemoved } from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import { invalidInput, notFound } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { everySession, type Store } from "../store/index.ts";
import { requireRecentSignIn, type SignedInSession, signedInSession } from "./browser-sessions.ts";

// The operator's own list of their passkeys: each named, renamed at will, and
// removed while another remains. Removing one needs a recent sign-in, as
// adding one does.

function listOf(db: Database, session: SignedInSession): PasskeyList {
  const rows = db
    .prepare(
      `SELECT id, name, created_at, last_used_at FROM passkeys
       WHERE person_id = ? ORDER BY created_at, id`,
    )
    .all(session.personId) as {
    id: number;
    name: string;
    created_at: number;
    last_used_at: number | null;
  }[];
  return {
    passkeys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      created_at: formatTimestamp(row.created_at),
      ...(row.last_used_at === null ? {} : { last_used_at: formatTimestamp(row.last_used_at) }),
      current: row.id === session.passkeyId,
    })),
    recent: session.recent,
  };
}

// listPasskeys lists the operator's passkeys, oldest first.
export function listPasskeys(store: Store, identity: Identity): PasskeyList {
  const { db } = store;
  return db.transaction(() => listOf(db, signedInSession(db, identity, store.clock())));
}

// renamePasskey names one of the operator's passkeys anew.
export function renamePasskey(store: Store, identity: Identity, id: number, name: string): void {
  const { db } = store;
  return db.transaction(() => {
    const session = signedInSession(db, identity, store.clock());
    const renamed = db
      .prepare("UPDATE passkeys SET name = ? WHERE id = ? AND person_id = ?")
      .run(name, id, session.personId);
    if (renamed.changes !== 1) {
      throw notFound("id");
    }
  });
}

// removePasskey removes one of the operator's passkeys, never the last, and
// with it every browser session it signed in, this one included if it did:
// the waits across sessions wake, so one those sessions hold ends now.
export function removePasskey(store: Store, identity: Identity, id: number): PasskeyRemoved {
  const { db } = store;
  const removed = db.transaction(() => {
    const session = signedInSession(db, identity, store.clock());
    const held = (
      db.prepare("SELECT id FROM passkeys WHERE person_id = ?").all(session.personId) as {
        id: number;
      }[]
    ).map((row) => row.id);
    if (!held.includes(id)) {
      throw notFound("id");
    }
    requireRecentSignIn(session);
    if (held.length === 1) {
      throw invalidInput("id", "this is your only passkey: add another before removing it");
    }
    db.prepare("DELETE FROM passkeys WHERE id = ?").run(id);
    return { signed_out: id === session.passkeyId };
  });
  store.notifier.notify(everySession);
  return removed;
}
