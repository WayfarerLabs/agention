# Voice and settings: High-Level Architecture

<!-- cspell:ignore Groq groq kbit -->

- Status: Built, revised after code review
- Date: 2026-11-21
- Requirements: [FRD](frd.md), S1, S2, V1 to V7, E1, E2, and its rulings
- Research: [prior-art research](prior-art-research.md)

This effort adds three things to the Agention v1 web UI and server:

- a Settings view that gathers what the operator configures;
- an optional transcription provider, configured there and called only by the server;
- two ways of using voice in the browser: dictation into the composer, and reading a message aloud.

Nothing on the agent side changes.

## Decisions at a glance

- **The server transcribes** (ruling 1). The browser records and sends the audio to Agention, and
  Agention calls the provider with the key it holds, returning only text. The key never reaches a
  browser, and no provider origin enters the app's content security policy.
- **One provider interface:** the OpenAI-compatible `POST {base}/audio/transcriptions`.
  - Presets cover OpenAI (first, ruling 1), Groq, and a server on the operator's own network.
  - It is built on `fetch` and `FormData`, with no provider SDK.
- **Settings live in the database:** one new typed table, `voice_settings`, holding the base URL,
  model, prompt and key, so a backup carries what Settings saved and a restore brings it back. The
  provider is worked out from the base URL, never stored apart from it.
- **The environment may supply the base URL, model and key** (ruling 3), the server's first
  environment variables, read at start under the same rules as Settings. A value from the
  environment wins, shows read-only in Settings, and stays with the service unit rather than in
  backups. A key saved in Settings is used only at the base URL it was entered for, so a new address
  from the environment never receives it.
- **Every voice change needs a recent sign-in**, the ten-minute window that adding or removing a
  passkey already needs, and changing the base URL clears the key.
- **The recording fits the existing request limits.** Recording at 32 kbit/s keeps five minutes
  (about 1.2 MB) under the API's 2 MiB body cap, so no route is exempt from it or from the 30-second
  request deadline. That deadline asks about 330 kbit/s of uplink for five minutes; a slower upload
  fails with the recording kept for a retry.
- **Read aloud stays in the browser:** `speechSynthesis`, on demand, no server part.
- **No audio is stored anywhere**, and nothing about it reaches agents.
- **A new ADR** records the relay, the server's environment variables, and the first optional paid
  service. ADR 0001 says Agention uses no paid services; the new ADR narrows that to none by
  default, with the operator opting into one here, and ADR 0001's line is marked superseded by it.

## Where transcription runs

|                  | Server relays (chosen)           | Browser calls the provider      | Browser speech recognition                                 | Model inside Agention        |
| ---------------- | -------------------------------- | ------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| Key              | Stays on the server              | Sent to every signed-in browser | None                                                       | None                         |
| App's CSP        | Unchanged (`connect-src 'self'`) | Gains each provider's origin    | Unchanged                                                  | Unchanged                    |
| Where audio goes | Server, then the chosen provider | The chosen provider             | Google (Chrome) or undocumented (Safari); Firefox lacks it | Stays on the server          |
| Latency added    | One hop for up to 1.9 MiB        | None                            | None                                                       | Seconds of CPU per clip      |
| New surface      | One operator-only endpoint       | Key exposure in the browser     | None                                                       | Native code, model downloads |

The relay is the only option that keeps the key out of browsers and lets the operator choose where
audio goes. Its cost is one endpoint and one hop. The server reads the recording within the API's
body cap, sends it on, decodes no audio, and keeps nothing.

## Components

### Server

- **Settings store** (migration 4): `voice_settings`, at most one row: what Settings last saved,
  with the base URL its key was entered for. Voice is on while a base URL and a model are in effect,
  from the row or the environment. The key is read only by the transcription client.
- **Web routes**, all on the web mount behind the operator's sign-in, Origin and CSRF checks, and
  none on the agent mount:
  - `GET /settings`: the voice configuration without the key, saying only whether one is set.
  - `POST /settings/voice` and `POST /settings/voice/clear`: set or turn off voice.
  - `POST /transcriptions`: one recording in, its text out, or `not_found` while voice is off.
- **Transcription client:** one interface, "transcribe this recording", implemented once, for the
  OpenAI-compatible API (ruling 4). A provider with an API of its own would add an implementation, a
  preset, and a column naming which kind a configuration uses.
  - It checks the base URL rule before each request and refuses redirects.
  - It times out, and aborts if the browser abandons the request.
  - It maps the provider's failures to `provider_failed` without echoing the provider's body, and
    never logs the key or the audio.

### Web UI

- **Settings view** at `/settings`, in the navigation beside Threads and Sessions, with three
  sections:
  - Passkeys, today's Passkeys view moved whole;
  - Voice;
  - Sign out, moved from the header.

  `/passkeys` routes to it, as `/registrations` routes to Sessions. Both sections that need a recent
  sign-in show the same Sign in again control first.

- **Voice section:** a preset, base URL, model and prompt, and a write-only key field. Below them,
  where the audio goes, said by the preset or the address. Save, Turn off, and Try it, which records
  and transcribes through the dictation path itself.
- **Dictation:** while voice is on, the composer shows a microphone control.
  - It records with `MediaRecorder` at 32 kbit/s, WebM/Opus, MP4/AAC or Ogg/Opus as the browser
    allows, and stops at five minutes or 1.9 MiB.
  - Starting a recording counts as seeing the thread, for the stale-write check.
  - The text goes in at the caret.
  - A failure keeps the draft, and the recording for a retry.
  - Nothing sends by itself.
- **Read aloud:** a message's options gain Read aloud. It speaks the message's text, detail, asks
  and answers as words, a sentence at a time, through `speechSynthesis` on the device, with Stop. It
  is offered only where the browser has speech synthesis.

### Agents

Unchanged: no agent route, tool, answer or API version changes.

## Security model additions

- **The provider key** is a secret like the server's own: held by the server, never sent to a
  browser or an agent, never logged. Backups contain a key saved in Settings, and are owner-only
  files already; a key from the environment lives in the service unit's owner-only environment file.
  A saved key goes only to the base URL it was entered for.
- **Where audio goes** is the operator's choice, made in Settings and stated there. The server sends
  a recording only to the configured provider, only when the operator's sign-in asks, and keeps none
  of it.
- **The base URL** is operator-set and needs a recent sign-in to change, so a stolen session cannot
  quietly redirect audio or the key elsewhere.
  - Changing it clears the key.
  - It allows plain `http` only to the operator's own network, and never to link-local addresses or
    a cloud metadata service.
  - It carries no user, query or fragment, and its requests follow no redirects.
- **Agents** cannot reach any of it: every route is on the web mount, and the agent mount's tests
  check each is unknown there.

## Testing

The [LLD](voice-lld.md) lists the tests. In outline:

- the store, routes and client against a local stub provider;
- web units;
- Chromium browser tests, with its fake microphone, in the gate;
- WebKit in the live run where it installs;
- the operator's Android Chrome and Windows Edge and Chrome against the staging server, with a real
  provider.
