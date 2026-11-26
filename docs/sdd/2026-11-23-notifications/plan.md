# Notifications: Plan

<!-- cspell:ignore VAPID webmanifest -->

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md)
- The operator accepted the FRD on 2026-11-25, its open choices as recommended. Building starts once
  the operator accepts the requirements revised so a rule can follow a saved view, recorded as an
  FRD ruling (FRD ruling 7; the last two items under Design).

## Design

- [x] Requirements drafted and reviewed (project review and complexity pass), revised for both.
- [x] Prior-art research, graded.
- [x] HLA drafted.
- [x] HLA and plan reviewed (project review and complexity pass), findings disposed (agention#96).
- [x] `push-lld.md` (agention#96): the payload and its padded size, the token cache, the retry
      schedule, the check's statement and its transaction, the route shapes and their errors, and
      how the worker opens a thread in an open window.
- [x] The operator accepts the FRD; rulings recorded verbatim in it, and the HLA and plan updated
      for any choice answered otherwise (agention#96).
- [x] On acceptance, the development contract names this effort as active alongside pull request and
      branch links (agention#96).
- [ ] Requirements revised so a rule can follow a saved view (FRD ruling 7): R1, R3, E2, the
      out-of-scope line saying only filters define a rule, and Why this exists, with the FRD's open
      question on the operator API answered. Done when the operator accepts the revised
      requirements, recorded as a ruling in the FRD.
- [ ] The HLA, `push-lld.md`, and PR 2's steps updated to the accepted revision.

## PR 1: installable web UI

- [ ] Web app manifest (name, icons in the sizes Android and desktop install need,
      `display: standalone`, start URL and scope `/`), served with the right content type.
- [ ] Content security policy adds `manifest-src 'self'` and states `worker-src 'self'`; the policy
      test updated.
- [ ] If Chromium's install check needs a service worker, this PR folds into PR 2 instead.
- [ ] Operator guide: adding Agention to a phone's home screen and to a desktop.
- [ ] Architecture document: the manifest and the content security policy's additions.

**Done when:** Chromium's installability check passes in the browser tests; the operator adds
Agention to their Android phone's home screen and it opens standalone; gates and CI pass.

## PR 2: notifications

Server:

- [ ] Rule filters schema in `packages/api`, derived from the list's filters, refusing `search`,
      `unread`, `overdue` and `agent_read` (exported for the thread list) and dropping
      `include_archived`; at least one filter; strict on read; at most 20 rules.
- [ ] Migration: `notification_rules` with the starting rule, `push_subscriptions` (at most 10),
      `thread_marks.notified_seq`, and the instance's VAPID key column; its frozen hash.
- [ ] The VAPID key made at serve start when absent, never logged; the public key derived.
- [ ] Web Push: the VAPID token with `jose`, cached per push service origin; `aes128gcm` with
      fixed-size padding on `node:crypto`; the RFC 8291 worked example passes byte for byte.
- [ ] Endpoint rule (pure function: https, port 443, no user information, known host at a dot
      boundary) and the sender, with its transport seam, no redirect, a timeout, `TTL`, `Urgency`,
      three tries at 10 and 45 seconds, the mark cleared when every send failed or the server stops
      mid-send, and 404 and 410 removing the subscription.
- [ ] Each try rechecks that its subscription's endpoint and keys and the thread's mark are as the
      check left them, and is cancelled otherwise. Tests: the row removed, and the row re-keyed by a
      Refresh, during a retry's wait, each sending no retry; the thread read, a newer message
      notified, then the older message's retry sending nothing.
- [ ] The check in the post-commit blocks of thread start and append, for agent writers only: no
      device, no mark; the list's statement scoped to the thread; errors logged, never failing the
      write. Tests: own thread not a sibling, an ask filter and a name filter, removed names.
- [ ] Reading or archiving through the notified message clears the mark.
- [ ] Subscription lifecycle: on with a recent sign-in; refresh of a stored endpoint only; off for
      this device, and removing another with a recent sign-in; sign-out; passkey removal by either
      path; a second sign-in moving it; expiry leaving it.
- [ ] Web routes for the key, the devices and the rules, with CSRF; none in the operator API.

Web UI:

- [ ] Service worker `push` and `notificationclick`, the route built from identifiers; a click goes
      only to a window on a route of the UI, else opens one, with `matchRoute` and `threadHref`
      moved to a module the worker bundles.
- [ ] Settings, Notifications: this device's switch and state, the device list with Remove, and the
      rules.
- [ ] Thread list: **Notify me** in the bar, off with its reason for a filter rules cannot take.
- [ ] Device intent kept in the browser; refresh on start and after sign-in only while it is set; a
      subscription the server does not know, or none, stops the device ("Stopped" in Settings,
      intent cleared); On unsubscribes first under a changed public key; Off and sign-out clear it
      and unsubscribe.
- [ ] Browser tests against a stubbed `pushManager`, with `push` and `notificationclick` delivered
      to the worker, including a click with the API's documentation page focused beside a web UI
      window, with only that page open, and with only the sign-in page open.

Collateral:

- [ ] New ADR: Web Push to the operator; ADR 0001's "No push" line marked superseded for the
      operator.
- [ ] SECURITY.md: what reaches push services and devices, outbound limits, keys and backups.
- [ ] Operator guide: turning notifications on per device, rules, what a notification shows, the
      phone's Do Not Disturb, and the known push services.
- [ ] Usage skill: asks' impact and priority may notify the operator's devices.
- [ ] Architecture document; the review checklist's push check, its A4 change (turning a device on
      and removing another device need a recent sign-in) and its A6 amendment (notifications inform
      the operator and never act on an agent's work); and the development contract's optional
      integrations.
- [ ] Live testing guide: how the operator checks delivery on a device.

**Done when:** the FRD's definition of done holds: the operator receives a blocking ask on their
Android phone, installed and with its screen off for a while, and opens the thread from it, and the
same on Windows in Edge and Chrome; Apple browsers are stated as untested; gates and CI pass, and
the effort ships in a release.

## Closeout

- [ ] Permanent docs carry everything the codebase relies on; nothing points into this directory.
- [ ] `locked.md` records what shipped.
