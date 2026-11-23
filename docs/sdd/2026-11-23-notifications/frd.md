# Notifications: Functional Requirements

- Status: Draft for the operator's acceptance. The choices marked **Open** below are the operator's;
  each states the lead's recommendation and the alternatives.
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
theirs to say, in the same terms the thread list already filters by, so a rule reads like a saved
filter.

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

**R1. A rule is a thread-list filter.** A notification rule is a set of the thread list's filters,
made from the thread list: with filters on, the operator saves them as a rule. Settings show each
rule's filters as the thread list would and open the thread list filtered by it, and a rule can be
removed there. A rule takes every filter but four: overdue and the agent's reading (unread by the
agent, stranded), which change with time alone; unread, which every agent message meets; and search,
since a notification never acts on what messages say. Including archived threads means nothing to a
rule, since an agent's message always brings a thread back. A rule naming a session, tag or topic
that no longer exists matches no thread until one by that name exists again; one naming a removed
group never matches again, as the thread list behaves.

**R2. An agent's message notifies.** When an agent's message is saved and leaves its thread matching
any rule, the thread notifies, unless it has already notified since the operator last read or
archived it. The operator's own actions (reading, marking unread, tagging, grouping, a script using
the operator API) never notify, and neither does time passing.

**R3. A starting rule, stored once.** Agention starts with one stored rule, which the operator may
change or remove like any other; once removed, it does not return. **Open (starting rule):** the
recommendation is a thread with an open ask whose impact is blocking. Alternatives: any open ask; no
starting rule.

### Volume

**N1. One notification per thread until read.** Across all rules, a thread notifies at most once
until the operator reads or archives it, as R2 says. Where the device supports replacing a
notification, a later one for the same thread replaces the earlier rather than adding to it. **Open
(reminder):** the recommendation is no reminder. The alternative is one reminder at a fixed delay
for a thread still unread, which would also be the place to notify when an answer-by passes.

**N2. Quiet hours.** **Open (quiet hours):** the recommendation is none in this effort; the phone's
own Do Not Disturb covers it, and the operator guide says how. The alternative is daily quiet hours
in the operator's time zone, during which nothing notifies, with each thread that would have
notified meanwhile notifying once when they end if it is still unread.

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
turning them on again needs a recent sign-in, as the first time did. **Open (what ends a device's
notifications):** the recommendation is that they end when the operator turns them off, signs that
device out, or removes the passkey that signed it in, and not when its sign-in expires, so a phone
left alone for a week still notifies; until one of those happens, a phone whose sign-in expired
still shows what D5 allows. The alternative ends them with the sign-in, which on a phone unused for
seven days ends them silently.

**D4. A notification opens its thread.** Opening a notification opens the thread it is about in
Agention, signed in as usual.

**D5. Content.** **Open (content):** the recommendation is the thread's title and why it needs the
operator, such as "Blocking ask", never a message's text. Alternatives: the same, with an option to
add the latest message's first line, knowing it then shows on a lock screen; or a generic text
alone, such as "A thread needs you", with no title.

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
- A device's subscription is made only from the operator's sign-in on it. Rules and notification
  settings change only through the web UI, never through the operator API.

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
- Notifications from the thread list's sort or grouping; only its filters define a rule.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- The operator receives, on their Android phone with Agention installed and its screen off for a
  while, a notification for a blocking ask, and opens the thread from it; and the same on Windows in
  Edge and in Chrome.
- Apple browsers are a named gap: the operator has no Apple devices, so delivery there is built to
  the platform's documented rules and stated as untested.
- The repository passes its documented checks in CI, and the effort ships in a release.

## Operator rulings, 2026-11-23 onward

(None yet.)
