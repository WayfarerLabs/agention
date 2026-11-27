import {
  type NotificationsState,
  type PushDevice,
  type PushDeviceResult,
  type PushSubscriptionInput,
} from "@wayfarerlabs/agention-api";
import { ApiFailure, PageFailure, request } from "../api.ts";
import { keepDeviceNotifications, readDeviceNotifications, type StopReason } from "../device.ts";

// This browser's push subscription, which the server sends this device's
// notifications to. The operator turns it on from Settings, with a tap;
// while it is on, the web UI refreshes it with the server as it starts and
// after an in-app sign-in, and finds it stopped when the browser no longer
// holds it or the server no longer knows it. Nothing here subscribes the
// browser but turning it on.

// The service worker's script, at the root, so its scope is the whole web UI.
const serviceWorkerScript = "/service-worker.js";

export const loadNotifications = () => request<NotificationsState>("GET", "/notifications");

// pushSupported says whether this browser can receive notifications: it has
// service workers and the Push and Notifications APIs, which Apple's browsers
// offer only to a web UI added to the Home Screen.
export const pushSupported = (): boolean =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// registerServiceWorker registers the web UI's service worker as the page
// starts, so it is there to turn notifications on and to refresh them, and a
// new release's worker installs. Registering again is no new registration.
export function registerServiceWorker(): void {
  if (pushSupported()) {
    navigator.serviceWorker.register(serviceWorkerScript, { scope: "/" }).catch(() => {
      // No worker, no notifications here; the page itself works as ever.
    });
  }
}

// deviceLabel names a device for Settings' list, from what its browser
// reports, as "Chrome on Android".
export function deviceLabel(userAgent: string): string {
  const browser = /Edg(A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(userAgent)
      ? "Firefox"
      : /SamsungBrowser\//.test(userAgent)
        ? "Samsung Internet"
        : /OPR\//.test(userAgent)
          ? "Opera"
          : /Chrome\/|CriOS\//.test(userAgent)
            ? "Chrome"
            : /Safari\//.test(userAgent)
              ? "Safari"
              : "Browser";
  const platform = /Android/.test(userAgent)
    ? "Android"
    : /iPhone/.test(userAgent)
      ? "iPhone"
      : /iPad/.test(userAgent)
        ? "iPad"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /CrOS/.test(userAgent)
            ? "ChromeOS"
            : /Macintosh|Mac OS X/.test(userAgent)
              ? "macOS"
              : /Linux/.test(userAgent)
                ? "Linux"
                : undefined;
  return platform === undefined ? browser : `${browser} on ${platform}`;
}

const keyBytes = (base64url: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64url.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (each) => each.charCodeAt(0));
};

// underKey says whether a subscription was made with the server's public key.
function underKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  if (key === null) {
    return false;
  }
  const held = new Uint8Array(key);
  const wanted = keyBytes(publicKey);
  return held.length === wanted.length && held.every((byte, index) => byte === wanted[index]);
}

// subscriptionInput is a subscription as the server takes it, with this
// device's label.
function subscriptionInput(subscription: PushSubscription): PushSubscriptionInput {
  const { endpoint = "", keys = {} } = subscription.toJSON();
  return {
    endpoint,
    keys: { p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" },
    label: deviceLabel(navigator.userAgent),
  };
}

// heldSubscription gives the subscription the browser holds for the web UI,
// if any, without waiting for a worker that is not there.
async function heldSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

// unsubscribeHere ends the browser's subscription, if it holds one. A
// browser that fails to leaves one that no push reaches once the server
// forgot it.
async function unsubscribeHere(): Promise<void> {
  try {
    await (await heldSubscription())?.unsubscribe();
  } catch {
    // Nothing more to do here: the server sends to it no more.
  }
}

// turnOn turns this device's notifications on: the browser's permission,
// asked from the operator's tap, then a subscription under the server's
// public key, replacing one under another key, which a browser would not
// hold beside it, then the server's record of it, which needs a recent
// sign-in. The device keeps the choice once the server accepts it.
export async function turnOn(publicKey: string, csrf: string | undefined): Promise<PushDevice> {
  const permission = await Notification.requestPermission();
  // Denied is blocked, the operator or the browser having said no for good;
  // anything else not granted was dismissed.
  if (permission === "denied") {
    throw new PageFailure(
      "This browser blocks Agention's notifications. Allow them in the browser's site settings, then turn them on again.",
    );
  }
  if (permission !== "granted") {
    throw new PageFailure(
      "The browser did not allow notifications. Turn them on again to answer its question.",
    );
  }
  const registration = await activeRegistration();
  const held = await registration.pushManager.getSubscription();
  if (held !== null && !underKey(held, publicKey)) {
    await held.unsubscribe();
  }
  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
  } catch (failure) {
    // The browser's own reason, such as "AbortError: Registration failed -
    // push service error", is the only clue to why, so the page shows it.
    throw new PageFailure(
      `This browser could not reach its push service to turn notifications on (${browserReason(failure)}). Try again later.`,
    );
  }
  let device: PushDevice;
  try {
    ({ device } = await request<PushDeviceResult>("POST", "/notifications/devices", {
      csrf,
      body: subscriptionInput(subscription),
    }));
  } catch (failure) {
    await unsubscribeHere();
    throw failure;
  }
  keepDeviceNotifications({ state: "on" });
  return device;
}

// activeRegistration registers the service worker, or finds it registered,
// and waits until it is active, since a subscription needs an active worker.
// It fails when registering fails or the worker never activates, where
// waiting on navigator.serviceWorker.ready would wait for good, so turning
// on says why and can be tried again.
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const failed = (why?: string) =>
    new PageFailure(
      `This browser could not set up Agention's notifications${why === undefined ? "" : ` (${why})`}. Try again later.`,
    );
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(serviceWorkerScript, { scope: "/" });
  } catch (failure) {
    throw failed(browserReason(failure));
  }
  if (registration.active !== null) {
    return registration;
  }
  const worker = registration.installing ?? registration.waiting;
  if (worker === null) {
    throw failed();
  }
  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      if (worker.state === "activated") {
        resolve();
      } else if (worker.state === "redundant") {
        reject(failed());
      }
    };
    worker.addEventListener("statechange", settle);
    settle();
  });
  return registration;
}

// browserReason gives a failure the browser threw as its name and message.
function browserReason(failure: unknown): string {
  if (failure instanceof Error) {
    return failure.message === "" ? failure.name : `${failure.name}: ${failure.message}`;
  }
  return String(failure);
}

// turnOff turns this device's notifications off: the server forgets its
// subscription, which needs no recent sign-in, then the browser ends it and
// the device forgets the choice. With no device the server lists as this
// one, as after a new sign-in on this browser before the refresh moved its
// subscription to it, the browser's subscription is refreshed first, which
// moves it here, so it is removed all the same. One the server does not
// know is off already.
export async function turnOff(device: PushDevice | undefined, csrf: string | undefined) {
  const notFound = (failure: unknown) =>
    failure instanceof ApiFailure && failure.code === "not_found";
  let current = device;
  if (current === undefined) {
    const subscription = await heldSubscription();
    if (subscription !== null) {
      try {
        ({ device: current } = await request<PushDeviceResult>(
          "POST",
          "/notifications/devices/refresh",
          { csrf, body: subscriptionInput(subscription) },
        ));
      } catch (failure) {
        if (!notFound(failure)) {
          throw failure;
        }
      }
    }
  }
  if (current !== undefined) {
    try {
      await request("POST", `/notifications/devices/${current.id}/remove`, { csrf });
    } catch (failure) {
      if (!notFound(failure)) {
        throw failure;
      }
    }
  }
  await unsubscribeHere();
  keepDeviceNotifications({ state: "off" });
}

// forgetNotificationsHere ends this device's notifications in the browser as
// it signs out, which the server's sign-out ends there.
export function forgetNotificationsHere(): void {
  keepDeviceNotifications({ state: "off" });
  void unsubscribeHere();
}

// stop records that this device's notifications stopped, and why, ending the
// browser's subscription, unless the operator changed them meanwhile.
async function stop(why: StopReason): Promise<void> {
  if (readDeviceNotifications().state !== "on") {
    return;
  }
  await unsubscribeHere();
  keepDeviceNotifications({ state: "stopped", why });
}

// refreshDevice runs while this device's notifications are on, as the web UI
// starts and after an in-app sign-in: it tells the server the browser's
// subscription as it is now, which also moves it to this browser's newest
// session. A browser that holds none, or one under another key, dropped
// them; one the server does not know was removed from another device or
// ended by its push service. Either way the device's notifications have
// stopped, and only turning them on again, with a tap, subscribes it again.
// Any other failure leaves them on, for the next start to try again.
export async function refreshDevice(csrf: string | undefined): Promise<void> {
  if (readDeviceNotifications().state !== "on" || !pushSupported()) {
    return;
  }
  const subscription = await heldSubscription();
  const { public_key } = await loadNotifications();
  if (subscription === null || !underKey(subscription, public_key)) {
    await stop("dropped");
    return;
  }
  try {
    await request<PushDeviceResult>("POST", "/notifications/devices/refresh", {
      csrf,
      body: subscriptionInput(subscription),
    });
  } catch (failure) {
    if (failure instanceof ApiFailure && failure.code === "not_found") {
      await stop("removed");
      return;
    }
    throw failure;
  }
}
