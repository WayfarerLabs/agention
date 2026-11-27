# Audio Mode: Low-Level Design

- Status: Draft, for review with the HLA; the FRD's open choices are designed as recommended
- Date: 2026-11-23
- Requirements: [FRD](frd.md) M1 to M7, E1 and E2; architecture: [HLA](hla.md), "Delivery 2: Audio
  Mode"
- Code is cited at this branch's base. `apps/web/src/device.ts` with drafts is cited at
  `origin/feat/browser-drafts` (692872a, agention#70), which this delivery stacks on.

## Pieces

| Piece          | Where                                           | What it is                                                                                |
| -------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `speak`        | `apps/web/src/voice/speech.ts`                  | Gains a promise, a watchdog, long sentences split, and `wordsOf` options (delivery 1)     |
| Recording step | `apps/web/src/voice/recording.ts` (new)         | Opens the microphone, records one take, and closes it; drawn out of `useDictation`        |
| Level monitor  | `apps/web/src/voice/level.ts` (new)             | Reads a turn's loudness and says when speech starts and ends                              |
| Tones          | `apps/web/src/voice/tones.ts` (new)             | The prompt tone and the listen tone, from an oscillator                                   |
| Grammar        | `apps/web/src/audio/commands.ts` (new)          | A transcript to a command, for the state the loop is in                                   |
| Turn loop      | `apps/web/src/audio/loop.ts` (new)              | The state machine of the tables below, with its effects passed in, so tests fake them all |
| Words          | `apps/web/src/audio/words.ts` (new)             | Every utterance Audio Mode says, by kind and data, from one table                         |
| Queue          | `apps/web/src/audio/queue.ts` (new)             | The next ask, and what an item says                                                       |
| View           | `apps/web/src/views/AudioMode.tsx` (new), route | The full-screen view, wake lock, Stop, and the per-item writer                            |

The loop is plain TypeScript, not React: the view creates it with its effects (speak, record,
transcribe, write, keep a draft, load) and renders its state. Every rule below is a pure function or
a transition, unit-tested with fakes.

**Constants are starting values.** Every number below marked as a starting value (thresholds,
windows, gaps, caps, retry intervals) is a named constant with a test seam, and the plan's device
spike sets it: the spike logs level traces in the car, each turn's noise floor, its speech level in
dBFS and the track's `getSettings().autoGainControl`, and the values are fixed from them.

## The queue and an item

**Source.** `GET /threads?status=open&sort=priority`, the request the thread list makes
(`apps/web/src/views/ThreadList.tsx:337-338`), through `usePages` (`apps/web/src/data.ts:153-178`),
which refreshes on `useResource`'s 10-second interval while the page is visible
(`apps/web/src/data.ts:37-80`). It loads the first page and follows `next`, by `more()`, only while
every ask on the pages loaded is set aside or passed over and `next` exists. Every ask is the
requester's, and the requester is always the session (`packages/api/src/threads.ts:97-100`,
`:287-290`), so every open ask is open to the operator. Archived threads are left out, as the list
leaves them out without `include_archived`: the operator archived them, and Audio Mode honors that.

**The next item.** After each answer, `loading` waits for the list's next refresh, so the answered
ask is gone and the order is current. The item is then the first ask, walking threads in the list's
order and each thread's open asks in `open_asks.asks` order (`packages/api/src/threads.ts:470-486`),
that is neither set aside nor passed over. With nothing set aside or passed, that is the most
pressing open ask overall, since the list sorts threads by their most pressing ask and each thread
lists its own most pressing first. A list entry names its asks only by number and message
(`packages/api/src/threads.ts:467-468`), so past a set-aside ask the walk keeps the list's order
rather than comparing asks across threads.

- **Set aside**: "next". Not offered again in this run. Keyed by agent, session, thread number and
  ask number.
- **Passed over**: three silent command turns in a row. Offered again once every other ask has been
  offered (M2).

**Nothing else left.** With no ask to offer: `Nothing is waiting on you.` when nothing was passed
over, else `<n> passed asks are waiting.`, said once on entering `idle`. Passed asks are offered
again 3 minutes later (a starting value), or at once when the list gains an ask, which is read
first, with `A new ask.`.

**Loading an item.** The view reads `GET /s/:agent/:session/threads/:thread?after=<from>&limit=100`,
which marks nothing read (reading is a separate `POST .../read`,
`apps/web/src/views/thread/ThreadView.tsx:280`). `from` is the lower of the thread's `read_through`
and the ask's message's sequence less one, and it pages on with `after` until it reaches the
thread's `last_seq`. The unread messages run through the thread's latest message, past the ask,
since the server takes a write only when `seen_through` is the thread's latest
(`apps/server/src/store/threads.ts:618-624`). The last message read is the item's `shown`. An ask
whose `askRead.open` is false by then (`packages/api/src/threads.ts:401-415`) is dropped, and the
next taken.

**What an item says.** Utterances of kind **own** are Audio Mode's words; **content** is what an
agent wrote. The prompt tone plays before an own utterance that starts the item or follows content,
so it marks only Audio Mode's words (M5); content never has a tone of its own, and always follows an
own lead-in.

| Utterance           | Kind    | Words                                                                                                 |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| Heading             | own     | `Thread: <title>. <agent>, session <session>.`                                                        |
| Each unread message | own     | `<author> wrote:`                                                                                     |
|                     | content | `wordsOf(message, { detail: false, asks: false })` (`apps/web/src/voice/speech.ts:68-87`)             |
| The ask             | own     | `Ask <n>:`                                                                                            |
|                     | content | the question                                                                                          |
| The prompt          | own     | `Say 1 for <label>, 2 for <label>, reply, decline, detail, repeat, next or stop.`                     |
|                     |         | with `multiple`, `Say one or more of 1 for <label>, 2 for <label>, or reply, ...`                     |
|                     |         | without suggestions, `Say reply, decline, detail, repeat, next or stop.`                              |
|                     |         | after the item's first prompt, `Say a number or a command.` (or `Say a command.` without suggestions) |

`wordsOf` leaves out asks so the item's own ask lines are the only reading of them; the other asks
on the messages read are items of their own.

**Detail.** "detail" says `Detail:` (own), then the ask's message's detail (content), or
`There is no detail.`; then each suggestion's description as `<n>, <label>:` (own) and the
description (content), for those that have one.

## The turn loop

Nine states. Steps run inside a state's transition and are not states of their own: the start,
cancelling, and catching up after a stale send. "Listen" is one turn (next section); **silence** is
a turn with no speech, which is never uploaded.

| State        | Says                                            | Hears        | Next                                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loading`    | nothing; on the first entry, the start step     | nothing      | `reading` with the next item; `idle` when none; on a load failure, the failures table                                                                                                                                                         |
| `idle`       | the "nothing else left" words, once             | nothing      | `reading` when a refresh brings an ask, or passed asks come due                                                                                                                                                                               |
| `reading`    | the item                                        | nothing      | `command`                                                                                                                                                                                                                                     |
| `command`    | (listen tone)                                   | a short turn | picks or `decline`: `confirming`; `reply`: `replying`; `detail`: the detail, `command`; `repeat`: `reading`; `next`: set aside, `loading`; `stop`: `ended`; not understood: `Not understood.` and the short prompt, `command`; silence: below |
| `replying`   | `Say your reply.`, (listen tone)                | a reply turn | text: `confirming`; silence or blank text: `Nothing heard.`, `command`                                                                                                                                                                        |
| `confirming` | the read back (below), (listen tone)            | a short turn | exactly `send`: `sending`; `stop`: the cancel step, then `ended`; anything else or silence: the cancel step, then `command` on the same ask                                                                                                   |
| `sending`    | nothing                                         | nothing      | written: `Sent.`, `loading`; stale: the catch-up step; otherwise the failures table                                                                                                                                                           |
| `suspended`  | nothing, while the page is hidden               | nothing      | visible again: the hidden row of the failures table                                                                                                                                                                                           |
| `ended`      | `Audio Mode is off.`, unless a failure said why | nothing      | the view closes; wake lock released, microphone closed                                                                                                                                                                                        |

**Silence in `command`.** The first and second say the short prompt and listen again. The third says
`No answer. Passing over this ask.`, passes the ask over, and goes to `loading`, which goes on to
`reading` or `idle`.

**Steps.**

- **Start**, on entering `loading` the first time: the wake lock is taken, the `AudioContext` made
  from the Start tap, and `Audio Mode.` said (own).
- **Cancel**, from `confirming`: `Cancelled. Nothing was sent.` (or, while the outcome is unknown,
  `Cancelled. Your answer may already have been sent.`); then the reply rule below.
- **Catch up**, from `sending` on a stale answer: `New messages arrived.` (own), then each missed
  message as an item reads it. When `staleChange` (`apps/web/src/views/thread/writer.ts:259-325`)
  finds the ask answered, withdrawn or revised by them, the failures table's stale row says so and
  the loop goes to `loading`; otherwise the read back again and `confirming`, whose send is then
  `readAndWrite`.

**The reply rule.** Every exit that leaves a built reply unsent keeps it in the thread's draft and
says `Your reply is in the thread's draft.`, or `Your reply could not be kept.` when the draft keeps
nothing (below): the cancel step, Stop or leaving the view during `confirming`, a refusal of the
send, the third transcription failure ending Audio Mode, the microphone lost, speech failing for
good, and a sign-out. Picks and a decline are built again from the ask and need no keeping.

**Every speaking state waits for `speak`'s promise before it listens**, so Audio Mode never hears
itself (M5). Stop from the control, or "stop" while listening (M1), and leaving the view go to
`ended` from any state. A send under way is not aborted; its outcome is said first if it arrives
within 5 seconds (a starting value), and otherwise `Your answer may not have been sent.`.

**The read back** (M4), all own words, built from the answer exactly as it will be sent:

- picks: `Answer "<question>" with "<label>".`, several as
  `with "<label>", "<label>" and "<label>"`;
- reply: `Answer "<question>" with your words: "<text>".`;
- decline: `Decline "<question>".`;
- then `Say send, or cancel.`

The answer is a `StagedAnswer` (`apps/web/src/views/thread/writer.ts:55-60`) with `picks` and
`words`, so `contentOf` (`writer.ts:201-221`) builds the message and `staleChange` judges a stale
send, as the composer does. A reply is the ask's own words, which every ask takes
(`packages/api/src/threads.ts:113-117`, `:155-158`); on an ask with suggestions it goes with
`other: true`.

**An unknown outcome.** A send that got no answer leaves the item `uncertain` until the outcome is
known. While it holds, every word about the answer says it may have been sent, a cancel included. On
a cancel, on Stop, and before the item is offered again, the view reloads the thread: an answer of
the operator's on the ask means it was sent (`Your answer was sent.`), and the loop goes on to
`loading`; the ask still open with no such answer means it was not (`Your answer was not sent.`).
`useWriter` keeps the request id for a retry of the same content (`writer.ts:413-458`), so "send"
again never sends twice.

## Listening

**Two kinds of turn**, short (a command or a confirmation) and reply:

| Turn  | Speech must start within | Quiet gap that ends it | Turn ends at |
| ----- | ------------------------ | ---------------------- | ------------ |
| Short | 6 s                      | 1,000 ms               | 10 s         |
| Reply | 10 s                     | 1,500 ms               | 60 s         |

All are starting values. At 32 kbit/s a minute is about 240 KB, far under the API's 2 MiB body cap
(`apps/web/src/voice/Dictation.tsx:27-32`).

**One turn.** Open the microphone with
`{ echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 }`; play
the listen tone; when the tone has ended and `AudioContext.outputLatency` has passed, so it has been
heard, start the recorder and the noise floor's window; wait for speech; record until the quiet gap
or a cap; stop; close the microphone. Automatic gain raises the gain in silence and lowers it under
speech, which would move the floor toward speech level, so Audio Mode asks for it off; whether the
operator's phone honors that, over car Bluetooth too, is what the spike's traces show. Dictation
keeps `{ audio: true }` (`apps/web/src/voice/Dictation.tsx:226`), so its takes are unchanged.

**The level.** An `AnalyserNode` (`fftSize` 1024) on a `MediaStreamAudioSourceNode` of the turn's
stream, in the one `AudioContext`. Every 20 ms, by `setInterval`, it reads `getFloatTimeDomainData`
and takes the frame's RMS in dBFS, floored at -100.

**The noise floor.** The 300 ms window's lowest 50 ms mean, so speech that starts inside the window
leaves it true. When speech covers the whole window, as when the operator talks over the tone, the
floor would be speech's level; so the floor is at most the previous turn's floor plus 6 dB, or -40
dBFS on the first turn.

**Speech.** It starts when the level stays at or above `max(floor + 12 dB, -55 dBFS)` for 100 ms,
and the turn ends after the quiet gap with no frame at or above that threshold. Both are starting
values; a lower threshold for holding speech once started is added only if the spike shows replies
cut short.

**A turn with no speech.** Speech did not start within its window: the recording is dropped, unread,
and nothing is uploaded; the state's silence row applies. A take with speech that comes back blank,
or under `minRecordingBytes` (`packages/api/src/settings.ts:143`, as `Dictation.tsx:176` uses it),
counts as silence too.

**Transcription.** `upload("/transcriptions", take.blob, { type, csrf, timeout, signal })`, as
dictation calls it (`apps/web/src/voice/Dictation.tsx:186-191`), on the plain route, never the
thread's. A reply's take that fails to transcribe is uploaded once more before the failure is said.

## The command grammar

**Normalization**, in this order: NFKC; lower case; every run of characters that are neither letters
nor digits becomes one space; trim. "Send." and " SEND! " are both `send`.

**Number words** map to digits as whole words: `one` to `ten`, the ordinals `first` to `tenth`, and
the homophones transcripts give for lone numbers, `won` 1, `to` and `too` 2, `for` 4. **Fillers**
are `number`, `option` and `and`, allowed anywhere in a transcript of numbers and dropped.

**Commands**, the whole normalized transcript against what the state allows:

| State        | Transcript                                             | Command          |
| ------------ | ------------------------------------------------------ | ---------------- |
| `command`    | numbers and fillers only, at least one number          | picks (below)    |
| `command`    | `reply`, `decline`, `detail`, `repeat`, `next`, `stop` | that command     |
| `confirming` | `send`                                                 | send             |
| `confirming` | `stop`                                                 | cancel, then end |
| `confirming` | anything else, `cancel` included                       | cancel           |

**Picks.** The numbers are deduplicated first, then checked: each from 1 to the ask's number of
suggestions, and more than one only with `multiple`. They map from one-based as spoken to the API's
zero-based picks (`packages/api/src/threads.ts:172-177`), in ascending order: "three and one and
three" is `[0, 2]`, and "one and one" is `[0]`, a single pick. A number out of range, several
numbers without `multiple`, or any number on an ask without suggestions is not understood, so
nothing is half-picked. "send it", "yes" and "okay" cancel a confirmation, and "reply with the
backfill" is not understood: every command is one word.

## Failures

Each is said in own words, with the prompt tone, and says whether anything was sent; a built reply
is kept by the reply rule wherever it is left unsent.

| Failure                                                                                  | Words                                                                                                                                                    | Outcome                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| The list or a thread failed to load, in `loading` or a refresh in `idle`                 | `Could not load the asks. Trying again.`, once per run of failures                                                                                       | retried after 5, 10, 20 and 40 s; after 5 failures in a row, `Could not load the asks. Audio Mode is off.`, `ended`                            |
| A send that got no answer (network, timeout), or `readAndWrite` resolving to `undefined` | `Your answer may not have been sent. Say send to try again; it will not be sent twice.`                                                                  | `confirming`, the item `uncertain`                                                                                                             |
| A send refused for another reason (`invalid_input`, `not_found`)                         | `Not sent: <the refusal's message>.`                                                                                                                     | `command` on the same ask, or `loading` when the thread is gone                                                                                |
| Stale, the ask answered, withdrawn or revised by what arrived                            | `Ask <n> was answered elsewhere.` / `was withdrawn.` / `was revised.`, then `Nothing was sent.`                                                          | `loading`; nothing is marked read                                                                                                              |
| Stale, the ask still open                                                                | `New messages arrived.`, the messages, the read back                                                                                                     | `confirming`; "send" is `readAndWrite`, which marks them read and writes                                                                       |
| A transcription failed (`provider_failed`, network, timeout, any other refusal)          | `Transcription failed. Nothing was sent. Say that again.`                                                                                                | the same state listens again; the third in a row, `Audio Mode is off.`, `ended`                                                                |
| The microphone refused or lost (`NotAllowedError`, `NotReadableError`, a track `ended`)  | `The microphone is not available. Nothing was sent. Audio Mode is off.`                                                                                  | `ended`                                                                                                                                        |
| An utterance failing without Audio Mode stopping it, or the watchdog firing              | nothing at first                                                                                                                                         | after 3 s, `speak` again from that sentence; the third failure within 60 s, `Speech stopped. Audio Mode is off.`, shown on screen too, `ended` |
| The page hidden mid-turn                                                                 | on return: `Audio Mode paused while the screen was hidden.`, then `Your answer was sent.`, `Your answer may not have been sent.`, or `Nothing was sent.` | `reading` the current item, or `loading` when it was sent                                                                                      |
| The sign-in refused (`unauthenticated` on any request)                                   | `You are signed out. Nothing was sent. Sign in on the screen.`                                                                                           | `ended`, said as the page returns to sign-in                                                                                                   |
| The wake lock refused or lost                                                            | `The screen may turn off.`, once a run                                                                                                                   | goes on; taken again on every return to visible                                                                                                |

**Hidden mid-turn.** On `visibilitychange` to hidden, the loop stops speaking, drops a recording
under way unread, aborts a transcription under way, and lets a send under way finish. A confirmation
under way is cancelled by the reply rule. On visible it takes the wake lock again, resumes the
`AudioContext`, and goes on as the table says.

**The sign-in refusal.** Every failed request with `unauthenticated` calls `useUnauthenticatedCheck`
(`apps/web/src/data.ts:16-26`), as `useResource`, `useFollowing` and `useAction` do (`data.ts:50`,
`:114`, `:195`) and `useWriter` does (`apps/web/src/views/thread/writer.ts:367`, `:393`). It
rechecks the session (`apps/web/src/session.tsx:52-64`, `:74`), and the shell swaps the view for
sign-in. Audio Mode records that it saw the refusal; its unmount cleanup, which otherwise stops
speech, then keeps a built reply by the reply rule and speaks the signed-out words once. Speech is
module-level (`apps/web/src/voice/speech.ts:88-94`), so it goes on as the sign-in page shows. No
shared hook changes.

**Speech interruptions.** An `interrupted` that Audio Mode did not cause, as when a call or a
navigation prompt takes the audio, backs off and resumes from the sentence it cut, as the table
says. Whether Android reports `interrupted` when another app takes audio focus is a question for the
plan's device spike.

## The recording step

Drawn out of `useDictation`'s `start` and its recorder handling
(`apps/web/src/voice/Dictation.tsx:215-297`, `:159-165`), with `recorderType`
(`Dictation.tsx:44-52`), `microphoneProblem` (`Dictation.tsx:86-93`) and the caps
(`Dictation.tsx:27-32`) moving with it into `apps/web/src/voice/recording.ts`:

```ts
export interface Take {
  blob: Blob;
  type: string;
}

// Why a recording ended: stopped by its caller, at its cap, or by the
// microphone's track ending, as when another app takes it.
export type Ending = "stopped" | "limit" | "ended";

export interface Recording {
  // The live stream, for a level monitor; its tracks stop when the take does.
  stream: MediaStream;
  started: number;
  // Begins recording, for a caller that opened the microphone first and
  // records after a tone; startRecording begins at once unless told not to.
  record(): void;
  // Stops and gives the take; drop stops and gives none.
  stop(): void;
  drop(): void;
  // Settles once: the take and why it ended, or undefined when dropped.
  done: Promise<{ take: Take; ending: Ending } | undefined>;
}

export class MicrophoneError extends Error {
  constructor(readonly kind: "cannot-record" | "refused" | "missing" | "failed" | "hidden") {
    super(`the microphone could not start: ${kind}`);
  }
}

// startRecording opens the microphone and starts one take, or rejects with a
// MicrophoneError: a page hidden as the microphone opens starts none.
// Aborting signal drops the take.
export function startRecording(options: {
  constraints: boolean | MediaTrackConstraints;
  limit: number;
  byteLimit: number;
  deferred?: boolean;
  signal?: AbortSignal;
}): Promise<Recording>;
```

- **Caps.** The step enforces its own `limit` and `byteLimit`, as dictation's timer and data handler
  do today (`Dictation.tsx:261-279`), and ends the take as `limit`. Audio Mode's speech window, gap
  and turn cap are the level monitor's, which calls `stop()` or `drop()`.
- **What stays with the callers.** `useDictation` keeps its call to `stopSpeaking`
  (`Dictation.tsx:216`) before it starts, and its hide effect (`Dictation.tsx:299-309`), which stops
  and transcribes; Audio Mode never records while speaking, and drops on hide.
- **Dictation.** It keeps its phases, focus, controls, Retry and the transcription call. Its `start`
  becomes `startRecording({ constraints: true, limit: recordingLimit, byteLimit })`, mapping a
  `MicrophoneError` to the notice `microphoneProblem` gives today, drawing its clock from `started`,
  and passing `done`'s take to `transcribe` (`Dictation.tsx:173-213`) unless it was dropped. Its
  hide and unmount effects call `stop()` and `drop()` where they call `finish(false)` and
  `finish(true)` today.
- **Tests.** Dictation's tests stay unchanged, the proof the step was drawn out without a change in
  behavior. The shared fake track in `apps/web/src/test-support.tsx:466-473` may change: it gains
  `addEventListener` and `removeEventListener`, and a way to fire `ended`, since the step listens
  for the track ending. That is test support, not a dictation test.

## Keeping a reply

With drafts kept in the browser (agention#70), `apps/web/src/device.ts` on that branch gives
`KeptDraft` (`:124-130`), `readDraft` (`:191-193`), `signOutMark` (`:197-199`) and `keepDraft`
(`:206-238`). Audio Mode reads `signOutMark()` as its view opens and keeps a reply so:

```ts
const kept = readDraft(thread);
const text =
  kept === undefined || kept.text.trim() === "" ? reply : `${kept.text.trimEnd()}\n\n${reply}`;
const record = keepDraft(
  thread,
  {
    text,
    detail: kept?.detail ?? "",
    // The draft's stale check counts from the oldest message any of its text
    // was written against.
    basis: kept === undefined ? shown : Math.min(kept.basis, shown),
    leftBehind: kept?.leftBehind ?? false,
  },
  mark,
);
```

`shown` is the item's last message read. When `keepDraft` keeps nothing, as after a sign-out or with
storage refused, the words are `Your reply could not be kept.`. The reply comes back as composer
text when the thread is next opened, not as an answer to the ask; the guide says so. A composer open
on the same thread in another tab rewrites the record with its own text when it next keeps, so the
guide says a kept reply comes back in a thread not open elsewhere.

## `speak` (delivery 1)

`speak` (`apps/web/src/voice/speech.ts:115-153`) keeps its arguments and its one flat list, reads
the voice and rate from the device choices as it speaks, and returns a promise that settles once:

```ts
export type Spoken =
  | { outcome: "spoken" }
  | { outcome: "stopped" } // stopSpeaking, or another speak, took over
  | { outcome: "failed"; reason: SpeechSynthesisErrorCode | "unavailable" | "stalled" };

export function speak(key: string, sentences: string[]): Promise<Spoken>;
```

- `spoken` when the last sentence's `end` fires; an empty list is `spoken` at once.
- `stopped` when `stopSpeaking` (`speech.ts:104-113`) or a later `speak` raised the reading number
  first; the own-number checks that make a stopped reading's events do nothing (`speech.ts:123-129`,
  `:143-146`) are where it settles.
- `failed` with the utterance's error when one fails while it is still the current reading.
  `interrupted` and `canceled` that Agention did not cause are failures now; read aloud's screen
  state treats them as quiet, as today.
- **Long sentences are split.** A sentence that would take more than about 12 s at the chosen rate,
  more than `12 x 14 x rate` characters at 14 characters a second, is split at the last comma before
  that length, else the last space, else at the length. Chrome's network voices stop after about 15
  seconds with no event (prior-art research, section 2).
- **The watchdog.** An utterance that has not started 10 s after `speak()` is called on it, or has
  not ended `2 x characters / (14 x min(rate, 1))` seconds plus 2 s after its `start` event, is
  cancelled and settles `failed` with `stalled`. `min(rate, 1)` keeps a fast rate the engine clamps
  from making the deadline too short. Both deadlines are starting values.
- **`wordsOf` options.** `wordsOf(message, { detail, asks })` (`speech.ts:68-87`), both on by
  default as today, lets Audio Mode leave out a message's detail and asks.

The promise, the split and the watchdog ship in delivery 1, where read aloud gains them.

## The writer, per item

`useWriter` (`apps/web/src/views/thread/writer.ts:365-479`) is bound to one thread, and its
`attempt` (`writer.ts:371`) keeps a request id across calls while content and `shown` allow it, so
one hook moved from thread to thread could reuse an unfinished attempt's id for the next thread's
write of equal content. The view renders the item as a child keyed by agent, session, thread number
and ask, which holds its own `useWriter` and hands the loop `write` and `readAndWrite` for that item
only. They reach the loop through refs refreshed on every render, so the loop always calls the
current closures, whose `missed` and CSRF token are the latest. `onWritten` refreshes the queue.

## Its own sounds

Both from the one `AudioContext`, with a 10 ms attack and a 40 ms release on a gain of 0.2:

- **Prompt tone**: a sine rising from 440 to 660 Hz over 150 ms.
- **Listen tone**: an 880 Hz sine for 80 ms, right before listening.

## Words, from one table

`apps/web/src/audio/words.ts` holds every utterance as a kind and its data, such as
`{ kind: "readBack", question, labels }` or `{ kind: "stale", ask, change }`, and renders each to
its sentences in one place. The loop emits kinds and data, never sentences, so tests assert those,
and the words themselves are reviewed in one table.

## Testing

- **Grammar**: normalization, every number word and homophone, fillers, deduplication before the
  several-picks check, "one to three" with and without `multiple`, ranges, and "send" only whole.
- **Level**: a fake `AnalyserNode` feeding frames: the floor's lowest window and its guard, the
  threshold, the gaps, each cap, and a turn with no speech never uploading.
- **Loop**: every row of the state and failure tables, with fake speak, record, transcribe, write,
  draft, load and clock, asserting utterance kinds and data; that only `confirming` reaches
  `sending`; that no recording starts while speech is unsettled; the reply rule on every exit; the
  unknown outcome held until the reload settles it.
- **`speak`**: each outcome with a fake `speechSynthesis`, the split, and both watchdog deadlines
  with a fake clock.
- **Recording step**: dictation's existing tests, unchanged.
- **Browser**: the HLA's project, with a recorded fake microphone and the stub provider.
