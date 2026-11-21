# Voice input and read-aloud for Agention: prior art and options

<!-- cspell:ignore ASVS behaviour CREDS CUDA Deepgram Groq Groq's huggingface Immich Immich's kbit Keyterm -->
<!-- cspell:ignore Kokoro mpga Nemotron Nextcloud Ollama ONNX pydub Qwen rhasspy speaches VITS Voxtral -->

Research notes, compiled 2026-11-21. Scope: dictation (record in the web UI, transcribe on the
server, text lands in the composer for editing, sent as ordinary text), optional read-aloud, and how
a settings page should hold a provider API key. No code or repository was touched.

Source grades used below: **A** primary (vendor docs, pricing pages, project source or repo
metadata, browser vendor docs, MDN); **B** primary but informal or undated (vendor engineer forum
reply, mailing-list intent, vendor blog); **C** reputable secondary (independent benchmark, press);
**D** anecdote (community forum, third-party blog). Prices and model names move monthly; everything
here is "as fetched on 2026-11-21" unless another date is given.

## 1. Speech-to-text providers

### Speech-to-text findings

**Independent accuracy and price snapshot** (Artificial Analysis STT leaderboard, fetched
2026-11-21, grade C; AA-WER is their own mixed benchmark, speed factor is audio seconds per wall
second, price is USD per 1,000 audio minutes):

| Model (provider)                            | AA-WER | Speed factor | $ / 1,000 min |
| ------------------------------------------- | ------ | ------------ | ------------- |
| Scribe v3 (ElevenLabs)                      | 1.9%   | 63           | 3.33          |
| MAI-Transcribe-2 (Microsoft AI)             | 2.0%   | 341          | 1.67          |
| Voxtral Small Transcribe 3 (Mistral)        | 2.1%   | 43           | 4.00          |
| Scribe v2 (ElevenLabs)                      | 2.2%   | 90           | 3.67          |
| Voxtral Mini Transcribe 3 (Mistral)         | 2.2%   | 60           | 3.50          |
| AssemblyAI-STT-3.7 (AssemblyAI)             | 2.5%   | 109          | 3.50          |
| Gemini 3.5 Transcribe (Google)              | 2.6%   | 95           | 5.00          |
| Azure Speech 09-2026 (Microsoft)            | 2.8%   | 149          | 6.00          |
| GPT Transcribe (OpenAI)                     | 3.3%   | 63           | 4.50          |
| GPT-4o Mini Transcribe (OpenAI, deprecated) | 4.5%   | 70           | 3.00          |
| Chirp 3 (Google Cloud STT v2)               | 4.3%   | 32           | 16.00         |
| Whisper Large v3 Turbo (Groq)               | 4.6%   | 409          | 0.67          |
| Nova-3 (Deepgram)                           | 5.2%   | 409          | 4.30          |

For dictation clips of 5 to 60 seconds, every hosted option above is fast enough (sub-second to low
single-second processing; network upload of a small Opus or AAC file dominates) and cheap (a heavy
day of 60 minutes of dictation costs USD 0.04 to 0.30). Accuracy and data handling decide, not price
or latency.

**OpenAI** (grade A):

- Current file model is `gpt-transcribe` (launched 2026-07-28 per press, grade C), USD 0.0045 per
  audio minute, on `POST /v1/audio/transcriptions`; supports `prompt`, `keywords`, `languages`
  (replaces singular `language`), and `stream=true` (SSE `transcript.text.delta` events).
  `gpt-live-transcribe` is the Realtime (WebSocket) counterpart.
- `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` are
  deprecated (notice 2026-08-26, shutdown 2027-02-26). Do not build on them.
- Limits: 25 MB per file; accepted formats flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.
- Data: per OpenAI's "your data" table, `/v1/audio/transcriptions` is not used for training, has
  **no** abuse-monitoring retention and no application state, and is ZDR-eligible.

**Groq** (grade A): OpenAI-compatible endpoints at
`<https://api.groq.com/openai/v1/audio/transcriptions`.> `whisper-large-v3-turbo` USD 0.04/hour (12%
WER on Groq's own table), `whisper-large-v3` USD 0.111/hour. Same format list as OpenAI. 25 MB
attachment (100 MB via `url` on dev tier). **Minimum billed length 10 s per request** (matters for
very short clips; still negligible cost). Data: no retention by default except up to 30 days of
troubleshooting/abuse logs; every customer can enable Zero Data Retention in Data Controls. Training
use is not stated on the page (unverified). Whisper accuracy is now mid-pack.

**Mistral Voxtral** (grade A/B): `POST /v1/audio/transcriptions`, Bearer auth, multipart file plus
`model` (`voxtral-mini-latest`; newer docs name `voxtral-mini-transcribe-3`). Best price per
accuracy among OpenAI-shaped APIs per AA. Mistral docs do not call it "OpenAI-compatible";
field-level compatibility with an OpenAI client is **unverified** (path and auth match). Open
weights (Apache 2.0) exist for Voxtral Mini/Realtime. Retention/training terms not researched.

**ElevenLabs Scribe** (grade A): own API (`/v1/speech-to-text`, `xi-api-key`), not OpenAI-shaped.
Scribe v3 and v2 USD 0.20/hour on the API pricing page (third parties quote 0.22; the page wins).
Highest accuracy in the AA table. Accepts webm, mp4, m4a, aac, opus and more; 5 GB / 15 h limits.
Keyterm prompting is an extra charge. **Zero Retention Mode is enterprise-only**
(`enable_logging=false`); default keeps history per privacy policy; whether non-ZRM API audio is
used for training is not stated (unverified).

**Deepgram** (grade A): own API (`/v1/listen`), not OpenAI-shaped. Nova-3 pre-recorded USD
0.0043/min monolingual, 0.0052 multilingual (pay as you go); USD 200 free credit. Accuracy is the
weakest of the majors on AA (5.2%) but it is the fastest. Model Improvement Program opt-out per
request with `mip_opt_out=true`; opted-out data is kept only as long as needed to process. Since
2026-03-05 opting out has no price impact (older community posts saying otherwise are stale).

**AssemblyAI** (grade A): own API, async (upload, then poll) model, which adds a round trip for
short clips. Current pre-recorded model `assemblyai-stt-3-7` USD 0.21/hour; Universal-2 USD
0.15/hour; Universal-3.5 Pro deprecated; SLAM-1 retired. USD 50 free credit (pricing page updated
2026-11-10). Retention: async audio deleted 24 to 48 h, transcripts 30 days unless a shorter TTL;
training only on files the contract allows, excluded for opt-out, BAA, EU.

**Google Cloud STT v2 / Chirp 3** and **Azure Speech**: accurate enough but heavier to integrate
(service accounts, regions, recognizer resources) and Chirp 3 is the most expensive option in the
table. Azure's free tier is 5 audio hours/month (grade A). Microsoft AI's MAI-Transcribe-2 looks
strong on AA but how a single operator obtains access was not researched (unverified).

**Self-hosted** (grade A for repo metadata; grade A/D for speed claims as marked):

| Option                              | What it is                                                                                                                                       | CPU feasibility                                                                                                                                          | Node integration                                                                                                                                      | Status (2026-11-21)                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| whisper.cpp `examples/server`       | C/C++ Whisper, ARM NEON, int quantization                                                                                                        | small model 2m05s for 13 min audio on i7-12700K, 8 threads (from faster-whisper README); base/small fine for short clips on a few cores                  | HTTP `POST /inference` (multipart `file`, `response_format`); **not** OpenAI-path compatible; WAV only unless started with `--convert` (needs ffmpeg) | MIT, v1.9.5 2026-10-06, active                                                                                 |
| faster-whisper                      | CTranslate2 Whisper (Python), int8 on CPU                                                                                                        | small int8 1m42s for 13 min audio (same bench); bundles FFmpeg via PyAV                                                                                  | Python only; reach via a server such as speaches                                                                                                      | MIT, v1.2.1 2025-10-31                                                                                         |
| speaches (ex faster-whisper-server) | "Ollama for STT/TTS": OpenAI-compatible transcription and speech endpoints; faster-whisper STT, Piper and Kokoro TTS; CPU and CUDA compose files | as faster-whisper                                                                                                                                        | OpenAI-compatible HTTP                                                                                                                                | MIT, active commits, but latest release is **v0.9.0-rc.3 (2025-12-27)**: no stable release in 11 months        |
| NVIDIA Parakeet TDT 0.6B v2/v3      | FastConformer transducer, open weights, ONNX int8 exports                                                                                        | author-reported RTF about 0.03 to 0.05 int8 on i7-12700KF (grade D); Open ASR leaderboard avg WER about 6.0 (v2) vs Whisper large-v3 about 7.2 (grade C) | sherpa-onnx Node addon has Parakeet TDT examples                                                                                                      | v3 is multilingual (25 European languages, per model card family; not re-fetched)                              |
| Moonshine                           | Small streaming-first ASR, on-device                                                                                                             | designed for edge/Raspberry Pi                                                                                                                           | sherpa-onnx Node addon (v1 and v2 examples); own JS/WASM lib                                                                                          | MIT (some legacy non-English models non-commercial)                                                            |
| sherpa-onnx (`sherpa-onnx-node`)    | ONNX Runtime toolkit, Node native addon                                                                                                          | linux-x64 and **linux-arm64** prebuilt                                                                                                                   | in-process: Whisper, Parakeet, Moonshine, SenseVoice ASR; Piper/VITS and Kokoro TTS                                                                   | Apache-2.0, npm 2.0.2 published 2026-11-19 (inside the 7-day hold-back; pick the prior release if adopted now) |
| LocalAI, vLLM                       | general OpenAI-compatible servers with transcription                                                                                             | LocalAI CPU-capable; vLLM is GPU-oriented                                                                                                                | OpenAI-compatible HTTP                                                                                                                                | active                                                                                                         |

Model sizes for Whisper (whisper.cpp README, grade A): tiny 75 MiB disk / about 273 MB RAM, base 142
MiB / 388 MB, small 466 MiB / 852 MB, medium 1.5 GiB / 2.1 GB, large 2.9 GiB / 3.9 GB.

Open ASR leaderboard context (grade C, 2026 snapshots): best open models (NVIDIA Nemotron 3.5
Transcribe, Cohere Transcribe, Qwen3-ASR) sit at about 5.3 to 5.4 average WER; all of them trail the
top closed APIs.

**OpenAI-compatible transcription API as the common interface.** Speaks
`POST {base}/audio/transcriptions` with multipart `file` + `model` and Bearer auth: OpenAI, Groq
(documented as compatible), Mistral (same path and auth; field compatibility unverified), speaches,
LocalAI, vLLM, Kokoro-FastAPI (TTS side only). Does **not**: ElevenLabs, Deepgram, AssemblyAI,
Google, Azure Speech (Azure OpenAI deployments use a different URL shape and `api-key` header; its
newer v1 path compatibility is unverified), whisper.cpp server (`/inference`). Open WebUI and
LibreChat both ship exactly this split: one generic "OpenAI / OpenAI-compatible" STT adapter (base
URL, key, model) plus a few native adapters (Open WebUI: local faster-whisper, openai, deepgram,
azure, mistral; LibreChat: openai, azureOpenAI, OpenAI-compatible, browser). Prior art therefore
supports "one generic adapter first, natives only if wanted".

## 2. Recording in the browser

### Recording findings

- **MediaRecorder** is Baseline widely available since April 2021 (MDN, grade A). Pick the container
  at runtime with `MediaRecorder.isTypeSupported()`; do not sniff user agents (MDN and WebKit's 2020
  MediaRecorder post agree).
- **Formats by engine**: Chrome/Edge and Firefox record `audio/webm;codecs=opus` (Firefox also
  Ogg/Opus). Chrome 126 (2024-06-11) added MP4 (AAC) output. **Safari 18.4 added WebM/Opus
  recording** ("MediaRecorder now supports creating WebM files using the Opus audio codec", WebKit
  features in Safari 18.4, grade A); Safari 14.1 to 18.3 record `audio/mp4` (AAC) only. All iOS
  browsers use WebKit (outside EU alternative-engine builds), so an iPhone behaves like Safari
  regardless of browser. Early 18.4 betas had MediaRecorder bugs (WebKit 290002, 290223, grade B).
- **Provider acceptance**: OpenAI, Groq and ElevenLabs list both webm and mp4/m4a, so **no
  transcoding is needed** for the mainstream path. The long-running community issue with Safari
  `audio/mp4` blobs at OpenAI's Whisper endpoint (2023 to 2024, grade D) was worked around by (a)
  naming the upload `*.m4a`, (b) calling `start(timeslice)` (for example 1000 ms) instead of a
  single final chunk, and (c) dropping empty `dataavailable` chunks. Open WebUI still detects
  AAC/mp4a and transcodes to MP3 with pydub/ffmpeg before sending (source, main branch, 2026-11-21),
  which shows the issue was real enough to code around. On Safari 18.4+ choosing webm/opus first
  sidesteps it. Server-side ffmpeg is needed only for whisper.cpp server (WAV) or as a fallback for
  odd inputs; it is a large native dependency and an input-parsing attack surface (whisper.cpp
  README itself warns about running `--convert` on untrusted uploads).
- **Sizes**: Opus speech at about 24 to 32 kbit/s is about 0.2 MB per minute; AAC from Safari is
  larger (roughly 64 to 128 kbit/s by default). A 5-minute cap stays far below the 25 MB OpenAI/Groq
  limit. Set `audioBitsPerSecond` and enforce a server-side byte and duration cap.
- **Secure context and permissions**: `getUserMedia()` exists only in secure contexts (HTTPS or
  localhost); `tailscale serve` HTTPS satisfies this. Permissions-Policy `microphone` has a default
  allowlist of `self`; if Agention sends `Permissions-Policy: microphone=()` (common in strict
  header sets) it must change to `microphone=(self)`, otherwise `getUserMedia` rejects with
  `NotAllowedError`. Cross-origin iframes need explicit `allow="microphone"` (not relevant here).
- **CSP**: `getUserMedia` and MediaRecorder are not governed by CSP. Uploading the blob with `fetch`
  to the same origin needs only `connect-src 'self'`. Playback needs `media-src`: an `<audio>`
  element pointing at a same-origin URL is covered by `'self'`; playing a recorded or fetched blob
  via `URL.createObjectURL` needs `media-src blob:` (MediaSource object URLs are also `blob:`).
  Playing through Web Audio (`decodeAudioData` + `AudioBufferSourceNode`) needs no `media-src`
  change at all. Calling the provider directly from the browser would need `connect-src` for the
  provider and would expose the key, so do not.
- **iOS quirks** (grade B/D): Safari re-prompts for microphone permission per session unless the
  operator sets Settings > Apps > Safari > Microphone to Allow; Home Screen (standalone) web apps
  have a history of re-prompts (WebKit 215884) and a 2025 report of MediaRecorder working only on
  the first launch of a Home Screen app (Apple forum 797987; a WebKit engineer acknowledged past
  getUserMedia reliability problems in PWAs, no fix confirmed). Always stop every `MediaStreamTrack`
  when recording ends so the mic indicator clears and the next session can reacquire it. Media
  `play()` with sound requires a user gesture on iOS (WebKit 2016 video policy post, grade A), which
  matters for read-aloud, not recording.

## 3. Browser built-ins and text-to-speech

### Browser built-in and speech synthesis findings

- **Web Speech API `SpeechRecognition`** is "Limited availability", not Baseline (MDN, grade A).
  MDN: "On some browsers, speech recognition uses a server-based recognition engine by default. Your
  audio is sent to a web service." Chrome's default sends audio to Google; **Chrome 139 (2025-08-05)
  added on-device recognition** via `processLocally = true` with `SpeechRecognition.available()` /
  `install()` (about 60 MB language packs, grade B); a `quality` hint was proposed in May 2026.
  Safari exposes `webkitSpeechRecognition` backed by Apple's speech service; whether a given request
  runs on device or on Apple servers is not documented for the web API, and developer reports
  describe slow fallbacks, `continuous` mode bugs and inconsistent `interimResults` on iOS (grade
  D). Firefox has not shipped it; a Mozilla intent to prototype and ship a strictly on-device
  implementation was posted 2026-09-16 (grade B, landing status unverified). Conclusion: not a
  reliable primary path for an iPhone-first app, and its privacy story differs per browser.
- **The zero-code baseline already exists**: the iOS keyboard's dictation key works in any textarea,
  including Agention's composer. Apple says dictation is processed on device in many languages and
  Keyboard Settings shows whether audio leaves the device (Apple privacy and support pages, grade
  A). Accuracy and punctuation are below Scribe/Voxtral/gpt-transcribe for long technical dictation,
  but it costs nothing and needs no settings. The feature should be justified against this baseline
  (accuracy on technical vocabulary, `keywords`/`prompt` biasing with project terms, long-form
  dictation, desktop parity).
- **`speechSynthesis`** (read aloud in the browser) is Baseline widely available since 2018 (MDN).
  It is free, on-device, needs no server, and suits a "Read aloud" button. Caveats: Chrome 71
  removed `speak()` without user activation (grade A); iOS also expects a gesture (commonly
  reported, specific WebKit doc not found: unverified); `getVoices()` may be empty until
  `voiceschanged`; on iOS 18 voice lists regressed and installed Enhanced/Premium voices can be
  missing from `getVoices()` (Apple forum 764438, WebKit bugs, grade B/D); there is no API to
  download better voices; long utterances should be chunked by sentence. Quality ranges from robotic
  (compact voices) to good (Premium voices where exposed).
- **Server TTS options**:
  - **OpenAI** `/v1/audio/speech` (`gpt-4o-mini-tts`, 13 voices, mp3/opus/aac/flac/wav/pcm, chunked
    streaming). **Deprecated: notice 2026-10-01, shutdown 2027-01-06**; the named replacement
    `gpt-realtime-2.1-mini` is Realtime-only and its model page marks `/v1/audio/speech` unsupported
    (grade A). OpenAI's usage policy requires disclosing that the voice is AI-generated. Speech
    requests keep 30-day abuse-monitoring logs. Do not adopt it as a default now.
  - **ElevenLabs**: v4 and v3 USD 0.08 per 1K characters, Flash/Turbo and v4 Turbo USD 0.04 per 1K;
    HTTP streaming and WebSocket endpoints; high quality; ZRM enterprise-only.
  - **Kokoro-82M**: Apache-2.0, 82M params, v1.0 (2025-01-27), 54 voices, 8 languages. Served
    OpenAI-compatibly by Kokoro-FastAPI (Apache-2.0, v0.10.0 2026-11-08, CPU image, mp3/opus/wav/
    pcm, `GET /v1/audio/voices`) and by speaches; in-process in Node via sherpa-onnx. `kokoro-js` on
    npm last published 2025-05-03 (stale). One fork's benchmark: Kokoro RTF about 0.12 vs Piper
    about 0.07 on an M2 Max (grade D).
  - **Piper**: `rhasspy/piper` (MIT) is archived; development continues as `OHF-Voice/piper1-gpl`
    (**GPL-3.0**, v1.8.0 2026-09-04). Voices on Hugging Face `rhasspy/piper-voices`. Very fast on
    CPU, lower naturalness than Kokoro. Running it as a separate process/server keeps GPL
    obligations away from Agention's code; linking it in process deserves a licence check.
  - Azure neural TTS has a 0.5M characters/month free tier; Google Cloud TTS not researched.
  - "OpenAI-compatible `/v1/audio/speech`" survives as a de facto local-server interface
    (Kokoro-FastAPI, speaches, LocalAI) even as OpenAI retires its own models from it.
- **Playback**: Agention messages are short, so synthesize the whole reply server-side and send it
  with a `Content-Length`, then play from a same-origin URL or a blob URL. Streaming playback adds
  cost: Safari probes media URLs with `Range: bytes=0-1` and expects a 206 (WebKit 184447), chunked
  responses without a length are unreliable on Safari (grade D), and MSE on iPhone means
  `ManagedMediaSource` (iOS 17.1+). Web Audio with PCM chunks is the other streaming route. None of
  this is worth building for v1; sentence-chunked requests give most of the latency win.

## 4. Settings pages that hold third-party API keys

### Settings and key findings (source-verified where marked)

| App                       | Where keys live                                                                                                                                    | Encrypted at rest                                                                                                              | Echoed back to the UI                                                                                                                                                                    | Env vs UI                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open WebUI                | `config` table in the app DB (PersistentConfig)                                                                                                    | No (plaintext)                                                                                                                 | **Yes**: `GET /api/v1/audio/config` (admin-only) returns `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, etc. verbatim (source, main, 2026-11-21)                                                  | Env seeds DB on first launch, then DB wins and env is ignored unless `ENABLE_PERSISTENT_CONFIG=False`; a well-known source of confusion (docs plus troubleshooting guides) |
| Immich                    | system config in DB, or a file via `IMMICH_CONFIG_FILE`                                                                                            | No                                                                                                                             | **Yes**: `mapAdminConfig` returns the config as-is, including OAuth `clientSecret` and SMTP `password`, to admins with `SystemConfigRead` (source, main, 2026-11-21)                     | Config file makes the whole admin settings UI read-only and API updates return 400; clean "one source of truth" model                                                      |
| Home Assistant            | UI integrations in `.storage/core.config_entries` (JSON); YAML users can use `secrets.yaml`                                                        | No (plaintext; maintainers' stated reason: unattended start needs the key on the same box)                                     | Config flows do not normally redisplay secrets (not source-verified)                                                                                                                     | UI-first; YAML for some integrations                                                                                                                                       |
| Nextcloud                 | `oc_appconfig`; `FLAG_SENSITIVE` values hidden from reports/listings and stored encrypted (docs disagree whether encryption began in 29, 31 or 32) | Yes for sensitive values, with the server secret in `config.php` on the same host                                              | Hidden from system reports                                                                                                                                                               | UI and `occ` CLI                                                                                                                                                           |
| LibreChat                 | Operator keys only in `.env`, referenced from `librechat.yaml` (`${STT_API_KEY}`); per-user keys in MongoDB                                        | Per-user credentials encrypted with `CREDS_KEY`/`CREDS_IV` (AES-256-CBC per code mirrors; random IV per value in newer format) | Not researched                                                                                                                                                                           | Speech providers are file-configured only, no UI entry; private/LAN base URLs blocked unless in `allowedAddresses` (SSRF guard)                                            |
| Grafana (extra prior art) | `secureJsonData`                                                                                                                                   | Yes, encrypted server-side                                                                                                     | **Never**: the frontend only receives `secureJsonFields: {key: true}`; reset by setting the field false; the server-side proxy decrypts and injects the secret into the outbound request | UI and provisioning files                                                                                                                                                  |

Takeaways:

- The popular self-hosted AI apps (Open WebUI, Immich) store keys in plaintext and return them to
  admin sessions. That is the anti-pattern to avoid: any XSS or stolen session reads the key.
  Grafana's write-only model is the one to copy.
- Encryption at rest with the key on the same host protects backups and DB dumps only; Home
  Assistant maintainers make exactly this argument. File permissions, keeping secrets out of logs
  and exports, and never returning them to clients matter more.
- **Re-authentication**: OWASP ASVS 4.0.3 3.7.1 and the Authentication Cheat Sheet call for
  re-authentication or step-up before sensitive changes. None of the surveyed self-hosted apps does
  this for provider keys (not found in any). For a passkey app the natural form is a fresh WebAuthn
  assertion with `userVerification: "required"` just before the write.
- **Base URL plus key is the real secret boundary**: with a generic OpenAI-compatible adapter,
  whoever can change the base URL can make the server send the stored key to their host. A base-URL
  change must therefore either require re-entering the key or count as a step-up action. LibreChat's
  private-address block is SSRF protection for multi-user deployments; for a single operator
  pointing at `localhost` speaches, allowing private addresses is reasonable but should be explicit.
- **Env vs UI**: env/file config is reproducible and keeps secrets out of the DB but is invisible
  from an iPhone; UI config is what the operator asked for. Immich's rule (if the file/env is set,
  the UI shows the value as managed and read-only) avoids Open WebUI's "env silently ignored" trap.

## Recommended approach for Agention

1. **Dictation path**: in the composer, a mic button records with MediaRecorder (`isTypeSupported`
   order: `audio/webm;codecs=opus`, `audio/mp4`; `start(1000)`; drop empty chunks; stop all tracks
   on finish; client cap about 5 minutes). Upload the blob to a same-origin authenticated endpoint;
   the server enforces a byte and duration cap, forwards the bytes unchanged (filename `.webm` or
   `.m4a` by MIME), returns text, and **stores no audio**. The text is inserted at the cursor for
   editing; it is never auto-sent. Rationale: no ffmpeg, no native code, works on iOS 18.4+ and
   older Safari, smallest attack surface.
2. **One provider adapter first: OpenAI-compatible transcription** (base URL, model, key, plus
   optional prompt/keywords). Default preset OpenAI `gpt-transcribe` (USD 0.0045/min, no training,
   no retention on this endpoint, streaming available later). Presets for Groq
   (`whisper-large-v3-turbo`, cheapest, ZDR toggle) and Mistral (`voxtral-mini-latest`, best
   accuracy per dollar, compatibility to be verified in a spike) cost nothing extra. A local
   speaches or LocalAI URL covers self-hosting without Agention shipping models. Use built-in
   `fetch` + `FormData`; no SDK dependency is needed (the `openai` npm package's latest release is a
   day old and would fall inside the seven-day hold-back anyway). A native ElevenLabs adapter (top
   accuracy) is the only native worth adding later, and only on demand.
3. **Do not embed local models in the Agention process** for v1: native addons, model downloads, and
   CPU and RAM contention on a shared VM. If wanted later, sherpa-onnx-node (Apache-2.0, linux-arm64
   prebuilt) with Parakeet or Moonshine is the cleanest in-process route.
4. **Read-aloud in two tiers**: tier 1 is browser `speechSynthesis` behind a per-message "Read
   aloud" button (user gesture, sentence-chunked, voice picker stored per device), free and private,
   needing no server setting. Tier 2 is an optional server TTS provider via an OpenAI-compatible
   `/v1/audio/speech` adapter aimed at Kokoro-FastAPI/speaches or ElevenLabs, whole-reply synthesis,
   played from a same-origin URL (CSP `media-src 'self'`) or Web Audio. Do not default to OpenAI TTS
   (shutdown 2027-01-06). Auto-reading incoming messages should be off by default and is limited by
   iOS gesture rules anyway.
5. **Headers**: `Permissions-Policy: microphone=(self)`; keep `connect-src 'self'`; add
   `media-src 'self'` (and `blob:` only if blob playback is chosen). No provider origins in CSP,
   because the browser never talks to providers.
6. **Settings page and secret handling**: voice is off until a provider is configured. Store the key
   server-side only (operator-only file with 0600 permissions or the app DB); never return it
   (expose `configured: true` and perhaps the last 4 characters); never log it. Changing the
   provider, base URL or key requires a fresh passkey assertion (step-up); changing the base URL
   clears the stored key. Provide "Test" (transcribe a bundled short clip) and "Clear". If an
   environment variable supplies the key, show it as managed by the environment and read-only.
   Encryption at rest is optional and should not be presented as protection while the key sits on
   the same host.
7. **Operator disclosure**: the settings page states where audio goes (provider name, retention and
   training stance with a link) so enabling voice is an informed choice.

## Refuted or do-not-rely-on claims

- "Use `whisper-1` or `gpt-4o-transcribe`": deprecated 2026-08-26, shutdown 2027-02-26.
- "OpenAI TTS (`tts-1`, `gpt-4o-mini-tts`) is a stable default": deprecated 2026-10-01, shutdown
  2027-01-06; the named replacement is not on `/v1/audio/speech`.
- "Safari can only record `audio/mp4`": false since Safari 18.4 (WebM/Opus).
- "Web Speech recognition is private / on-device": Chrome is server-based by default (on-device only
  with `processLocally`, Chrome 139+); Safari routing undocumented; Firefox not shipped.
- "whisper.cpp server is OpenAI-compatible": it serves `/inference`, WAV unless `--convert`.
- "Piper is MIT and maintained at rhasspy/piper": archived; successor is GPL-3.0.
- "Deepgram charges more if you opt out of model improvement": superseded 2026-03-05.
- "AssemblyAI SLAM-1 / Universal-3 Pro are current": SLAM-1 retired; Universal-3.5 Pro deprecated in
  favour of AssemblyAI-STT-3.7.
- Third-party per-minute conversions of OpenAI token pricing (USD 0.006/min etc.) refer to
  deprecated models; `gpt-transcribe` has an official per-minute price.
- ElevenLabs Scribe at USD 0.22 or 0.29/hour (aggregators) vs USD 0.20 on ElevenLabs' page: use the
  page.
- "Encrypting the key in the DB makes it safe": only if the decryption key is elsewhere.
- speaches "stable release": none since an RC on 2025-12-27; treat as pre-release software.

## Open questions

1. Which languages does the operator dictate in, and how much technical vocabulary (repo names, CLI
   flags)? This decides between gpt-transcribe (`keywords`/`prompt`), Voxtral and Scribe.
2. Is iOS keyboard dictation already "good enough"? A side-by-side on real messages would test
   whether server STT earns its complexity.
3. Is the operator comfortable with audio leaving the tailnet at all, or is a local speaches/LocalAI
   box on the tailnet the expected default? This changes the default preset.
4. Does Agention already have a step-up (fresh passkey assertion) primitive, or is one needed for
   this feature and reusable for other secrets?
5. Is Agention used as a Home Screen web app on the iPhone? If so, the reported standalone-mode
   microphone problems need a device test before committing to the UX.
6. Read-aloud scope: on-demand only, or auto-read of incoming asks while hands-free? The latter runs
   into iOS gesture and audio-session limits.
7. Should transcripts or audio ever be retained (for example to retry a failed transcription)? The
   recommendation is no audio retention; a retry would keep the blob client-side only.
8. Unverified items to spike: Mistral field compatibility with an OpenAI-shaped request; Azure
   OpenAI v1 path compatibility; Groq and ElevenLabs training stance; iOS `speechSynthesis` gesture
   rule on current iOS; whether Safari 18.4+ webm/opus uploads transcribe cleanly on each preset.

## Sources

| URL                                                                                                                                   | Date (as shown or fetched) | Grade      | Used for                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------- | ---------------------------------------------- |
| <https://developers.openai.com/api/docs/guides/speech-to-text>                                                                        | fetched 2026-11-21         | A          | models, formats, 25 MB, params, streaming      |
| <https://developers.openai.com/api/docs/models/gpt-transcribe>                                                                        | fetched 2026-11-21         | A          | USD 0.0045/min, endpoints                      |
| <https://developers.openai.com/api/docs/deprecations>                                                                                 | fetched 2026-11-21         | A          | STT and TTS shutdown dates                     |
| <https://developers.openai.com/api/docs/guides/your-data>                                                                             | fetched 2026-11-21         | A          | training/retention per endpoint                |
| <https://developers.openai.com/api/docs/guides/text-to-speech>                                                                        | fetched 2026-11-21         | A          | TTS models, voices, formats, disclosure        |
| <https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini>                                                                 | via search 2026-11-21      | A          | speech endpoint unsupported                    |
| <https://the-decoder.com/gpt-transcribe-improves-on-its-predecessor-but-cant-catch-elevenlabs-google-or-mistral-on-error-rates/>      | 2026-07                    | C          | gpt-transcribe launch context                  |
| <https://artificialanalysis.ai/speech-to-text>                                                                                        | fetched 2026-11-21         | C          | cross-provider WER, speed, price               |
| <https://console.groq.com/docs/speech-to-text>                                                                                        | fetched 2026-11-21         | A          | Groq models, price, limits, 10 s minimum       |
| <https://console.groq.com/docs/your-data>                                                                                             | fetched 2026-11-21         | A          | Groq retention, ZDR                            |
| <https://deepgram.com/pricing>                                                                                                        | fetched 2026-11-21         | A          | Nova-3 prices, free credit                     |
| <https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program>                                             | fetched 2026-11-21         | A          | `mip_opt_out`                                  |
| <https://developers.deepgram.com/changelog/2026/3/5>                                                                                  | 2026-03-05                 | A          | MIP opt-out no price impact                    |
| <https://www.assemblyai.com/pricing.md>                                                                                               | updated 2026-11-10         | A          | models, prices, credit                         |
| <https://assemblyai.com/docs/data-retention-and-model-training>                                                                       | fetched 2026-11-21         | A          | retention, training                            |
| <https://elevenlabs.io/pricing/api>                                                                                                   | fetched 2026-11-21         | A          | Scribe and TTS prices                          |
| <https://elevenlabs.io/docs/capabilities/speech-to-text>                                                                              | fetched 2026-11-21         | A          | Scribe formats, limits, accuracy claims        |
| <https://elevenlabs.io/docs/developers/resources/zero-retention-mode>                                                                 | fetched 2026-11-21         | A          | ZRM enterprise-only                            |
| <https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files>                                                                | via search 2026-11-21      | A          | Voxtral endpoint, auth, model alias            |
| <https://mistral.ai/news/voxtral-transcribe-2>                                                                                        | 2026-02                    | B          | Voxtral pricing context                        |
| <https://cloud.google.com/speech-to-text/pricing>                                                                                     | fetch truncated 2026-11-21 | A (unread) | Chirp 3 pricing not confirmed; AA used instead |
| <https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/>                                               | fetched 2026-11-21         | A          | free tiers only (prices not rendered)          |
| <https://github.com/ggml-org/whisper.cpp>                                                                                             | v1.9.5 2026-10-06          | A          | model sizes, WAV input, NEON                   |
| <https://github.com/ggml-org/whisper.cpp/tree/master/examples/server>                                                                 | fetched 2026-11-21         | A          | `/inference`, `--convert`, security note       |
| <https://github.com/SYSTRAN/faster-whisper>                                                                                           | v1.2.1 2025-10-31          | A          | CPU benchmark table                            |
| <https://github.com/speaches-ai/speaches>                                                                                             | v0.9.0-rc.3 2025-12-27     | A          | OpenAI-compatible STT/TTS server               |
| <https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples>                                                             | v2.0.2 2026-11-19          | A          | Node addon platforms and model families        |
| <https://github.com/moonshine-ai/moonshine>                                                                                           | fetched 2026-11-21         | A          | Moonshine scope, licence                       |
| <https://github.com/groxaxo/parakeet-tdt-0.6b-v3-fastapi-openai>                                                                      | undated                    | D          | Parakeet CPU RTF claim                         |
| <https://huggingface.co/blog/open-asr-leaderboard>                                                                                    | 2025/2026                  | C          | open model WER context                         |
| <https://huggingface.co/hexgrad/Kokoro-82M>                                                                                           | v1.0 2025-01-27            | A          | Kokoro licence, voices                         |
| <https://github.com/remsky/Kokoro-FastAPI>                                                                                            | v0.10.0 2026-11-08         | A          | OpenAI-compatible Kokoro server                |
| <https://github.com/OHF-Voice/piper1-gpl>                                                                                             | v1.8.0 2026-09-04          | A          | Piper successor, GPL-3.0                       |
| <https://github.com/rhasspy/piper>                                                                                                    | archived                   | A          | archive status                                 |
| <https://registry.npmjs.org> (sherpa-onnx-node, kokoro-js, openai, @huggingface/transformers)                                         | fetched 2026-11-21         | A          | package versions and dates                     |
| <https://webkit.org/blog/16574/webkit-features-in-safari-18-4/>                                                                       | 2025-03                    | A          | WebM/Opus MediaRecorder                        |
| <https://webkit.org/blog/11353/mediarecorder-api/>                                                                                    | 2020                       | A          | feature detection guidance                     |
| <https://bugs.webkit.org/show_bug.cgi?id=290223>                                                                                      | 2025-03                    | B          | 18.4 beta WebM issues                          |
| <https://developer.chrome.com/release-notes/126>                                                                                      | 2024-06-11                 | A          | Chrome MP4 MediaRecorder                       |
| <https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder>                                                                      | fetched 2026-11-21         | A          | MediaRecorder API, Baseline                    |
| <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia>                                                          | fetched 2026-11-21         | A          | secure context, Permissions Policy, errors     |
| <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/media-src>                               | fetched 2026-11-21         | A          | media-src scope                                |
| <https://community.openai.com/t/whisper-problem-with-audio-mp4-blobs-from-safari/322252>                                              | 2023                       | D          | Safari mp4 workaround reports                  |
| <https://bugs.webkit.org/show_bug.cgi?id=215884>                                                                                      | 2020 to 2024               | B          | standalone re-prompts                          |
| <https://developer.apple.com/forums/thread/797987>                                                                                    | 2025-08                    | B          | Home Screen MediaRecorder failure              |
| <https://webkit.org/blog/6784/new-video-policies-for-ios/>                                                                            | 2016-07-25                 | A          | gesture rule for audible playback              |
| <https://bugs.webkit.org/show_bug.cgi?id=184447>                                                                                      | 2018                       | B          | Safari Range 0-1 probe                         |
| <https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition>                                                                  | fetched 2026-11-21         | A          | availability, server-based note                |
| <https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API>                                            | fetched 2026-11-21         | A          | processLocally, synthesis usage                |
| <https://developer.chrome.com/blog/new-in-chrome-139>                                                                                 | 2025-08-05                 | A          | on-device recognition                          |
| <https://groups.google.com/a/chromium.org/g/blink-dev/c/P8P-x7AnC6I>                                                                  | 2026-05                    | B          | on-device quality hint intent                  |
| <https://groups.google.com/a/mozilla.org/g/dev-platform/c/6f4l8P9hO6o>                                                                | 2026-09-16                 | B          | Firefox on-device intent                       |
| <https://developer.apple.com/forums/thread/775699>                                                                                    | 2025                       | D          | Safari interimResults / cloud fallback         |
| <https://www.apple.com/legal/privacy/data/en/ask-siri-dictation/>                                                                     | fetched 2026-11-21         | A          | dictation on-device indicator                  |
| <https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis>                                                                    | fetched 2026-11-21         | A          | Baseline status                                |
| <https://developer.chrome.com/blog/chrome-71-deps-rems/>                                                                              | 2018                       | A          | speak() needs user activation                  |
| <https://developer.apple.com/forums/thread/764438>                                                                                    | 2024                       | D          | iOS 18 voice list regression                   |
| <https://raw.githubusercontent.com/open-webui/open-webui/main/backend/open_webui/routers/audio/__init__.py>                           | main, fetched 2026-11-21   | A          | engines, AAC transcode, keys returned to admin |
| <https://docs.openwebui.com/reference/env-configuration.md>                                                                           | fetched 2026-11-21         | A          | PersistentConfig behaviour                     |
| <https://raw.githubusercontent.com/immich-app/immich/main/server/src/dtos/config.dto.ts>                                              | main, fetched 2026-11-21   | A          | `mapAdminConfig` returns secrets               |
| <https://docs.immich.app/install/config-file>                                                                                         | fetched 2026-11-21         | A          | config file makes UI read-only                 |
| <https://community.home-assistant.io/t/wth-2025-a-secret-is-secret-why-are-passwords-in-plain-text-in-the-config-entries-file/809838> | 2024-12                    | D          | plaintext config entries, rationale            |
| <https://www.home-assistant.io/docs/configuration/secrets/>                                                                           | fetched 2026-11-21         | A          | secrets.yaml scope                             |
| <https://docs.nextcloud.com/server/latest/developer_manual/digging_deeper/config/appconfig.html>                                      | fetched 2026-11-21         | A          | sensitive app config values                    |
| <https://www.librechat.ai/docs/configuration/dotenv>                                                                                  | fetched 2026-11-21         | A          | CREDS_KEY/CREDS_IV                             |
| <https://www.librechat.ai/docs/configuration/stt_tts>                                                                                 | fetched 2026-11-21         | A          | speech config via env/YAML, allowedAddresses   |
| <https://grafana.com/developers/plugin-tools/how-to-guides/data-source-plugins/add-authentication-for-data-source-plugins>            | fetched 2026-11-21         | A          | write-only secureJsonData pattern              |
| <https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html>                                                      | fetched 2026-11-21         | A          | re-authentication guidance                     |
| <https://github.com/OWASP/ASVS/blob/v4.0.3/4.0/en/0x12-V3-Session-management.md>                                                      | v4.0.3                     | A          | ASVS 3.7.1                                     |
| <https://www.home-assistant.io/integrations/wyoming/>                                                                                 | fetched 2026-11-21         | A          | HA local voice pipeline prior art              |
