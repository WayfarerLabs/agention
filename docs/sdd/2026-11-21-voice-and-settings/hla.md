# Voice and settings: High-Level Architecture

<!-- cspell:ignore Groq groq kbit -->

- Status: Draft
- Date: 2026-11-21
- Requirements: [FRD](frd.md), S1, S2, V1 to V7, E1, E2, and its rulings
- Research: [prior-art research](prior-art-research.md)

This effort adds three things to the Agention v1 web UI and server: a Settings view that gathers
what the operator configures; an optional transcription provider, configured there and called only
by the server; and two ways of using voice in the browser, dictation into the composer and reading a
message aloud. Nothing on the agent side changes.

## Decisions at a glance

- **The server transcribes** (ruling 1). The browser records and sends the audio to Agention, and
  Agention calls the provider with the key it holds, returning only text. The key never reaches a
  browser, and no provider origin enters the app's content security policy.
- **One provider interface:** the OpenAI-compatible `POST {base}/audio/transcriptions`, with presets
  for OpenAI (first, ruling 1), Groq, and a server on the operator's own network. Built-in `fetch`
  and `FormData`; no provider SDK.
- **Settings live in the database**, in one new table, the provider key among them, so a backup
  carries them and restoring brings voice back. An environment variable may supply the key instead,
  and then wins and shows as managed by the environment.
- **A secret changes only after a recent sign-in**, reusing the ten-minute window that adding or
  removing a passkey already needs.
- **Read aloud stays in the browser:** `speechSynthesis`, on demand, no server part.
- **No audio is stored anywhere**, and nothing about it reaches agents.

## Where transcription runs

|                  | Server relays (chosen)                                     | Browser calls the provider      | Browser speech recognition                                 | Model inside Agention        |
| ---------------- | ---------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| Key              | Stays on the server                                        | Sent to every signed-in browser | None                                                       | None                         |
| App's CSP        | Unchanged (`connect-src 'self'`)                           | Gains each provider's origin    | Unchanged                                                  | Unchanged                    |
| Where audio goes | Server, then the chosen provider                           | The chosen provider             | Google (Chrome) or undocumented (Safari); Firefox lacks it | Stays on the server          |
| Latency added    | One hop for a small clip, well under a second on a tailnet | None                            | None                                                       | Seconds of CPU per clip      |
| New surface      | One operator-only endpoint                                 | Key exposure in the browser     | None                                                       | Native code, model downloads |

The relay is the only option that keeps the key out of browsers and lets the operator choose where
audio goes. Its cost is one endpoint and one hop. The server streams the upload to the provider
rather than holding it, decodes no audio, and keeps nothing.

## Components

### Server

- **Settings store** (migration 4): a `settings` table of named values, holding the voice
  configuration: preset, base URL, model, optional prompt, and the key. Values the operator sets are
  validated at the boundary. The key is read only by the transcription client.
- **Web routes**, all on the web mount behind the operator's sign-in, Origin and CSRF checks, and
  none on the agent mount:
  - `GET /settings` returns the voice configuration without the key: whether one is set, and whether
    the environment supplies it.
  - `POST /settings/voice` sets the configuration. Changing the base URL or the key needs a recent
    sign-in, and changing the base URL clears a stored key.
  - `POST /settings/voice/test` transcribes a short clip the server ships, to confirm the setup.
  - `POST /transcriptions` takes one recording (`audio/webm` or `audio/mp4`, within its own size
    cap, above the API's general body cap) and answers with its text, or refuses while voice is off.
- **Transcription client:** one adapter for the OpenAI-compatible interface. It sends the recording
  unchanged with the model and optional prompt, times out, maps the provider's failures to the API's
  error codes without echoing the provider's body, and never logs the key or the audio.
- **Rate limit:** transcriptions share the web mount's limiter with a bucket of their own.
- **Security headers:** `Permissions-Policy: microphone=(self)` on the app, and nothing else
  widened. The diagram frame stays as it is.

### Web UI

- **Settings view** at `/settings`, in the navigation beside Threads and Sessions, with three
  sections: Passkeys (today's Passkeys view, moved whole), Voice, and Sign out (moved from the
  header). `/passkeys` keeps working as a link into the Passkeys section, since
  `agention passkey-link` and the docs name it.
- **Voice section:** a preset, base URL, model and prompt, a write-only key field showing only
  whether a key is set (or that the environment manages it), Test, Clear, and what the chosen
  provider does with audio, linked to its terms. Saving a secret change asks for a fresh sign-in
  when the current one is no longer recent.
- **Dictation:** while voice is on, the composer shows a microphone control. It records with
  `MediaRecorder` (WebM/Opus where the browser has it, else MP4/AAC), shows elapsed time against the
  limit, stops all tracks when done, uploads, and inserts the text at the cursor. A failure says why
  and leaves the draft as it was. Nothing sends by itself.
- **Read aloud:** a message's options gain Read aloud, which speaks the message's text, Markdown
  reduced to words, through `speechSynthesis` on the device, with Stop while speaking. It is offered
  only where the browser has speech synthesis.

### Agents

Unchanged: no agent route, tool, answer or API version changes.

## Security model additions

- **The provider key** is a secret like the server's own: held by the server, never sent to a
  browser or an agent, never logged. Backups contain it, and are owner-only files already.
- **Where audio goes** is the operator's choice, made in Settings and stated there. The server sends
  a recording only to the configured provider, only when the operator's sign-in asks, and keeps none
  of it.
- **The base URL** is operator-set and needs a recent sign-in to change, so a stolen session cannot
  quietly redirect audio or the key elsewhere. Changing it clears the key.
- **Agents** cannot reach any of it: every route is on the web mount, and the agent mount's tests
  check each is unknown there.

## Testing

- **Store and routes:** the settings' bounds, the write-only key, the recent sign-in rule, clearing
  the key on a base URL change, the environment override, every route unknown on the agent mount.
- **Transcription client:** against a local stub provider: the multipart request, timeouts, error
  mapping, the size cap, no logging of key or audio.
- **Browser:** the Settings view and the moved passkeys and sign-out; dictation with Chromium's fake
  microphone through a stub provider, text inserted at the cursor and nothing sent; read aloud
  offered and stopped. WebKit runs where Playwright's WebKit build can, for the Apple world (ruling
  2).
- **Real devices:** the operator's Android Chrome and Windows Edge and Chrome, against the staging
  server with a real provider.
