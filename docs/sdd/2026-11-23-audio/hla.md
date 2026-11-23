# Read aloud and Audio Mode: High-Level Architecture

- Status: Draft, following the FRD's draft; the FRD's open choices are built as recommended
- Date: 2026-11-23
- Requirements: [FRD](frd.md), A1 and A2, M1 to M7, E1 to E3
- Research: [prior-art research](prior-art-research.md)

Both deliveries are web UI only. The server, its routes, its settings and the content security
policy are unchanged; Audio Mode transcribes through the route dictation already uses, and every
answer it sends goes through the web UI's existing thread writer.

## Decisions at a glance

- **The browser speaks.** Read aloud and Audio Mode both use `speechSynthesis`, with the voice and
  rate chosen in this browser (A1). Nothing about speech reaches the server.
- **`speak` stays one flat list of sentences**, and returns a promise that settles when the list was
  spoken, stopped or failed. It splits a sentence too long to finish before a browser's cut-off, and
  a watchdog per utterance ends one that never finishes. "Read from here" and Audio Mode build their
  lists and call it.
- **Audio Mode is a turn loop in the browser**: speak, listen, transcribe, act. It listens only
  while it is not speaking, so it never hears itself.
- **The end of speech is told from the microphone's level** (M7, as recommended), relative to the
  noise measured as each turn starts. A turn with no speech in it is silence, decided in the
  browser, and is never uploaded.
- **Commands are matched in the browser**, the whole normalized transcript against the commands the
  current state allows. No model call and no server part.
- **Audio Mode's turns use the plain transcription route**, never the thread's: a thread's title is
  written by an agent, and on the thread's route it would reach the provider's prompt, where it
  could steer what a confirmation is heard as.
- **Confirmation is a state, never a word in content.** Only Audio Mode's own state machine can be
  waiting for "send"; text read aloud cannot put it there (M4).
- **Answers go through `useWriter`**, the web UI's thread writer, which already keeps one request id
  across retries and handles stale writes, so a send is never doubled.
- **Its own sounds are synthesized**, two short tones from a Web Audio oscillator, so no audio asset
  is added (M5).
- **Decision records:** the first delivery's new ADR supersedes ADR 0002's read aloud line, which
  gains a setting and voices that may send text off the device; the second delivery's new ADR
  records reading aloud automatically in Audio Mode and sending on a spoken confirmation, as the
  FRD's "What this changes" says.

## Delivery 1: read aloud

**Voice and rate** (A1). Two device choices beside the others in `apps/web/src/device.ts`, which
gains string and number choices readable outside React, since `speak` reads them as it speaks: a
voice by its `voiceURI` and a rate from 0.5 to 2. Settings gain a **Read aloud** section of their
own, apart from Voice, since read aloud needs no provider and no recent sign-in. It lists
`speechSynthesis.getVoices()` as they load (the list fills after `voiceschanged`), the page's
language first, marking each voice whose `localService` is false as sending text off the device,
with a sample button and the rate. With no choice, the browser's default voice and rate are used, as
today; a chosen voice the browser no longer offers falls back to the default, and Settings say so.

**Controls** (A2).

- Each message shows a read aloud button in its head, outside the options menu, which reads that
  message as read aloud does today.
- Each message's options menu offers **Read from here**: one list of sentences, each message's words
  after its author's name, from that message through the latest. When the thread shown does not
  reach the latest, the rest is loaded once, first.
- While anything is read, **Stop** stays in reach at the thread's foot, reachable by keyboard and
  named for assistive technology. Starting a recording, leaving the thread, or reading something
  else stops it, as today.

## Delivery 2: Audio Mode

**Starting and staying on** (M1). **Audio Mode** in the Threads tab's bar, shown only while a
transcription provider is configured, opens a full-screen view showing only its state ("Reading",
"Listening", "Sending") and one large **Stop**. Starting it is the user gesture the browser needs
for speech and the microphone. It holds a screen wake lock and takes it again when the page becomes
visible. Stop, "stop", leaving the view, or a failure it cannot recover from ends it and releases
the wake lock.

**What it reads** (M2, as recommended). The operator's thread list with `status=open` and
`sort=priority` and no other filter, loaded and refreshed as every list is, every 10 seconds while
visible. Each item is the most pressing open ask overall, taken after the list refreshes following
each answer. An item is the thread's title, its agent and session, the text of its unread messages
through the latest, since an answer is accepted only from a writer who has seen the latest, and the
ask's question with its suggestions numbered from one. An ask skipped with "next" is set aside for
the rest of the run; one met with silence three times is passed over and offered again after the
others. When nothing is left it says so once, with how many passed asks are waiting, and announces
new asks as the list gains them.

**The turn loop.**

```text
prompt tone, then read the item (device voice)
  -> listen tone -> record until silence (level-based) -> plain transcription route -> text
  -> match a command
       number(s) / reply / decline -> prompt tone, read the answer back
                                      -> listen tone -> "send"? -> useWriter
       detail / repeat / next      -> act, back to read
       stop                        -> end
       not understood              -> prompt tone, say so, listen again
```

**Listening.** A plain recording step is drawn out of `useDictation`
(`apps/web/src/voice/Dictation.tsx`), so dictation and Audio Mode share one recorder rather than
two. The microphone opens for each turn and closes after it, as E2 says; a short device spike before
building the loop measures what opening it each turn costs on the operator's phone, including with
car Bluetooth audio. A Web Audio `AnalyserNode` measures loudness against the noise in the turn's
first moment; a turn ends about a second after speech stops, or at a cap: a few seconds for a
command, a minute for a reply.

**Commands** (M3). The transcript is normalized (case, punctuation, number words to digits) and the
whole of it is matched against what the current state allows: one or more numbers where the ask has
suggestions, several only where it takes several, mapped from one-based to the API's picks; "reply",
then a turn for the text; "decline", "detail", "repeat", "next" and "stop". Anything else is "not
understood".

**Confirmation** (M4). The answer is built first, then read back from it with the ask's question and
each picked suggestion's label. The loop waits, in its own state, for one more turn: the whole
transcript "send" sends; anything else or silence cancels. A cancelled reply's text is added to the
thread's browser draft after any text already there, with the draft's basis the lower of an existing
draft's and the last message read; it comes back as composer text, not as an answer to the ask,
which the guide says.

**Sending and failures** (M6). The answer goes through `useWriter`, with `seen_through` the last
message read aloud. A stale answer, which also covers an ask answered, withdrawn or replaced
elsewhere, comes back with the messages that arrived; Audio Mode reads them and offers the ask again
if it is still open; when more arrived than one page holds, the next send is stale again and reads
the rest. A send with no answer says the answer may not have been sent and returns to the
confirmation, where "send" tries again under the same request id, so it is never sent twice. Each
other failure is said, with whether anything was sent:

- an utterance that ends without Audio Mode stopping it, or never ends, which `speak`'s watchdog
  catches, as when a call or a navigation prompt takes the audio; Audio Mode backs off and resumes,
  and ends only after repeated failures;
- the page hidden mid-turn, which stops listening and drops the turn, said on return;
- the microphone taken away, or a transcription that fails;
- the sign-in refused, said as the page returns to sign-in.

**Its own voice** (M5). A rising tone before each of Audio Mode's own prompts, and a short higher
tone right before it records, synthesized with an oscillator.

## Data and contracts

No server change: no route, table, setting or policy. The web UI keeps two new device choices. Audio
Mode needs drafts kept in the browser (agention#70) for a cancelled reply, so the second delivery
stacks on it or follows it; it uses the plain transcription route, which is on main.

## Security model additions

- **What reaches the transcription provider**: in Audio Mode, each turn's recording with speech in
  it, including anything else audible then, such as passengers or a radio; Settings and the guide
  say so. Never a thread's title or names, which Audio Mode does not send.
- **What is confirmed**: only Audio Mode's own state leads to a send, and what is read back is the
  answer exactly as it will be sent. A provider can mishear the confirmation; it cannot choose what
  is confirmed. SECURITY.md states this in place of its "never in a thread" line.
- **Voices that send text away** are marked from the browser's own `localService` report, and
  SECURITY.md's read aloud paragraph says such a voice sends what is read to its vendor.

## Testing

- **Unit (Vitest, jsdom):** `speak`'s promise with a fake `speechSynthesis`; the voice choice and
  its fallback; the command grammar over transcripts; the turn loop as a state machine with fake
  speech, recorder, level and clock, covering each failure above and confirmation by the whole
  transcript only.
- **Browser (Chromium, Playwright):** a project of its own launching Chromium with a recorded
  utterance as the fake microphone, so the level check sees speech start and end; the stub
  transcription provider scripted per turn; speech stubbed with an init script whose utterances end;
  caps short through a test seam. It drives an ask read, answered by number, confirmed and sent; a
  cancelled reply added to the draft; a stale send re-offered. It earns its own project because the
  end of speech is the riskiest mechanism, and only a real microphone stream in Chromium proves the
  level wiring that unit tests fake. The file is played with `%noloop`
  (`--use-file-for-fake-audio-capture=<file>%noloop`), which restarts it for each `getUserMedia`
  stream: checked in Chromium's headless shell 1255, where a tone 1 s into the file was first heard
  about 1,035 ms into each of three streams in turn. Since each turn opens its own stream, every
  turn hears the file from its start, so the file opens with silence longer than the listen tone,
  the output latency and the noise floor's window together, about 1 s.
- **Devices (operator):** read aloud with a chosen voice in Edge on Windows and on Android; Audio
  Mode on the mounted phone, per the FRD's definition of done.

## Open with the operator

The FRD's choices. Each other answer changes this design only locally:

- **Provider speech now:** a third delivery with a speech provider setting, a server route that
  speaks a stored message by reference, `<audio>` playback with Media Session, and screen-off use.
- **Asks, then messages, or everything:** the queue's source query, and whether hearing marks read.
- **A speech-detection library:** replaces the level check; adds `'wasm-unsafe-eval'` to
  `script-src` and a pinned dependency.
- **Marking voice answers:** a plain note appended to a reply sent from Audio Mode.
