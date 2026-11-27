<!-- cspell:ignore aesgcm autopush Beverloo dedup deprioritized ECDH HKDF pushforge pushsubscriptionchange upserts vapidkeys webcrypto webpush -->

# Notifications research: Web Push, platforms, volume control, rules as saved searches

Prior-art research for the Agention notifications design. Researched 2026-11-23.

**Grading key** (used inline as (A), (B), (C), and in the sources table):

- **A**: official spec, vendor documentation, vendor source code, or registry data.
- **B**: vendor-run engineering blog or announcement, browser intent threads, reputable tech press.
- **C**: forum, Q&A, mailing-list remark, third-party blog or tutorial.

Source numbers like (S12) refer to the sources table at the end.

## Executive summary

- **Web Push works with no third-party account.** With VAPID, Chrome needs no Firebase project or
  sender ID (S20), and Apple needs no Apple Developer Program membership (S9, S10). Mozilla autopush
  needs no registration either (S12). A self-hosted Node server can push to Android Chrome, desktop
  Chrome and Edge, Firefox, and iOS 16.4+ Home Screen apps using only a VAPID key pair it generates
  itself.
- **Every push must show a notification.** Chrome and Edge reject subscriptions without
  `userVisibleOnly: true` (S5, S14, S28). If no notification is shown, Edge shows a generic one
  (S14) and Safari revokes the permission (S9). FCM demotes high-priority messages that produce no
  notification (S17). So pushes cannot silently retract or clear notifications on other devices, and
  cannot be used for background sync.
- **Payloads are small.** Push services must accept 4096-byte bodies (S1). The maximum plaintext in
  a single aes128gcm record is 3993 bytes (S2). Mozilla documents 2744 bytes through its FCM bridge
  (S12). A thread id and title fit easily. `web-push` does not pad, so the payload length leaks the
  title length unless Agention pads the plaintext itself (S31).
- **Subscriptions die quietly.** The reliable signal is a 404 or 410 on send: delete the
  subscription on either (S6, S9, S13). `pushsubscriptionchange` cannot be relied on. Chrome fires
  it only when permission is re-granted, with null subscriptions (S24, S28); iOS does not fire it at
  all (S28). The design needs client-side reconciliation: on every app open, call
  `getSubscription()` and sync it with the server.
- **On Android, install the PWA.** Chrome's October 2025 auto-revocation of notification permission
  exempts installed web apps (S16). WebAPK notifications are attributed to the app (S26). From
  Chrome 155 on Android (announced July 2026), the permission prompt is non-blocking and can time
  out with `'default'` (S25).
- **iOS is not designed out if Agention:**
  - asks for permission only from a tap inside an installed Home Screen web app (S9, S10);
  - always shows a notification for every push (S9);
  - does not depend on `tag`, `renotify`, `actions` or `requireInteraction`, none of which Safari
    supports (S28).

  Declarative Web Push (iOS 18.4+) is a forward-compatible payload shape worth adopting (S11, S8).

- **Urgency and Doze.** RFC 8030 defines `Urgency` (very-low to high) (S1). FCM says high-priority
  messages can wake a device in Doze (S17, S18). No official document says how Chrome maps web push
  `Urgency` onto FCM priority (open question). Apple says to use `high` to "attempt to deliver the
  notification immediately" (S9).
- **Library choice.** `web-push` 4.0.0 (2026-11-06, ESM, MPL-2.0, four runtime dependencies, about
  14M weekly downloads) is mature and eligible under the 7-day hold-back. It has npm registry
  signatures but no provenance attestation (S30, S31). Zero-dependency WebCrypto alternatives exist
  with SLSA provenance: `@pushforge/builder` and `@block65/webcrypto-web-push` (S30). A hand-rolled
  implementation on `node:crypto` is feasible (all primitives exist (S32)), and RFC 8291 includes a
  worked example to test against (S2).
- **Volume control.** For "a thread entering a filter's set notifies once", the closest prior art is
  the Prometheus/Alertmanager state model (S33, S34) and PagerDuty's `dedup_key` (S37):
  - a firing state keyed by (rule, thread), so membership is the state, not each event;
  - hysteresis through `for` and `keep_firing_for`;
  - `group_wait` and `group_interval` to batch bursts;
  - `repeat_interval` and escalation for re-notify;
  - mute time intervals for quiet hours.

  On the device, `tag` = thread id collapses repeats (Chromium only). `Topic` = an opaque hash
  collapses undelivered messages at the push service (S1).

- **Gmail, Slack and Jira rules are not "enters the set".** Gmail filters and Slack keywords fire
  per incoming message (S41, S39). Jira filter subscriptions are scheduled snapshots, and Atlassian
  accepts duplicates to avoid misses (S43). GitHub custom filters are inbox views only (S45). Only
  alerting systems define membership transitions. They re-notify on re-entry after resolution (S34,
  S37). A "once until read" policy needs Agention's own state.
- **Security:**
  - The push service sees timing, size, endpoint linkage, and the unencrypted `TTL`, `Urgency` and
    `Topic` headers, but not the payload (S2, S1, S8).
  - Validate notification click targets as same-origin mapped routes (S47, S48).
  - Validate client-supplied endpoints against SSRF (S49).
  - Rotating the VAPID key forces every device to resubscribe (S3).
  - On Android, Chrome already redacts web notification content on a locked screen when the user's
    setting hides sensitive content (S27).

## Q1. Web Push today (2026)

### 1.1 Protocol stack

#### RFC 8030, generic event delivery (S1) (A)

- **TTL** is mandatory; a push service returns 400 without it. The service may shorten it and
  reports the TTL it used in the response. With `TTL: 0`, the message is delivered only if the UA is
  reachable at that moment. Receipts cannot be relied on for zero-TTL messages (section 5.2).
- **Urgency** takes very-low, low, normal (the default) or high. The RFC's example conditions run
  from very-low ("on power and Wi-Fi") to high ("low battery", for example "incoming calls or
  time-sensitive alerts"). A UA may tell its push service the lowest urgency it accepts. Urgency is
  not forwarded to the UA (section 5.3).
- **Topic**: a newer message with the same topic replaces an _undelivered_ one for that
  subscription. A topic is at most 32 filename-safe base64 characters. Topic is "neither encrypted
  nor authenticated" and is not forwarded to the UA (section 5.4).
- **Status codes**: 201 means accepted, not delivered. 404 means an expired subscription (section
  7.3). 413 may be returned only for bodies over 4096 bytes (section 7.2). 429 means rate limited,
  ideally with `Retry-After`. In the RFC, 410 is a receipt failure (sections 6.2 and 6.3), but push
  services use 410 for gone subscriptions in practice (see 1.4).

#### RFC 8291, message encryption (S2) (A)

- Key agreement is ECDH on P-256. The UA holds one key pair per subscription (`p256dh`) and a
  16-byte `auth` secret. The server generates a fresh key pair per message.
- Keys are derived with HKDF-SHA-256. The content coding is aes128gcm (RFC 8188).
- Each message is exactly one record. The header is 86 octets, so the maximum plaintext is 4096 -
  86 - 1 - 16 = **3993 octets**.
- Padding is "the only mechanism" to hide length. The push service can see timing, length, which
  server talks to which UA, and all HTTP headers (section 7).

#### RFC 8292, VAPID (S3) (A)

- **JWT**: signed ES256 with `aud` set to the push service origin and `exp` at most 24 hours out.
  `sub` should be a `mailto:` or `https:` contact.
- **Header**: `Authorization: vapid t=<jwt>, k=<public key>`.
- **Restricted subscriptions**: a subscription created with `applicationServerKey` is bound to that
  key. Push services may answer 401 or 403 on a mismatch.
- **Key rotation**: "the application server MUST create a new subscription restricted to the new
  key" (section 4.2).
- **Security considerations**: `sub` is unverified, and token reuse is encouraged so push services
  can cache validation (section 5).

#### Push API (W3C editor's draft) (S8) (A)

- Subscriptions are bound to a service worker registration and are deactivated when it is
  unregistered.
- When permission is revoked, the UA "MUST deactivate the affected subscriptions" and "MAY" fire
  `pushsubscriptionchange`.
- The spec warns there is "no guarantee that a push message was sent by an application server" of
  the same origin.
- The spec now includes **declarative push messages**: JSON
  `{"web_push": 8030, "notification": {title, navigate, body, tag, renotify, ...}}`. If no
  notification is shown, the UA shows one itself.

_Design implications:_

- Use aes128gcm only. `web-push` defaults to it (S31); aesgcm is legacy.
- Make `Topic` an opaque value such as an HMAC of the thread id. Never put the title or any readable
  id in it, because it travels in clear to the push service.
- Set `TTL` deliberately per rule. An ask with a deadline should carry a TTL no longer than the time
  left until the deadline, so a stale buzz never arrives after the deadline. `web-push` defaults to
  four weeks (S31).
- Set `Urgency: high` for notifications whose whole purpose is to interrupt.

### 1.2 Push services and accounts

| Browser                                                         | Push service and endpoint host                                                                                             | Account needed?                                                                                         | Source               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------- |
| Chrome (desktop and Android)                                    | FCM, `fcm.googleapis.com`                                                                                                  | No: "With VAPID you no longer need a Firebase project, a `gcm_sender_id`, or an `Authorization` header" | (S20) (B)            |
| Edge (Windows)                                                  | WNS, via the Windows OS client by default; policy `ForceBuiltInPushMessagingClient` switches to Edge's built-in WNS client | Not documented; Microsoft's PWA guide just says to use VAPID and `web-push`                             | (S15) (A), (S14) (A) |
| Edge (endpoint hosts)                                           | Reported as `*.notify.windows.com`; one user saw an FCM endpoint in Edge                                                   | Unknown                                                                                                 | (S22) (C)            |
| Firefox                                                         | Mozilla autopush, `updates.push.services.mozilla.com/wpush/v1/...`                                                         | No; "The VAPID key is optional"                                                                         | (S12) (A)            |
| Safari, iOS and iPadOS 16.4+ Home Screen apps, macOS Safari 16+ | APNs; allow `https://*.push.apple.com`                                                                                     | No: "You don't need to join the Apple Developer Program"                                                | (S9) (A), (S10) (B)  |

The FCM legacy API shutdown in June 2024 did not affect the Web Push endpoints, according to Peter
Beverloo of Google as relayed in a forum thread (S21) (C), secondhand.

_Design implication:_ the no-third-party-account requirement is met by standard Web Push. The
browser vendors' push services are unavoidable intermediaries. They are not accounts, but they do
see metadata (see Q6). Treat the endpoint as an opaque URL. Never branch on the vendor except to
apply an SSRF allowlist.

### 1.3 Payload size limits

- **Spec floor**: services must not return 413 for bodies of 4096 bytes or less (S1). web.dev calls
  4096 "the minimum size payload a push service must support" (S6) (A).
- **Plaintext ceiling** for a single record: 3993 bytes (S2).
- **Apple**: `PayloadTooLarge` means "over the limit of 4 KB" (S9).
- **Mozilla**: 4096 bytes normally, but "data may be limited to only 2744 bytes" through its FCM
  bridge (S12). Its errors page says the maximum is "4028 characters" (S13). _Disagreement:_ the
  Mozilla pages state different numbers. Budget for the smallest.
- **Chrome Android**: truncates notification text fields at 5 KiB
  (`MAX_CHARSEQUENCE_LENGTH = 5 * 1024`) (S27). This is irrelevant at Agention's sizes.

_Design implication:_ a payload of
`{thread id, title (truncated to about 200 chars), rule label, timestamp}`, padded to a fixed bucket
(say 1 KiB), stays far below every limit, including Mozilla's 2744-byte bridge. Padding matters:
`web-push` 4.0.0 calls `http_ece.encrypt` with no `pad` option (S31), so the record length tracks
the title length.

### 1.4 Subscription lifecycle

- **Expiry**: `PushSubscription.expirationTime` exists in Chrome 60+, Firefox 96+ and Safari 16+
  (S28). When it is set, the UA "SHOULD attempt to refresh" the subscription before expiry (S8). In
  practice it is usually null. web.dev says browsers "commonly expire" subscriptions anyway and
  warns against working around that (S5) (A).
- **404 and 410 handling**:
  - web.dev: on 404, delete and wait for the client to resubscribe; on 410, remove (reproducible by
    calling `unsubscribe()`) (S6, S7).
  - Mozilla: 404 (errno 102) means invalid, "should not be used again"; 410 (errno 103, 105 and 106)
    means expired or invalid; 429 means back off and honor `Retry-After` (S13).
  - Apple: 410 means "The device token has expired", 403 means an authentication error, 429 means
    too many requests to one device (S9).
  - FCM: returns 400 `UnauthorizedRegistration` for VAPID key mismatches (S7).
- **`pushsubscriptionchange` support**:
  - **Chrome**: fires only when permission was revoked and then re-granted, with empty
    `oldSubscription` and `newSubscription`. The Intent to Ship said M137 (S24) (B); MDN's compat
    data says Chrome 138 (S28) (A). _Disagreement_ on the milestone; either way it is shipped.
  - **Firefox**: supported since version 44, but without the `oldSubscription` and `newSubscription`
    properties (S28).
  - **Safari**: macOS Safari 16 supports it; **Safari iOS does not** (S28).
  - **Old Edge**: legacy EdgeHTML had it and removed it at 79 (S28).
  - **MDN example**: resubscribing inside the handler with `fetch()` can fail offline (S4) (A).
- **Service worker updates**: a subscription belongs to the _registration_, not the script. It is
  deactivated only when the registration is unregistered or cleared (S8). Updating the worker script
  therefore does not lose the subscription. Changing the worker's scope or unregistering it does. On
  Safari, Intelligent Tracking Prevention can delete service worker registrations for sites not
  visited recently. Declarative Web Push subscriptions survive that deletion (S11) (B).
- **Permission revocation** deactivates subscriptions (S8). Chrome may auto-revoke the permission
  for noisy, low-engagement sites, but not for installed web apps (S16) (B).

_Design implications:_

- The server deletes a subscription on 404 or 410 and logs the reason. It backs off on 429 and 5xx.
- The client reconciles on every app start and service worker activation. It calls
  `getSubscription()`, checks the subscription's `applicationServerKey` against the server's current
  public key, and POSTs the endpoint and keys to the server, which upserts them by endpoint.
- The client watches `navigator.permissions.query({name: 'notifications'})` for `change` events
  (S25) and resubscribes when the state becomes `granted`.
- A `pushsubscriptionchange` handler is an optimization, not the mechanism.
- The UI shows each device's status (last successful send, last error) so a dead subscription is
  visible rather than silent.

### 1.5 `userVisibleOnly` and invisible pushes

- **Chrome and Edge** reject `subscribe()` unless `userVisibleOnly` is true and an
  `applicationServerKey` is given (S4, S28).
- **web.dev**: "You _must_ pass a value of `true`" (S5).
- **Edge**: "doesn't support push messages that aren't displayed... Microsoft Edge displays a
  generic notification" if none is shown (S14) (A).
- **Chrome** shows a default "site has been updated in the background" notification. It applies a
  budget for misses, and Firefox applies a quota and then unsubscribes. These come from mailing
  lists and bug trackers (S23) (C); I found no current official document.
- **Safari**: "doesn't support invisible push notifications... If you don't, Safari revokes the push
  notification permission for your site" (S9) (A).
- **WebKit** says a missed notification "can lead to a revoked subscription" (S11).
- **FCM**: if high-priority "messages don't result in user-facing notifications, your messages may
  be deprioritized to normal priority", judged over 7 days per app instance (S17) (A).

_Design implications:_

- One push equals one visible notification, always. When a thread leaves the set or is answered
  elsewhere, do **not** push a "clear".
- Instead, clear stale notifications locally when the app opens or the thread is read on that device
  (`registration.getNotifications()` then `close()`).
- Accept that other devices keep a stale notification until they are opened. Alternatively, send a
  visible replacement such as "Resolved: `<title>`" with the same `tag`. That works only on
  Chromium, because Safari ignores `tag` (see 4.2), and it still buzzes unless `silent` is set
  (Safari iOS lacks `silent` (S28)).
- If the push handler cannot decrypt the payload or finds it invalid, it must still show a generic
  notification rather than nothing.

## Q2. Platform constraints

### 2.1 Android Chrome

- **Permission prompt (Chrome 155 on Android, announced July 2026)**: Chrome uses a lighter,
  non-blocking prompt. "The notification permission request will time out when the non-blocking
  prompt expires", so code must handle `'default'`. After a first prompt, Site Controls offers a
  subscribe entry point, so the site must watch for permission changes. The blog recommends
  contextual prompting (S25) (B).
- **Older guidance**: never prompt on page load; show a custom pre-prompt explaining value; provide
  in-app settings; a block is hard to undo (S44) (A).
- **Quiet UI and revocation**:
  - Chrome 80 introduced a quieter permission UI. Users are enrolled automatically if they deny
    often or a site has low acceptance (S46) (B).
  - Since October 2025, Chrome on Android and desktop revokes the permission for sites with "very
    low user engagement and a high volume of notifications". It "does not revoke notifications for"
    installed web apps (S16) (B).
- **Installed PWA (WebAPK)**:
  - Chrome hands notifications to the WebAPK, so they appear to come from the app, and permission is
    delegated between the WebAPK and Chrome (Android T+ paths) (S26) (A).
  - _Disagreement:_ a web.dev note says WebAPK apps are not granted notification permission at
    install and must request it at runtime. A web.dev FAQ says permissions "will still be managed
    through Chrome" (both via (S26b) (A)). Both can hold: delegation removes the double prompt, but
    a runtime request is still needed.
- **Notification channels**:
  - Since Android O (2017), Chrome creates a channel per origin instead of one "Sites" channel. The
    Chromium `notification_channels_provider_android` source describes per-origin channels (S29) [A
    source, B press].
  - The channel's importance is user-controlled. Web pages cannot set channel importance or
    lock-screen visibility, because the Notifications API has no such option (S5, S4).
  - Whether a WebAPK gets its own channel set is not documented (open question).
- **Android 13+ (`POST_NOTIFICATIONS`)**: notification permission is a runtime permission of the
  Chrome app itself. If Chrome's app-level notifications are off, no site can notify (S19b) (A).
- **Android 15 notification cooldown**: lowers volume and vibration for repeated notifications from
  the same app "for up to two minutes". Users can turn it off. Calls, alarms and priority
  conversations are exempt (S19c) (A, B). Bursts from Agention would be softened by the OS anyway,
  but should not be relied on.
- **Android 16**: auto-groups an app's notifications that lack a summary (S19c) (A).
- **Lock screen**: when the user hides sensitive content, Chrome supplies a public version
  "displaying just the site origin and badge or generated icon" with hidden-content text
  (`createPublicNotification`) (S27) (A).

### 2.2 iOS and iPadOS 16.4 and later

- **Home Screen only**:
  - The web app needs a manifest with `display: standalone` or `fullscreen` and must be opened from
    the Home Screen (S10) (B).
  - Permission can be requested only "in response to direct user interaction" (S10). Apple: "call
    the push subscription method immediately from the gesture's event handler" (S9) (A).
  - Safari tabs on iOS cannot request push (S10, S28).
- **No Apple Developer Program** is needed. Allow `https://*.push.apple.com`. APNs requires SNI and
  supports HTTP/1.1 and HTTP/2. Do not exceed 100 unacknowledged pipelined requests (S9).
- **Apple limits (S9)**:
  - TTL: stored "for 30 days or fewer", and the number stored while the device is offline is
    limited.
  - JWT: "Don't refresh your JWT more frequently than once per hour".
  - Payload: 4 KB.
  - Errors: `BadJwtToken` covers a `sub` that is not a URL or mailto, a wrong `aud`, and `exp` more
    than a day out. `VapidPkHashMismatch` and `TooManyRequests` are also documented.
  - `web-push` 4.0 warns that a localhost `sub` is rejected by Safari (S31b).
- **Unsupported notification options** on Safari and Safari iOS per MDN compat data (S28) (A):
  `renotify`, `requireInteraction`, `actions`, `badge` and `vibrate`. `silent` is supported in macOS
  Safari 16.6 but not on iOS. `tag` is also listed as unsupported: "The property can be set, but has
  no effect".
- **Focus and badging**: Home Screen app notifications integrate with Focus. The Badging API
  (`setAppBadge`) works during push handling (S10) (B).
- **Declarative Web Push**:
  - Available on iOS and iPadOS 18.4 for Home Screen apps and in macOS Safari 18.5 (S11, S11b) (B).
  - Firefox has parser work landed for version 158 but no confirmed release (S11c) (C).
  - There is no Chrome Intent found (open question).
  - The payload is backward compatible: browsers without support deliver it to the service worker as
    an ordinary push (S11).
- **EU**: Apple reversed its iOS 17.4 plan to drop Home Screen web apps in the EU (S50) (B).

_Design implication:_ iOS works if the subscribe button lives inside the installed web app, every
push shows a notification, and collapse and dedupe happen **server-side**, since device-side `tag`
is a no-op on Safari. Adopting the declarative JSON payload shape now costs little and gains iOS
robustness against ITP.

### 2.3 Desktop Edge and Chrome (Windows)

- **Browser must be running**: pushes arrive only while the browser process is running; a background
  process with no windows counts (S19) (A).
- **Edge uses WNS** through the Windows OS client by default (S15) (A).
- **WNS and TTL**: a 2021 Q&A reports that WNS discarded web pushes to offline Edge devices
  regardless of `TTL` (effectively TTL 0), with no Microsoft resolution (S22) (C). A 2022 Q&A
  reports 406 responses from `*.notify.windows.com` (S22b) (C). Neither is confirmed.
- **Edge generic notification** if none is shown (S14). `openWindow` from a notification may reuse
  an installed standalone app window on Chrome for Windows (S47) (A).

_Design implication:_ desktop is best effort. The phone is the reliable channel. Do not promise
"delivered later" semantics on Edge.

### 2.4 Background and battery: Doze and Urgency

- **Doze** suspends network access and defers jobs, deferring work to maintenance windows that grow
  sparser over time. FCM `RemoteNotification` (formerly high-priority) messages are the sanctioned
  way to wake the device for "time-sensitive, user-visible notifications" (S18) (A).
- **FCM priority**: high priority is delivered "immediately even if the device is in Doze mode".
  Normal priority "may be delayed... until the device exits doze" (S17, S17b) (A).
- **Urgency mapping**: there is **no official statement** on how Chrome maps web push `Urgency` onto
  FCM priority. Field reports:
  - A 2019 Chromium bug reports high-urgency web push not waking dozing devices; its status was not
    visible (S35) (C).
  - A 2026 GitHub issue reports that `Urgency: high` fixed delayed delivery on Android (S36) (C).
- **Apple**: "To attempt to deliver the notification immediately, specify high" (S9) (A).
- **The RFC itself** frames `high` for "time-sensitive alerts" (S1).

_Design implication:_ send `Urgency: high` only for rules the operator marks as interrupting (for
example asks at priority high or above). Send `normal` for informational rules. Because every
Agention push is user-visible, FCM's demotion rule is not triggered. Test on a real Android device
in forced Doze (`adb shell dumpsys deviceidle force-idle` (S18)).

## Q3. Node libraries

Registry data was retrieved 2026-11-23 (S30) (A). The hold-back cutoff is 2026-11-16.

| Package                       | Latest (date)      | Runtime deps                                                                         | Engines    | License | Provenance                          | Weekly downloads |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------ | ---------- | ------- | ----------------------------------- | ---------------- |
| `web-push`                    | 4.0.0 (2026-11-06) | `jws ^4.0.1`, `asn1.js ^5.3.0`, `http_ece 1.2.1` (exact), `https-proxy-agent ^9.1.0` | node >= 16 | MPL-2.0 | registry signatures, no attestation | about 14.2M      |
| `@block65/webcrypto-web-push` | 2.0.0 (2026-09-03) | `uint8array-extras ^1.5.0`                                                           | node >= 22 | MIT     | SLSA v1 attestation                 | about 458k       |
| `@pushforge/builder`          | 2.0.5 (2026-04-23) | none                                                                                 | node >= 20 | MIT     | SLSA v1 attestation                 | about 95k        |
| `webpush-webcrypto`           | 1.0.5 (2025-04-22) | none                                                                                 | n/a        | MIT     | none                                | about 3.5k       |

### `web-push` details

- **Publisher**: published by `marco-c` (a Mozilla address) (S30).
- **4.0.0 changes**: migrates the package to ESM and class syntax, drops `mkdirp`, `del` and
  `minimist`, bumps `jws`, refreshes the lockfile for vulnerable transitive dependencies, enables
  Firefox in CI, and adds a docs warning against localhost VAPID subjects. The changelog marks no
  breaking changes, though ESM is effectively one (S31b) (A).
- **Dates and activity**: npm shows 2026-11-06; the GitHub release page shows "10 Nov", a small
  _disagreement_. The previous release was 3.6.7 on 2024-01-16. The repository has 36 open issues
  and 9 open PRs (S31).
- **Code read in the 4.0.0 tarball** (S31c) (A):
  - default TTL is 2419200 seconds (4 weeks); the default JWT `exp` is 12 hours, capped at 24 hours;
  - a fresh JWT is signed per request, with no caching, which is at odds with Apple's "Don't refresh
    your JWT more frequently than once per hour" (S9) whenever two sends come within an hour;
  - there is no padding option;
  - a legacy GCM API-key code path is still present.
- **Advisories**: the npm bulk advisory endpoint returned none for `web-push` 4.0.0 or 3.6.7,
  `http_ece` 1.2.1, `jws` 4.0.1 or `asn1.js` 5.4.1 (S30).
- **Dependency health**: `asn1.js` 5.4.1 last published in 2020 and pulls `bn.js`, `inherits`,
  `minimalistic-assert` and `safer-buffer`. `http_ece` 1.2.1 has no dependencies.
  `https-proxy-agent` 9.1.0 pulls `debug`, `agent-base` and `proxy-agent-negotiate`.

### Hand-rolling on `node:crypto`

Node 24 was the version checked (S32) (A). All needed primitives exist:

- `crypto.createECDH('prime256v1')` or `crypto.diffieHellman` for ECDH;
- `crypto.hkdfSync('sha256', ...)`;
- `crypto.createCipheriv('aes-128-gcm', ...)`;
- `crypto.sign('sha256', data, {key, dsaEncoding: 'ieee-p1363'})` for an ES256 JWS, since a JWT
  needs raw r||s, not DER;
- JWK import for key storage.

The full sender is roughly 100 to 150 lines: VAPID JWT, aes128gcm with padding, and the HTTP POST.
RFC 8291 Appendix A gives a worked example with intermediate values for a deterministic test (S2).
Against that, `web-push` and the WebCrypto libraries have years of interop exposure across FCM, WNS,
Mozilla and APNs.

_Design implication:_ three viable options, in rising order of ownership:

1. `web-push` 4.0.0, eligible under the hold-back. Mature and Mozilla-maintained, but MPL-2.0
   (file-level copyleft: compatible with use as a dependency, but shipping it in a bundle means
   telling recipients where its source is), four dependencies, no provenance, and no padding, so
   Agention pads the plaintext before calling it.
2. `@pushforge/builder`: zero dependencies, attested, MIT. It is younger, so check its padding and
   headers support before choosing.
3. Own implementation, tested against the RFC 8291 vector plus live sends to each push service.

The choice is a design ruling, not something this research can settle.

## Q4. Notification volume control: prior art

### 4.1 How products avoid bursts

| System                          | Mechanisms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Source                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Prometheus and Alertmanager** | Alerts are _state_: inactive, then pending, then firing. `for` waits before firing; `keep_firing_for` holds firing after the condition clears (hysteresis). Alertmanager `group_by` (one notification per group), `group_wait` 30s default (batch the first burst), `group_interval` 5m (batch later additions), `repeat_interval` 4h (re-notify while still firing), `send_resolved`, inhibition (a source alert mutes targets), `mute_time_intervals` and `active_time_intervals` (quiet hours)                                     | (S33, S34) (A)        |
| **PagerDuty**                   | Separate high- and low-urgency rule sets per user, each rule with a delay in minutes for staged channels. Escalation timeout defaults to 30 min (minimum 1); a policy can repeat up to 9 times. "Once a user acknowledges the incident... PagerDuty stops sending notifications"; an acknowledged incident that re-triggers resumes the policy. Low urgency never escalates. `dedup_key`: triggers with the same key merge into the open alert; after resolve, "any further events with the same `dedup_key` will create a new alert" | (S37, S38, S38b) (A)  |
| **Slack**                       | Mobile push is gated on desktop inactivity: by default one minute after the screen locks or 10 minutes without cursor activity, with an optional extra delay. Notification schedule by days and hours pauses outside it; VIPs bypass a pause. Keywords: case-insensitive exact match, and not in threads you don't follow. Email digests every 15 min or 1 h                                                                                                                                                                          | (S39, S40) (A)        |
| **Linear**                      | Desktop, mobile and Slack notifications in real time. Email digests "send with time delays based on urgency" and "are only sent if you haven't already read the Linear inbox notification". Priority inbox tab (2026-09) filters what needs attention. Inbox capped at 2000. New browser push subscriptions are not supported                                                                                                                                                                                                         | (S42) (A), (S42b) (B) |
| **GitHub**                      | One inbox item per _thread_ (issue, PR, commit) with `reason` (assign, mention, review_requested, ...) and `updated_at` and `unread`; the reason can change on later notifications. Done and Saved states. Mobile push can be customized and scheduled                                                                                                                                                                                                                                                                                | (S45, S45b) (A)       |
| **Gmail (Android)**             | "Notify once" (later "Notify for every message"): checked means notify only for the first message of a thread (2011 description)                                                                                                                                                                                                                                                                                                                                                                                                      | (S41b) (C)            |
| **Android OS**                  | Notification cooldown (Android 15) softens repeats for up to 2 min; per-app channels; Android 16 auto-grouping                                                                                                                                                                                                                                                                                                                                                                                                                        | (S19c) (A)            |
| **iOS**                         | Focus filters apply to web app notifications                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | (S10) (B)             |
| **Notifications API**           | `tag`: a same-tag notification replaces the old one. `renotify: true` (needs `tag`) re-alerts on replacement; otherwise replacement is silent. Support: `renotify` in Chrome 50+ and Edge, not Firefox or Safari; `tag` in Chrome, Edge and Firefox, a no-op in Safari                                                                                                                                                                                                                                                                | (S4b, S28) (A)        |
| **RFC 8030 `Topic`**            | Replaces a not-yet-delivered message with the same topic at the push service. Useful when the phone is offline or dozing and several updates queue up                                                                                                                                                                                                                                                                                                                                                                                 | (S1) (A)              |

### 4.2 Which patterns fit "a thread entering a filter's set notifies once"

- **State, not events.** Agention rules are predicates over thread state ("open ask to me with
  priority >= high"; "blocked on me in group Work"). That is the Prometheus model: evaluate
  membership, notify on the transition into the set. Gmail and Slack fire per new message instead
  (S33).
- **Key the firing state by (rule, thread)**, like an alert fingerprint or PagerDuty `dedup_key`
  (S37). Then collapse across rules **per thread**: if two rules admit the same thread, the operator
  gets one notification. On the device, `tag` = thread id replaces rather than stacks (Chromium;
  Safari needs the server-side collapse anyway). At the push service, `Topic` = HMAC(thread id)
  prevents a backlog for an offline phone (S1).
- **Hysteresis against flapping**: a short `for` (a few seconds) before firing and a
  `keep_firing_for` before considering a thread "left". This absorbs edits that briefly drop and
  restore priority, or a status toggled twice (S33).
- **Batch bursts** like `group_wait` and `group_interval` (S34). If several threads enter within N
  seconds, send one summary ("3 threads need you"). This also avoids Android cooldown muting (S19c).
- **Suppress while present**, like Slack's desktop-inactivity gate (S39). If an Agention UI is
  focused, either skip the push or deliver it only to non-active devices.
- **Re-notify** like PagerDuty escalation or Alertmanager `repeat_interval` (S38, S34). Optional: if
  a high-priority ask stays unread for X, notify once more, with a bounded repeat count.
  Acknowledging (opening or reading) stops it, as PagerDuty's ack does (S38).
- **Quiet hours** like `mute_time_intervals` or Slack schedules (S34, S40). A per-rule bypass for
  the highest priority matches Slack VIPs and PagerDuty high urgency. iOS Focus and Android DND
  already apply at the OS level.

## Q5. Rules as saved searches: how prior art defines "enters the set"

| System                      | Rule model                                                                                                                                 | "Enters the set" semantics                                                                                                                                                                                                  | Re-entry behavior                                                                                           | Source                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------- |
| Gmail filters               | Criteria over **incoming messages**                                                                                                        | Evaluated per message on arrival; "Filters only apply to specific messages and not the entire email thread"; existing mail only by a one-off "Also apply filter to matching conversations" backfill, which does not forward | Every new matching message fires again; label changes do not re-evaluate                                    | (S41) (A), (S41c) (C) |
| Slack keyword notifications | Keywords over new messages                                                                                                                 | Per message event                                                                                                                                                                                                           | Every matching message                                                                                      | (S40) (A)             |
| GitHub notifications        | Subscriptions plus reasons (participating, mention, review_requested, ...) per thread; custom filters (up to 15) are saved inbox **views** | Thread gets activity and you have a reason                                                                                                                                                                                  | New activity updates the same thread item; custom filters drive no push (none documented)                   | (S45, S45b) (A)       |
| Jira filter subscriptions   | Saved JQL filter emailed on a CRON schedule                                                                                                | **Snapshot** of the whole result set at each run; time-window JQL can miss items between runs; Atlassian advises overlapping windows, accepting duplicates                                                                  | Item appears in every run while it matches                                                                  | (S43) (A), (S43b) (C) |
| Linear                      | Issue subscriptions plus notification categories; priority inbox is a filter over notifications                                            | Event per subscribed issue change                                                                                                                                                                                           | Per event; email skipped if already read                                                                    | (S42) (A), (S42b) (B) |
| Prometheus and Alertmanager | Query over state; each result series is an alert                                                                                           | Transition into the result set, after `for`                                                                                                                                                                                 | After resolution, re-entry is a **new** firing and notifies again; while firing, `repeat_interval` re-sends | (S33, S34) (A)        |
| PagerDuty Events v2         | Events with `dedup_key`                                                                                                                    | First trigger opens the alert; later triggers merge while open                                                                                                                                                              | After resolve, the same key creates a **new** alert and notifies                                            | (S37) (A)             |

_Findings:_

- No mainstream consumer product implements "saved search that notifies on entry" with a dedupe
  policy. The state-machine semantics come from alerting systems.
- Alerting systems deliberately **do** re-notify on re-entry after resolution. Agention needs its
  own rule to avoid that. A thread that leaves and re-enters should not buzz again if the operator
  has not looked at it since the last notification.

_Design implications:_

1. Store membership per (rule, thread) with `entered_at` and `notified_at`. Evaluate on thread
   mutation events (event-driven re-evaluation of a state predicate), not on a schedule. The
   schedule approach is Jira's miss-or-duplicate problem (S43).
2. Time-based predicates (for example "deadline within 1 h") also need a timer-driven evaluation,
   because time passing is a state change with no mutation event.
3. The re-entry policy is a design choice with prior art on each side:
   - always notify on re-entry (Alertmanager, PagerDuty);
   - once per (rule, thread) ever;
   - **once until the operator reads the thread** (closest to Gmail's "notify once" and Linear's
     skip-if-read).

   The third fits "needs me" best. Re-arm the (rule, thread) marker when the operator reads the
   thread, or when the thread content materially changes after a read.

4. On rule create or edit, seed existing members as already notified, Gmail-style forward-only, with
   an explicit "notify for current matches" option like Gmail's backfill checkbox (S41c). This
   avoids a burst on save.
5. Collapse per thread across rules (4.2). The notification body names the rule that matched first,
   or the highest-priority one.

## Q6. Security and privacy

- **What the push service sees**:
  - timing, frequency and size (S8, S2);
  - which server talks to which subscription (S2);
  - every HTTP header, including the unencrypted `Topic` (S1), `TTL`, `Urgency`, and the VAPID JWT
    with its `sub` contact (not forwarded to the UA (S3));
  - the sending server's IP address.

  The payload is end-to-end encrypted to the UA's `p256dh` and `auth` (S2). _Implications:_ an
  opaque `Topic` (HMAC); fixed-size padding to hide title length; a `sub` that names an instance URL
  or a role mailbox rather than a personal address. `sub` must not be localhost for Apple (S9,
  S31b).

- **VAPID private key**:
  - Generate it once locally and keep it secret; share only the public key (S5).
  - Do not use online generators. Microsoft's Edge guide suggests vapidkeys.com (S14); avoid it (see
    the refuted section).
  - Store it with server secrets (file mode 0600 or the existing secret store). Never ship it to the
    client or log it.
  - Rotation requires every client to resubscribe (S3). Pushes fail with 403, `VapidPkHashMismatch`
    (S9) or `UnauthorizedRegistration` (S7). Plan a rotation path: the client compares
    `subscription.options.applicationServerKey` with the server's key at startup and resubscribes on
    a mismatch.
  - Compromise lets an attacker push to restricted subscriptions **only** if they also hold the
    endpoints and `p256dh`/`auth`. So the subscription table is sensitive too.
- **Payload trust**: the spec notes no guarantee that a message came from the same-origin
  application server (S8). The service worker should validate the payload schema and build every
  displayed string and URL itself. It should never render HTML or follow a URL from the payload.
- **Per-device subscriptions tied to sign-in**:
  - Apple's guide: store the endpoint and keys "together with the user's account information" (S9).
  - Bind each subscription row to the session or device credential that registered it.
  - On sign-out: the client calls `subscription.unsubscribe()`, which makes subsequent sends return
    410 (S7), and the server deletes the row.
  - On server-side session revocation (for example a lost phone), delete that session's
    subscriptions server-side even if the device never checks in.
  - Deactivated endpoints are never reused (S8), so deletion is safe.
- **Lock screen**:
  - Android: if the user hides sensitive notification content, Chrome shows only the origin and a
    hidden-content line (`createPublicNotification`) (S27) (A). Users can also hide content per app
    (S51) (A). Web pages cannot set visibility themselves.
  - iOS: Show Previews offers Always, When Unlocked or Never, globally or per app (S52) (A).
  - _Implication:_ "thread title only" still appears on an unlocked or permissive lock screen. Offer
    a "generic text" mode ("Agention: a thread needs you") as an operator setting, because titles
    authored by agents may contain sensitive project text.
- **Click URLs**:
  - `clients.openWindow()` resolves to null for a cross-origin URL. It needs transient activation;
    Firefox allows it only from `notificationclick` (S47) (A).
  - The Declarative Web Push `navigate` member has no same-origin requirement in the spec (S8).
  - Follow OWASP's mapped-identifier pattern (S48) (B): the payload carries a thread id only. The
    service worker builds `new URL('/threads/' + encodeURIComponent(id), self.location.origin)` and
    checks that `url.origin === self.location.origin` before focusing or opening.
  - If adopting the declarative format, the server constructs `navigate` from the id and never from
    agent-supplied text.
  - MDN warns that `Client.url` does not track SPA route changes, so focusing a matching client by
    URL is unreliable. Use `postMessage` to the focused client instead (S47).
- **SSRF**: the server POSTs to a URL the client supplied. Restrict endpoints to `https:` and an
  allowlist of push-service hosts:
  - `fcm.googleapis.com` (S20);
  - `*.push.apple.com` (S9);
  - `updates.push.services.mozilla.com` (S12);
  - `*.notify.windows.com` (S22) (C); verify.

  Do not follow redirects to private addresses (S49) (B). This matters more for a self-hosted server
  on a private network.

## Refuted / do-not-rely-on

- **"A silent push can retract a notification or sync state."** No. Chrome and Edge require
  user-visible pushes, Edge substitutes a generic notification, Safari revokes the permission, and
  FCM demotes priority (S5, S14, S9, S17).
- **"`tag` and `renotify` collapse notifications everywhere."** Safari and Safari iOS ignore `tag`
  ("can be set, but has no effect"). `renotify` is Chrome and Edge only (S28). Collapse server-side.
- **"`pushsubscriptionchange` tells you when a subscription changes."** Chrome fires it only on
  permission re-grant, with null subscriptions (S24). Firefox lacks old and new subscriptions; iOS
  lacks the event (S28). Rely on 404 and 410 plus client reconciliation.
- **"Chrome subscriptions never expire"** (mailing-list claim (S23b) (C)). web.dev says browsers
  "commonly expire" subscriptions (S5). Mozilla reports FCM endpoints returning 410 after inactivity
  (S23c) (C).
- **"404 means expired, 410 means receipt failure"** (RFC 8030 text (S1)). In practice Mozilla and
  Apple return 410 for gone subscriptions (S13, S9). Treat both 404 and 410 as delete.
- **"4096 bytes of plaintext."** 4096 is the encrypted body floor. Plaintext is at most 3993 bytes,
  and as little as 2744 through Mozilla's FCM bridge (S2, S12).
- **"TTL is honored everywhere."** WNS reportedly ignores it for Edge (S22) (C), unconfirmed. Apple
  caps at 30 days (S9); Mozilla at 2592000 s (S13). Push services may lower TTL (S1).
- **"`Urgency: high` guarantees Doze wake-up for web push."** It is not documented for Chrome. FCM
  documents high priority only for native messages, with demotion rules (S17). One 2019 bug reports
  a failure (S35) (C).
- **"RFC 8030 delivery receipts confirm delivery."** Receipts are unusable at TTL 0 (S1). I found no
  evidence that FCM, APNs or WNS expose them to Web Push senders. Do not design around them.
- **"The FCM legacy API shutdown broke Web Push."** Unsettled: the only source is Google's Peter
  Beverloo as relayed in a forum thread (S21) (C). Do not rely on either claim.
- **"Online VAPID key generators are fine"** (as Microsoft's guide implies (S14)). A third party
  would see the private key. Generate locally (`web-push generate-vapid-keys` or `node:crypto`).
- **"iOS Safari tabs can get web push."** Only installed Home Screen web apps can (S10, S28).
- **"Chrome's per-site Android channels look as they did in 2017."** That press coverage is
  from 2017. The current per-origin behavior is supported by Chromium source (S29), but the WebAPK
  channel layout is unverified.
- **"A saved-search subscription (Jira) is a trigger."** It is a scheduled snapshot that can miss or
  duplicate items (S43).

## Open questions

1. **Urgency mapping**: how does Chrome on Android map `Urgency` onto FCM delivery priority (high
   versus normal, or `RemoteNotification` versus `BackgroundSync` in FCM v2 (S18))? This needs a
   Chromium source read or a device test in forced Doze.
2. **Edge on Android**: which push service does Edge use there, and does WNS honor `TTL` today? Test
   with a real Edge subscription per platform.
3. **WebAPK channels**: does an installed Agention WebAPK get its own Android notification channels
   or app-level settings, separate from Chrome's per-origin channel? Can the operator give Agention
   a distinct sound or importance?
4. **Library ruling**: `web-push` 4.0.0 (MPL-2.0, ESM, no provenance, no padding) versus
   `@pushforge/builder` (zero dependencies, attested) versus a hand-rolled sender. Check
   `@pushforge/builder` for Topic, Urgency and padding support before ruling.
5. **Declarative Web Push**: adopt the payload shape now (Safari 18.4+ benefits; other browsers fall
   back to the service worker)? Chrome's status is unknown (no Intent found); Firefox's is in
   progress (S11c).
6. **Re-entry policy**: "once until read" (recommended above), "always on re-entry", or "once ever"?
   What counts as "read" (opened the thread on any device, or explicitly acknowledged)?
7. **Presence suppression**: skip pushes to all devices while any Agention window is focused, or
   only to the focused device?
8. **Lock-screen default**: is the operator content with titles on the lock screen, or should the
   default be generic text with titles opt-in?
9. **VAPID `sub`**: an instance `https:` URL or a `mailto:`? The value is visible to Google, Apple,
   Mozilla and Microsoft.
10. **Deadline-driven rules**: what timer granularity is needed (for example "deadline within 1 h"
    entering the set purely through time)?
11. **iOS validation**: there are no Apple devices today, so iOS behavior is unverified in practice.
    Is a borrowed device or simulator test acceptable before claiming iOS support?

## Sources

| #    | URL                                                                                                                                                                                                                                    | What it supports                                                                                             | Grade |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----- |
| S1   | <https://www.rfc-editor.org/rfc/rfc8030.html>                                                                                                                                                                                          | TTL, Urgency, Topic, status codes, 4096 floor, receipts                                                      | A     |
| S2   | <https://www.rfc-editor.org/rfc/rfc8291.html>                                                                                                                                                                                          | aes128gcm, 3993-byte plaintext, padding, push service visibility, Appendix A example                         | A     |
| S3   | <https://www.rfc-editor.org/rfc/rfc8292.html>                                                                                                                                                                                          | VAPID claims, header, restriction, rotation, security                                                        | A     |
| S4   | <https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe> and <https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/pushsubscriptionchange_event>                                                  | subscribe options, user gesture, change event handling                                                       | A     |
| S4b  | <https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification>                                                                                                                                          | tag, renotify, silent, requireInteraction, actions                                                           | A     |
| S5   | <https://web.dev/articles/push-notifications-subscribing-a-user>                                                                                                                                                                       | userVisibleOnly must be true, key handling, expiry in practice                                               | A     |
| S6   | <https://web.dev/articles/push-notifications-web-push-protocol>                                                                                                                                                                        | response codes, 4 KB, TTL, Topic, Urgency                                                                    | A     |
| S7   | <https://web.dev/articles/push-notifications-common-issues-and-reporting-bugs>                                                                                                                                                         | 404 and 410 handling, FCM `UnauthorizedRegistration`                                                         | A     |
| S8   | <https://w3c.github.io/push-api/>                                                                                                                                                                                                      | registration binding, revocation, refresh, declarative messages, metadata exposure                           | A     |
| S9   | <https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers>                                                                                                                  | no developer program, `*.push.apple.com`, invisible push revokes, TTL 30 days, JWT hourly, 4 KB, error codes | A     |
| S10  | <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>                                                                                                                                                               | Home Screen, gesture, no developer program, Focus, badging                                                   | B     |
| S11  | <https://webkit.org/blog/16535/meet-declarative-web-push/>                                                                                                                                                                             | declarative format, ITP survival, silent-push penalty                                                        | B     |
| S11b | <https://webkit.org/?p=16574> and <https://webkit.org/?p=16923>                                                                                                                                                                        | Safari 18.4 iOS and 18.5 macOS availability                                                                  | B     |
| S11c | <https://bugzilla.mozilla.org/show_bug.cgi?id=2068765>                                                                                                                                                                                 | Firefox declarative parser work (version 158)                                                                | C     |
| S12  | <https://mozilla-services.github.io/autopush-rs/http.html>                                                                                                                                                                             | 404 and 410, 4096 and 2744 bytes, Topic, VAPID optional, endpoint host                                       | A     |
| S13  | <https://mozilla-services.github.io/autopush-rs/errors.html>                                                                                                                                                                           | errno table, max TTL 2592000, 4028, Retry-After                                                              | A     |
| S14  | <https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/push>                                                                                                                                                    | Edge requires userVisibleOnly, generic notification, suggests online key generator                           | A     |
| S15  | <https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/forcebuiltinpushmessagingclient>                                                                                                                         | Edge uses WNS via OS client                                                                                  | A     |
| S16  | <https://blog.google/chromium/automatic-notification-permission/>                                                                                                                                                                      | auto-revocation (Oct 2025), installed apps exempt                                                            | B     |
| S17  | <https://firebase.google.com/docs/cloud-messaging/android-message-priority>                                                                                                                                                            | high priority in Doze, demotion when no notification                                                         | A     |
| S17b | <https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-priority>                                                                                                                                         | normal versus high, webpush Urgency header example                                                           | A     |
| S18  | <https://developer.android.com/training/monitoring-device-state/doze-standby>                                                                                                                                                          | Doze restrictions, RemoteNotification, adb Doze testing                                                      | A     |
| S19  | <https://web.dev/articles/push-notifications-faq>                                                                                                                                                                                      | desktop browser must be running; Android wakes browser                                                       | A     |
| S19b | <https://developer.android.com/develop/ui/views/notifications/notification-permission>                                                                                                                                                 | Android 13 POST_NOTIFICATIONS                                                                                | A     |
| S19c | <https://developer.android.com/about/versions/16/summary> and <https://www.androidauthority.com/android-15-notification-cooldown-3415784>                                                                                              | cooldown (Android 15), auto-grouping (16)                                                                    | A / B |
| S20  | <https://developer.chrome.com/blog/web-push-interop-wins>                                                                                                                                                                              | no Firebase project with VAPID, fcm.googleapis.com endpoint                                                  | B     |
| S21  | <https://groups.google.com/g/firebase-talk/c/3C2Vq9pIWr4>                                                                                                                                                                              | Web Push endpoints not deprecated (secondhand Google answer)                                                 | C     |
| S22  | <https://learn.microsoft.com/en-us/answers/questions/566758/windows-push-notification-service-ttl-support-appe>                                                                                                                        | WNS ignores TTL report, notify.windows.com hosts                                                             | C     |
| S22b | <https://learn.microsoft.com/en-us/answers/questions/940324/406-not-acceptable-may-be-returned-when-sending-a>                                                                                                                         | WNS 406 report                                                                                               | C     |
| S23  | <https://lists.w3.org/Archives/Public/public-webapps/2014OctDec/0223.html> and <https://bugzilla.mozilla.org/show_bug.cgi?id=1437919>                                                                                                  | Chrome default notification and budget, Firefox quota                                                        | C     |
| S23b | <https://lists.w3.org/Archives/Public/public-webapps-github/2020May/0225.html>                                                                                                                                                         | "subscriptions never expire" claim                                                                           | C     |
| S23c | <https://bugzilla.mozilla.org/show_bug.cgi?id=1497429>                                                                                                                                                                                 | Firefox change-event gaps; stale endpoint reports                                                            | C     |
| S24  | <https://groups.google.com/a/chromium.org/g/blink-dev/c/_ckNx_SZIjc>                                                                                                                                                                   | Chrome pushsubscriptionchange on re-grant, M137, null subscriptions                                          | B     |
| S25  | <https://developer.chrome.com/blog/notification-prompts-android>                                                                                                                                                                       | Chrome 155 prompt timeout, Site Controls, contextual prompting                                               | B     |
| S26  | <https://chromium.googlesource.com/chromium/src/+/main/components/webapps/docs/android_architecture.md>                                                                                                                                | WebAPK notification attribution and permission delegation                                                    | A     |
| S26b | <https://web.dev/webapks/>                                                                                                                                                                                                             | WebAPK runtime notification permission note; permissions managed by Chrome                                   | A     |
| S27  | <https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/notifications/android/java/src/org/chromium/chrome/browser/notifications/NotificationBuilderBase.java>                                                           | lock-screen public version, 5 KiB text cap                                                                   | A     |
| S28  | <https://github.com/mdn/browser-compat-data> (api/Notification.json, ServiceWorkerGlobalScope.json, PushManager.json, PushSubscription.json)                                                                                           | per-browser support for tag, renotify, actions, silent, change event, subscribe notes                        | A     |
| S29  | <https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/notifications/notification_channels_provider_android.cc> and <https://www.androidpolice.com/2017/07/28/chrome-android-o-will-give-website-notification-channel/> | per-origin channels                                                                                          | A / B |
| S30  | <https://registry.npmjs.org/web-push> (also /@block65/webcrypto-web-push, /@pushforge/builder, /webpush-webcrypto, <https://api.npmjs.org/downloads/>)                                                                                 | versions, dates, dependencies, engines, licenses, attestations, downloads, advisories                        | A     |
| S31  | <https://github.com/web-push-libs/web-push>                                                                                                                                                                                            | options, defaults, issue counts, browser table                                                               | A     |
| S31b | <https://github.com/web-push-libs/web-push/releases>                                                                                                                                                                                   | 4.0.0 changes, localhost subject warning                                                                     | A     |
| S31c | <https://registry.npmjs.org/web-push/-/web-push-4.0.0.tgz> (src/web-push-lib.js, vapid-helper.js, encryption-helper.js)                                                                                                                | default TTL and exp, per-request JWT, no padding                                                             | A     |
| S32  | <https://nodejs.org/api/crypto.html>                                                                                                                                                                                                   | ECDH, HKDF, AES-GCM, `dsaEncoding: 'ieee-p1363'`                                                             | A     |
| S33  | <https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/>                                                                                                                                                           | for, keep_firing_for, pending and firing states                                                              | A     |
| S34  | <https://prometheus.io/docs/alerting/latest/configuration/>                                                                                                                                                                            | group_wait, group_interval, repeat_interval, inhibition, time intervals                                      | A     |
| S35  | <https://issues.chromium.org/issues/41437304>                                                                                                                                                                                          | web push not waking a dozing device (2019; content behind sign-in)                                           | C     |
| S36  | <https://github.com/arteeh/uniichat/issues/70>                                                                                                                                                                                         | Urgency high fixing Android delay (anecdote)                                                                 | C     |
| S37  | <https://docs.pagerduty.com/developer/send-alert-event>                                                                                                                                                                                | dedup_key semantics                                                                                          | A     |
| S38  | <https://docs.pagerduty.com/incident-management/schedules/escalation-policies>                                                                                                                                                         | escalation timeout, repeats, ack stops notifications                                                         | A     |
| S38b | <https://docs.pagerduty.com/account-admin/user-profile/notification-rules>                                                                                                                                                             | urgency rule sets, delays                                                                                    | A     |
| S39  | <https://slack.com/help/articles/360025446073-Guide-to-Slack-notifications>                                                                                                                                                            | mobile on desktop inactivity, email batching                                                                 | A     |
| S40  | <https://slack.com/help/articles/201355156-Configure-your-Slack-notifications>                                                                                                                                                         | schedule, VIP bypass, keyword matching, inactivity defaults                                                  | A     |
| S41  | <https://developers.google.com/workspace/gmail/api/guides/filter_settings>                                                                                                                                                             | filters on incoming messages, per message not thread                                                         | A     |
| S41b | <https://www.androidcentral.com/android-101-how-get-notified-once-email-thread-or-each-new-message>                                                                                                                                    | Gmail notify once per thread (2011)                                                                          | C     |
| S41c | <https://zapier.com/blog/gmail-filters/>                                                                                                                                                                                               | "Also apply filter to matching conversations" backfill; forwarding only new                                  | C     |
| S42  | <https://linear.app/docs/notifications>                                                                                                                                                                                                | real-time push, digests skipped if read, 2000 cap, no browser push                                           | A     |
| S42b | <https://linear.app/changelog/2026-09-03-priority-inbox>                                                                                                                                                                               | priority inbox                                                                                               | B     |
| S43  | <https://support.atlassian.com/jira/kb/filter-subscription-misses-issues-updated-just-before-execution/>                                                                                                                               | subscriptions as scheduled snapshots, overlap and duplicates                                                 | A     |
| S43b | <https://jira.atlassian.com/browse/JRASERVER-68697>                                                                                                                                                                                    | subscription mail behavior with empty results                                                                | C     |
| S44  | <https://web.dev/articles/push-notifications-permissions-ux>                                                                                                                                                                           | permission prompt best practices                                                                             | A     |
| S45  | <https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox>                                                                                         | 15 custom filters, inbox queries                                                                             | A     |
| S45b | <https://docs.github.com/en/rest/activity/notifications>                                                                                                                                                                               | thread model, reasons, polling                                                                               | A     |
| S46  | <https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html>                                                                                                                                                         | quieter permission UI                                                                                        | B     |
| S47  | <https://developer.mozilla.org/en-US/docs/Web/API/Clients/openWindow>                                                                                                                                                                  | same-origin resolve, activation, Firefox click-only, SPA caveat                                              | A     |
| S48  | <https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html>                                                                                                                                   | mapped identifiers, allowlists                                                                               | B     |
| S49  | <https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html>                                                                                                                               | SSRF allowlisting (applied by inference to push endpoints)                                                   | B     |
| S50  | <https://www.macrumors.com/2024/03/01/apple-walks-back-decision-to-disable-eu-web-apps/>                                                                                                                                               | EU Home Screen web apps kept                                                                                 | B     |
| S51  | <https://support.google.com/android/answer/9079661>                                                                                                                                                                                    | Android lock-screen sensitive content controls                                                               | A     |
| S52  | <https://support.apple.com/guide/iphone/change-notification-settings-iph7c3d96bab/ios>                                                                                                                                                 | iOS Show Previews: Always, When Unlocked, Never, per app                                                     | A     |

### Sources that disagree

- Chrome's `pushsubscriptionchange` milestone: M137 (S24) versus Chrome 138 (S28).
- Mozilla's payload maximum: 4096 and 2744 (S12) versus 4028 (S13).
- `web-push` 4.0.0 date: npm 2026-11-06 (S30) versus GitHub "10 Nov" (S31b).
- WebAPK notification permission: delegated (S26) versus requested at runtime (S26b). These are
  likely compatible.
- 404 versus 410 meaning: RFC (S1) versus services (S13, S9).
- Gmail filter backfill details come only from third-party guides (S41c).
