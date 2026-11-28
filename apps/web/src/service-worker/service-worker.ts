// The web UI's service worker, which shows each push as a notification and
// opens its thread when the operator opens one. It is push-only: no fetch
// handler, no cache. It takes no URL from a payload: a thread's route is
// built from its identifiers, on the worker's own origin. It loads no schema
// library, so it stays a few kilobytes, which browsers fetch whole at each
// start of the web UI: it checks what it reads by hand, in push-data.ts.
import type { OpenThreadMessage } from "@wayfarerlabs/agention-api";
import { matchRoute, threadHref } from "../routes.ts";
import { payloadOf, reasonWords, threadOf } from "./push-data.ts";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("push", (event) => {
  event.waitUntil(show(event.data));
});

async function show(data: PushMessageData | null): Promise<void> {
  const payload = payloadOf(data);
  if (payload === undefined) {
    // A push must always show something, or browsers revoke the permission.
    return self.registration.showNotification("Agention", { body: "Something needs you" });
  }
  const { agent, session, thread, title, why } = payload;
  // The tag is the thread, so a later notification of it replaces this one
  // where the browser honors tags; it alerts again, since a thread notifies
  // again only once it was read.
  const options: ReplacingOptions = {
    body: reasonWords[why],
    tag: `${agent}/${session}/${thread}`,
    renotify: true,
    data: { agent, session, thread },
    icon: "/icons/192.png",
  };
  return self.registration.showNotification(title, options);
}

// The Notifications API's renotify, which TypeScript's library leaves out:
// a notification replacing one of the same tag alerts again.
interface ReplacingOptions extends NotificationOptions {
  renotify: boolean;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(open(event.notification.data));
});

// showsWebUi says whether a window is the web UI, whose page listens for the
// thread to open, rather than another page of this origin, such as the API's
// documentation, which runs no script.
const showsWebUi = (client: WindowClient) =>
  matchRoute(new URL(client.url).pathname).name !== "not-found";

// open opens a notification's thread: in a web UI window, the focused one
// first, by telling it which, or else in a new window at the thread's route.
async function open(data: unknown): Promise<void> {
  const target = threadOf(data);
  const path = target === undefined ? "/" : threadHref(target.agent, target.session, target.thread);
  const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
    .filter((client): client is WindowClient => "focus" in client)
    .filter(showsWebUi);
  const client = windows.find((each) => each.focused) ?? windows[0];
  if (client === undefined) {
    await self.clients.openWindow(new URL(path, self.location.origin).href);
    return;
  }
  await client.focus();
  if (target !== undefined) {
    const message: OpenThreadMessage = { type: "open-thread", ...target };
    client.postMessage(message);
  }
}
