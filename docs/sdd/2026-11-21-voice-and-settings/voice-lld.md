# Voice and settings: LLD

<!-- cspell:ignore Groq groq kbit -->

- Status: Draft
- Date: 2026-11-21
- Governs: [plan](plan.md) Delivery 1
- Requirements: [FRD](frd.md) S1, S2, V1 to V7, E1, E2, rulings 1 and 2; [HLA](hla.md)

This settles what the HLA leaves open. Code and public docs written from it state behavior in their
own words, without requirement or ruling numbers.

## Database

Migration 4, STRICT, times in Unix milliseconds, adds one table and changes nothing that exists:

```sql
-- The voice configuration: at most one row. No row means voice is off.
CREATE TABLE voice_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  preset TEXT NOT NULL,          -- 'openai', 'groq' or 'custom'
  base_url TEXT NOT NULL,        -- https, or http only to a loopback or private address
  model TEXT NOT NULL,
  prompt TEXT,                   -- optional vocabulary hint, at most 500 code points
  api_key TEXT,                  -- absent for a server that needs none
  updated_at INTEGER NOT NULL
) STRICT;
```

A typed row rather than a table of named values: each area that later gains settings (notifications
next) brings its own table, with its own constraints, rather than sharing untyped values. Clearing
voice deletes the row. A 0.4 server refuses the database once migration 4 has run, as for every
migration.

## The provider

- **Interface:** `POST {base_url}/audio/transcriptions`, `multipart/form-data` with `file` (the
  recording, named `audio.webm` or `audio.m4a` by its type), `model`, `response_format=json`, and
  `prompt` when set; `Authorization: Bearer <key>` when a key is set. The answer's `text` is the
  transcript; anything else is a failure.
- **Presets**, OpenAI first (ruling 1):

  | Preset | Base URL                         | Model                    | Terms link                         |
  | ------ | -------------------------------- | ------------------------ | ---------------------------------- |
  | OpenAI | `https://api.openai.com/v1`      | `gpt-transcribe`         | OpenAI's API data usage page       |
  | Groq   | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | Groq's data processing page        |
  | Custom | entered by the operator          | entered by the operator  | none; the UI says audio goes there |

  A preset fills the base URL and model, which the operator may still change; the preset records
  which terms link to show. The links live in the web UI's code beside the presets.

- **Base URL rule:** `https:` anywhere, or `http:` only to a loopback or private address (a local
  transcription server on the operator's network). The server resolves nothing to enforce this
  beyond parsing the URL's host literal or name; a name that is not an IP literal must use `https:`.
- **Limits:** a recording is at most 8 MiB (about 5 minutes of MP4/AAC at 192 kbit/s; WebM/Opus is
  far smaller); the request to the provider times out after 60 seconds; the provider's answer is
  read up to 1 MiB.
- **Failures** map to a new web-only error code, `provider_failed` (502), whose message says only
  what kind of failure it was: unreachable, timed out, refused the key (401 or 403), rate-limited
  (429), or another status. The provider's body is never passed on and never logged.

## Errors

Two new codes, sent only on the web mount (the bridge never reads codes):

| Code              | Status | When                                                       |
| ----------------- | ------ | ---------------------------------------------------------- |
| `not_configured`  | 409    | A transcription is asked for while voice is off            |
| `provider_failed` | 502    | The provider could not be reached or did not answer usably |

A secret change without a recent sign-in is `not_allowed` (403), as for passkeys, and the web UI
answers it by asking for a fresh sign-in and retrying.

## Web routes

All on the web mount, behind the operator's sign-in, Origin and CSRF checks; each is unknown on the
agent mount, which the existing test asserts.

| Route                        | Does                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /settings`              | The voice configuration without the key: `preset`, `base_url`, `model`, `prompt`, `key: "none" \| "set" \| "environment"`, or `voice: null` when off                                             |
| `POST /settings/voice`       | Sets preset, base URL, model and prompt, and the key when given; a recent sign-in for a new key or a changed base URL, and a changed base URL clears a stored key unless a new one comes with it |
| `POST /settings/voice/clear` | Turns voice off; needs a recent sign-in when a stored key is cleared with it                                                                                                                     |
| `POST /settings/voice/test`  | Sends the provider one second of generated silence as WAV and answers `{ ok: true }` or `provider_failed`                                                                                        |
| `POST /transcriptions`       | The body is the recording, `Content-Type` `audio/webm` or `audio/mp4` (codecs parameters allowed), at most 8 MiB; answers `{ text }`                                                             |

`POST /transcriptions` is exempt from the API's 2 MiB body cap and has its own 8 MiB cap, refused as
413 like the general one. Its body streams to the provider. It spends a new rate budget,
`transcribe`, burst 10, one token per 30 seconds, shared across the operator's sessions.

## The environment

`AGENTION_TRANSCRIPTION_KEY`, when set and non-empty, is the key: it wins over a stored one, which
stays stored but unused, and `GET /settings` says `key: "environment"`. The web UI shows the key as
managed by the server's environment and offers no key field. The operator guide names the variable
beside the service setup. Only the key comes from the environment; the rest is set in the UI.

## Web UI

- **Navigation:** Threads, Sessions, Settings. `/settings` holds three sections in order: Voice,
  Passkeys, Sign out. `/passkeys` routes to `/settings#passkeys`, scrolled to that section. The
  header loses its Sign out.
- **Voice section, voice off:** a short explanation of what voice does and where audio would go, and
  a Set up control opening the form.
- **The form:** preset (OpenAI, Groq, Custom), base URL and model (filled by the preset), prompt
  (optional, "words to recognize, such as names"), key (write-only: empty field with "a key is set"
  when one is), the provider's terms link or, for Custom, that audio goes to the address entered;
  Save, Test, and Turn off.
- **Recent sign-in:** a save that the server refuses as `not_allowed` for want of a recent sign-in
  shows "Confirm it's you" and runs the passkey sign-in, then retries the save once.
- **Composer, voice on:** a microphone button beside Send. Pressed: asks for the microphone, records
  (`audio/webm;codecs=opus`, else `audio/mp4`), and shows elapsed time against 5:00 with Stop and
  Cancel; recording stops by itself at 5:00. Stop uploads and shows "Transcribing"; the text arrives
  at the caret, separated by a space from text around it, and the composer keeps focus. Cancel or a
  failure discards the recording and leaves the draft as it was, with the failure's words. Every
  track stops when recording ends.
- **Read aloud:** the message's options menu gains Read aloud where `speechSynthesis` exists. It
  speaks the message's text and detail, rendered to plain words (code blocks read as "code block",
  diagrams as "diagram"), in the browser's default voice for the page's language, and changes to
  Stop while speaking. Leaving the thread stops it.

## Security headers

`Permissions-Policy: microphone=(self)` joins the app's headers. The diagram frame keeps its own
headers, and its sandbox already denies it the microphone.

## Testing

- **Migration:** a 0.4 database opened at HEAD, untouched except for the new table.
- **Store:** one row at most, bounds, clearing.
- **Routes:**
  - the key never appears in any answer;
  - `not_allowed` without a recent sign-in for a new key or a changed base URL;
  - a changed base URL clearing the key;
  - the environment override;
  - `not_configured` while off;
  - the 8 MiB cap and the content types;
  - the `transcribe` budget;
  - every route unknown on the agent mount.
- **Client** against a local stub provider:
  - the multipart fields and the bearer header;
  - the timeout;
  - each failure kind mapped;
  - a provider body never echoed;
  - the log carrying neither key nor audio.
- **Web units:** the Settings view's states, the write-only key, the recent sign-in retry, the
  composer's insertion at the caret, and failures keeping the draft.
- **Browser (Chromium):**
  - the Settings view with the moved Passkeys and Sign out, and `/passkeys` leading there;
  - dictation end to end with `--use-fake-device-for-media-stream` through the stub provider;
  - read aloud offered and stopped;
  - WebKit for the same where Playwright's WebKit build supports it, and said where it does not.
