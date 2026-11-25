# Read aloud and Audio Mode: Functional Requirements

- Status: Draft for the operator's acceptance. The choices marked **Open** below are the operator's;
  each states the lead's recommendation and the alternatives.
- Date: 2026-11-23
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim or as close transcription.
- Origin: agention#37, a follow-up to the voice and settings effort
  (`docs/sdd/2026-11-21-voice-and-settings/`), whose Settings, transcription provider and read aloud
  are the baseline. Its first ruling, that the server calls voice providers with a key no browser
  ever holds, binds here too.

## Why this exists

Dictation lets the operator answer by voice. Hearing what agents wrote is the other half, and today
it falls short: read aloud uses the device's default voice and rate, which the operator finds
robotic and slow, and it sits in each message's options menu.

With the phone mounted in a car or on a bike, the operator still has agents waiting on them. An
Audio Mode would read the asks that wait on them aloud and take their answers by voice, so they can
keep agents moving without reading or touching the screen, while nothing is sent that they did not
hear read back and confirm.

## Who this is for

- **The operator**, the one human, on an Android phone first, and in Edge or Chrome on Windows.
- **Agents** are unaffected: they read and write text as they do now, and an answer given in Audio
  Mode is the same answer the web UI sends.

## What this changes in earlier decisions

- **The voice and settings effort's V7** says nothing is read aloud unless the operator asks, and
  put reading aloud automatically out of scope. Audio Mode, once the operator starts it, reads the
  asks waiting on them without a request for each one.
- **SECURITY.md** says a provider can put words in a draft but never in a thread. In Audio Mode, the
  transcription provider hears the operator's confirmation, so a provider that heard "cancel" as
  "send" could send what was read back. What is read back is spoken by the device from the exact
  text to be sent, so the provider never chooses what is confirmed, only whether the confirmation
  was heard. The architecture's decision record states this and SECURITY.md is updated with it.
- **ADR 0002** says read aloud has no setting. A1 adds a voice and rate kept in each browser, with
  no server part.

## Functional requirements

### Read aloud (first delivery)

**A1. A chosen voice and rate.** Settings on each device choose the voice and the rate read aloud
uses, from the voices the browser offers, and start from the browser's default until the operator
picks one. Settings mark a voice the browser reports as sending the text off the device, as some
browsers' natural voices do. Where the browser offers languages rather than voices, as Chrome on
Android does, the rate is the choice.

**A2. Read aloud where it is needed.** Each message has a read aloud control of its own, outside its
options menu, and a thread offers to read from a message through to the latest. What is read and
skipped is as read aloud does today. A stop control is always in reach while anything is being read,
and every control has an accessible name and is reachable from the keyboard.

### Audio Mode (second delivery)

**M1. A hands-free mode, screen on.** The operator starts Audio Mode from the web UI, with the phone
mounted and its screen on; Audio Mode keeps the screen awake. It ends by voice while it listens, or
at any time by the one large control it shows. While it is on, everything it offers is done by
voice, and the screen shows only its state and that control: nothing to read. It needs a
transcription provider. Audio Mode is for use where it is safe to listen and speak; Agention is not
a car interface, which the web UI page says.

**M2. What it reads.** **Open (what Audio Mode reads):** the recommendation is the open asks waiting
on the operator, in the thread list's priority order, one ask at a time: the thread's title, the
agent and session, the text of the thread's unread messages through the latest, and the ask's
question with its suggestions numbered, with the detail on request. Alternatives: open asks, then
other unread messages from agents; or every unread message in the order it arrived. Hearing an item
does not mark it read; answering it does, as answering does today, so everything an answer marks
read was read aloud first. An ask skipped with "next" is not offered again until Audio Mode starts
again. An ask met with silence three times is passed over, not skipped: it comes back after the
others, and when nothing else is left Audio Mode says how many passed asks are waiting and offers
them again a few minutes later or when a new ask arrives.

**M3. Commands.** A fixed set, each said after Audio Mode signals that it is listening:

- a suggestion's number, or several numbers where the ask takes several;
- "reply", then the text to answer with;
- "decline";
- "detail", to hear the message's detail;
- "repeat";
- "next", to leave the ask unanswered and move on;
- "stop", to end Audio Mode.

A command not understood is said back as not understood, and nothing happens.

**M4. Nothing is sent unheard.** An answer is read back first, by the device's voice from the exact
text to be sent and naming what it answers ("Answer 'Drop the table now, or after the backfill?'
with 'After the backfill'. Say send, or cancel."). It is sent only on "send", a word that answers no
ask; anything else, or silence, cancels, and a cancelled reply is added to the thread's draft, after
any text already there. Only Audio Mode's own state can lead to a confirmation, never words in what
was read.

**M5. Its own voice is known.** Audio Mode marks its own prompts with a short sound before each, so
what Agention asks is never confused with what an agent wrote. It signals with a sound each time it
starts listening, and listens only while it is not speaking.

**M6. Failures are said.** Audio Mode never stops reading or listening silently. When a provider or
the network fails, the browser session ends, the microphone is taken away, or an ask is answered,
withdrawn or replaced elsewhere before it is sent, it says what happened and whether anything was
sent. A send whose outcome is unknown is retried as the same request, so it never sends twice. When
new messages arrived in the thread since it was read, the send is refused as it is today, and Audio
Mode reads what arrived and asks again.

**M7. Knowing when the operator has finished speaking.** **Open (end of speech):** the
recommendation is to tell from the microphone's level when the operator has stopped speaking, with
no new dependency and no change to the content security policy, accepting that a noisy car may cut a
long reply short or wait a moment longer. The alternative is a speech-detection library running in
the browser, which handles noise better but needs the content security policy to allow WebAssembly.

### Engineering

**E1. Agents unchanged.** No agent route, tool or answer changes, and the agent API version stays as
it is. **Open (marking voice answers):** the recommendation is that an answer given in Audio Mode is
unmarked, like any other. The alternative adds a short plain note to a reply made by voice, so an
agent knows homophones and numbers may have been misheard.

**E2. Security and privacy.**

- Audio Mode's commands and replies are transcribed through the server's transcription route, as
  dictation is; no provider key or token reaches a browser beyond what Settings already show.
- The microphone is open in Audio Mode only while it listens, and anything spoken nearby then, by
  passengers or a radio, reaches the transcription provider; Settings and the guide say so. No audio
  is stored.
- What is read aloud is spoken by the browser; a voice the browser reports as sending text off the
  device is marked (A1).

**E3. Collateral.** The operator guide, the web UI page, SECURITY.md, the architecture document and
ADRs describe the read aloud controls, the voice settings, Audio Mode, its commands and
confirmation, and what reaches the transcription provider; the live tests cover them.

## Out of scope

- **Provider speech and Audio Mode with the screen off.** **Open (provider speech):** the
  recommendation is a later decision. The browser's own voices stop with the screen and get no
  headset or lock-screen controls; provider speech, played as audio, would give both, at the price
  of a second provider setting, message text sent to that provider, and server work to speak a
  message without putting its text in a URL. It is worth deciding once the operator has used the
  chosen voices, and once a test on their phone shows whether the microphone keeps working with the
  screen off. The alternative brings it into this effort as a third delivery.
- Android Auto and CarPlay, which take only native apps.
- A wake word, such as "Hey Agention", and speaking over Agention while it speaks.
- Streaming transcription. Commands are short, and the existing transcription route serves them.
- Reading attachments aloud.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- The operator reads a thread aloud in Edge on Windows and on their Android phone with a chosen
  voice or rate.
- On their Android phone, mounted with the screen on, the operator hears a blocking ask read in
  Audio Mode, answers it by voice with a confirmation, and hears the next, without touching the
  screen; and hears a failure said when the network is cut mid-answer.
- Apple browsers are a named gap: the operator has no Apple devices.
- The repository passes its documented checks in CI, and the effort ships in a release.

## Operator rulings, 2026-11-23 onward

(None yet.)
