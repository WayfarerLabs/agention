import {
  markInput,
  type PushSubscriptionInput,
  savedViewCreateInput,
  savedViewViewInput,
  threadsView,
  unreadInput,
} from "@wayfarerlabs/agention-api";
import { createECDH, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removePasskey } from "../auth/operator-passkeys.ts";
import { closeBrowserSession, openBrowserSession, signOut } from "../auth/browser-sessions.ts";
import { eventsAfter, lastSeq } from "../audit/test-events.ts";
import { ApiError } from "../errors.ts";
import { type Identity, identityForBrowserSession } from "../identity.ts";
import { createGroup, removeGroup, setSessionGroup } from "./groups-and-tags.ts";
import { archiveThread, markRead, markUnread } from "./marks.ts";
import {
  checkNotification,
  notifyView,
  readNotifications,
  refreshDevice,
  removeDevice,
  stopNotifying,
  turnOnDevice,
} from "./notifications.ts";
import { createSavedView, readView, removeSavedView, replaceSavedView } from "./saved-views.ts";
import type { AgentMessage } from "./store.ts";
import {
  type Agent,
  Fixture,
  hour,
  insertTestPasskey,
  testOrigin,
  threadTarget,
} from "./test-fixture.ts";

// Notifications in the store: which saved views notify, the devices that
// receive them, and the check after an agent's message, with the mark that
// keeps a thread to one notification until the operator reads or archives it.

let fixture: Fixture;
let builder: Agent;
// The agents' messages the store handed its hook, as agention serve's check
// would hear them.
let heard: AgentMessage[];

beforeEach(() => {
  heard = [];
  fixture = new Fixture({ afterAgentMessage: (message) => heard.push(message) });
  builder = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

function failure(fn: () => unknown): { code: string; field: string | undefined } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return { code: error.code, field: error.field };
    }
    throw error;
  }
  throw new Error("expected the operation to fail");
}

const store = () => fixture.store;
const operator = () => fixture.operator;

// The starting view, which every new database holds.
const startingView = () =>
  (
    fixture.db.prepare("SELECT id FROM saved_views WHERE name = 'Blocking asks'").get() as {
      id: number;
    }
  ).id;

const save = (name: string, view: Record<string, unknown> = {}) =>
  createSavedView(store(), operator(), savedViewCreateInput.parse({ name, view })).id;

const notifying = () => readNotifications(store(), operator(), "key").notifying;

function subscription(
  endpoint = "https://fcm.googleapis.com/fcm/send/device-1",
): PushSubscriptionInput {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
    label: "Chrome on Android",
  };
}

// A browser signed in now, beside the fixture's, with its own session and,
// unless given one, the fixture's passkey, and the cookie it holds.
function newBrowser(passkeyId = fixture.passkeyId): { identity: Identity; cookie: string } {
  const opened = fixture.db.transaction(() =>
    openBrowserSession(fixture.db, 1, passkeyId, fixture.now),
  );
  const identity = identityForBrowserSession(fixture.db, opened.hash, testOrigin);
  if (identity === undefined) {
    throw new Error("no identity for the new browser");
  }
  return { identity, cookie: opened.token };
}

const devices = () =>
  fixture.db.prepare("SELECT id FROM push_subscriptions ORDER BY id").all() as { id: number }[];

// recorded answers the actions of the audit events a change records.
function recorded(change: () => unknown): string[] {
  const before = lastSeq(fixture.db);
  change();
  return eventsAfter(fixture.db, before).map((event) => event.action);
}

// The thread's mark, null when it has not notified since the operator last
// read or archived it.
const mark = (thread: number) =>
  (
    fixture.db
      .prepare(
        `SELECT notified_seq FROM thread_marks m JOIN threads t ON t.id = m.thread_id
         WHERE m.actor_id = 1 AND t.number = ?`,
      )
      .get(thread) as { notified_seq: number | null } | undefined
  )?.notified_seq ?? null;

// checked runs the check on each message heard since the last call, as
// agention serve does, answering the threads' numbers that notified.
function checked(): number[] {
  const numbers: number[] = [];
  for (const message of heard.splice(0)) {
    const notification = checkNotification(store(), message);
    if (notification !== undefined) {
      numbers.push(notification.payload.thread);
    }
  }
  return numbers;
}

const blockingAsk = { asks: [{ question: "Ship it?", impact: "blocking" }] };

describe("a view's notifying", () => {
  it("starts with Blocking asks, which notifies, its list the impact filter alone", () => {
    const row = fixture.db
      .prepare("SELECT view, notifies FROM saved_views WHERE id = ?")
      .get(startingView()) as { view: string; notifies: number };
    expect(readView(row.view)).toEqual(threadsView.parse({ impact: "blocking" }));
    expect(notifying()).toEqual([startingView()]);
  });

  it("turns on and off, each again changing nothing", () => {
    const view = save("Releases", { tag: ["release"] });
    notifyView(store(), operator(), view);
    notifyView(store(), operator(), view);
    expect(notifying()).toEqual([startingView(), view]);
    stopNotifying(store(), operator(), view);
    stopNotifying(store(), operator(), view);
    expect(notifying()).toEqual([startingView()]);
  });

  it("refuses a view with a refused filter on, naming the view, and one not there", () => {
    for (const view of [{ search: "deploy" }, { overdue: true }, { agent_read: "stranded" }]) {
      const id = save(`View ${Object.keys(view)[0]}`, view);
      expect(failure(() => notifyView(store(), operator(), id))).toEqual({
        code: "invalid_input",
        field: "view",
      });
    }
    expect(failure(() => notifyView(store(), operator(), 999))).toEqual({
      code: "not_found",
      field: "view",
    });
    expect(failure(() => stopNotifying(store(), operator(), 999))).toEqual({
      code: "not_found",
      field: "id",
    });
    expect(notifying()).toEqual([startingView()]);
  });

  it("ends when its list is replaced with one a notifying view refuses, or it is removed", () => {
    const kept = save("Kept", { impact: "blocking" });
    notifyView(store(), operator(), kept);
    replaceSavedView(
      store(),
      operator(),
      kept,
      savedViewViewInput.parse({ view: { priority: "urgent", unread: true } }),
    );
    expect(notifying()).toContain(kept);
    replaceSavedView(
      store(),
      operator(),
      kept,
      savedViewViewInput.parse({ view: { search: "deploy" } }),
    );
    expect(notifying()).not.toContain(kept);
    removeSavedView(store(), operator(), startingView());
    expect(notifying()).toEqual([]);
  });
});

describe("the check", () => {
  beforeEach(() => {
    turnOnDevice(store(), operator(), subscription());
  });

  it("notifies a thread the starting view keeps, and not a sibling in the session", () => {
    fixture.createThread(builder, blockingAsk);
    fixture.createThread(builder, { asks: [{ question: "Later?" }] });
    expect(checked()).toEqual([1]);
    expect([mark(1), mark(2)]).toEqual([1, null]);
  });

  it("answers the thread's title and why it needs the operator, never a message's text", () => {
    fixture.createThread(builder, { title: "Release", text: "secret words", ...blockingAsk });
    const [message] = heard.splice(0);
    expect(checkNotification(store(), message as AgentMessage)?.payload).toEqual({
      agent: "builder",
      session: "main",
      thread: 1,
      title: "Release",
      why: "blocking",
    });
  });

  it("matches a view by a name filter, its order and grouping changing nothing", () => {
    removeSavedView(store(), operator(), startingView());
    const other = fixture.registerAgent("reviewer", "main");
    const view = save("Builder's", {
      agent: ["builder"],
      sort: "created",
      reverse: true,
      group: "agent",
    });
    notifyView(store(), operator(), view);
    fixture.createThread(builder);
    fixture.createThread(other);
    expect(checked()).toEqual([1]);
  });

  it("keeps a view's unread and including archived threads on, as the list runs them", () => {
    removeSavedView(store(), operator(), startingView());
    notifyView(store(), operator(), save("Unread", { unread: true, include_archived: true }));
    fixture.createThread(builder);
    expect(checked()).toEqual([1]);
  });

  it("matches a view naming a removed session once one by that name exists, and a removed group never", () => {
    removeSavedView(store(), operator(), startingView());
    notifyView(store(), operator(), save("Nightly", { session: ["builder/nightly"] }));
    const group = createGroup(store(), operator(), { name: "Work", color: "gray" }).id;
    setSessionGroup(store(), operator(), builder.target, { group });
    notifyView(store(), operator(), save("Work", { session_group: [group] }));
    removeGroup(store(), operator(), group);
    fixture.createThread(builder);
    expect(checked()).toEqual([]);
    const nightly = fixture.registerAgent("builder", "nightly");
    fixture.createThread(nightly);
    expect(checked()).toEqual([1]);
  });

  it("matches a replaced list from the next message", () => {
    const thread = fixture.createThread(builder);
    expect(checked()).toEqual([]);
    replaceSavedView(
      store(),
      operator(),
      startingView(),
      savedViewViewInput.parse({ view: { agent: ["builder"] } }),
    );
    fixture.write(builder.identity, threadTarget(builder, thread.number), { text: "Again" });
    expect(checked()).toEqual([1]);
  });

  it("stays quiet on an agent's settling message under a view hiding Settled threads", () => {
    removeSavedView(store(), operator(), startingView());
    notifyView(store(), operator(), save("Unsettled", { settled: "hide" }));
    const thread = threadTarget(builder, fixture.createThread(builder).number);
    expect(checked()).toEqual([1]);
    markRead(store(), operator(), thread, markInput.parse({ through: 1 }));
    fixture.write(builder.identity, thread, { text: "Merged, so done.", settles: true });
    expect(checked()).toEqual([]);
    fixture.write(builder.identity, thread, { text: "Reopened." });
    expect(checked()).toEqual([1]);
  });

  it("skips a notifying view that has a refused filter on", () => {
    fixture.db
      .prepare("UPDATE saved_views SET view = ? WHERE id = ?")
      .run(JSON.stringify(threadsView.parse({ search: "deploy" })), startingView());
    fixture.createThread(builder, { title: "deploy", ...blockingAsk });
    expect(checked()).toEqual([]);
  });

  it("sets no mark while no device is on", () => {
    removeDevice(store(), operator(), (devices()[0] as { id: number }).id);
    fixture.createThread(builder, blockingAsk);
    expect(checked()).toEqual([]);
    expect(mark(1)).toBeNull();
  });

  it("never hears the operator's own writes, nor a replay", () => {
    fixture.startThread(builder);
    expect(heard).toEqual([]);
    const input = { request_id: "r-again", title: "Twice", ...blockingAsk };
    fixture.createThread(builder, input);
    fixture.createThread(builder, input);
    expect(heard).toHaveLength(1);
  });
});

describe("the mark", () => {
  const target = (number: number) => threadTarget(builder, number);
  const write = () =>
    fixture.write(builder.identity, target(1), { text: "More", asks: [blockingAsk.asks[0]] });
  const read = (through: number) =>
    markRead(store(), operator(), target(1), markInput.parse({ through }));

  beforeEach(() => {
    turnOnDevice(store(), operator(), subscription());
    fixture.createThread(builder, blockingAsk);
  });

  it("lets a thread notify once until the operator reads through it, then again", () => {
    expect(checked()).toEqual([1]);
    write();
    expect(checked()).toEqual([]);
    read(1);
    expect(mark(1)).toBeNull();
    write();
    expect(checked()).toEqual([1]);
    expect(mark(1)).toBe(3);
    read(2);
    expect(mark(1)).toBe(3);
    read(3);
    expect(mark(1)).toBeNull();
  });

  it("clears on an archive through it, and stays clear when the thread is marked unread", () => {
    expect(checked()).toEqual([1]);
    fixture.write(builder.identity, target(1), { withdrawals: [{ ask: 1, reason: "Moot." }] });
    expect(checked()).toEqual([]);
    archiveThread(store(), operator(), target(1), markInput.parse({ through: 2 }));
    expect(mark(1)).toBeNull();
    markUnread(store(), operator(), target(1), unreadInput.parse({ from: 1 }));
    write();
    expect(checked()).toEqual([1]);
  });

  it("clears when the operator replies", () => {
    expect(checked()).toEqual([1]);
    fixture.write(operator(), target(1), { answers: [{ ask: 1, text: "Yes" }] });
    expect(mark(1)).toBeNull();
  });
});

describe("devices", () => {
  it("turn on with a recent sign-in, an endpoint already held updated rather than added", () => {
    const first = subscription();
    let id = 0;
    expect(
      recorded(() => {
        const { device } = turnOnDevice(store(), operator(), first);
        expect(device).toMatchObject({ label: "Chrome on Android", current: true });
        expect(device.accepted_at).toBeUndefined();
        id = device.id;
      }),
    ).toEqual(["addPushDevice"]);
    expect(recorded(() => turnOnDevice(store(), operator(), first))).toEqual([]);
    expect(
      recorded(() => turnOnDevice(store(), operator(), { ...subscription(), label: "Chrome" })),
    ).toEqual(["refreshPushDevice"]);
    expect(devices()).toEqual([{ id }]);
    fixture.advance(11 * 60_000);
    expect(failure(() => turnOnDevice(store(), operator(), subscription()))).toEqual({
      code: "not_allowed",
      field: undefined,
    });
  });

  it("refuse an endpoint the server will not send to and keys that do not decode", () => {
    const good = subscription();
    const cases: [PushSubscriptionInput, string][] = [
      [{ ...good, endpoint: "https://evil.test/push" }, "endpoint"],
      [{ ...good, keys: { ...good.keys, p256dh: good.keys.p256dh.slice(4) } }, "keys.p256dh"],
      [
        { ...good, keys: { ...good.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } },
        "keys.p256dh",
      ],
      [{ ...good, keys: { ...good.keys, auth: good.keys.auth.slice(4) } }, "keys.auth"],
    ];
    for (const [input, field] of cases) {
      expect(failure(() => turnOnDevice(store(), operator(), input))).toEqual({
        code: "invalid_input",
        field,
      });
    }
    expect(devices()).toEqual([]);
  });

  it("number at most 10", () => {
    for (let index = 0; index < 10; index++) {
      turnOnDevice(
        store(),
        newBrowser().identity,
        subscription(`https://fcm.googleapis.com/fcm/send/${index}`),
      );
    }
    expect(failure(() => turnOnDevice(store(), operator(), subscription()))).toEqual({
      code: "invalid_input",
      field: undefined,
    });
  });

  it("are one per browser session, a new subscription taking the old one's place", () => {
    turnOnDevice(store(), operator(), subscription("https://fcm.googleapis.com/fcm/send/old"));
    const { device } = turnOnDevice(
      store(),
      operator(),
      subscription("https://fcm.googleapis.com/fcm/send/new"),
    );
    expect(devices()).toEqual([{ id: device.id }]);
  });

  it("refresh only an endpoint the server holds, moving it to a new sign-in's session", () => {
    const held = subscription();
    turnOnDevice(store(), operator(), held);
    fixture.advance(hour);
    const again = newBrowser();
    expect(
      failure(() =>
        refreshDevice(
          store(),
          again.identity,
          subscription("https://fcm.googleapis.com/fcm/send/other"),
        ),
      ),
    ).toEqual({ code: "not_found", field: "endpoint" });
    const { device } = refreshDevice(store(), again.identity, { ...held, label: "Chrome" });
    expect(device).toMatchObject({ label: "Chrome", current: true });
    expect(readNotifications(store(), operator(), "key").devices).toEqual([
      expect.objectContaining({ id: device.id, current: false }),
    ]);
  });

  it("refresh recording nothing when nothing changed", () => {
    const held = subscription();
    turnOnDevice(store(), operator(), held);
    expect(recorded(() => refreshDevice(store(), operator(), held))).toEqual([]);
    expect(
      recorded(() => refreshDevice(store(), operator(), { ...held, label: "Chrome" })),
    ).toEqual(["refreshPushDevice"]);
  });

  it("are held by their endpoint's canonical form, whatever its spelling", () => {
    const held = subscription("https://FCM.googleapis.com:443/fcm/send/device-1");
    const { device } = turnOnDevice(store(), operator(), held);
    expect(fixture.db.prepare("SELECT endpoint FROM push_subscriptions").all()).toEqual([
      { endpoint: "https://fcm.googleapis.com/fcm/send/device-1" },
    ]);
    const respelled = { ...held, endpoint: "https://fcm.googleapis.com/fcm/send/device-1" };
    expect(refreshDevice(store(), operator(), respelled).device.id).toBe(device.id);
    turnOnDevice(store(), newBrowser().identity, respelled);
    expect(devices()).toEqual([{ id: device.id }]);
  });

  it("refresh into a session holding another, which goes", () => {
    turnOnDevice(store(), operator(), subscription("https://fcm.googleapis.com/fcm/send/old"));
    const other = newBrowser();
    const moved = subscription("https://fcm.googleapis.com/fcm/send/moved");
    const { device } = turnOnDevice(store(), other.identity, moved);
    refreshDevice(store(), operator(), moved);
    expect(devices()).toEqual([{ id: device.id }]);
  });

  it("are removed: this one with no recent sign-in, another only with one", () => {
    const own = turnOnDevice(store(), operator(), subscription()).device.id;
    const other = newBrowser();
    const theirs = turnOnDevice(
      store(),
      other.identity,
      subscription("https://fcm.googleapis.com/fcm/send/theirs"),
    ).device.id;
    fixture.advance(11 * 60_000);
    expect(failure(() => removeDevice(store(), operator(), theirs))).toEqual({
      code: "not_allowed",
      field: undefined,
    });
    removeDevice(store(), operator(), own);
    expect(devices()).toEqual([{ id: theirs }]);
    expect(failure(() => removeDevice(store(), operator(), own))).toEqual({
      code: "not_found",
      field: "id",
    });
  });

  it("end when their browser signs out, not on a new sign-in or the sign-in's expiry", () => {
    const signingOut = newBrowser();
    turnOnDevice(
      store(),
      signingOut.identity,
      subscription("https://fcm.googleapis.com/fcm/send/out"),
    );
    const replaced = newBrowser();
    const kept = turnOnDevice(
      store(),
      replaced.identity,
      subscription("https://fcm.googleapis.com/fcm/send/kept"),
    ).device.id;
    signOut(store(), signingOut.identity, signingOut.cookie);
    expect(devices()).toEqual([{ id: kept }]);
    // A new sign-in on the same browser closes the old session, as does its
    // expiry, which the next session opened deletes.
    fixture.db.transaction(() => closeBrowserSession(fixture.db, replaced.cookie, fixture.now));
    fixture.advance(31 * 24 * hour);
    newBrowser();
    expect(devices()).toEqual([{ id: kept }]);
  });

  it("end with the passkey that signed their browser in", () => {
    const passkey = insertTestPasskey(fixture.db, 1, fixture.now);
    const phone = newBrowser(passkey);
    turnOnDevice(
      store(),
      phone.identity,
      subscription("https://fcm.googleapis.com/fcm/send/phone"),
    );
    const kept = turnOnDevice(store(), operator(), subscription()).device.id;
    removePasskey(store(), operator(), passkey);
    expect(devices()).toEqual([{ id: kept }]);
  });
});
