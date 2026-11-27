import { formatTimestamp, type PasskeyList, type PasskeyRemoved } from "@wayfarerlabs/agention-api";
import { recordAudit } from "../audit/record.ts";
import type { Database } from "../database/database.ts";
import { invalidInput, notFound } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { everySession, type Store } from "../store/index.ts";
import {
  liveSessionsOf,
  requireRecentSignIn,
  type SignedInSession,
  signedInSession,
} from "./browser-sessions.ts";

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
    const now = store.clock();
    const session = signedInSession(db, identity, now);
    const previous = db
      .prepare("SELECT name FROM passkeys WHERE id = ? AND person_id = ?")
      .get(id, session.personId) as { name: string } | undefined;
    if (previous === undefined) {
      throw notFound("id");
    }
    db.prepare("UPDATE passkeys SET name = ? WHERE id = ?").run(name, id);
    recordAudit(store, now, { kind: "identity", identity }, "renamePasskey", {
      passkey: { id, name },
      previousName: previous.name,
    });
  });
}

// removePasskey removes one of the operator's passkeys, never the last, and
// with it every browser session it signed in, this one included if it did:
// the waits across sessions wake, so one those sessions hold ends now. Its
// audit event, naming the sessions it ends, is recorded just before the
// removal, in the same transaction, while the passkey that signed this
// browser in, which it may be, still has its name.
export function removePasskey(store: Store, identity: Identity, id: number): PasskeyRemoved {
  const { db } = store;
  const removed = db.transaction(() => {
    const now = store.clock();
    const session = signedInSession(db, identity, now);
    const held = db
      .prepare("SELECT id, name FROM passkeys WHERE person_id = ?")
      .all(session.personId) as { id: number; name: string }[];
    const passkey = held.find((row) => row.id === id);
    if (passkey === undefined) {
      throw notFound("id");
    }
    requireRecentSignIn(session);
    if (held.length === 1) {
      throw invalidInput("id", "this is your only passkey: add another before removing it");
    }
    const ended = liveSessionsOf(db, { passkeyId: id }, now);
    recordAudit(store, now, { kind: "identity", identity }, "removePasskey", {
      passkey: { id, name: passkey.name },
      endedSessions: ended,
    });
    db.prepare("DELETE FROM passkeys WHERE id = ?").run(id);
    return { signed_out: id === session.passkeyId };
  });
  store.notifier.notify(everySession);
  return removed;
}
