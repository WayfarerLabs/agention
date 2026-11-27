import {
  markInput,
  type PushPayload,
  type PushSubscriptionInput,
} from "@wayfarerlabs/agention-api";
import ece from "http_ece";
import { createECDH, type ECDH, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markRead } from "../store/marks.ts";
import {
  checkNotification,
  type Notification,
  refreshDevice,
  removeDevice,
  turnOnDevice,
} from "../store/notifications.ts";
import type { AgentMessage } from "../store/store.ts";
import { type Agent, Fixture, threadTarget } from "../store/test-fixture.ts";
import { PushSender, retryWaits, type Transport } from "./sender.ts";
import { settlePushKey } from "./vapid.ts";

// The sender against a local test push service, reached through its
// transport: what it sends, how it retries, and what each answer does to the
// device and the thread's mark.

let fixture: Fixture;
let builder: Agent;
let heard: AgentMessage[];
let shutdown: AbortController;

beforeEach(() => {
  heard = [];
  fixture = new Fixture({ afterAgentMessage: (message) => heard.push(message) });
  builder = fixture.registerAgent("builder", "main");
  shutdown = new AbortController();
});

afterEach(() => {
  shutdown.abort();
  fixture.close();
});

// A device: the subscription it registers, and the key pair only it holds.
interface Device {
  input: PushSubscriptionInput;
  ecdh: ECDH;
  auth: Buffer;
}

function newDevice(endpoint = "https://fcm.googleapis.com/fcm/send/device-1"): Device {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    input: {
      endpoint,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
      label: "Chrome on Android",
    },
  };
}

const turnOn = (device: Device) =>
  turnOnDevice(fixture.store, fixture.operator, device.input).device.id;

// A request the test push service received.
interface Received {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  redirect: RequestInit["redirect"];
}

// A test push service: it answers each request with what answer gives for
// its endpoint, 201 by default, or, for "hang", not until the request is
// aborted.
function pushService(answer: (url: string) => number | "hang" = () => 201) {
  const received: Received[] = [];
  const transport: Transport = async (url, init) => {
    received.push({
      url,
      headers: init.headers as Record<string, string>,
      body: Buffer.from(init.body as Uint8Array),
      redirect: init.redirect,
    });
    const answered = answer(url);
    if (answered === "hang") {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return new Response(null, { status: answered, headers: { location: "https://evil.test/" } });
  };
  return { received, transport };
}

// queued answers each request with the next status given, then 201.
const queued =
  (...answers: (number | "hang")[]) =>
  () =>
    answers.shift() ?? 201;

// The waits the sender made, with what runs during each.
function waits(during: (() => void)[] = []) {
  const waited: number[] = [];
  const wait = async (milliseconds: number) => {
    waited.push(milliseconds);
    during.shift()?.();
  };
  return { waited, wait };
}

function sender(transport: Transport, wait = waits().wait, timeout?: number): PushSender {
  return new PushSender({
    store: fixture.store,
    key: settlePushKey(fixture.db),
    log: (line) => logged.push(line),
    shutdown: shutdown.signal,
    transport,
    wait,
    ...(timeout === undefined ? {} : { timeout }),
  });
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
});

// expectLogged checks the sender logged this many lines, none of them naming
// an endpoint's path, the secret part of it.
function expectLogged(lines: number): void {
  expect(logged).toHaveLength(lines);
  for (const line of logged) {
    expect(line).not.toContain("/fcm/send/");
  }
}

// notification writes a blocking ask in a new thread, or another message in
// thread 1, and answers what the check decided.
function notification(thread?: number): Notification {
  if (thread === undefined) {
    fixture.createThread(builder, { asks: [{ question: "Ship it?", impact: "blocking" }] });
  } else {
    fixture.write(builder.identity, threadTarget(builder, thread), {
      asks: [{ question: "And this?", impact: "blocking" }],
    });
  }
  const [message] = heard.splice(-1);
  const decided = checkNotification(fixture.store, message as AgentMessage);
  if (decided === undefined) {
    throw new Error("the thread did not notify");
  }
  return decided;
}

const mark = () =>
  (
    fixture.db.prepare("SELECT notified_seq FROM thread_marks WHERE actor_id = 1").get() as
      { notified_seq: number | null } | undefined
  )?.notified_seq ?? null;

const accepted = () =>
  fixture.db.prepare("SELECT id, accepted_at FROM push_subscriptions ORDER BY id").all();

describe("a send", () => {
  it("posts the encrypted payload, padded, with its headers, and records the acceptance", async () => {
    const device = newDevice();
    const id = turnOn(device);
    const service = pushService();
    await sender(service.transport).send(notification());
    const [request] = service.received;
    expect(request?.url).toBe(device.input.endpoint);
    expect(request?.redirect).toBe("manual");
    expect(request?.headers).toEqual({
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
      Authorization: expect.stringMatching(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/),
    });
    expect(request?.body).toHaveLength(1126);
    const payload = JSON.parse(
      ece
        .decrypt(request?.body as Buffer, {
          version: "aes128gcm",
          privateKey: device.ecdh,
          authSecret: device.auth,
        })
        .toString(),
    ) as PushPayload;
    expect(payload).toEqual({
      agent: "builder",
      session: "main",
      thread: 1,
      title: "A question",
      why: "blocking",
    });
    expect(accepted()).toEqual([{ id, accepted_at: fixture.now }]);
    expect(mark()).toBe(1);
  });

  it("sends a body of one size whatever the title", async () => {
    turnOn(newDevice());
    const service = pushService();
    const send = sender(service.transport);
    await send.send(notification());
    fixture.createThread(builder, {
      title: "\u{10FFFF}".repeat(200),
      asks: [{ question: "Ship it?", impact: "blocking" }],
    });
    const long = checkNotification(fixture.store, heard.splice(-1)[0] as AgentMessage);
    await send.send(long as Notification);
    expect(service.received.map((request) => request.body.length)).toEqual([1126, 1126]);
  });

  it("follows no redirect, failing on one and clearing the mark", async () => {
    turnOn(newDevice());
    const service = pushService(queued(302));
    await sender(service.transport).send(notification());
    expect(service.received).toHaveLength(1);
    expectLogged(1);
    expect(mark()).toBeNull();
  });

  it("retries a 5xx, a 429 and a timeout, 10 and 45 seconds apart, at most three tries", async () => {
    turnOn(newDevice());
    const service = pushService(queued(503, 429, 500));
    const { waited, wait } = waits();
    await sender(service.transport, wait).send(notification());
    expect(service.received).toHaveLength(3);
    expect(waited).toEqual([...retryWaits]);
    expectLogged(1);
    expect(mark()).toBeNull();

    const slow = pushService(queued("hang", 201));
    await sender(slow.transport, wait, 20).send(notification(1));
    expect(slow.received).toHaveLength(2);
    expect(mark()).toBe(2);
  });

  it("removes a device its push service says is gone", async () => {
    const gone = turnOn(newDevice("https://fcm.googleapis.com/fcm/send/gone"));
    const kept = turnOn(newDevice("https://fcm.googleapis.com/fcm/send/kept"));
    const service = pushService((url) => (url.endsWith("/gone") ? 404 : 201));
    await sender(service.transport).send(notification());
    expect(accepted()).toEqual([{ id: kept, accepted_at: fixture.now }]);
    expect(gone).toBeLessThan(kept);

    fixture.db.prepare("UPDATE thread_marks SET notified_seq = NULL").run();
    await sender(pushService(() => 410).transport).send(notification(1));
    expect(accepted()).toEqual([]);
  });

  it("clears the mark only when no device accepted", async () => {
    turnOn(newDevice("https://fcm.googleapis.com/fcm/send/refused"));
    turnOn(newDevice("https://fcm.googleapis.com/fcm/send/accepted"));
    await sender(pushService((url) => (url.endsWith("/refused") ? 403 : 201)).transport).send(
      notification(),
    );
    expect(mark()).toBe(1);
  });

  it("checks the endpoint rule again, sending nothing to a stored endpoint it refuses", async () => {
    turnOn(newDevice());
    const refused = newDevice();
    fixture.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, passkey_id, session_id, label,
           created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "https://evil.test/push",
        refused.ecdh.getPublicKey(),
        refused.auth,
        fixture.passkeyId,
        "f".repeat(32),
        "Elsewhere",
        fixture.now,
      );
    const service = pushService();
    await sender(service.transport).send(notification());
    expect(service.received.map((request) => request.url)).toEqual([
      "https://fcm.googleapis.com/fcm/send/device-1",
    ]);
    expectLogged(1);
  });

  it("logs a database write that fails rather than throwing it", async () => {
    turnOn(newDevice());
    // Every write that clears a mark fails from here on.
    fixture.db
      .prepare(
        `CREATE TRIGGER clearing_fails BEFORE UPDATE OF notified_seq ON thread_marks
      WHEN new.notified_seq IS NULL BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
      )
      .run();
    const refused = sender(pushService(() => 403).transport);
    await expect(refused.send(notification())).resolves.toBeUndefined();
    expectLogged(2);

    logged = [];
    const hanging = pushService(queued("hang"));
    const send = sender(hanging.transport, waits().wait, 60_000);
    fixture.createThread(builder, { asks: [{ question: "Ship it?", impact: "blocking" }] });
    send.afterAgentMessage(heard.splice(-1)[0] as AgentMessage);
    await vi.waitFor(() => expect(hanging.received).toHaveLength(1));
    expect(() => shutdown.abort()).not.toThrow();
    expectLogged(1);
  });

  it("never holds up the agent's write", async () => {
    turnOn(newDevice());
    const service = pushService(queued("hang"));
    const send = sender(service.transport, waits().wait, 60_000);
    fixture.createThread(builder, { asks: [{ question: "Ship it?", impact: "blocking" }] });
    send.afterAgentMessage(heard.splice(-1)[0] as AgentMessage);
    expect(service.received).toHaveLength(0);
    await vi.waitFor(() => expect(service.received).toHaveLength(1));
    expect(mark()).toBe(1);
    // Stopping the server ends the send in flight and clears its mark.
    shutdown.abort();
    expect(mark()).toBeNull();
  });
});

describe("a retry", () => {
  it("sends nothing to a device removed during its wait", async () => {
    const id = turnOn(newDevice());
    const service = pushService(queued(500));
    const { wait } = waits([() => removeDevice(fixture.store, fixture.operator, id)]);
    await sender(service.transport, wait).send(notification());
    expect(service.received).toHaveLength(1);
    expect(mark()).toBeNull();
  });

  it("sends nothing under keys a refresh replaced during its wait", async () => {
    const device = newDevice();
    turnOn(device);
    const service = pushService(queued(500));
    const rekeyed = { ...newDevice(device.input.endpoint).input };
    const { wait } = waits([() => refreshDevice(fixture.store, fixture.operator, rekeyed)]);
    await sender(service.transport, wait).send(notification());
    expect(service.received).toHaveLength(1);
  });

  it("sends nothing for a message read, and a newer one notified, during its wait", async () => {
    turnOn(newDevice());
    const service = pushService(queued(500));
    let newer: Notification | undefined;
    const send = sender(
      service.transport,
      waits([
        () => {
          markRead(
            fixture.store,
            fixture.operator,
            threadTarget(builder, 1),
            markInput.parse({
              through: 1,
            }),
          );
          newer = notification(1);
        },
      ]).wait,
    );
    const older = notification();
    const settled = send.send(older);
    await settled;
    await send.send(newer as Notification);
    expect(service.received).toHaveLength(2);
    expect(mark()).toBe(2);
  });
});
