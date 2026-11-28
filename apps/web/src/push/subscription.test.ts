// cspell:ignore KHTML BAAA

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepDeviceNotifications, readDeviceNotifications } from "../device.ts";
import { FakeApi, failure } from "../test-support.tsx";
import { deviceLabel, refreshDevice, turnOff, turnOn } from "./subscription.ts";

describe("deviceLabel", () => {
  it.each([
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Chrome on Windows",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox on Linux"],
    ["something else", "Browser"],
  ])("names %s as %s", (userAgent, label) => {
    expect(deviceLabel(userAgent)).toBe(label);
  });
});

// The server's public key in the fake API's default answer (noNotifications),
// as the bytes a browser holds it as.
const serverKey = new Uint8Array([4, 0, 0]).buffer;
// The same key as the server gives it, base64url.
const serverPublicKey = "BAAA";

// This device's subscription as the web UI refreshes it and turns it off,
// against a browser that holds one or none.
describe("the browser's subscription", () => {
  let api: FakeApi;
  let held: { subscription: PushSubscription | null; unsubscribed: number };

  // subscription is a browser's subscription under a key.
  const subscription = (key: ArrayBuffer): PushSubscription =>
    ({
      options: { applicationServerKey: key },
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        keys: { p256dh: "p", auth: "a" },
      }),
      unsubscribe: () => {
        held.unsubscribed++;
        held.subscription = null;
        return Promise.resolve(true);
      },
    }) as unknown as PushSubscription;

  beforeEach(() => {
    api = new FakeApi();
    held = { subscription: null, unsubscribed: 0 };
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", class {});
    const registration = {
      pushManager: { getSubscription: () => Promise.resolve(held.subscription) },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: () => Promise.resolve(registration) },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    expect(api.unhandled).toEqual([]);
  });

  describe("refreshDevice", () => {
    it("does nothing while this device's notifications are not on", async () => {
      keepDeviceNotifications({ state: "stopped", why: "removed" });
      await refreshDevice("token");
      expect(api.calls).toEqual([]);
    });

    it("tells the server the browser's subscription, which keeps them on", async () => {
      keepDeviceNotifications({ state: "on" });
      held.subscription = subscription(serverKey);
      api.on("POST", "/notifications/devices/refresh", { body: { device: {} } });
      await refreshDevice("token");
      expect(
        api.callsTo("POST", "/notifications/devices/refresh").map((call) => call.body),
      ).toEqual([
        {
          endpoint: "https://fcm.googleapis.com/fcm/send/abc",
          keys: { p256dh: "p", auth: "a" },
          label: expect.any(String) as string,
        },
      ]);
      expect(readDeviceNotifications()).toEqual({ state: "on" });
    });

    it("stops them when the browser holds no subscription, or one under another key", async () => {
      keepDeviceNotifications({ state: "on" });
      await refreshDevice("token");
      expect(readDeviceNotifications()).toEqual({ state: "stopped", why: "dropped" });

      keepDeviceNotifications({ state: "on" });
      held.subscription = subscription(new Uint8Array([4, 1, 1]).buffer);
      await refreshDevice("token");
      expect(readDeviceNotifications()).toEqual({ state: "stopped", why: "dropped" });
      expect(held.unsubscribed).toBe(1);
      expect(api.callsTo("POST", "/notifications/devices/refresh")).toEqual([]);
    });

    it("stops them, ending the browser's subscription, when the server does not know it", async () => {
      keepDeviceNotifications({ state: "on" });
      held.subscription = subscription(serverKey);
      api.on("POST", "/notifications/devices/refresh", failure("not_found", "device not found"));
      await refreshDevice("token");
      expect(readDeviceNotifications()).toEqual({ state: "stopped", why: "removed" });
      expect(held.unsubscribed).toBe(1);
    });

    it("leaves them on when the refresh fails otherwise, for the next start to try again", async () => {
      keepDeviceNotifications({ state: "on" });
      held.subscription = subscription(serverKey);
      api.on("POST", "/notifications/devices/refresh", { status: 502, text: "bad gateway" });
      await expect(refreshDevice("token")).rejects.toThrow();
      expect(readDeviceNotifications()).toEqual({ state: "on" });
      expect(held.unsubscribed).toBe(0);
    });
  });

  describe("turnOn", () => {
    let permission: NotificationPermission;
    let subscribe: () => Promise<PushSubscription>;

    beforeEach(() => {
      permission = "granted";
      subscribe = () => {
        held.subscription = subscription(serverKey);
        return Promise.resolve(held.subscription);
      };
      vi.stubGlobal("Notification", { requestPermission: () => Promise.resolve(permission) });
      registration = {
        active: {},
        installing: null,
        waiting: null,
        pushManager: {
          getSubscription: () => Promise.resolve(held.subscription),
          subscribe: () => subscribe(),
        },
      };
      register = () => Promise.resolve(registration);
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: () => register(),
          getRegistration: () => Promise.resolve(registration),
          // As the browser's, it waits for an active worker and never fails.
          ready: new Promise(() => undefined),
        },
      });
    });

    let registration: Record<string, unknown>;
    let register: () => Promise<unknown>;

    // installing is a worker still installing. Its waited says once turning
    // on waits on it, and become moves it to a state then.
    const installing = () => {
      const worker = Object.assign(new EventTarget(), { state: "installing" });
      let waits = 0;
      const listen = worker.addEventListener.bind(worker);
      worker.addEventListener = (...args: Parameters<EventTarget["addEventListener"]>) => {
        waits++;
        listen(...args);
      };
      registration.active = null;
      registration.installing = worker;
      return {
        waited: () => waits > 0,
        become: (state: string) => {
          worker.state = state;
          worker.dispatchEvent(new Event("statechange"));
        },
      };
    };

    it("fails, sending nothing, when the browser cannot register the worker", async () => {
      register = () => Promise.reject(new DOMException("script failed to load", "TypeError"));
      await expect(turnOn(serverPublicKey, "token")).rejects.toThrow("TypeError");
      expect(api.calls).toEqual([]);
      expect(readDeviceNotifications()).toEqual({ state: "off" });
    });

    it("fails, sending nothing, when the worker it waits on never activates", async () => {
      const worker = installing();
      const turning = turnOn(serverPublicKey, "token");
      await vi.waitFor(() => expect(worker.waited()).toBe(true));
      worker.become("redundant");
      await expect(turning).rejects.toThrow();
      expect(api.calls).toEqual([]);
    });

    it("waits for a worker still installing, subscribing only once it is active", async () => {
      const worker = installing();
      const device = { id: 1, label: "Chrome", created_at: "", current: true };
      api.on("POST", "/notifications/devices", { body: { device } });
      const turning = turnOn(serverPublicKey, "token");
      await vi.waitFor(() => expect(worker.waited()).toBe(true));
      expect(api.calls).toEqual([]);
      worker.become("activated");
      await expect(turning).resolves.toEqual(device);
    });

    it("tells the server the browser's new subscription, and keeps the choice", async () => {
      const device = { id: 1, label: "Chrome", created_at: "", current: true };
      api.on("POST", "/notifications/devices", { body: { device } });
      await expect(turnOn(serverPublicKey, "token")).resolves.toEqual(device);
      expect(api.callsTo("POST", "/notifications/devices")).toHaveLength(1);
      expect(readDeviceNotifications()).toEqual({ state: "on" });
    });

    it("goes no further than the permission when the browser does not grant it", async () => {
      let subscribed = 0;
      subscribe = () => {
        subscribed++;
        return Promise.reject(new Error("not reached"));
      };
      for (const answer of ["denied", "default"] as const) {
        permission = answer;
        await expect(turnOn(serverPublicKey, "token")).rejects.toThrow();
      }
      expect([subscribed, api.calls]).toEqual([0, []]);
    });

    it("passes on the browser's own reason when its push service fails", async () => {
      subscribe = () =>
        Promise.reject(new DOMException("Registration failed - push service error", "AbortError"));
      await expect(turnOn(serverPublicKey, "token")).rejects.toThrow(
        "AbortError: Registration failed - push service error",
      );
      expect(api.calls).toEqual([]);
    });

    it("ends the browser's subscription when the server refuses it", async () => {
      api.on("POST", "/notifications/devices", failure("not_allowed", "sign in again"));
      await expect(turnOn(serverPublicKey, "token")).rejects.toThrow();
      expect([held.unsubscribed, readDeviceNotifications()]).toEqual([1, { state: "off" }]);
    });
  });

  describe("turnOff", () => {
    it("removes the device the server lists as this one", async () => {
      keepDeviceNotifications({ state: "on" });
      held.subscription = subscription(serverKey);
      api.on("POST", "/notifications/devices/7/remove", { body: {} });
      await turnOff({ id: 7, label: "Chrome", created_at: "", current: true }, "token");
      expect(api.callsTo("POST", "/notifications/devices/refresh")).toEqual([]);
      expect(api.callsTo("POST", "/notifications/devices/7/remove")).toHaveLength(1);
      expect([held.unsubscribed, readDeviceNotifications()]).toEqual([1, { state: "off" }]);
    });

    it("with none listed as this one, refreshes first, so the server's row goes too", async () => {
      keepDeviceNotifications({ state: "on" });
      held.subscription = subscription(serverKey);
      api.on("POST", "/notifications/devices/refresh", {
        body: { device: { id: 7, label: "Chrome", created_at: "", current: true } },
      });
      api.on("POST", "/notifications/devices/7/remove", { body: {} });
      await turnOff(undefined, "token");
      expect(api.callsTo("POST", "/notifications/devices/7/remove")).toHaveLength(1);
      expect([held.unsubscribed, readDeviceNotifications()]).toEqual([1, { state: "off" }]);
    });

    it("with none listed and one the server does not know, is off all the same", async () => {
      keepDeviceNotifications({ state: "on" });
      held.subscription = subscription(serverKey);
      api.on("POST", "/notifications/devices/refresh", failure("not_found", "device not found"));
      await turnOff(undefined, "token");
      expect([held.unsubscribed, readDeviceNotifications()]).toEqual([1, { state: "off" }]);
    });
  });
});
