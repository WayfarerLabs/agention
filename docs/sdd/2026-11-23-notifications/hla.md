# Notifications: High-Level Architecture

<!-- cspell:ignore VAPID vapid aes128gcm webmanifest -->

- Status: The FRD is accepted with the operator's rulings, its open choices as recommended, and this
  HLA follows them. Rules are still drafted here as filter sets. Ruling 7 accepts that a rule can
  follow a saved view; the FRD's requirements are revised for it first, and this HLA is updated once
  the operator accepts them (a plan item, before building).
- Date: 2026-11-23
- Requirements: [FRD](frd.md), R1 to R3, N1 and N2, D1 to D5, E1 to E3
- Research: [prior-art research](prior-art-research.md)

This effort adds Web Push notifications to the Agention server and web UI:

- rules, each a set of the thread list's filters, saved from the thread list;
- a check, when an agent's message is saved, of whether its thread now needs the operator;
- a sender that encrypts and posts each notification to the device's browser push service;
- an installable web UI with a service worker that shows a notification and opens its thread.

No agent route, tool or answer changes.

## Decisions at a glance

- **Only an agent's message notifies** (R2). The check runs right after an agent's write commits,
  beside the existing wake of long polls. Nothing runs on a timer, so ADR 0001's "no server action
  on deadlines" holds.
- **A rule is matched by the thread list's own statement**, scoped to one thread. A rule can never
  mean something the list does not show.
- **One mark per thread** records the message that last notified, beside the operator's read and
  archive marks. Reading or archiving through it clears it (N1).
- **Web Push on `jose` and `node:crypto`**, with no new dependency. `jose`, already bundled, signs
  the VAPID token (RFC 8292). About 30 lines of our own do the `aes128gcm` encryption (RFC 8291),
  checked against the RFC's worked example. The `web-push` package would add 13 packages, among them
  a proxy agent, under MPL-2.0 notice obligations in our bundle.
- **The server sends only to the browser push services**, by host name: Google's, Mozilla's, Apple's
  and Microsoft's, over HTTPS on port 443. Any other endpoint is refused when it is registered and
  again when it is sent to.
- **Nothing readable reaches a push service**: every payload is padded to one size, no `Topic`
  header is sent, and the VAPID subject is the project's URL, naming neither the operator nor the
  server's host.
- **A subscription belongs to the passkey that signed its device in.** It goes when that passkey is
  removed, when its device turns notifications off or signs out, or when the operator removes it
  from the device list. A browser session expiring leaves it (FRD D3, ruling 5). Turning a device on
  needs a recent sign-in, and Settings list every device.
- **A failed send is retried briefly, then lets the thread notify again.** No durable queue.
- **A notification is information to the operator, never an action on an agent's work.** The new ADR
  says so, which is how rules may key on open asks, a derived signal, without breaking the review
  checklist's rule that derived signals never trigger actions. Rules never key on what messages say.
- **The service worker is push-only**: `push` and `notificationclick`, no fetch handler, no cache.
- **A new ADR** records Web Push to the operator and marks ADR 0001's "No push" line superseded for
  the operator; reaching an agent only when it checks stays.

## Where it runs

```text
agent --message_send--> server: write commits
                          |
                          +-> long polls woken (as today)
                          `-> notification check (this thread)
                                 | a device on, a rule matches, not notified since read?
                                 +- no  -> done
                                 `- yes -> mark notified -> sender, per subscription
                                                              | VAPID token + aes128gcm, padded
                                                              v
                                             browser push service (FCM, Mozilla, APNs, WNS)
                                                              |
                                                              v
                                 device: service worker `push` -> showNotification(tag = thread)
                                         `notificationclick` -> the thread's route in the app
```

## Components

### Server

**Rules store.** A table of rules, each its filters as a JSON object read back through a strict
schema. The schema lives in `packages/api` beside `threadFilters`, derived from it with `search`,
`unread`, `overdue` and `agent_read` refused and `include_archived` taken and dropped (FRD R1), so a
filter added to the list is one a rule can take unless it is deliberately left out. A rule needs at
least one filter, and there are at most 20, like the other bounded collections. The migration that
creates the table inserts the starting rule, `{"impact": "blocking"}`, once (R3).

A rule naming something that no longer exists keeps its filters as written and the list's statement
decides: a session, tag or topic matches again once one by that name exists, and a removed group,
whose id is never reused, never matches again.

**The check.** It runs in the post-commit blocks of the store's thread start and message append
(`store/threads.ts`, where `appended` wakes long polls), only when the writer is an agent session.
Never in `SessionNotifier.notify`, which revocations also call. In one transaction it:

1. returns when no device is on, so a device turned on later is not denied a thread already marked;
2. returns when the thread's mark is set, meaning it notified and the operator has not read or
   archived through that message since;
3. runs the list's statement once per rule, scoped to this thread, until one matches;
4. on a match, sets the mark to the thread's latest message and returns the payload's parts.

The statement is the list's own: `threadsSeen` already takes its scope as an argument, and
`readThread` already scopes it to one thread, so the check is the list's total with the thread's id
as its scope and the rule's filters through the list's `where` and parameters. No filter is written
twice.

The check never fails the write it follows: the write has committed, so an error is logged and the
agent's answer stands.

**The mark.** A `notified_seq` column on `thread_marks`, the row that holds the operator's
`read_seq` and `archived_seq` for the thread, set by the server rather than the actor, which the
table's comment says. Raising the operator's read mark or archive mark to or past it clears it, so
marking a thread unread later does not keep it silent.

**Push keys.** The server makes its VAPID private key (P-256) at `agention serve` start when none is
stored, as it settles the instance's name, and keeps it in the instance row, so a backup carries it
and a restore keeps every device's subscription working. The public key is derived from it, never
stored apart. The private key never leaves the server and is never logged.

**Subscriptions.** A table of device subscriptions, at most 10: the endpoint URL (unique), its
`p256dh` and `auth` keys, the passkey that signed the device in (`ON DELETE CASCADE`), the hash of
the browser session that registered or last refreshed it (no foreign key, so expiry leaves it), a
label from the browser and platform the device reported, when it was made, and when a push service
last accepted a send to it. They are secrets the server holds and are kept like the others: in the
database, never logged, carried by backups. A device is "this device" by the browser session that
registered or last refreshed it, one subscription per session, so no endpoint travels in a URL.

- **On** (with a recent sign-in): the endpoint must be `https`, port 443 or none, no user
  information, and a host matched below, or the request is refused with a typed error. An existing
  endpoint is updated, not duplicated, taking the current session's hash and passkey; a new one
  replaces the subscription this browser session holds, if any.
- **Refresh** (from the web UI on start and after an in-app sign-in, no recent sign-in needed): only
  updates an endpoint the server stores, its keys, passkey and session hash. For any other, the web
  UI unsubscribes, clears the device's intent and shows it as stopped, and turning it on again is
  **On**. That covers a device removed from another one and a browser that dropped its subscription
  and made a new one.
- **Off** removes this device's subscription, with no recent sign-in. Removing another device's from
  the list needs one, as revoking an API key does.
- A row whose browser no longer holds its subscription ends at the push service's 404 or 410, at
  **On** from its session, or at Remove.
- **Sign-out** of a browser session removes the subscriptions that session registered or last
  refreshed, and the web UI unsubscribes in the browser. Signing in again on the same browser closes
  the old session without signing out; the next refresh moves the subscription to the new session.
- **Removing a passkey**, from Settings or by a passkey link replacing them all, removes its
  subscriptions by cascade.
- **A push service answering 404 or 410** means the subscription is gone; the server removes it.

**The sender.** For each subscription, after the check's transaction commits:

- a VAPID token signed with `jose` (ES256, `aud` the endpoint's origin, `exp` 12 hours out, `sub`
  the project's URL), reused per push service origin until an hour before it expires, since Apple
  asks that a token not be refreshed more than once an hour;
- the payload encrypted with `aes128gcm`, a fresh salt and key per message, its plaintext padded to
  one fixed size the largest payload fits;
- a `fetch` with `redirect: "manual"`, as the transcription provider's, refusing any redirect, a
  10-second timeout, `TTL` of one day and `Urgency: high`, after checking the endpoint's host again;
- on a timeout, a 5xx or a 429, up to two more tries over about a minute;
- when no subscription accepted the send, the mark is cleared if it still names that message, so the
  thread's next agent message tries again.

Sends never hold up the agent's write. When the server stops, it clears the mark of every send not
yet settled before it closes the database, so the thread's next agent message notifies. A crash
gives it no chance to: a thread whose send was in flight keeps its mark and stays silent until the
operator reads or archives it.

**Known push services.** The endpoint's host, matched as a name at a dot boundary and never resolved
by our own code: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `push.apple.com` and
hosts under it, and hosts under `notify.windows.com`. HTTPS and the push service's certificate bind
the name. A new browser's push service needs the list extended, which the operator guide says.

**Routes.** All under the web API, behind the browser session and its CSRF check, none in the
operator API (E2):

- `GET /api/web/notifications`: the public key, the devices (label, made, last accepted send, and
  which is this one), and the rules;
- `POST /api/web/notifications/devices` (on and refresh) and
  `POST /api/web/notifications/devices/:id/remove`;
- `POST /api/web/notifications/rules` (from the thread list's filters) and
  `POST /api/web/notifications/rules/:id/remove`.

Every change is a `POST`, and a removal is `POST .../:id/remove`, as the web API's other routes are.
The check runs from a store hook called after an agent's write commits, which only `agention serve`
sets, so the store does no network work itself.

### Web UI

- **Installable.** A web app manifest (name, icons, `display: standalone`, start URL and scope `/`)
  linked from the page, and `manifest-src 'self'` in the content security policy. The service worker
  comes with notifications, unless Chromium's install check needs it sooner. The policy also states
  `worker-src 'self'`, which today follows from `script-src 'self'`, so a later change to scripts
  cannot widen workers.
- **The service worker** shows each push as a notification: the thread's title, and why it needs the
  operator from its most pressing open ask ("Blocking ask", "Urgent ask", "Open ask") or "New
  message" when none is open. Its `tag` is the thread's agent, session and number, so a later one
  for the thread replaces it. On click it focuses an Agention window and tells it, by message, which
  thread to open, or opens a window at that thread's route. The route is built from the identifiers,
  never taken as a URL from the payload.
- **Device intent.** The web UI keeps, in this browser's storage beside its other device settings,
  whether the operator turned notifications on here. Refresh acts only while it is set; Off and
  sign-out clear it and unsubscribe in the browser. A device the operator turned off is never
  subscribed again without a tap.
- **Settings, Notifications.** This device's switch, asking the browser's permission from the tap,
  with a recent sign-in, and its state ("On", "Off", "Stopped" with why, "Blocked by the browser").
  The device list, each with its label, when it was turned on and when it last received a send, and
  Remove. The rules, each as the list's filter chips, opening the list filtered by it, with Remove.
- **The thread list's bar** gains **Notify me** while a filter a rule can take is on, saving those
  filters as a rule. While a filter a rule cannot take is on, the action is off and its description
  says which.

### Agents

The usage skill tells agents that an ask's impact and priority may notify the operator's devices, so
they set them honestly. No route, tool or answer changes, and the agent API version stays (E1).

## Data model additions

| Where                        | Holds                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| `notification_rules` (new)   | id, filters (strict JSON), created_at; the starting rule inserted once    |
| `push_subscriptions` (new)   | endpoint (unique), keys, passkey (cascade), session hash, label, made and |
|                              | last-accepted times                                                       |
| `thread_marks.notified_seq`  | the message that last notified, cleared by the operator's read or archive |
| `instance.vapid_private_key` | made at serve start when absent                                           |

One migration adds them, with its frozen hash, and rolls back as a whole like the others.

## Security model additions

- **Outbound:** HTTPS on port 443 only, to the push service host names, with no redirect followed, a
  10-second timeout, and the host checked when registered and when sent to.
- **What a push service sees:** the endpoint it issued, the VAPID public key and token (naming the
  project, not the server's host), `TTL`, `Urgency`, and a ciphertext of fixed size. Not the
  thread's title, agent, session or number, and no per-thread value it could link notifications by.
- **What a device shows:** the thread's title and why, on its lock screen. Never a message's text
  (D5, ruling 4).
- **Keys:** the VAPID private key and the subscriptions are secrets in the database, carried by
  backups, which are already private files.
- **Who can subscribe:** only a signed-in browser with a recent sign-in, through the web API with
  CSRF. Every device that receives notifications is listed and removable from any device. An API key
  can neither subscribe nor change rules.
- **The service worker** takes no URL from a payload and has no fetch handler.
- **Review checklist:** a new check for push: outbound limits, padding, no per-thread value in
  clear, nothing from a payload used as a URL, and notifications never keyed on message content.

## Testing

- **Crypto:** the RFC 8291 worked example, byte for byte; the VAPID token verified with `jose`
  against the public key, with its `aud`, `exp` and `sub`.
- **Matching:** a rule keeps its own thread and not a sibling in the same session, for an ask filter
  and a name filter; the starting rule; a rule naming a removed session and a removed group; an
  empty rule refused.
- **Volume:** an agent's message notifies once; another before the operator reads does not; after a
  read or archive, the next one does, including after marking unread again; the operator's own
  writes never notify; no device on, no mark.
- **Sender:** against a local test push service through the sender's transport seam: padding to one
  size, headers, no redirect followed, retries on 5xx, 429 and timeouts, the mark cleared when every
  send failed, 404 and 410 removing the subscription, and a slow service not holding up the write.
  The host and endpoint rule is tested apart, as a pure function.
- **Subscriptions:** refused endpoints; a recent sign-in needed to register and to remove another
  device; sign-out, passkey removal by either path and Remove from the list; expiry leaving them; a
  second sign-in moving one; a refresh of an endpoint the server does not store stopping the device.
- **Browser (Chromium, Playwright):** headless Chromium has no push service and Playwright cannot
  click a system notification, so these run against a stubbed `pushManager` and by delivering `push`
  and `notificationclick` events to the worker directly: the switch's states, the device list,
  Notify me, rules in Settings, and a click opening the right thread. The manifest's install check
  runs through Chromium's own installability report where the headless shell offers it.
- **Devices (operator):** Android Chrome installed and screen off, and Windows Edge and Chrome, as
  the FRD's definition of done says. Apple browsers are built to their documented rules and stated
  as untested; Apple's declarative Web Push is not adopted, for the same reason.

## Delivery

Two pull requests, each usable on its own:

1. **Installable web UI:** the manifest, icons, `manifest-src` and the guide's install steps.
   Agention can be added to a phone's home screen. If Chromium's install check needs a service
   worker after all, this folds into the second PR rather than shipping one that does nothing.
2. **Notifications:** everything else here, with its collateral: the operator guide, the usage
   skill, SECURITY.md, the architecture document, the new ADR, the review checklist, the live
   testing guide, and the development contract's optional integrations.

## Settled with the operator

The operator accepted the FRD's five choices and the Web Push library as recommended (FRD rulings 1
to 6). Each other answer would have changed this design only locally:

- **A starting rule of "any open ask", or none:** the migration's insert.
- **A reminder:** a periodic job and a reminded mark, which could also notify when an answer-by
  passes; it would need its own line in the new ADR, since ADR 0001 rules out server action on
  deadlines.
- **Quiet hours:** a time zone setting, a held mark per thread and a job at the window's end.
- **A preview option:** a setting behind a recent sign-in, and the latest agent message's first
  line, cut to a byte budget so the payload stays within the smallest push service's limit.
- **Ending with the sign-in:** the subscription's session column becomes a foreign key with cascade.
- **The `web-push` package:** it replaces our encryption and token code, and the server pads the
  payload before handing it over and sends the request itself.
