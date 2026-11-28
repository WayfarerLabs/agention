# Notifications: Plan

<!-- cspell:ignore VAPID webmanifest -->

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md)
- The operator accepted the FRD on 2026-11-25, its open choices as recommended, and on 2026-11-27 a
  rule as a saved view that notifies, with saved views and notifications shipping in one release
  (FRD rulings 9 and 10). PR 1 went ahead of that revision (FRD ruling 8). PR 2 builds on saved
  views (agention#184).

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
- [x] Requirements revised so a rule can follow a saved view (FRD ruling 7): R1, R3, E2, the
      out-of-scope line saying only filters define a rule, and Why this exists, with the FRD's open
      question on the operator API answered. Done when the operator accepts the revised
      requirements, recorded as a ruling in the FRD. Drafted as the FRD's proposed revision, whose
      text then takes the place of the current text (FRD ruling 9; agention#188).
- [x] The HLA, `push-lld.md`, and PR 2's steps reworked to the accepted revision: a rule as a
      `notifies` flag on a saved view, with no bound of its own; the starting view, numbered with
      `name COLLATE NOCASE NOT IN (...)` and skipped at 200 views, with a test that a name taken in
      another case is numbered; matching from a view's filters; the refused-filter predicate, with a
      replace that turns one on ending the view's notifying; a Notify switch on each row of
      Settings' Saved views, with Settings' Notifications pointing there; Replace's and Remove's
      questions saying when notifying ends; the routes turning a view's notifying on and off; and
      the `saved-views:write` collateral the HLA lists, A18's second crossing among it
      (agention#188).
- [x] Saved views (agention#184) merged to `main`, with no release cut before PR 2 merges (FRD
      ruling 10; agention#184).
- [x] Release order of saved views and notifications settled by the operator and recorded as an FRD
      ruling: one release (FRD ruling 10; agention#188).

## PR 1: installable web UI

- [x] Web app manifest (name, icons in the sizes Android and desktop install need,
      `display: standalone`, start URL and scope `/`), served with the right content type
      (agention#193).
- [x] Content security policy adds `manifest-src 'self'` and states `worker-src 'self'`; the policy
      test updated (agention#193).
- [x] If Chromium's install check needs a service worker, this PR folds into PR 2 instead. It does
      not: Chrome installs from its menu without one, since 108 on Android and 112 on desktops
      (`docs/architecture.md` "The web UI's files"; agention#193).
- [x] Operator guide: adding Agention to a phone's home screen and to a desktop (agention#193).
- [x] Architecture document: the manifest and the content security policy's additions
      (agention#193).

**Done when:** the browser tests show Chromium parses the manifest with the server's name,
standalone display, the root as id, start URL, and scope, and 192 and 512 icons for any use that
decode at their declared sizes (the headless shell's installability report answers no errors even
for a page with no manifest, so it cannot stand as the check); the operator adds Agention to their
Android phone's home screen and it opens standalone; gates and CI pass.

## PR 2: notifications

Builds on saved views (agention#184) and ships in the same release (FRD ruling 10), so no key issued
with `saved-views:write` gains what notifies: saved views merged first, on 2026-11-27, so no release
is cut until this PR merges.

Server:

- [x] The refused filters in `packages/api` (`refusedFiltersOn` and the `NotifyRefusedFilter` type
      exported: `search` and `agent_read` set, `overdue` true), shared by the server and the web UI;
      their test (agention#201).
- [x] Migration, appended after saved views': `saved_views.notifies`, off by default; the starting
      view, Blocking asks, notifying, numbered with `name COLLATE NOCASE NOT IN (...)` and skipped
      at 200 views, its list written out as `threadsView` parses it; `push_subscriptions` (at most
      10); `thread_marks.notified_seq`; the instance's VAPID key column; its frozen hash. Tests: the
      starting view reading back through `readView`, a name taken in another case numbered, and 200
      views getting none (agention#201).
- [x] Rules: On refusing a view with a refused filter on, naming it; Off, idempotent;
      `replaceSavedView` turning `notifies` off in its update when the new list has a refused filter
      on, and `removeSavedView` ending it with the row, each one's comment saying so; `readView`
      exported; no saved views read selecting `notifies`. Tests: Replace ending notifying through an
      API key holding `saved-views:write`; a rename and a tag rename keeping it; a view listed
      through the operator API carrying no `notifies` (agention#201).
- [x] The VAPID key made at serve start when absent, never logged; the public key derived
      (agention#201).
- [x] Web Push: the VAPID token with `jose`, cached per push service origin; `aes128gcm` with
      fixed-size padding on `node:crypto`; the RFC 8291 worked example passes byte for byte
      (agention#201).
- [x] Endpoint rule (pure function: https, port 443, no user information, known host at a dot
      boundary) and the sender, with its transport seam, no redirect, a timeout, `TTL`, `Urgency`,
      three tries at 10 and 45 seconds, the mark cleared when every send failed or the server stops
      mid-send, and 404 and 410 removing the subscription (agention#201).
- [x] Each try rechecks that its subscription's id and keys and the thread's mark are as the check
      left them, and is cancelled otherwise. Tests: the row removed, and the row re-keyed by a
      Refresh, during a retry's wait, each sending no retry; the thread read, a newer message
      notified, then the older message's retry sending nothing (agention#201).
- [x] The check in the post-commit blocks of thread start and append, for agent writers only: no
      device, no mark; the list's statement scoped to the thread, from each notifying view, skipping
      one with a refused filter on; errors logged, never failing the write. Tests: own thread not a
      sibling, an ask filter and a name filter, removed names, a view's order and grouping changing
      no match (agention#201).
- [x] Reading or archiving through the notified message clears the mark (agention#201).
- [x] Subscription lifecycle: on with a recent sign-in; refresh of a stored endpoint only; off for
      this device, and removing another with a recent sign-in; sign-out; passkey removal by either
      path; a second sign-in moving it; expiry leaving it (agention#201).
- [x] Web routes for the key, the devices, and a saved view's notifying (`/notifications/views`),
      with CSRF; none in the operator API (agention#201).

Web UI:

- [x] Service worker `push` and `notificationclick`, the route built from identifiers; a click goes
      only to a window on a route of the UI, else opens one, with `matchRoute` and `threadHref`
      moved to a module the worker bundles (agention#201).
- [x] Settings, Notifications: this device's switch and state, the device list with Remove, and a
      link to Saved views for which views notify (agention#201).
- [x] Settings' Saved views: a Notify switch on each row, off with its reason for a view with a
      refused filter on; Remove's question, and that of Replace with this list in the thread list's
      Saved views sheet, saying when the change ends a view's notifying (agention#201).
- [x] Device intent kept in the browser; refresh on start and after sign-in only while it is set; a
      subscription the server does not know, or none, stops the device ("Stopped" in Settings,
      intent cleared); On unsubscribes first under a changed public key; Off and sign-out clear it
      and unsubscribe (agention#201).
- [x] Browser tests against a stubbed `pushManager`, with `push` and `notificationclick` delivered
      to the worker, including a click with the API's documentation page focused beside a web UI
      window, with only that page open, and with only the sign-in page open; the Notify switch and
      Replace's and Remove's questions for a view that notifies (agention#201).

Collateral:

- [x] New ADR: Web Push to the operator; ADR 0001's "No push" line marked superseded for the
      operator; ADR 0007's "One crossing is intended" amended with the second crossing; and one line
      that "never changes what an existing scope grants" (review check A18, `SECURITY.md`) holds
      because saved views and notifications ship in one release (FRD ruling 10; agention#201).
- [x] SECURITY.md: what reaches push services and devices, outbound limits, keys, and backups; and
      in API keys, that `saved-views:write` also changes what notifies, its "and nothing more"
      dropped (agention#201).
- [x] What `saved-views:write` grants, saying it also changes what notifies: the scope's description
      in `packages/api/src/scopes.ts`, with `docs/api/openapi.json` regenerated; the API key form;
      the scope tables of the operator guide and `docs/architecture.md`; and the sentence under the
      latter's table that one operation reaches across resources (agention#201).
- [x] `docs/web-ui.md`: Saved views gains the Notify switch, and Remove's and Replace's questions
      saying when notifying ends (it says Remove leaves every list as it was); Settings names where
      notifying is set (agention#201).
- [x] Operator guide: turning notifications on per device, which saved views notify and the Notify
      switch, what a notification shows, the phone's Do Not Disturb, and the known push services
      (agention#201).
- [x] Usage skill: asks' impact and priority may notify the operator's devices (agention#201).
- [x] Architecture document; the review checklist's push check, its A4 change (turning a device on
      and removing another device need a recent sign-in), its A6 amendment (notifications inform the
      operator and never act on an agent's work), and A18's second intended crossing (replacing or
      removing a view that notifies, under `saved-views:write`) in its crossing sentence and its
      look-for; A19's obligation that a migration rewriting stored views turns `notifies` off for a
      view its rewrite gives a refused filter; and the development contract's optional integrations
      (agention#201).
- [x] Live testing guide: how the operator checks delivery on a device, and among the saved views
      operations, a key's Replace with search on ending a view's notifying (agention#201).
- [x] The operator's device acceptance: a blocking ask received and its thread opened on Android,
      Chrome on Windows turned on and its test push accepted, and Edge on the operator's Windows
      machine named as a Windows-side gap, recorded as ruling 13 (agention#201).

**Done when:** the FRD's definition of done holds: the operator receives a blocking ask on their
Android phone, installed and with its screen off for a while, and opens the thread from it, and the
same on Windows in Edge and Chrome; Apple browsers are stated as untested; gates and CI pass, and
the effort ships in the same release as saved views.

## Closeout

- [ ] Permanent docs carry everything the codebase relies on; nothing points into this directory.
- [ ] `locked.md` records what shipped.
