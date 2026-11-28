# Notifications: Functional Requirements

- Status: Accepted by the operator, with the rulings recorded under
  [Operator rulings](#operator-rulings-2026-11-23-onward): on 2026-11-25 (rulings 1 to 7), and, as
  revised so a rule is a saved view that notifies, on 2026-11-27 (rulings 9 and 10), and keeping its
  own Web Push code on 2026-11-27 (ruling 11). Notifications ship in the same release as saved views
  (ruling 10). The installable web UI went ahead of the revision (ruling 8).
- Date: 2026-11-23
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim or as close transcription.
- Origin: agention#30, and the operator's direction that notifications follow the voice and settings
  effort as a designed effort of their own. The web UI's Settings
  (`docs/sdd/2026-11-21-voice-and-settings/`) and the thread list's filters are the baseline.

## Why this exists

Agents ask the operator for answers, decisions and approvals, and their work waits on some of them.
Today the operator learns of an ask only by looking: the Threads tab, its badge, or the attention
summary. Away from the desk, above all on a phone with Agention closed, nothing tells them. An agent
blocked on them stays blocked until they happen to look.

The operator should be told when something needs them, and only then. What counts as "needs me" is
theirs to say, as a saved view: a list they keep can tell them when an agent writes in a thread it
holds.

## Who this is for

- **The operator**, the one human, on a phone first, and on a desktop browser.
- **Agents** write as they do today; E1 states what stays unchanged for them.

## What this changes in ADR 0001

ADR 0001 lists **No push** among its deliberate limits: Agention reaches the person only through its
own web UI. This effort lifts that limit for the operator, through Web Push to the web UI only, and
the HLA's decision record supersedes that line. The limit's other half, reaching an agent only when
it checks, stays.

ADR 0001's **No server action on deadlines** stays as it is. Only an agent's message sets off a
notification (R2), so nothing notifies because time passed.

## Functional requirements

### Rules

**R1. A rule is a saved view that notifies.** The operator turns notifying on or off for any saved
view with the Notify switch on its row in Settings' Saved views, which is where Settings show which
views notify. A view notifies by its filters alone; its order and grouping play no part. The rule
follows the view: a rename keeps it, replacing the view's list changes what notifies from then on,
and removing the view ends it. Three filters cannot notify when they are on: search, since a
notification never acts on what messages say, and overdue and the agent's reading (unread by the
agent, stranded), which change with time alone. A view with one on cannot be turned on, and
replacing a notifying view's list with one that has one on ends its notifying, as removing the view
does. Replacing or removing a view that notifies says, when it asks, if notifying ends. Unread and
including archived threads change nothing, since every agent message leaves its thread unread and
not archived. A view naming something that no longer exists matches as its list does (saved views
R9).

**R2. An agent's message notifies.** When an agent's message is saved and leaves its thread matching
any rule, the thread notifies, unless it has already notified since the operator last read or
archived it. The operator's own actions (reading, marking unread, tagging, grouping, a script using
the operator API) never notify, and neither does time passing.

**R3. A starting view, stored once.** Agention adds one saved view that notifies, Blocking asks: the
threads with an open ask whose impact is blocking (ruling 1), its name numbered if a view already
has it. It is added even beside a view of the same filters, and not at all when the operator already
keeps 200 views, the most there can be. The operator changes, stops, or removes it like any other
view, and Agention never adds it again.

### Volume

**N1. One notification per thread until read.** Across all rules, a thread notifies at most once
until the operator reads or archives it, as R2 says. Where the device supports replacing a
notification, a later one for the same thread replaces the earlier rather than adding to it. There
is no reminder (ruling 2).

**N2. No quiet hours in this effort.** Agention adds none in this effort; the phone's own Do Not
Disturb covers it, and the operator guide says how (ruling 3).

### Delivery

**D1. Push to the web UI, with no third-party account.** Notifications reach the web UI through the
browser's own push service, as Web Push. Neither the operator nor the server needs an account with
any provider, and a notification's content is encrypted from the server to the device. They reach
Chrome on Android, with or without Agention added to the home screen, and Edge and Chrome on a
desktop while the browser is running.

**D2. The web UI installs as an app.** The web UI can be added to a phone's home screen and opens
there as an app of its own. Apple's browsers deliver Web Push only to a web UI installed that way.

**D3. Per device, opted in.** Notifications are turned on per device, from Settings on that device,
after a recent sign-in there. Settings list every device that receives them, with when the server
last sent to each. A device turns its own notifications off at any time; removing another device
from the list needs a recent sign-in, as revoking an API key does. When a device's notifications
stop, because the browser dropped them or another device removed it, its Settings say so, and
turning them on again needs a recent sign-in, as the first time did. A device's notifications end
when the operator turns them off, signs that device out, or removes the passkey that signed it in,
and not when its sign-in expires, so a phone left alone for a week still notifies; until one of
those happens, a phone whose sign-in expired still shows what D5 allows (ruling 5).

**D4. A notification opens its thread.** Opening a notification opens the thread it is about in
Agention, signed in as usual.

**D5. Content.** A notification shows the thread's title and why it needs the operator, such as
"Blocking ask", never a message's text (ruling 4).

### Engineering

**E1. Agents unchanged.** No agent route, tool or answer changes, and the agent API version stays as
it is. The usage skill tells agents, so they use impact and priority honestly, that their asks may
notify the operator's devices.

**E2. Security.**

- The server's push signing key is generated and kept by the server, never sent anywhere or logged;
  only its public half reaches browsers. Each device's push address and keys are kept like other
  secrets the server holds, in backups included.
- The server sends only to a browser push service, over HTTPS: never to the operator's network, a
  link-local or a metadata address, and it follows no redirect.
- Nothing readable reaches the push service: what it sees in clear names no thread, and a
  notification's size does not reveal its content's length. The server identifies itself to the push
  service without naming any person.
- A device's subscription is made only from the operator's sign-in on it. Only the web UI turns a
  view's notifying on or off and manages the devices; the operator API does neither and does not
  show them.

  Replacing or removing a view that notifies through the operator API, which `saved-views:write`
  allows, changes what notifies; the API key form and the operator guide say so of that scope.

**E3. Collateral.** The operator guide, the usage skill, SECURITY.md, the architecture document, the
development contract's optional integrations, the review checklist and ADRs describe rules,
delivery, what reaches the push service and devices, and how keys are kept; the live tests cover
them.

## Out of scope

- Channels other than Web Push (email, chat, SMS). The rules are designed so others can follow
  behind them.
- Notifying agents, or anyone other than the operator.
- Registrations awaiting approval. They block an agent too, but rules are thread filters; a
  registration notification can follow as its own change.
- Batching notifications across threads, and holding them back while the operator is using Agention.
- Notifying by a view's order or grouping; only its filters decide what notifies.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- The operator receives, on their Android phone with Agention installed and its screen off for a
  while, a notification for a blocking ask, and opens the thread from it; and the same on Windows in
  Edge and in Chrome.
- Apple browsers are a named gap: the operator has no Apple devices, so delivery there is built to
  the platform's documented rules and stated as untested.
- The repository passes its documented checks in CI, and the effort ships in a release.

## Operator rulings, 2026-11-23 onward

Answered in Agention on 2026-11-25, local time (thread 35, message 7, 2026-11-26T05:28Z). The
question: "Which designs should I build for the next release? Picking one accepts its requirements
as drafted, with the recommendations." Its detail: "Picking an effort below accepts its requirements
as drafted, with the recommended answer to each question still open on it, so you would not need to
answer its own thread too." The operator picked "Saved views (#170)", "Notifications (#96)", and
"Audit log (#123)". The questions still open on notifications were asks 5 to 10 in Agention thread
19, and picking notifications settled each at its recommended answer:

1. Starting rule: blocking asks (R3).
2. Reminders: none (N1).
3. Quiet hours (ask 7, "Quiet hours in Agention itself?"): "Not now; use phone DND" ("Your phone's
   Do Not Disturb covers nights; the guide says how. Agention quiet hours would need your time zone,
   a held queue and a release job."). So there are none in this effort; the phone's Do Not Disturb
   covers it, and the operator guide says how (N2).
4. What a notification shows: the title and why it needs the operator, never a message's text (D5).
5. What ends a device's notifications: turning them off, signing that device out, or removing its
   passkey, not the sign-in expiring (D3).
6. Web Push (ask 10, "How should the server speak Web Push?"): "Own code on node:crypto" ("No new
   dependency; padding and outbound limits built in; tested against the RFC's worked example and
   your devices."). The token is signed with `jose`, which the server already ships, as the HLA
   says. Ask 12 in thread 19, asked after this acceptance, reopens how push is implemented, and is
   open (ruling 11 answers it).
7. Saved views (thread 35's suggestion for notifications): "Recommended second, reshaped so a rule
   can follow a saved view; I'd show you that change before building". The reshape touches R1, R3,
   E2, the out-of-scope line saying only filters define a rule (saved views carry order and grouping
   too), and Why this exists. Building starts once the operator accepts those revised requirements,
   recorded here as a ruling.
8. The installable web UI ahead of the revision: answered in Agention on 2026-11-27 (thread 19,
   message 13, 2026-11-27T18:14Z), to the question in message 12: "May the installable web UI
   (notifications PR 1) go ahead as its own PR before you accept the reshape?" The operator picked
   "Go ahead (Recommended)" ("It's unaffected by the reshape; I record your release as a ruling and
   open it stacked on #96."). So the plan's PR 1 is built and merged on its own, ahead of the
   revision ruling 7 calls for.
9. The revision ruling 7 calls for: answered in Agention on 2026-11-27 (thread 19, message 13,
   2026-11-27T18:14:19Z), to ask 14 in message 11 (2026-11-26T12:09Z): "Accept the reshaped
   notifications design (rules are saved views switched to notify) as drafted in PR #188?" The
   operator picked "Accept as drafted (Recommended)" ("Rules follow views live; a saved-views:write
   key can change what notifies, recorded as a second exception."). So Why this exists, R1, R3, E2's
   last point, and the out-of-scope line on order and grouping read as drafted, and E2 gives way as
   the draft proposed: replacing or removing a view that notifies through the operator API, under
   `saved-views:write`, changes what notifies.
10. Release order: answered in the same message, to ask 15 in message 11: "Should saved views and
    notifications ship in the same release?" The operator picked "One release (Recommended)" ("No
    key you've already issued ever widens."). So saved views and notifications ship in the same
    release, and no key issued with `saved-views:write` gains what notifies after it was issued.
11. Web Push, our own code (ask 12, reopening ruling 6's choice): answered in Agention on 2026-11-27
    (thread 19, message 17, 2026-11-27T21:34:51Z), to the question in message 9: "Keep our own Web
    Push code, proven by the RFC's worked example, an independent round-trip check in tests, and
    your devices before merge?" The operator picked "Yes, own code" ("As designed, plus the
    test-only round-trip check."). So ruling 6 stands, with an independent decryption in the tests
    and the operator's devices as the acceptance before merge.
12. No overall rate cap (ask 18): answered in Agention on 2026-11-27, local time (thread 19, message
    23, 2026-11-28T03:44Z), to the question in message 19: "Ship notifications without an overall
    rate cap for now?" The operator picked "No cap for now (Recommended)" ("One per thread until
    read, plus each agent's write rate; revisit with real use."). So nothing caps how often
    notifications are sent beyond a thread notifying once until read and each agent's write rate.
