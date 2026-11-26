# Notifications: High-Level Architecture

<!-- cspell:ignore VAPID vapid aes128gcm webmanifest -->

- Status: Follows the FRD as the operator accepted it, with its rulings: a rule is a saved view that
  notifies (rulings 7, 9, and 10). It builds on saved views (agention#184), which ships in the same
  release (ruling 10).
- Date: 2026-11-23
- Requirements: [FRD](frd.md), R1 to R3, N1 and N2, D1 to D5, E1 to E3
- Research: [prior-art research](prior-art-research.md)

This effort adds Web Push notifications to the Agention server and web UI:

- rules, each a saved view the operator switched to notify, matched by its filters;
- a check, when an agent's message is saved, of whether its thread now needs the operator;
- a sender that encrypts and posts each notification to the device's browser push service;
- an installable web UI with a service worker that shows a notification and opens its thread.

No agent route, tool or answer changes.

## Decisions at a glance

- **Only an agent's message notifies** (R2). The check runs right after an agent's write commits,
  beside the existing wake of long polls. Nothing runs on a timer, so ADR 0001's "no server action
  on deadlines" holds.
- **A rule is a saved view that notifies** (R1): a flag on the view and nothing else, so it follows
  the view: a rename keeps it, a replaced list is what the next check matches, and removing the view
  ends it. The operator keeps one list, not two in step.
- **A rule is matched by the thread list's own statement** from its view's filters, scoped to one
  thread. A rule can never mean something its view does not show, and the view's order and grouping,
  which only arrange threads, play no part.
- **No notifying view has a refused filter on.** Turning notifying on refuses a view with search,
  overdue, or the agent's reading on, and replacing a notifying view's list with one that has one on
  ends its notifying, so a notification never names a thread its view would not show and no view
  sits paused.
- **`saved-views:write` changes what notifies** (E2, ruling 9). Replacing or removing a view that
  notifies changes or ends its notifying, a write across resources that review check A18 records as
  a second intended crossing beside the tag rename. No saved views read shows the flag, so the
  operator API never says which views notify. Saved views and notifications ship in one release
  (ruling 10), so no key already issued with that scope gains it.
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
  the operator; reaching an agent only when it checks stays. It amends ADR 0006's "One crossing is
  intended" with the second crossing, and says that "never changes what an existing scope grants"
  (review check A18, `SECURITY.md`) holds because saved views and notifications ship in one release
  (ruling 10).

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

**Rules.** A `notifies` column on `saved_views`, off by default: a rule is a view with it on. It
holds no filters of its own and needs no bound of its own, since saved views' 200 bounds it.
Removing a view ends its notifying with the row, a rename changes nothing, and a replaced list is
what the next check matches. No saved views read selects the column, so neither mount's saved views
operations show it (E2). A view naming something that no longer exists matches as its list does
(saved views R9): a session, tag or topic once one by that name exists, and a removed group, whose
id is never reused, never again.

**The refused filters.** One predicate in `packages/api` names the filters a view has on that cannot
notify (R1): `search` set, `overdue` true, and `agent_read` set. Views are stored whole, so a filter
at its default is present but off. Turning notifying on refuses a view with one on, naming it, and
replacing a notifying view's list with one that has one on turns `notifies` off in the same update,
so no notifying view ever has one on. The check skips one all the same, and a later migration that
rewrites stored views turns `notifies` off for a view its rewrite gives a refused filter. The web UI
names a view's refused filter with the same predicate.

**The starting view.** The migration, appended after saved views' own, inserts a saved view of
`{"impact": "blocking"}` as `threadsView` parses it, every part stored as saved views store one,
with `notifies` on (R3). Its name is the first of "Blocking asks", "Blocking asks 2", and so on that
is not taken, compared as the name column's uniqueness compares, ignoring the case of ASCII letters.
It is added even beside a view of the same filters, and skipped when 200 views exist.

**The check.** It runs in the post-commit blocks of the store's thread start and message append
(`store/threads.ts`, where `appended` wakes long polls), only when the writer is an agent session.
Never in `SessionNotifier.notify`, which revocations also call. In one transaction it:

1. returns when no device is on, so a device turned on later is not denied a thread already marked;
2. returns when the thread's mark is set, meaning it notified and the operator has not read or
   archived through that message since;
3. runs the list's statement once per notifying view, from the view's filters and scoped to this
   thread, until one matches;
4. on a match, sets the mark to the thread's latest message and returns the payload's parts.

The statement is the list's own: `threadsSeen` already takes its scope as an argument, and
`readThread` already scopes it to one thread, so the check is the list's total with the thread's id
as its scope and the view's filters through the list's `where` and parameters. No filter is written
twice.

The view is read through saved views' strict read of a stored view and passed to the statement as it
is. The list's `where`, its parameters, and the lead of a thread read only the view's filters, and
the check counts with the list's default order, so the view's order, direction, and grouping change
no match: with a filter on asks on, a thread leads with an ask meeting every one whenever it holds
one, and the order only picks which. Unread and including archived threads run as the list runs
them, and an agent's message leaves its thread unread and not archived for the operator.

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
- before each try, a read of the store that the subscription still holds the endpoint and keys the
  check found and that the thread's mark still names this message. A device whose notifications
  ended meanwhile gets nothing (FRD D3), nor does one under keys it has replaced, and a thread read
  or notified anew meanwhile gets no late alert that would replace its newer notification. A stale
  try is cancelled, as one not accepted; a request already started cannot be recalled;
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
  which is this one), and the views that notify;
- `POST /api/web/notifications/devices` (on and refresh) and
  `POST /api/web/notifications/devices/:id/remove`;
- `POST /api/web/notifications/views` (a view's id, turning its notifying on) and
  `POST /api/web/notifications/views/:id/remove` (turning it off).

The operator API's saved views operations keep their shapes; their replace and remove end a view's
notifying as above, which is the crossing under `saved-views:write`. Every change is a `POST`, and a
removal is `POST .../:id/remove`, as the web API's other routes are. The check runs from a store
hook called after an agent's write commits, which only `agention serve` sets, so the store does no
network work itself.

### Web UI

- **Installable.** A web app manifest (name, icons, `display: standalone`, start URL and scope `/`)
  linked from the page, and `manifest-src 'self'` in the content security policy. The service worker
  comes with notifications, unless Chromium's install check needs it sooner. The policy also states
  `worker-src 'self'`, which today follows from `script-src 'self'`, so a later change to scripts
  cannot widen workers.
- **The service worker** shows each push as a notification: the thread's title, and why it needs the
  operator from its most pressing open ask ("Blocking ask", "Urgent ask", "Open ask") or "New
  message" when none is open. Its `tag` is the thread's agent, session and number, so a later one
  for the thread replaces it. On click it focuses a window showing the web UI, one whose address is
  a route of the UI, and tells it, by message, which thread to open; with none, it opens a window at
  that thread's route (FRD D4). Another page of the origin, such as the API's documentation, which
  runs no script, is never chosen. The route is built from the identifiers, never taken as a URL
  from the payload.
- **Device intent.** The web UI keeps, in this browser's storage beside its other device settings,
  whether the operator turned notifications on here. Refresh acts only while it is set; Off and
  sign-out clear it and unsubscribe in the browser. A device the operator turned off is never
  subscribed again without a tap.
- **Settings, Notifications.** This device's switch, asking the browser's permission from the tap,
  with a recent sign-in, and its state ("On", "Off", "Stopped" with why, "Blocked by the browser").
  The device list, each with its label, when it was turned on and when it last received a send, and
  Remove. For which views notify, it points to Settings' Saved views.
- **Settings, Saved views.** Each row, beside Rename and Remove, gains a Notify switch, off with its
  reason for a view with a refused filter on. Remove's question there, and the question of Replace
  with this list in the thread list's Saved views sheet, say when the change ends the view's
  notifying.

### Agents

The usage skill tells agents that an ask's impact and priority may notify the operator's devices, so
they set them honestly. No route, tool or answer changes, and the agent API version stays (E1).

## Data model additions

| Where                        | Holds                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| `saved_views.notifies`       | whether the view notifies, off by default; on for the starting view       |
| `push_subscriptions` (new)   | endpoint (unique), keys, passkey (cascade), session hash, label, made and |
|                              | last-accepted times                                                       |
| `thread_marks.notified_seq`  | the message that last notified, cleared by the operator's read or archive |
| `instance.vapid_private_key` | made at serve start when absent                                           |

One migration adds them and the starting view, with its frozen hash, and rolls back as a whole like
the others.

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
  can neither subscribe, turn a view's notifying on or off, nor read which views notify. One holding
  `saved-views:write` can replace or remove a view that notifies, which changes what notifies (E2),
  and that scope's description says so.
- **The service worker** takes no URL from a payload and has no fetch handler.
- **Review checklist:** a new check for push: outbound limits, padding, no per-thread value in
  clear, nothing from a payload used as a URL, and notifications never keyed on message content.

## Testing

- **Crypto:** the RFC 8291 worked example, byte for byte; the VAPID token verified with `jose`
  against the public key, with its `aud`, `exp` and `sub`.
- **Matching:** a notifying view keeps its own thread and not a sibling in the same session, for an
  ask filter and a name filter; the starting view; a view naming a removed session and a removed
  group; a view's order and grouping changing no match; a view with unread or including archived
  threads on matching.
- **Rules:** turning on a view with each refused filter on refused, naming it; turning off a view
  that does not notify answering as done; an API key holding `saved-views:write` replacing a
  notifying view's list with one that has one on ending its notifying, and with one that has none
  keeping it; removing the view ending it; a rename and a tag rename keeping it; a view listed
  through the operator API carrying no `notifies`; the starting view numbered past a name taken in
  another case, added beside a view of the same filters, and skipped at 200 views.
- **Volume:** an agent's message notifies once; another before the operator reads does not; after a
  read or archive, the next one does, including after marking unread again; the operator's own
  writes never notify; no device on, no mark.
- **Sender:** against a local test push service through the sender's transport seam: padding to one
  size, headers, no redirect followed, retries on 5xx, 429, and timeouts, the mark cleared when
  every send failed, 404 and 410 removing the subscription, and a slow service not holding up the
  write. A retry sends nothing after its device is removed or re-keyed during the wait, or after the
  thread is read and a newer message notifies during it. The host and endpoint rule is tested apart,
  as a pure function.
- **Subscriptions:** refused endpoints; a recent sign-in needed to register and to remove another
  device; sign-out, passkey removal by either path and Remove from the list; expiry leaving them; a
  second sign-in moving one; a refresh of an endpoint the server does not store stopping the device.
- **Browser (Chromium, Playwright):** headless Chromium has no push service and Playwright cannot
  click a system notification, so these run against a stubbed `pushManager` and by delivering `push`
  and `notificationclick` events to the worker directly: the device switch's states, the device
  list, the Notify switch in Settings' Saved views with a refused filter's reason, the questions of
  Replace and Remove for a view that notifies, and a click opening the right thread, in a web UI
  window and never in the API's documentation page. The manifest's install check runs through
  Chromium's own installability report where the headless shell offers it.
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
   testing guide, and the development contract's optional integrations. That collateral includes
   what `saved-views:write` grants: the scope's description in `packages/api/src/scopes.ts` (and so
   `docs/api/openapi.json`), the API key form, the operator guide's and `docs/architecture.md`'s
   scope tables and the sentence under `docs/architecture.md`'s that one operation reaches across
   resources, `SECURITY.md`'s API keys, whose "and nothing more" no longer holds, review check A18's
   crossing sentence and its look-for of a write across resources beyond the tag rename's, the new
   ADR's amendment of ADR 0006's one crossing, `docs/web-ui.md`'s Saved views and Settings, and the
   live testing guide's saved views operations. It builds on saved views (agention#184), and the two
   ship in the same release (ruling 10).

## Settled with the operator

The operator accepted the FRD's five choices and the Web Push library as recommended (FRD rulings 1
to 6), and a rule as a saved view that notifies, shipping in one release with saved views (rulings 9
and 10). Each other answer to the first six would have changed this design only locally:

- **A starting view of "any open ask", or none:** the migration's insert.
- **A reminder:** a periodic job and a reminded mark, which could also notify when an answer-by
  passes; it would need its own line in the new ADR, since ADR 0001 rules out server action on
  deadlines.
- **Quiet hours:** a time zone setting, a held mark per thread and a job at the window's end.
- **A preview option:** a setting behind a recent sign-in, and the latest agent message's first
  line, cut to a byte budget so the payload stays within the smallest push service's limit.
- **Ending with the sign-in:** the subscription's session column becomes a foreign key with cascade.
- **The `web-push` package:** it replaces our encryption and token code, and the server pads the
  payload before handing it over and sends the request itself.
