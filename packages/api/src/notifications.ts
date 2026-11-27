import { z } from "zod";
import { threadNumber } from "./bounds.ts";
import { name } from "./names.ts";
import { savedViewId } from "./saved-views.ts";
import { singleLineText } from "./text.ts";
import type { ThreadFilters } from "./thread-lists.ts";

// Notifications: the operator's devices that receive Web Push, and the saved
// views that notify, a view notifying when an agent's message leaves a thread
// its list keeps. Only the web UI reaches them; the operator API neither
// changes nor shows them, and no agent route does.

// The filters that keep a saved view from notifying while they are on:
// search, since a notification never acts on what messages say, and overdue
// and the agent's reading, which change with time alone. Unread and
// including archived threads are not among them, since every agent message
// leaves its thread unread and not archived.
const refusedFilters = ["search", "overdue", "agent_read"] as const;
export type NotifyRefusedFilter = (typeof refusedFilters)[number];

// The refused filters' names, as the thread list's filters name them, which
// the server's refusal and the web UI both say.
export const refusedFilterNames: Record<NotifyRefusedFilter, string> = {
  search: "Search",
  overdue: "Overdue",
  agent_read: "Read by agent",
};

// refusedFiltersOn names the refused filters a list has on. A saved view is
// stored whole, so a filter at its default is present but off: overdue is on
// only when true, search and agent_read whenever set.
export function refusedFiltersOn(filters: ThreadFilters): NotifyRefusedFilter[] {
  return refusedFilters.filter((filter) =>
    filter === "overdue" ? filters.overdue : filters[filter] !== undefined,
  );
}

// The most devices that receive notifications at once.
export const maxPushDevices = 10;

export const pushDeviceId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// What a device reported of its browser and platform, as "Chrome on Android".
export const pushDeviceLabel = singleLineText({ min: 1, max: 60 });

// A browser's push subscription as its toJSON gives it, with the label the
// web UI makes for the device. The server checks the endpoint names a known
// push service and that the keys decode to a P-256 point and a 16-octet
// secret.
export const pushSubscriptionInput = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "must be base64url"),
    auth: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be base64url"),
  }),
  label: pushDeviceLabel,
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInput>;

// A device that receives notifications, as Settings lists it: its label, when
// it was turned on, when a push service last accepted a send to it, if ever,
// and whether it is this browser's.
export const pushDevice = z.object({
  id: pushDeviceId,
  label: z.string(),
  created_at: z.string(),
  accepted_at: z.string().optional(),
  current: z.boolean(),
});
export type PushDevice = z.infer<typeof pushDevice>;

export const pushDeviceResult = z.object({ device: pushDevice });
export type PushDeviceResult = z.infer<typeof pushDeviceResult>;

// What Settings show of notifications: the server's public key, which a
// browser subscribes with, base64url; whether this browser signed in
// recently enough to turn a device on or remove another; every device, in
// the order they were turned on; and the ids of the saved views that notify.
export const notificationsState = z.object({
  public_key: z.string(),
  recent: z.boolean(),
  devices: z.array(pushDevice).max(maxPushDevices),
  notifying: z.array(savedViewId),
});
export type NotificationsState = z.infer<typeof notificationsState>;

// Turning a saved view's notifying on takes the view's id.
export const notifyViewInput = z.object({ view: savedViewId });
export type NotifyViewInput = z.infer<typeof notifyViewInput>;

// Why a thread needs the operator, from its open asks: one blocks, the most
// pressing is urgent, one is open, or none is and the agent wrote.
export const pushReason = z.enum(["blocking", "urgent", "open", "message"]);
export type PushReason = z.infer<typeof pushReason>;

// The thread a notification is about, by the identifiers its route is built
// from.
export const pushThread = z.object({ agent: name, session: name, thread: threadNumber });
export type PushThread = z.infer<typeof pushThread>;

// A notification as the server encrypts it to a device: the thread, its
// title, and why it needs the operator, never a message's text. The service
// worker ignores a field it does not know.
export const pushPayload = pushThread.extend({ title: z.string(), why: pushReason });
export type PushPayload = z.infer<typeof pushPayload>;

// What the service worker tells a web UI window when the operator opens a
// notification: open this thread.
export const openThreadMessage = pushThread.extend({ type: z.literal("open-thread") });
export type OpenThreadMessage = z.infer<typeof openThreadMessage>;
