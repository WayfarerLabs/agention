import {
  formatTimestamp,
  maxPushDevices,
  type NotificationsState,
  type PushDevice,
  type PushDeviceResult,
  type PushPayload,
  type PushReason,
  type PushSubscriptionInput,
  refusedFilterNames,
  refusedFiltersOn,
  type ThreadSummary,
} from "@wayfarerlabs/agention-api";
import { createECDH } from "node:crypto";
import { recordAudit } from "../audit/record.ts";
import {
  requireRecentSignIn,
  type SignedInSession,
  signedInSession,
} from "../auth/browser-sessions.ts";
import type { Database } from "../database/database.ts";
import { invalidInput, notFound } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { endpointProblem } from "../push/endpoint.ts";
import { findOperator } from "./directory.ts";
import { readView } from "./saved-views.ts";
import type { Store } from "./store.ts";
import { threadKept } from "./thread-lists.ts";
import { readThread } from "./thread-reads.ts";

// Notifications, as the store keeps them: which saved views notify, the
// devices that receive notifications, and the check, after an agent's
// message, of whether its thread now needs the operator. Only a browser
// session reaches the views' notifying and the devices, through the web UI's
// own routes; no API key or agent does. The sender (push/sender.ts) does the
// network work; nothing here does.

// actorOf is an audit event's actor for an identity.
const actorOf = (identity: Identity) => ({ kind: "identity", identity }) as const;

// readNotifications reads what Settings show of notifications.
export function readNotifications(
  store: Store,
  identity: Identity,
  publicKey: string,
): NotificationsState {
  const { db } = store;
  return db.transaction(() => {
    const session = signedInSession(db, identity, store.clock());
    const devices = (
      db
        .prepare(
          `SELECT id, label, session_id, created_at, accepted_at FROM push_subscriptions
           ORDER BY id`,
        )
        .all() as unknown as DeviceRow[]
    ).map((row) => deviceOf(row, session.id));
    const notifying = (
      db.prepare("SELECT id FROM saved_views WHERE notifies = 1 ORDER BY id").all() as {
        id: number;
      }[]
    ).map((row) => row.id);
    return { public_key: publicKey, recent: session.recent, devices, notifying };
  });
}

// notifyView turns a saved view's notifying on, refusing a view with a filter
// on that a notifying view refuses. Turning on a view that already notifies
// changes nothing and records nothing.
export function notifyView(store: Store, identity: Identity, id: number): void {
  const { db } = store;
  db.transaction(() => {
    const now = store.clock();
    signedInSession(db, identity, now);
    const row = db.prepare("SELECT name, view, notifies FROM saved_views WHERE id = ?").get(id) as
      { name: string; view: string; notifies: number } | undefined;
    if (row === undefined) {
      throw notFound("view");
    }
    const [refused] = refusedFiltersOn(readView(row.view));
    if (refused !== undefined) {
      throw invalidInput(
        "view",
        `its ${refusedFilterNames[refused]} filter is on, and a view with that filter on cannot notify`,
      );
    }
    if (row.notifies === 1) {
      return;
    }
    db.prepare("UPDATE saved_views SET notifies = 1 WHERE id = ?").run(id);
    recordAudit(store, now, actorOf(identity), "notifyView", { view: { id, name: row.name } });
  });
}

// stopNotifying turns a saved view's notifying off. Turning off a view that
// does not notify changes nothing and records nothing.
export function stopNotifying(store: Store, identity: Identity, id: number): void {
  const { db } = store;
  db.transaction(() => {
    const now = store.clock();
    signedInSession(db, identity, now);
    const row = db.prepare("SELECT name, notifies FROM saved_views WHERE id = ?").get(id) as
      { name: string; notifies: number } | undefined;
    if (row === undefined) {
      throw notFound("id");
    }
    if (row.notifies === 0) {
      return;
    }
    db.prepare("UPDATE saved_views SET notifies = 0 WHERE id = ?").run(id);
    recordAudit(store, now, actorOf(identity), "stopNotifying", { view: { id, name: row.name } });
  });
}

// A device's row as Settings list it.
interface DeviceRow {
  id: number;
  label: string;
  session_id: string;
  created_at: number;
  accepted_at: number | null;
}

const deviceOf = (row: DeviceRow, current: string): PushDevice => ({
  id: row.id,
  label: row.label,
  created_at: formatTimestamp(row.created_at),
  ...(row.accepted_at === null ? {} : { accepted_at: formatTimestamp(row.accepted_at) }),
  current: row.session_id === current,
});

// readDevice reads a device as Settings list it.
const readDevice = (db: Database, id: number, current: string): PushDevice =>
  deviceOf(
    db
      .prepare(
        `SELECT id, label, session_id, created_at, accepted_at FROM push_subscriptions
         WHERE id = ?`,
      )
      .get(id) as unknown as DeviceRow,
    current,
  );

// A subscription as a device sent it, checked: an endpoint the server sends
// to, in its canonical form, so one subscription is never stored twice
// under two spellings, and keys that decode to a P-256 point and a 16-octet
// secret.
interface Subscription {
  endpoint: string;
  p256dh: Buffer;
  auth: Buffer;
  label: string;
}

// checkedSubscription checks a subscription's endpoint and keys, which arrive
// from the browser.
function checkedSubscription(input: PushSubscriptionInput): Subscription {
  const problem = endpointProblem(input.endpoint);
  if (problem !== undefined) {
    throw invalidInput("endpoint", problem);
  }
  const p256dh = Buffer.from(input.keys.p256dh, "base64url");
  if (p256dh.length !== 65 || !onCurve(p256dh)) {
    throw invalidInput("keys.p256dh", "must be base64url of a P-256 public key, 65 octets");
  }
  const auth = Buffer.from(input.keys.auth, "base64url");
  if (auth.length !== 16) {
    throw invalidInput("keys.auth", "must be base64url of 16 octets");
  }
  return { endpoint: new URL(input.endpoint).href, p256dh, auth, label: input.label };
}

// onCurve says whether a public key is a point on P-256, by agreeing a secret
// with it from a key thrown away.
function onCurve(point: Buffer): boolean {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(point);
    return true;
  } catch {
    return false;
  }
}

// A subscription the server holds, as On and a refresh compare it.
interface HeldRow {
  id: number;
  p256dh: Uint8Array;
  auth: Uint8Array;
  label: string;
  passkey_id: number;
  session_id: string;
}

const heldRow = (db: Database, endpoint: string) =>
  db
    .prepare(
      `SELECT id, p256dh, auth, label, passkey_id, session_id FROM push_subscriptions
       WHERE endpoint = ?`,
    )
    .get(endpoint) as HeldRow | undefined;

// updateHeld brings a held subscription up to date: the keys and label the
// device sent, and the browser session and passkey now holding it, first
// removing any other row that session holds, its browser's older
// subscription, so a session holds one. Only a change is recorded.
function updateHeld(
  store: Store,
  identity: Identity,
  now: number,
  held: HeldRow,
  subscription: Subscription,
  session: SignedInSession,
): PushDeviceResult {
  const { db } = store;
  const replaced = (
    db
      .prepare("DELETE FROM push_subscriptions WHERE session_id = ? AND id <> ? RETURNING id")
      .all(session.id, held.id) as { id: number }[]
  ).map((row) => row.id);
  const changed =
    replaced.length > 0 ||
    !subscription.p256dh.equals(held.p256dh) ||
    !subscription.auth.equals(held.auth) ||
    subscription.label !== held.label ||
    session.passkeyId !== held.passkey_id ||
    session.id !== held.session_id;
  if (changed) {
    db.prepare(
      `UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = ?, passkey_id = ?, session_id = ?
       WHERE id = ?`,
    ).run(
      subscription.p256dh,
      subscription.auth,
      subscription.label,
      session.passkeyId,
      session.id,
      held.id,
    );
    recordAudit(store, now, actorOf(identity), "refreshPushDevice", {
      device: { id: held.id, name: subscription.label },
      replaced,
    });
  }
  return { device: readDevice(db, held.id, session.id) };
}

// turnOnDevice registers this browser's subscription, with a recent
// sign-in. An endpoint the server already holds is updated as a refresh
// updates it, rather than duplicated; a new one takes the place of the
// subscription this browser session holds, if any, or is added while fewer
// than maxPushDevices are.
export function turnOnDevice(
  store: Store,
  identity: Identity,
  input: PushSubscriptionInput,
): PushDeviceResult {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const session = signedInSession(db, identity, now);
    requireRecentSignIn(session);
    const subscription = checkedSubscription(input);
    const held = heldRow(db, subscription.endpoint);
    if (held !== undefined) {
      return updateHeld(store, identity, now, held, subscription, session);
    }
    const replaced = (
      db
        .prepare("DELETE FROM push_subscriptions WHERE session_id = ? RETURNING id")
        .all(session.id) as { id: number }[]
    ).map((row) => row.id);
    const { count } = db.prepare("SELECT count(*) AS count FROM push_subscriptions").get() as {
      count: number;
    };
    if (count >= maxPushDevices) {
      throw invalidInput(
        undefined,
        `${maxPushDevices} devices receive notifications, the most there can be; remove one first`,
      );
    }
    const { id } = db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, passkey_id, session_id, label,
           created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        subscription.endpoint,
        subscription.p256dh,
        subscription.auth,
        session.passkeyId,
        session.id,
        subscription.label,
        now,
      ) as { id: number };
    recordAudit(store, now, actorOf(identity), "addPushDevice", {
      device: { id, name: subscription.label },
      replaced,
    });
    return { device: readDevice(db, id, session.id) };
  });
}

// refreshDevice updates the subscription of an endpoint the server holds,
// with no recent sign-in: its keys and label, and the browser session and
// passkey now holding it, which moves it to a new sign-in on the same
// browser. Any other endpoint is not found, and the web UI then stops the
// device's notifications. A refresh that changes nothing records nothing.
export function refreshDevice(
  store: Store,
  identity: Identity,
  input: PushSubscriptionInput,
): PushDeviceResult {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const session = signedInSession(db, identity, now);
    const subscription = checkedSubscription(input);
    const held = heldRow(db, subscription.endpoint);
    if (held === undefined) {
      throw notFound("endpoint");
    }
    return updateHeld(store, identity, now, held, subscription, session);
  });
}

// removeDevice removes a device's subscription. This browser's own needs no
// recent sign-in, since it is turning this device off; another device's
// needs one, as revoking an API key does.
export function removeDevice(store: Store, identity: Identity, id: number): void {
  const { db } = store;
  db.transaction(() => {
    const now = store.clock();
    const session = signedInSession(db, identity, now);
    const row = db
      .prepare("SELECT label, session_id FROM push_subscriptions WHERE id = ?")
      .get(id) as { label: string; session_id: string } | undefined;
    if (row === undefined) {
      throw notFound("id");
    }
    if (row.session_id !== session.id) {
      requireRecentSignIn(session);
    }
    db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id);
    recordAudit(store, now, actorOf(identity), "removePushDevice", {
      device: { id, name: row.label },
    });
  });
}

// A subscription as the sender encrypts to it.
export interface PushTarget {
  id: number;
  endpoint: string;
  p256dh: Uint8Array;
  auth: Uint8Array;
}

// A notification the check decided on: the thread, the agent's message that
// set it off, which the thread's mark now names, the operator's actor, whose
// mark it is, what it says, and every device to send it to.
export interface Notification {
  threadId: number;
  seq: number;
  operator: number;
  payload: PushPayload;
  targets: PushTarget[];
}

// reasonOf says why a thread needs the operator, from its open asks.
function reasonOf(thread: ThreadSummary): PushReason {
  const asks = thread.open_asks;
  if (asks.blocking) {
    return "blocking";
  }
  if (asks.priority === "urgent") {
    return "urgent";
  }
  return asks.count > 0 ? "open" : "message";
}

// checkNotification decides, in one transaction, right after an agent's
// message at seq committed, whether its thread notifies: some device
// receives notifications, the thread has not notified since the operator last
// read or archived it, and some notifying view's list keeps it. When it does,
// it sets the thread's mark to the message and answers what to send where.
// With no device it sets no mark, so a device turned on later is not denied a
// thread already marked.
export function checkNotification(
  store: Store,
  message: { threadId: number; seq: number },
): Notification | undefined {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    const { count } = db.prepare("SELECT count(*) AS count FROM push_subscriptions").get() as {
      count: number;
    };
    const operator = findOperator(db)?.actorId;
    if (count === 0 || operator === undefined) {
      return undefined;
    }
    const mark = db
      .prepare("SELECT notified_seq FROM thread_marks WHERE actor_id = ? AND thread_id = ?")
      .get(operator, message.threadId) as { notified_seq: number | null } | undefined;
    if (mark?.notified_seq != null) {
      return undefined;
    }
    const views = db
      .prepare("SELECT view FROM saved_views WHERE notifies = 1 ORDER BY id")
      .all() as { view: string }[];
    // A notifying view never has a refused filter on, which notifyView and
    // replaceSavedView keep so; one is skipped all the same.
    const kept = views
      .map((row) => readView(row.view))
      .some(
        (view) =>
          refusedFiltersOn(view).length === 0 &&
          threadKept(store, message.threadId, operator, view, now),
      );
    if (!kept) {
      return undefined;
    }
    db.prepare(
      `INSERT INTO thread_marks (actor_id, thread_id, notified_seq) VALUES (?, ?, ?)
       ON CONFLICT (actor_id, thread_id) DO UPDATE SET notified_seq = excluded.notified_seq`,
    ).run(operator, message.threadId, message.seq);
    const thread = readThread(store, message.threadId, operator, now);
    const targets = db
      .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id")
      .all() as unknown as PushTarget[];
    return {
      threadId: message.threadId,
      seq: message.seq,
      operator,
      payload: {
        agent: thread.agent,
        session: thread.session,
        thread: thread.number,
        title: thread.title,
        why: reasonOf(thread),
      },
      targets,
    };
  });
}

// stillWanted says whether a send of a notification to a device is still
// wanted: the device's subscription is as the check found it, not removed
// nor given other keys (an id's endpoint never changes), and the thread's
// mark still names the message, not cleared by a read or archive nor moved
// on by a newer notification.
export function stillWanted(store: Store, notification: Notification, target: PushTarget): boolean {
  const { db } = store;
  const device = db
    .prepare("SELECT 1 FROM push_subscriptions WHERE id = ? AND p256dh = ? AND auth = ?")
    .get(target.id, target.p256dh, target.auth);
  const marked = db
    .prepare("SELECT 1 FROM thread_marks WHERE actor_id = ? AND thread_id = ? AND notified_seq = ?")
    .get(notification.operator, notification.threadId, notification.seq);
  return device !== undefined && marked !== undefined;
}

// markAccepted records that a push service accepted a send to a device.
export function markAccepted(store: Store, id: number): void {
  store.db
    .prepare("UPDATE push_subscriptions SET accepted_at = ? WHERE id = ?")
    .run(store.clock(), id);
}

// forgetDevice removes a subscription its push service says is gone.
export function forgetDevice(store: Store, id: number): void {
  store.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id);
}

// clearNotified clears the thread's mark while it still names the
// notification's message, so the thread's next agent message notifies again:
// for a notification no device accepted, or one the server stopped in the
// middle of.
export function clearNotified(store: Store, notification: Notification): void {
  store.db
    .prepare(
      `UPDATE thread_marks SET notified_seq = NULL
       WHERE actor_id = ? AND thread_id = ? AND notified_seq = ?`,
    )
    .run(notification.operator, notification.threadId, notification.seq);
}
