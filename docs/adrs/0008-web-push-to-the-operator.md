# 8. Web Push to the operator, when a saved view notifies

<!-- cspell:ignore VAPID aes128gcm -->

Date: 2026-11-27

## Status

Accepted. Supersedes "No push" in "Not doing" of [ADR 0001](0001-agention-v1-architecture.md) for
the operator: the server may notify the operator's devices through Web Push to the web UI, and only
that way. Reaching an agent only when it checks stays. Amends "One crossing is intended" in
[ADR 0007](0007-saved-views.md) with a second crossing: replacing or removing a view that notifies,
under `saved-views:write`, changes what notifies.

## Context

Agents ask the operator for answers, decisions, and approvals, and their work waits on some of them.
The operator learned of an ask only by looking, so away from the desk, above all on a phone with
Agention closed, an agent blocked on them stayed blocked until they happened to look. The operator
asked to be told when something needs them, and only then, with what counts as "needs me" theirs to
say. Saved views ([ADR 0007](0007-saved-views.md)) already hold the lists the operator keeps.

Browsers deliver Web Push from their own push service, to a page's service worker, with no account
on any provider: Chrome and Edge on Android and desktops, and Apple's browsers for a web app added
to the Home Screen. A push message is encrypted from the server to the device (RFC 8291), and the
server identifies itself to the push service with a signed token (RFC 8292, VAPID).

## Decision

- **A rule is a saved view that notifies.** A view carries a `notifies` flag and nothing else, so a
  rule follows its view: a rename keeps it, a replaced list is what the next check matches, and
  removing the view ends it. A view notifies by its filters alone, matched by the thread list's own
  statement scoped to one thread, so a rule never means what its view would not show; its order and
  grouping play no part. Agention adds one starting view that notifies, Blocking asks, once.
- **Filters that cannot notify.** Search, overdue, and the agent's reading cannot be on in a view
  that notifies: a notification never acts on what messages say, and the others change with time
  alone. Turning notifying on refuses such a view, and replacing a notifying view's list with one
  that has one on ends its notifying in the same update, so no notifying view has one on.
- **Only an agent's message notifies**, checked right after its write commits, and a thread notifies
  once until the operator reads or archives it. Nothing runs on a timer, so ADR 0001's "No server
  action on deadlines" holds.
- **Notifications inform the operator and never act on an agent's work.** That is how a rule may key
  on open asks, a derived signal, without breaking the rule that derived signals never trigger
  actions.
- **Web Push on `jose` and `node:crypto`, with no new dependency.** `jose`, already bundled, signs
  the token, and a few dozen lines of our own do the `aes128gcm` encryption, checked against RFC
  8291's worked example and decrypted in the tests by an independent implementation, a development
  dependency only.
- **Nothing readable reaches a push service**: every payload is padded to one size, no `Topic`
  header is sent, and the token's subject is the project's URL, naming neither the operator nor the
  server's host. A notification shows the thread's title and why it needs the operator, never a
  message's text.
- **The server sends only to the known push services**, by host name, over HTTPS on port 443, with
  no redirect followed, checked when a device registers and again before each send.
- **Per device, opted in, managed only from the web UI.** A device turns notifications on with a
  recent sign-in there; its subscription belongs to the passkey that signed it in and ends when that
  passkey is removed, when the device turns them off or signs out, or when the operator removes it
  from the list, not when its sign-in expires. No API key can subscribe, turn a view's notifying on
  or off, or read which views notify.
- **A second crossing under `saved-views:write`.** Replacing or removing a view that notifies
  through the operator API changes or ends its notifying, a write across resources beside the tag
  rename's. It does not break "an existing scope never changes what it grants" (review check A18,
  `SECURITY.md`): saved views and notifications ship in one release, so no key issued with that
  scope gains it after it was issued.
- **A failed send is retried briefly, then lets the thread notify again.** There is no durable
  queue.
- **The service worker is push-only**: it shows a push and opens its thread, with no fetch handler
  and no cache, and builds the thread's route from its identifiers, never from a URL in a payload.

## Alternatives considered

- **Rules of their own**, a filter set beside the saved views: two lists in step, where the operator
  keeps one.
- **The `web-push` package**: 13 more packages in the bundle, among them a proxy agent, under
  MPL-2.0 notice obligations, for what a few dozen lines and `jose` do.
- **Email, chat, or SMS**: each needs an account with a provider, which Web Push does not.
- **Quiet hours, reminders, or a preview of the message**: quiet hours need a time zone, a held
  queue and a release job, and the phone's Do Not Disturb covers nights; a reminder is server action
  on a deadline; a preview puts message text on a lock screen.
- **Apple's declarative Web Push**: the operator has no Apple device to test it on.
- **Ending a device's notifications with its sign-in**: a phone left alone for a week would stop
  notifying, which is when it matters most.

## Consequences

- Agention reaches the operator outside its web UI for the first time: the push services see that a
  server sends to a device, when, and a ciphertext of fixed size, and the device's lock screen shows
  a thread's title and why.
- The server makes outbound requests on an agent's write, to the push services alone. A send never
  holds up the write, and a crash mid-send leaves that thread silent until the operator reads it.
- The push key and the subscriptions are secrets in the database, carried by backups, so a restore
  keeps every device's notifications working.
- `saved-views:write` changes what notifies, which its description, the API key form, and the
  operator guide say.
- A migration that rewrites stored views also turns notifying off for a view its rewrite gives a
  refused filter, which review check A19 says.
- A new browser's push service needs its host added to the list the server sends to.
