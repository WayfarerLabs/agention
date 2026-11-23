<!-- cspell:ignore aai alaw ASR autoplay bargein bargeintype Chirp Cortana Deepgram DTMF ElevenLabs Firstname Groq hotword keyterm keyterms Kokoro Lastname mulaw NHTSA OHF ONNX onnxruntime Orpheus PhET phetsims Picovoice playout readback Readium remsky ricky0123 Silero Siri speaches ulaw VoiceXML -->

# Audio research: provider speech, browser playback, Audio Mode, streaming transcription

Prior-art research for agention#37: better read aloud, and a hands-free Audio Mode. Researched
2026-11-23. Model names, prices and APIs were read from official pages on that date.

**Grading key** (used inline as (A), (B), (C), and in the sources table):

- **A**: official spec, vendor documentation, vendor source code, or registry data.
- **B**: vendor engineering blog or announcement, browser intent threads, reputable tech press.
- **C**: forum, Q&A, third-party blog or tutorial.
- A source read only through a search summary, not on its own page, is graded C whatever it is.

Source numbers like (S12) refer to the sources table at the end. Where a finding is an inference
rather than something a source states, it says so.

## Executive summary

- **OpenAI is retiring its whole `POST /audio/speech` line.** `tts-1`, `tts-1-hd` and every
  `gpt-4o-mini-tts` snapshot shut down on 2027-01-06 (S2) (A). The named replacement,
  `gpt-realtime-2.1-mini`, is a Realtime speech-to-speech model whose model page marks
  `v1/audio/speech` "Not supported" (S5) (A). An OpenAI text-to-speech preset shipped now would stop
  working about six weeks later.
- **The interface outlives OpenAI's models.** AssemblyAI launched an OpenAI-compatible
  `/audio/speech` in November 2026 (USD 15 per 1M characters, up to 5,000 characters, SSE streaming)
  (S12) (B). Groq serves Orpheus on the same path (USD 22 per 1M characters, 200 characters a
  request, WAV only) (S9, S10) (A). Kokoro-FastAPI (Apache-2.0, v0.10.0 of 2026-11-08) serves it
  self-hosted (S13) (A). Limits, formats and voices differ per provider, so the server has to split
  text to each provider's input cap and pick a format each one accepts.
- **On-device speech can sound much better with no server at all.** Agention's read aloud speaks in
  the browser's default voice at the default rate, one sentence per utterance
  (`apps/web/src/voice/speech.ts:118-160`). Edge on Windows offers cloud "Online (Natural)" voices
  to any page through `speechSynthesis` (S23, S20). Choosing a voice and a rate is a cheap first
  step. Those voices send the text to Microsoft's service (S23) (A), and Chrome's "Google" voices
  need the network (S20) (C).
- **`speechSynthesis` is a poor base for screen-off use.** Chrome's Google voices stop after about
  14 seconds with no end event, and the usual pause and resume workaround breaks on Android (S20,
  S21) (C). Speech synthesis is not a media element, so it gets no media notification or lock-screen
  controls (inference from S31). An `<audio>` element does: Chromium keeps audio-only media playing
  in a hidden page on Android (S28) (A). Media Session then gives headset keys, and a media
  notification with lock-screen controls for media of five seconds or longer (S30, S31).
- **The CSP shapes the playback design.** Agention's policy is `media-src 'self'`
  (`apps/server/src/http/app.ts:40-45`). CSP 3 says `'self'` never matches a `blob:` URL (S29) (A).
  Playing a same-origin URL that the server streams needs no policy change. A blob or MediaSource
  URL needs `media-src blob:`.
- **Realtime transcription exists, but the relay is the hard part.** OpenAI's `gpt-live-transcribe`
  (USD 0.017 a minute) runs over a WebSocket at `/v1/realtime?intent=transcription`. It takes 24 kHz
  PCM and has no server VAD, so the client must detect end of speech (S49, S51) (A). Agention has no
  WebSocket server today, and Node has only a WebSocket client (S35) (A). Browser streaming uploads
  need HTTP/2 and return no response until the upload ends (S34) (A).
- **Client secrets would bend ruling 1.** OpenAI's `ek_` secrets live 10 minutes by default and up
  to 2 hours. Each "can be used to create multiple sessions until it expires" (S52) (A). AssemblyAI
  tokens are reusable within their window too (S54) (A). Using them puts a reusable, billable
  credential and a provider origin into the browser.
- **A small command set does not need a streaming model.** On-device Web Speech recognition is not
  available on Android (S58) (B). Porcupine has no personal free tier (S61) (A). The simplest path
  is on-device voice activity detection (Silero through `@ricky0123/vad-web`, ISC, 0.0.31 (S60) (A))
  that cuts each utterance and sends it through the existing `/transcriptions` relay. The browser
  then matches the text against a short grammar. It needs `'wasm-unsafe-eval'` in `script-src`
  (inference: ONNX Runtime Web is WebAssembly, and the policy today is `script-src 'self'`).
- **Every hands-free messaging product confirms before sending.** Android Auto, Gemini and Siri read
  the reply back and ask before they send it (S38, S39, S41) (A). Apple offers an opt-out (S41) (A).
  Android Auto recognizes commands only when they "follow one of the patterned sequences" (S38) (A).
  Outlook's retired Play My Emails listened after each message for "Reply, Next, Previous, Skip,
  Pause, Resume, Archive, Flag" (S44) (B).
- **Distraction guidance is visual-manual and voluntary.** NHTSA's Phase 1 guidelines set 2-second
  glances and 12 seconds in total, and lock out scrolling text and manual text entry. They are
  "nonbinding" and leave auditory-vocal interfaces to a later phase (S46) (A). Android for Cars bars
  long-form messaging apps such as email (MF-4) and accepts only native apps (S37, S36) (A).
  Agention cannot be an Android Auto app. Audio Mode would run on the phone's own browser.
- **Barge-in needs echo cancellation of the page's own playback.** Chrome's intent to ship
  `echoCancellation: "all"` (remove all system playout from the microphone) targets Chrome 141 on
  every platform, including Android (S62) (B). A 2019 W3C list comment, seen only in a search
  summary (C), reports that Chrome's canceller used to consider only WebRTC peer audio. Half-duplex
  turn-taking or push-to-talk avoids the need.
- **Keeping the microphone live with the screen off on Android Chrome is unverified.** Reports
  conflict and no official statement was found. It needs a test on the operator's phone before the
  design depends on it (see Open questions).

## 1. Provider text-to-speech over `POST /audio/speech`

### 1.1 OpenAI

- **Models and shutdown.** The speech endpoint accepts `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` and
  `gpt-4o-mini-tts-2025-12-15`. All four are deprecated, with notice on 2026-10-01 and shutdown on
  2027-01-06 (S2, S3) (A). The model page lists both `gpt-4o-mini-tts` snapshots as deprecated (S6)
  (A). The guide says "`gpt-realtime-2.1-mini` isn't a supported model for `/v1/audio/speech`" (S1)
  (A). The model page lists only `v1/realtime` as supported (S5) (A).
  - **Design implication:** do not offer OpenAI as a text-to-speech preset or default. If the
    operator's own OpenAI-compatible server is offered, the model name stays free text.
- **Voices.** There are 13 built-in voices: alloy, ash, ballad, coral, echo, fable, onyx, nova,
  sage, shimmer, verse, marin and cedar. The guide recommends `marin` or `cedar`, and says voices
  are "currently optimized for English". The `tts-1` models take only nine of them (S1, S3) (A).
  Custom voices take an `{ "id": ... }` object (S3) (A).
  - **Design implication:** voice is a provider-specific string; a preset can suggest a default
    voice but must not validate against a fixed list.
- **Request shape.** `input` is at most 4,096 characters. `response_format` is mp3 (the default),
  opus, aac, flac, wav or pcm (24 kHz, 16-bit little-endian, no header). `speed` runs from 0.25 to
  4.0. `stream_format` is `audio` (the default) or `sse`, and `sse` is not supported on the `tts-1`
  models. `instructions` (up to 4,096 characters) is ignored by the `tts-1` models (S3) (A).
  - **Design implication:** the request Agention builds is model, voice, input, format and speed.
    `instructions` and `sse` are optional extras that some providers ignore or refuse.
- **Streaming and latency.** Responses use chunked transfer encoding so "playback can begin before
  the full file is generated". The guide recommends `wav` or `pcm` "for the fastest response times"
  (S1) (A). No latency figure is published.
  - **Design implication:** a server route can pipe the provider's body to the browser as it
    arrives. Measured time to first audio belongs in the live test, not in a design promise.
- **Price.** `tts-1` costs USD 15 per 1M characters and `tts-1-hd` USD 30. `gpt-4o-mini-tts` costs
  USD 0.60 per 1M text input tokens and USD 12 per 1M audio output tokens. The pricing pages give no
  per-minute estimate for it (S4, S6) (A).
- **Data.** `/v1/audio/speech` keeps abuse-monitoring logs for 30 days, has no application state, is
  eligible for Zero Data Retention, and is not used for training by default (S7) (A).
- **Disclosure.** "Our usage policies require you to provide a clear disclosure to end users that
  the TTS voice they are hearing is AI-generated" (S1) (A).
  - **Design implication:** with one operator who configured the provider, Settings saying the voice
    is generated meets the spirit. It matters only if an OpenAI model is ever used.
- **GPT-Live-1.** OpenAI launched a full-duplex voice model on 2026-09-10 at USD 0.05 a minute "for
  the front-end voice layer". It listens and speaks in one model, paired with a backend model of the
  developer's choice (S8) (B). The announcement does not say whether it can simply speak supplied
  text.
  - **Design implication:** this is a conversational agent layer, not read aloud. It is out of scope
    for this effort.

### 1.2 Other hosted providers on the same interface

- **AssemblyAI.** The text-to-speech API "answers the same `POST /audio/speech` request shape under
  its own base URL", `https://tts.us.assemblyai.com/v1/openai`, with an EU host as well (S12) (B).
  - Models are `assemblyai-tts-1` or per-language `assemblyai-tts-en`, `-es` and so on. OpenAI model
    names are rejected.
  - OpenAI English voice names map to its own (alloy becomes aai-jane).
  - `input` takes 1 to 5,000 code points. Formats are mp3, pcm, wav, mulaw and alaw; opus, aac and
    flac are refused.
  - `speed` must be 1, and `instructions` is ignored.
  - `stream_format: "sse"` returns `speech.audio.delta` events.
  - It costs USD 15 per 1M input characters (S12, S55) (B, A).
  - The pages read state no retention policy.
  - **Design implication:** the closest drop-in for an OpenAI-shaped request, at OpenAI's `tts-1`
    price. Its host differs from AssemblyAI's speech-to-text host, so text-to-speech needs its own
    base URL, not the transcription one.
- **Groq.** The path is `https://api.groq.com/openai/v1/audio/speech` (S9) (A). The models are
  `canopylabs/orpheus-v1-english` and `canopylabs/orpheus-arabic-saudi`. The English voices are
  autumn, diana, hannah, austin, daniel and troy. Input is at most 200 characters, and "The only
  supported format is "wav"". Bracketed directions such as `[cheerful]` steer delivery. English
  costs USD 22 per 1M characters (S10) (A). Streaming is not documented. Groq keeps no inference
  data by default, keeps troubleshooting logs up to 30 days, and offers a Zero Data Retention toggle
  (S11) (A).
  - **Design implication:** 200 characters means one request per sentence or less, and WAV is
    several times larger than MP3 to relay (inference from the bit rates). A per-provider input cap
    and format are part of the preset, not constants.
- **Providers with their own interface.** Deepgram uses `POST /v1/speak?model=aura-2-...` with
  `Authorization: Token`, caps Aura input at 2,000 characters, and charges USD 0.030 per 1K
  characters for Aura-2 (S16, S17) (A). ElevenLabs uses `POST /v1/text-to-speech/{voice_id}` with an
  `xi-api-key` header, and `enable_logging` defaults to true (S18) (A). Google Cloud and Azure have
  their own APIs as well; their prices were not verified here.
  - **Design implication:** as with transcription (ruling 4), each would need its own client
    implementation. None is needed to ship.

### 1.3 Self-hosted servers

- **Kokoro-FastAPI.** Apache-2.0, release v0.10.0 on 2026-11-08 (S13) (A). It serves
  `POST /v1/audio/speech` with mp3, wav, opus, flac, aac and pcm, streaming, voice listing at
  `/v1/audio/voices`, and weighted voice mixes. There are CPU images for amd64 and arm64. The author
  measures about 300 ms to first audio on a 4060 Ti GPU, about 3.5 s on an older i7 CPU and under 1
  s on an M3 Pro (S13) (A, author's own hardware).
  - **Design implication:** the "operator's own server" option covers it with no extra code. CPU
    latency on a small home server may be seconds, so the UI should show that speech is loading.
- **speaches.** MIT. It serves `/v1/audio/speech` with Kokoro (`speaches-ai/Kokoro-82M-v1.0-ONNX`),
  but not opus or aac (S14) (A). Its latest release is `v0.9.0-rc.3` from 2025-12-27, a release
  candidate (S14) (A).
  - **Design implication:** compatible, but the format list shows why the format must be
    configurable: an opus default would fail here.
- **Piper.** Development moved to `OHF-Voice/piper1-gpl` (GPL-3.0, v1.8.0 on 2026-09-04). Its HTTP
  server is `POST /synthesize` with `text`, `voice` and `length_scale`, returning WAV. It is not
  OpenAI-compatible (S15) (A).
  - **Design implication:** reachable only through a wrapper such as speaches. Running it as a
    separate process keeps its GPL terms away from Agention's code.

## 2. On-device `speechSynthesis` on Android Chrome and Windows Edge and Chrome

- **The API allows voice and rate.** `rate` is relative to the voice's default, from 0.1 to 10, and
  engines may clamp it further. `localService` is false for voices "supplied by a remote speech
  synthesizer service". `pause()` pauses "mid-utterance" (S19) (A). Agention sets only `lang`
  (`apps/web/src/voice/speech.ts:118-160`).
  - **Design implication:** a remembered voice and rate per device is the cheapest quality win. It
    is a device preference, since voice lists differ per browser.
- **Edge on Windows has cloud natural voices.** Edge's `ConfigureOnlineTextToSpeech` policy says
  pages using `SpeechSynthesis` can use "Online Text to Speech voice fonts, part of Azure Cognitive
  Services", which "are higher quality than the pre-installed system voice fonts". The policy does
  not apply on Android (S23) (A). Microsoft announced them for `SpeechSynthesis` in 2019 (S24) (B).
  A third-party survey counts "over 250 preloaded voices across 75 languages", needing network
  access, without pitch control (S20) (C). An Edge 150 forum thread reports natural voice names
  reading "undefined" until an update (S25) (C).
  - **Design implication:** on Edge, preferring a voice whose name contains "Natural" likely answers
    most of "robotic". Inference: the default on Windows Chrome is probably an older local Microsoft
    voice. Settings should say that these voices send the text to Microsoft.
- **Chrome desktop's Google voices are network voices with a cut-off.** They "require online
  access", "do not return boundary events", and stop when an utterance "takes longer than 14
  seconds" (S20) (C). The PhET project saw Google voices on Windows Chromium "simply stop after 15
  seconds", and "we never get end or cancel events". Its pause and resume workaround "breaks for
  Android chrome" (S21) (C).
  - **Design implication:** keep chunking. A paragraph under about 14 seconds would cut the gaps
    between sentences, which may be part of "slow". Do not use the pause and resume workaround.
- **Android Chrome lists languages, not voices.** Chrome on Android "doesn't return the list of
  voices available to the users" and returns languages instead, including ones without a voice pack
  installed. It marks no `default` (S20) (C). The system engine sets the voice, and Android's engine
  caps the input length of one `speak` call (S59) (A).
  - **Design implication:** a voice picker on Android is of little use. Rate is the control that
    matters there, along with pointing the operator to Android's own text-to-speech settings.
- **Activation.** Chrome made `speak()` fail with `not-allowed` unless the frame "has ever had user
  activation" (sticky), from M71 (S22) (B).
  - **Design implication:** Audio Mode can speak newly arrived messages without a fresh tap, as long
    as the operator tapped once on the page to start it.
- **Screen off.** No source says whether a page's `speechSynthesis` keeps speaking with the screen
  off or the tab hidden on Android Chrome. Chrome's own "Listen to this page" gained background
  playback in Chrome 130, but that is a browser feature, not the web API (search summary only,
  ungraded). Speech synthesis is not a media element, so Media Session gives it no notification
  (inference from S31).
  - **Design implication:** treat on-device speech as foreground-only until tested on the operator's
    phone. Screen-off Audio Mode should play provider audio through an `<audio>` element.

## 3. Playing audio in the browser

- **Background playback on Android.** Chromium's `ShouldPausePlaybackWhenHidden` says "Audio only
  stream is allowed to play when in background", unless it is muted (S28) (A). Pages "playing audio"
  are not discarded "unless under extreme resource constraints" (S27) (A). Frozen pages run no
  timers or fetch callbacks (S27) (A).
  - **Design implication:** an `<audio>` element that is playing keeps the page alive with the
    screen off. In the gaps between messages nothing is playing. Whether the page is frozen then,
    and so misses the next message, must be tested.
- **Media Session.** It shows metadata on notifications and lock screens, and routes hardware and
  headset keys to `play`, `pause`, `previoustrack`, `nexttrack`, `seekbackward` and `seekforward`
  handlers (S30) (A). Chrome for Android shows a media notification only for media of 5 seconds or
  longer. Web Audio "doesn't request Android Audio Focus"; it works only through an `<audio>`
  element (S31) (B).
  - **Design implication:** map headset and lock-screen keys onto Audio Mode: play or pause, next
    message, previous message. That is hands-free control with no microphone at all. Very short
    clips will not raise the notification.
- **Autoplay.** Chrome allows sound without a gesture once "the user has interacted with the
  domain", or when the site was "added to their home screen" on mobile or installed as a PWA on
  desktop. Web Audio is covered too. A rejected `play()` promise tells the page autoplay was refused
  (S26) (B).
  - **Design implication:** start Audio Mode with a tap, and handle a rejected `play()` by showing a
    play control. Installing Agention as a PWA on the phone helps.
- **Screen Wake Lock.** It keeps the screen from dimming or locking. A lock is released when the
  page "becomes inactive" or is not visible, and can be refused in power-save mode (S32) (A).
  - **Design implication:** good for a screen-on mode on a phone mount. It does nothing for
    screen-off use, and there is no web CPU wake lock.
- **CSP.** Under CSP 3, "If url's scheme is "blob", return "Does Not Match"" for `'self'`. Any other
  non-HTTP(S) scheme must be listed explicitly (S29) (A). Agention's `media-src 'self'` therefore
  blocks blob and MediaSource URLs today (`apps/server/src/http/app.ts:40-45`).
  - **Design implication:** prefer `<audio src>` pointing at a same-origin route, which needs no
    policy change. A route keyed by message, not by text in the query string, keeps message text out
    of URLs and access logs.
- **Streaming formats.** MSE has a byte-stream format for MPEG audio (`audio/mpeg`), with no
  `codecs` parameter (S33) (A). Plain progressive playback of a chunked MP3 response needs no MSE.
  - **Design implication:** MP3 from the provider, relayed as it arrives to an `<audio>` element,
    streams without MSE or blob URLs. Whether Chrome's MSE accepts Ogg Opus was not verified.
- **Upload streaming.** Chrome streams request bodies only with `duplex: "half"`, rejects HTTP/1.x,
  and "the response never becomes available until the request body has been fully sent" (S34) (A).
  - **Design implication:** a fetch upload cannot carry live microphone audio and return partial
    transcripts on the same request. Live partials need a WebSocket, or separate requests per
    utterance.

## 4. Audio Mode prior art

- **Android Auto messaging.** Apps post `MessagingStyle` notifications with a reply action
  (`SEMANTIC_ACTION_REPLY`, one `RemoteInput`, no UI) and a mark-as-read action (S36) (A). Android
  Auto reads them aloud, and puts the transcribed voice reply into the reply action (S36) (A). The
  design guide's exchange is "Reply!", "What's the message?", dictation, a readback with the
  recipient, "Do you want to send it?", "Yes!", "Message sent to Firstname Lastname". Commands work
  "only when they follow one of the patterned sequences" (S38) (A). The help page says the assistant
  "repeats your message and asks if you're ready to send it", and you can say send, cancel or ask
  for a change (S39) (A).
  - **Design implication:** a small state machine (listening for a command, taking a reply,
    confirming) with each state's grammar short and explicit. Sending is always a separate confirmed
    step.
- **Gemini in the car.** Gemini replaced Assistant in Android Auto in November 2025. When several
  messages arrive it "can summarize them", and a reply can be adjusted mid-request ("add my ETA")
  (S40) (B).
  - **Design implication:** summarizing a backlog is prior art for "read me what's waiting". In
    Agention that would mean reading thread titles and open asks before full messages, not an LLM
    summary.
- **Siri announce and CarPlay.** Siri announces notifications on supported headphones and in
  CarPlay. "Siri repeats what you said, then asks for confirmation before sending your reply", and
  "Reply Without Confirmation" skips that (S41) (A). CarPlay has the matching setting (S42) (A).
  - **Design implication:** confirm by default. An opt-out is an operator preference to rule on, not
    a default.
- **Outlook Play My Emails** (retired with Cortana; its command page is gone (S45) (A)). It read up
  to 30 unread emails from the past day, with threads oldest first. It flagged emails with
  attachments, links or graphics as better read on a screen, and listened after each message for
  "Reply, Next, Previous, Skip, Pause, Resume, Archive, Flag", plus Delete, Exit and mark as read or
  unread (S44) (B).
  - **Design implication:** the closest prior art to a voice-first inbox. Agention's equivalent of
    better read on a screen is a message with a diagram, code or attachment; read aloud already says
    "Diagram." and "Code block." for those.
- **Google Assistant driving mode** is gone: its dashboard went in 2022, its launcher in 2024, and
  the Maps bar in April 2025 (S43) (B; the earlier dates come from press coverage seen in search).
  It is not live prior art.
- **Barge-in.** VoiceXML 2.0 lets a user "interrupt, or "bargein" on, a prompt using speech". With
  `bargeintype` `speech`, "the prompt will be stopped as soon as speech" is detected, and with
  `hotword` it "will not be stopped until a complete match of an active grammar is detected" (S47)
  (A).
  - **Design implication:** stopping on any speech is fragile with car noise and radio. Stopping
    only on a recognized command (hotword style), or on a headset key, is more robust.
- **Echo cancellation for barge-in.** Chrome's `echoCancellation` gained `"all"`, which removes the
  whole system playout from the microphone, and `"remote-only"`, which removes only PeerConnection
  audio. It targets Chrome 141 on Windows, Mac, Linux, ChromeOS and Android (S62) (B). MDN marks
  both values experimental (S63) (C, read only through a search summary).
  - **Design implication:** listening while Agention speaks needs `echoCancellation: "all"` and a
    device test. Half-duplex (do not listen while speaking) is the safe first version.
- **Distraction guidance.** NHTSA's Phase 1 guidelines target "glances away from the roadway of 2
  seconds or less" and "12 seconds or less" in total. They lock out "displaying automatically
  scrolling text", "manual text entry for the purpose of text-based messaging" and displaying web
  text for reading. They are "nonbinding, voluntary", and auditory-vocal interfaces were left to
  Phase 3 (S46) (A). Android for Cars requires messaging apps to be short-form; "Long-form messaging
  apps, such as apps for email, are not permitted" (MF-4). Communication apps must not show
  scrolling text (ST-1) (S37) (A).
  - **Design implication:** Agention is not a car app and should not claim to be safe while driving.
    An honest Audio Mode is fully eyes-free once started: no reading, no typing, large controls, and
    nothing that needs a glance to continue.

## 5. Streaming transcription

- **OpenAI file transcription.** `gpt-transcribe` (USD 0.0045 a minute) is the recommended model for
  recorded speech, and it is what Agention's OpenAI preset uses
  (`packages/api/src/settings.ts:153-159`). With `stream=true` it returns `transcript.text.delta`
  events and then `transcript.text.done`, with no Realtime session (S48, S50) (A). `whisper-1`,
  `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` shut down on 2027-02-26 (S2) (A).
  - **Design implication:** dictation already uses the surviving model. Streaming the relay's
    response gives earlier text for long dictation with no new transport.
- **OpenAI realtime transcription.** The WebSocket URL is
  `wss://api.openai.com/v1/realtime?intent=transcription`, with `session.update` setting
  `"type": "transcription"` (S49) (A).
  - Input is `audio/pcm` at 24,000 Hz, sent as base64 `input_audio_buffer.append` chunks.
  - `gpt-live-transcribe` does not support `server_vad` or `semantic_vad`. The client detects end of
    speech and sends `input_audio_buffer.commit`.
  - Events are `...input_audio_transcription.delta` and `.completed`, matched by `item_id`.
  - Options include `prompt`, `keywords` (hint terms), `languages`, and `delay` (`minimal` to
    `xhigh`).
  - `gpt-live-transcribe` costs USD 0.017 a minute of realtime audio and works only on
    `v1/realtime/transcription_sessions` (S51) (A).
  - **Design implication:** `keywords` suits a command vocabulary. The client-side VAD it requires
    is the same component the per-utterance path needs anyway.
- **Turn detection elsewhere.** Realtime conversation sessions offer `server_vad` (threshold 0.5,
  300 ms prefix padding, 500 ms silence by default) and `semantic_vad` with `eagerness` (S52) (A).
- **Other providers.**
  - **Deepgram:** streaming Nova-3 costs USD 0.0048 a minute (promotional) and Flux USD 0.0065 (S17)
    (A). Keyterm prompting takes up to 100 terms on Nova-3 and Flux. Temporary tokens default to 30
    seconds; the reference allows 1 to 3,600 seconds, while an older FAQ says the TTL cannot be
    changed (S53) (C, read only through a search summary).
  - **AssemblyAI:** streams at `wss://streaming.assemblyai.com/v3/ws` with
    `assemblyai-stt-3-7-realtime-agent`. It accepts PCM, AAC or Ogg Opus and returns `end_of_turn`
    (S56) (A). Realtime costs USD 0.30 to 0.45 an hour, billed on session time, not audio sent, with
    keyterms included (S55) (A).
  - **Groq:** documents file transcription only (`whisper-large-v3-turbo`, USD 0.04 an hour), and
    bills a 10-second minimum per request (S57) (A).
  - **Design implication:** session-time billing (AssemblyAI) makes an open always-listening
    connection cost money while silent. Per-utterance requests cost only for speech. On Groq a
    one-word command bills as 10 seconds, still about USD 0.0001.
- **Browser-direct with ephemeral tokens.** OpenAI's `POST /v1/realtime/client_secrets` returns an
  `ek_` value that "can be used to create multiple sessions until it expires", for 10 seconds to 2
  hours (default 600). Sessions started before expiry continue past it (S52) (A). AssemblyAI tokens
  open "more than one session" until their window closes (S54) (A).
  - **Design implication:** not the key, but a bearer credential that spends the operator's money,
    sent to the browser, plus a provider origin in `connect-src`. That cuts against ruling 1 and the
    CSP, so keep the relay unless the operator rules otherwise.
- **Relayed through the server.** Node 24 has a global `WebSocket` client, stable since 22.4.0, and
  no WebSocket server (S35) (A). Agention's server has no WebSocket route or dependency today
  (`apps/server/package.json`, `hono` and `@hono/node-server` only).
  - **Design implication:** a live relay means a new dependency and a long-lived authenticated
    socket on the web mount: a real architectural step. The per-utterance alternative reuses
    `POST /transcriptions` as it is.
- **On-device options for a command set.**
  - Chrome's on-device Web Speech recognition (`processLocally`) shipped on desktop, but "Android &
    ChromeOS currently do not support on-device Web Speech" (May 2026) (S58) (B). Chrome's default
    recognizer sends audio to Google (see the voice effort's research).
  - Picovoice Porcupine runs wake words on device, but needs an AccessKey, and "there are no
    dedicated free or paid plans for personal or non-commercial use" (S61) (A).
  - `@ricky0123/vad-web` 0.0.31 (2026-09-12, ISC) runs Silero VAD on ONNX Runtime Web and gives
    `onSpeechStart` and `onSpeechEnd`, the latter with 16 kHz samples (S60) (A).
  - **Design implication:** VAD on device, then the existing relay per utterance, then exact or
    fuzzy matching of the transcript against the current state's grammar. Self-hosting the model and
    WebAssembly files keeps `connect-src 'self'`, but needs `'wasm-unsafe-eval'` in `script-src`.

## 6. Security and privacy

**What providers keep:**

| Provider and endpoint             | Kept                                                            | Training       | Source     |
| --------------------------------- | --------------------------------------------------------------- | -------------- | ---------- |
| OpenAI `/v1/audio/speech`         | 30-day abuse monitoring; ZDR eligible                           | No, by default | (S7) (A)   |
| OpenAI `/v1/audio/transcriptions` | None                                                            | No, by default | (S7) (A)   |
| OpenAI `/v1/realtime`             | 30-day abuse monitoring; ZDR eligible                           | No, by default | (S7) (A)   |
| Groq, all audio                   | None by default; troubleshooting logs up to 30 days; ZDR toggle | Not stated     | (S11) (A)  |
| ElevenLabs                        | Logging on by default (`enable_logging`)                        | Not checked    | (S18) (A)  |
| AssemblyAI                        | Not stated on the pages read                                    | Not stated     | (S12, S55) |
| Edge natural voices               | Text goes to Azure Cognitive Services; retention not stated     | Not stated     | (S23) (A)  |

- **Design implication:** provider text-to-speech is a new data flow. Today read aloud never leaves
  the device; with a provider, every message read aloud goes to it. Settings must state where
  message text goes, as they do for recordings, and the operator chooses it.

- **The key and ephemeral secrets.** Ruling 1 keeps the provider key on the server. A text-to-speech
  key is the same kind of secret and fits the same rules: write-only, never logged, bound to its
  base URL. Ephemeral secrets are reusable and billable for up to 2 hours (S52) (A).
  - **Design implication:** relay text-to-speech through the server too, which also keeps
    `media-src 'self'`.
- **Always listening.** Android 12 and later show a status-bar icon while any app uses the
  microphone, and a Quick Settings toggle turns microphone access off for all apps (S64) (A).
  - **Design implication:** with VAD on device, audio leaves the phone only when someone speaks. But
    "someone" includes passengers, the radio and a podcast, and every such utterance reaches the
    provider.
  - The design should listen only while Audio Mode is on, and show that it is listening. It should
    never act on one utterance alone for anything that sends.
  - Agents' own messages read aloud could contain a command word, and the microphone hears them.
    That is one more reason for half-duplex or echo cancellation set to `"all"`.
- **Injected text.** A transcript or a misheard command must not send anything by itself. The voice
  effort's rule is that nothing sends without the operator; Audio Mode keeps it with a spoken
  readback and an explicit confirm, as every product in section 4 does.

## Refuted or do not rely on

- **"`gpt-realtime-2.1-mini` replaces `gpt-4o-mini-tts` on `/audio/speech`."** Refuted: its model
  page marks `v1/audio/speech` not supported, and the guide says so (S5, S1) (A).
- **"OpenAI has 11 voices."** The guide's introduction says 11, but it and the API reference list 13
  (S1, S3) (A).
- **"Kokoro-FastAPI has no releases."** A page fetch showed an empty releases section, but the
  GitHub releases API lists v0.10.0 of 2026-11-08 (S13) (A). Trust the registry data.
- **"speaches serves Piper."** Its home page says so, but its text-to-speech page names only a
  Kokoro model, and its latest tag is a release candidate (S14) (A). Verify before a preset depends
  on it.
- **"Piper speaks the OpenAI interface."** Refuted: its server is `POST /synthesize` returning WAV
  (S15) (A).
- **"Pause and resume works around Chrome's 14-second cut-off."** Not on Android, where speech stops
  and never resumes (S21) (C).
- **"`'self'` in `media-src` covers blob URLs."** Refuted by CSP 3 (S29) (A).
- **"Screen Wake Lock keeps audio running with the screen off."** No: it keeps the screen on, and is
  released when the page is hidden (S32) (A).
- **"Chrome's echo cancellation removes the page's own playback."** Do not rely on it without
  `echoCancellation: "all"` (S62) (B).
- **"On-device Web Speech makes command recognition private on the phone."** Not on Android as of
  May 2026 (S58) (B).
- **"Deepgram temporary tokens always last 30 seconds."** The docs conflict; check the current
  reference (S53).
- **"Groq text-to-speech streams."** Not documented (S9, S10) (A).
- **Google Assistant driving mode and Outlook Play My Emails as live products.** Both are gone (S43,
  S45). Use them as design prior art only.
- **Google Cloud Text-to-Speech prices.** The pricing page did not load; no figure here comes from
  it. Do not quote one from memory.
- **"Agention could appear in Android Auto."** No: Android Auto takes notification messaging from
  native apps, and bars long-form messaging (S36, S37) (A).

## Open questions

1. **Provider text-to-speech at all, and whose?** With OpenAI's speech models gone on 2027-01-06,
   the hosted options on the shared interface are AssemblyAI (new, USD 15 per 1M characters) and
   Groq (200-character requests, WAV only), plus self-hosted Kokoro. Does the operator want message
   text sent to a provider, and which preset comes first? Or does better on-device voice choice and
   rate come first?
2. **Does ruling 1 cover ephemeral client secrets?** This research recommends yes: keep every
   provider call relayed. The question decides between browser-direct realtime and a new server
   WebSocket.
3. **Screen off or screen on?** Must Audio Mode work with the phone locked in a pocket, or is a
   screen-on mode (wake lock, phone mounted) acceptable first? Screen-off listening on Android
   Chrome is unverified and needs a test on the operator's phone: microphone after lock, page frozen
   between messages, speech synthesis after lock.
4. **Is driving an intended use?** If so, the design should follow the eyes-free posture of section
   4 and say plainly that Agention is not a certified car interface.
5. **Confirm before send, always?** All prior art confirms by default; Apple allows opting out.
6. **How does the operator interrupt?** Options are headset and lock-screen keys through Media
   Session, push-to-talk, a spoken command while Agention is silent (half-duplex), or barge-in with
   echo cancellation set to `"all"` (needs a device test).
7. **What does Audio Mode read?** Every new message, only messages with open asks, or a summary
   (thread titles and asks) first, then details on "more"?
8. **New dependencies.** VAD needs `@ricky0123/vad-web` and `onnxruntime-web`, self-hosted, and
   `'wasm-unsafe-eval'` in the CSP. A live transcription relay needs a WebSocket server library.
   Which of these is acceptable?
9. **One provider or two?** Text-to-speech and transcription can share a base URL (Groq, a home
   server) or not (AssemblyAI uses a different host for each). Should Settings hold a separate
   speech provider?

## Sources

| #   | URL                                                                                                                                                       | What it supports                                                               | Grade |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- |
| S1  | <https://developers.openai.com/api/docs/guides/text-to-speech>                                                                                            | Models, voices, formats, chunked streaming, latency advice, disclosure         | A     |
| S2  | <https://developers.openai.com/api/docs/deprecations>                                                                                                     | Text-to-speech and transcription shutdown dates and replacements               | A     |
| S3  | <https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create>                                                          | Speech request parameters and limits                                           | A     |
| S4  | <https://developers.openai.com/api/docs/pricing>                                                                                                          | Speech, transcription and realtime prices                                      | A     |
| S5  | <https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini>                                                                                     | `v1/audio/speech` not supported; realtime only                                 | A     |
| S6  | <https://developers.openai.com/api/docs/models/gpt-4o-mini-tts>                                                                                           | Snapshots deprecated; token prices                                             | A     |
| S7  | <https://developers.openai.com/api/docs/guides/your-data>                                                                                                 | Retention and training per audio endpoint                                      | A     |
| S8  | <https://openai.com/index/introducing-gpt-live-1-in-the-api/>                                                                                             | GPT-Live-1, 2026-09-10, USD 0.05 a minute                                      | B     |
| S9  | <https://console.groq.com/docs/text-to-speech>                                                                                                            | Groq speech endpoint and models                                                | A     |
| S10 | <https://console.groq.com/docs/text-to-speech/orpheus>                                                                                                    | Orpheus voices, 200-character cap, WAV only, prices                            | A     |
| S11 | <https://console.groq.com/docs/your-data>                                                                                                                 | Groq retention and ZDR                                                         | A     |
| S12 | <https://www.assemblyai.com/blog/migrate-openai-tts-to-assemblyai>                                                                                        | AssemblyAI OpenAI-compatible speech, limits, formats, price (2026-11-18)       | B     |
| S13 | <https://github.com/remsky/Kokoro-FastAPI> and its GitHub releases API                                                                                    | Endpoints, formats, latency, images, license; v0.10.0 of 2026-11-08            | A     |
| S14 | <https://speaches.ai/usage/text-to-speech/> and the speaches-ai/speaches releases API                                                                     | Kokoro model, formats refused; v0.9.0-rc.3 of 2025-12-27                       | A     |
| S15 | <https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_HTTP.md> and its releases API                                                                 | Piper HTTP API; GPL-3.0; v1.8.0 of 2026-09-04                                  | A     |
| S16 | <https://developers.deepgram.com/docs/text-to-speech>                                                                                                     | Deepgram `/v1/speak`, 2,000-character cap                                      | A     |
| S17 | <https://deepgram.com/pricing>                                                                                                                            | Nova-3, Flux and Aura-2 prices                                                 | A     |
| S18 | <https://elevenlabs.io/docs/api-reference/text-to-speech/convert>                                                                                         | ElevenLabs endpoint, header, `enable_logging` default                          | A     |
| S19 | <https://webaudio.github.io/web-speech-api/>                                                                                                              | `rate`, `localService`, `pause()` semantics                                    | A     |
| S20 | <https://readium.org/speech/docs/WebSpeech.html>                                                                                                          | Voice behavior per browser: Android voice list, 14-second cut-off, Edge voices | C     |
| S21 | <https://github.com/phetsims/utterance-queue/issues/60>                                                                                                   | Google voice cut-off; pause and resume breaks on Android                       | C     |
| S22 | <https://groups.google.com/a/chromium.org/g/blink-dev/c/WsnBm53M4Pc>                                                                                      | `speak()` requires sticky user activation                                      | B     |
| S23 | <https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/configureonlinetexttospeech>                                                        | Edge online voices are Azure Cognitive Services; not on Android                | A     |
| S24 | <https://blogs.windows.com/msedgedev/2019/08/14/cloud-powered-voices-microsoft-edge-chromium/>                                                            | Edge cloud voices exposed through `SpeechSynthesis` (2019)                     | B     |
| S25 | <https://techcommunity.microsoft.com/discussions/edgeinsiderdiscussions/edge-version-150-javascript-speechsynthesis-getvoices-undefined-voices/4538591>   | Edge 150 natural voice names reading "undefined"                               | C     |
| S26 | <https://developer.chrome.com/blog/autoplay>                                                                                                              | Autoplay conditions, Web Audio, detecting refusal                              | B     |
| S27 | <https://developer.chrome.com/docs/web-platform/page-lifecycle-api>                                                                                       | Freezing, discard exemptions for audio                                         | A     |
| S28 | Chromium `third_party/blink/renderer/platform/media/web_media_player_impl.cc` and `content/public/renderer/render_frame_media_playback_options.cc` (main) | Audio-only media plays in background on Android                                | A     |
| S29 | <https://w3c.github.io/webappsec-csp/>                                                                                                                    | `'self'` never matches `blob:`; non-HTTP(S) schemes listed explicitly          | A     |
| S30 | <https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API>                                                                                      | Metadata, action handlers, lock-screen and headset keys                        | A     |
| S31 | <https://developer.chrome.com/blog/media-session> and <https://web.dev/articles/media-session>                                                            | 5-second rule; Web Audio needs an `<audio>` element                            | B     |
| S32 | <https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API>                                                                                   | Wake lock released when hidden                                                 | A     |
| S33 | <https://www.w3.org/TR/mse-byte-stream-format-mpeg-audio/>                                                                                                | MSE `audio/mpeg` byte stream format                                            | A     |
| S34 | <https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests>                                                                        | Streaming uploads: HTTP/2 only, half duplex                                    | A     |
| S35 | <https://nodejs.org/api/globals.html>                                                                                                                     | Node `WebSocket` client, stable since 22.4.0                                   | A     |
| S36 | <https://developer.android.com/training/cars/communication/notification-messaging>                                                                        | Android Auto messaging flow, reply and mark-as-read actions                    | A     |
| S37 | <https://developer.android.com/docs/quality-guidelines/car-app-quality>                                                                                   | MF-4 long-form ban, ST-1, DD rules                                             | A     |
| S38 | <https://developers.google.com/cars/design/android-auto/apps/voice-messaging>                                                                             | Reply dialogue, confirmation, patterned sequences                              | A     |
| S39 | <https://support.google.com/androidauto/answer/6348317>                                                                                                   | Read, summarize, reply, confirm before send                                    | A     |
| S40 | <https://blog.google/products/android/android-auto-gemini-tips/>                                                                                          | Gemini in Android Auto, summaries, edits (2025-11-20)                          | B     |
| S41 | <https://support.apple.com/en-az/guide/iphone/iph838fd6fd4/15.0>                                                                                          | Announce with Siri, confirmation, Reply Without Confirmation                   | A     |
| S42 | <https://support.apple.com/en-in/guide/iphone/iphb5d45624c/16.0/ios>                                                                                      | CarPlay messages, Automatically Send Messages                                  | A     |
| S43 | <https://9to5google.com/2025/04/25/google-assistant-driving-mode-maps/>                                                                                   | Assistant driving mode removed from Maps, April 2025                           | B     |
| S44 | <https://techcommunity.microsoft.com/blog/outlook/play-my-emails-in-outlook-and-get-time-back-in-your-day/930243>                                         | Play My Emails flow and commands                                               | B     |
| S45 | <https://support.microsoft.com/en-gb/office/what-can-i-say-and-when-can-i-say-it-de08eaf7-17a0-4a19-9aa4-3016d59d438f>                                    | Play My Emails command page retired                                            | A     |
| S46 | <https://www.govinfo.gov/content/pkg/FR-2013-04-26/html/2013-09883.htm>                                                                                   | NHTSA Phase 1 visual-manual guidelines                                         | A     |
| S47 | <https://www.w3.org/TR/voicexml20/>                                                                                                                       | Barge-in and barge-in types (section 4.1.5)                                    | A     |
| S48 | <https://developers.openai.com/api/docs/guides/speech-to-text>                                                                                            | `gpt-transcribe` streaming, deprecations, 25 MB                                | A     |
| S49 | <https://developers.openai.com/api/docs/guides/realtime-transcription>                                                                                    | Realtime transcription session shape                                           | A     |
| S50 | <https://developers.openai.com/api/docs/models/gpt-transcribe>                                                                                            | Endpoints and price                                                            | A     |
| S51 | <https://developers.openai.com/api/docs/models/gpt-live-transcribe>                                                                                       | Endpoints and price                                                            | A     |
| S52 | <https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create>                                               | Client secret lifetime and reuse; VAD defaults                                 | A     |
| S53 | <https://developers.deepgram.com/reference/token-based-auth-api/grant-token> and <https://developers.deepgram.com/docs/keyterm>                           | Temporary token TTL; keyterm limits (read through search)                      | C     |
| S54 | <https://www.assemblyai.com/docs/temporary-tokens.md>                                                                                                     | Token window, reuse, browser query parameter                                   | A     |
| S55 | <https://www.assemblyai.com/pricing>                                                                                                                      | Streaming models, session billing, speech price                                | A     |
| S56 | <https://www.assemblyai.com/docs/speech-to-text/universal-streaming>                                                                                      | Streaming URL, model, formats, end of turn                                     | A     |
| S57 | <https://console.groq.com/docs/speech-to-text>                                                                                                            | Groq models, prices, 10-second minimum                                         | A     |
| S58 | <https://mail-archive.com/blink-dev@chromium.org/msg16523.html>                                                                                           | No on-device Web Speech on Android or ChromeOS (2026-05-06)                    | B     |
| S59 | <https://developer.android.com/reference/android/speech/tts/TextToSpeech>                                                                                 | `getMaxSpeechInputLength` caps one `speak` call                                | A     |
| S60 | <https://github.com/ricky0123/vad> and <https://registry.npmjs.org/@ricky0123/vad-web>                                                                    | Silero VAD in the browser; 0.0.31, ISC                                         | A     |
| S61 | <https://picovoice.ai/docs/faq/general/>                                                                                                                  | AccessKey; no personal plans                                                   | A     |
| S62 | <https://groups.google.com/a/chromium.org/g/blink-dev/c/x5nfoaUAUWY>                                                                                      | `echoCancellation` `"all"` and `"remote-only"`, Chrome 141                     | B     |
| S63 | <https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation>                                                                 | The new values are experimental (read through search)                          | C     |
| S64 | <https://developer.android.com/about/versions/12/behavior-changes-all>                                                                                    | Microphone indicator and toggle                                                | A     |
