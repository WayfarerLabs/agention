import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import type { Database } from "../database/database.ts";
import type { Identity, RequestOrigin } from "../identity.ts";
import { storedName } from "../store/server-name.ts";
import type { Store } from "../store/store.ts";
import {
  type AuditAction,
  type AuditFailure,
  type AuditInput,
  type NamedRef,
  operatorUser,
} from "./actions.ts";
import {
  type Parts,
  buildEvent,
  buildFailure,
  type BuiltEvent,
  type CliCommand,
  type EventFrame,
  eventJson,
  failureAnswer,
  failureDetail,
} from "./events.ts";

// Recording: each event is inserted inside the transaction of the change it
// records, so neither exists without the other; a failure, which changes
// nothing, is recorded in a transaction of its own, coalesced with an open
// event of its kind.

// Who an event is by: an identity; a registration's key, which names no
// session yet; an API key refused at authentication, which has no identity;
// the command line; or no one.
export type AuditActor =
  | { kind: "identity"; identity: Identity }
  | { kind: "registration_key"; registrationId: number; origin: RequestOrigin }
  | { kind: "refused_key"; keyId: number; origin: RequestOrigin }
  | { kind: "cli"; command: CliCommand }
  | { kind: "none"; origin: RequestOrigin };

// A coalesced failure stays open until the end of the UTC minute of its first
// failure. One whose end is more than a minute ahead was recorded before the
// clock stepped back, and counts as closed: nothing coalesces into it, and it
// holds back no delivery.
export const minute = 60_000;

// The condition an open event meets at :now, for a query that reads the open
// events through their own index.
export const openAt = "open_until > :now AND open_until <= :now + 60000";

const operatorOf = (db: Database, personId: number) => {
  const row = db.prepare("SELECT name FROM people WHERE id = ?").get(personId) as
    { name: string } | undefined;
  if (row === undefined) {
    throw new Error("an audit event names an operator who does not exist");
  }
  return { id: personId, name: row.name };
};

const personOf = (db: Database, actor: number) => {
  const row = db.prepare("SELECT person_id FROM actors WHERE id = ?").get(actor) as
    { person_id: number | null } | undefined;
  if (row?.person_id === null || row === undefined) {
    throw new Error("an audit event's operator credential acts for no person");
  }
  return operatorOf(db, row.person_id);
};

// The user the command line runs as. A user with no entry in the system's
// user database, as a container started with a bare uid runs as, has no
// name, and is named by its uid alone.
function osUser(): { uid: number; name: string | undefined } {
  try {
    const user = userInfo();
    return { uid: user.uid, name: user.username };
  } catch {
    return { uid: process.getuid?.() ?? -1, name: undefined };
  }
}

const apiKeyParts = (person: NamedRef, key: NamedRef, origin: RequestOrigin): Parts => ({
  actor: { user: operatorUser(person), session: { credential_uid: `api_key:${key.id}` } },
  user: operatorUser(person),
  session: undefined,
  credential: { kind: "api_key", id: key.id, name: key.name },
  credentialKind: "api_key",
  credentialId: String(key.id),
  origin,
});

// partsOf reads who an actor is, as the event's parts name them, with the names
// the event carries as they are now: the operator's, a key's, a passkey's, an
// agent's and its session's. It answers undefined for a refused key deleted
// since, which names no one.
function partsOf(db: Database, actor: AuditActor): Parts | undefined {
  const anonymous = { actor: undefined, user: undefined, session: undefined };
  switch (actor.kind) {
    case "cli": {
      const user = osUser();
      return {
        ...anonymous,
        actor: {
          user: { uid: `os_user:${user.uid}`, name: user.name, type_id: 99, type: "OS user" },
          process: { pid: process.pid, name: "agention", cmd_line: `agention ${actor.command}` },
        },
        credential: { kind: "cli", command: actor.command, os_user: user.name },
        credentialKind: "cli",
        credentialId: null,
        origin: undefined,
      };
    }
    case "none":
      return {
        ...anonymous,
        credential: { kind: "none" },
        credentialKind: "none",
        credentialId: null,
        origin: actor.origin,
      };
    case "registration_key":
      return {
        ...anonymous,
        actor: { session: { credential_uid: `registration:${actor.registrationId}` } },
        credential: { kind: "registration", id: actor.registrationId },
        credentialKind: "registration",
        credentialId: String(actor.registrationId),
        origin: actor.origin,
      };
    case "refused_key": {
      const key = db
        .prepare("SELECT name, person_id FROM api_keys WHERE id = ?")
        .get(actor.keyId) as { name: string; person_id: number } | undefined;
      return key === undefined
        ? undefined
        : apiKeyParts(
            operatorOf(db, key.person_id),
            { id: actor.keyId, name: key.name },
            actor.origin,
          );
    }
    case "identity":
      return identityParts(db, actor.identity);
  }
}

function identityParts(db: Database, identity: Identity): Parts {
  const { credential, origin } = identity;
  switch (credential.kind) {
    case "registration": {
      const row = db
        .prepare(
          `SELECT s.id, s.name AS session, a.name AS agent
           FROM registrations r JOIN sessions s ON s.id = r.session_id
           JOIN agents a ON a.id = s.agent_id WHERE r.id = ?`,
        )
        .get(credential.registrationId) as { id: number; session: string; agent: string };
      return {
        actor: {
          user: { uid: `session:${row.id}`, name: `${row.agent}/${row.session}`, type_id: 4 },
          session: { credential_uid: `registration:${credential.registrationId}` },
        },
        user: undefined,
        session: undefined,
        credential: {
          kind: "registration",
          id: credential.registrationId,
          agent: row.agent,
          session: row.session,
        },
        credentialKind: "registration",
        credentialId: String(credential.registrationId),
        origin,
      };
    }
    case "api_key": {
      const key = db.prepare("SELECT name FROM api_keys WHERE id = ?").get(credential.id) as {
        name: string;
      };
      return apiKeyParts(
        personOf(db, identity.actor),
        { id: credential.id, name: key.name },
        origin,
      );
    }
    case "browser_session": {
      const person = personOf(db, identity.actor);
      const passkey = db
        .prepare("SELECT name FROM passkeys WHERE id = ?")
        .get(credential.passkeyId) as { name: string };
      const session = {
        uid: `browser_session:${credential.id}`,
        credential_uid: `passkey:${credential.passkeyId}`,
      };
      return {
        actor: { user: operatorUser(person), session },
        user: operatorUser(person),
        session,
        credential: {
          kind: "browser_session",
          id: credential.id,
          passkey: { id: credential.passkeyId, name: passkey.name },
        },
        credentialKind: "browser_session",
        credentialId: credential.id,
        origin,
      };
    }
  }
}

// The instance row is persisted state, so its id is checked when read, and
// its name is read as every reader of it does.
function instanceOf(db: Database): EventFrame["instance"] {
  const row = db.prepare("SELECT uid FROM instance WHERE id = 1").get() as { uid: string | null };
  if (row.uid === null || !/^[0-9a-f]{32}$/.test(row.uid)) {
    throw new Error("the instance's stored id is malformed");
  }
  return { uid: row.uid, name: storedName(db) };
}

// frameOf reads the frame of the next event: the next sequence, which only
// this transaction's writer can take, a new uid, and the instance.
function frameOf(db: Database, by: Parts, time: number): EventFrame {
  const { taken } = db
    .prepare(
      "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'), 0) AS taken",
    )
    .get() as { taken: number };
  return { seq: taken + 1, uid: randomUUID(), time, instance: instanceOf(db), by };
}

function insert(
  db: Database,
  frame: EventFrame,
  action: string,
  outcome: "success" | "failure",
  event: BuiltEvent,
  openUntil: number | null,
): void {
  db.prepare(
    `INSERT INTO audit_events (seq, uid, time, class_uid, action, outcome, credential_kind,
       credential_id, event, open_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    frame.seq,
    frame.uid,
    frame.time,
    event.classUid,
    action,
    outcome,
    event.credentialKind,
    event.credentialId,
    event.json,
    openUntil,
  );
}

// recordAudit builds an action's event and inserts it, inside the caller's
// transaction, after the change it records, and wakes the dispatcher once the
// transaction ends. A failed insert throws, failing the transaction and its
// change with it. A wake after a rollback finds nothing new.
export function recordAudit<A extends AuditAction>(
  store: Store,
  now: number,
  actor: AuditActor,
  action: A,
  input: AuditInput<A>,
): void {
  const { db } = store;
  const by = partsOf(db, actor);
  if (by === undefined) {
    throw new Error("an audit event's actor is gone");
  }
  const frame = frameOf(db, by, now);
  insert(db, frame, action, "success", buildEvent(frame, action, input), null);
  queueMicrotask(store.auditWake.wake);
}

// The open event a failure coalesces into, of its action, credential, code,
// and the status its caller was answered with, found through the open events'
// own index. Delivery closes every event it takes, so none a sink has passed
// is open; the bound by the cursors, as the update trigger's, is defense in
// depth.
export const openFailureQuery = `SELECT seq, event FROM audit_events INDEXED BY audit_events_open
  WHERE ${openAt} AND action = :action AND credential_kind = :kind
    AND credential_id IS :id AND json_extract(event, '$.status_detail') IS :detail
    AND json_extract(event, '$.http_response.code') IS :answer
    AND seq > (SELECT coalesce(max(delivered_seq), 0) FROM audit_sinks)`;

// recordFailure records a failure in a transaction of its own: the first of
// its kind in a minute as a new event with a count of one, open until the
// minute ends, and each later one by raising that event's count and moving its
// end on. Its kind is its action, its credential, its code, and the status
// its caller was answered with. No sink
// receives an open event, so the dispatcher is not woken: it waits for the
// minute to end.
export function recordFailure(store: Store, actor: AuditActor, failure: AuditFailure): void {
  const { db } = store;
  db.transaction(() => {
    const now = store.clock();
    const by = partsOf(db, actor);
    if (by === undefined) {
      return;
    }
    const frame = frameOf(db, by, now);
    const event = buildFailure(frame, failure);
    const open = db.prepare(openFailureQuery).get({
      now,
      action: failure.action,
      kind: event.credentialKind,
      id: event.credentialId,
      detail: failureDetail(failure) ?? null,
      answer: failureAnswer(failure) ?? null,
    }) as { seq: number; event: string } | undefined;
    if (open === undefined) {
      insert(db, frame, failure.action, "failure", event, (Math.floor(now / minute) + 1) * minute);
      return;
    }
    const counted = JSON.parse(open.event) as { count: number; end_time: number };
    counted.count += 1;
    // A clock stepped back never moves the window's end back.
    counted.end_time = Math.max(counted.end_time, now);
    db.prepare("UPDATE audit_events SET event = ? WHERE seq = ?").run(eventJson(counted), open.seq);
  });
}

// How often a failure to record a failure is logged, at most, while it lasts.
export const failureLogInterval = 60_000;

// FailureRecorder records failures for a server's mounts. A failure that
// cannot be recorded, as on a busy or full database, is written to the
// server's log at most once a minute, by the store's clock, and the request is
// refused as it would be anyway.
export type FailureRecorder = (actor: AuditActor, failure: AuditFailure) => void;

export function failureRecorder(store: Store, log: (message: string) => void): FailureRecorder {
  let loggedAt: number | undefined;
  return (actor, failure) => {
    try {
      recordFailure(store, actor, failure);
    } catch (error) {
      const now = store.clock();
      if (loggedAt === undefined || now - loggedAt >= failureLogInterval) {
        loggedAt = now;
        log(`cannot record a failure in the audit log: ${(error as Error).stack ?? String(error)}`);
      }
    }
  };
}
