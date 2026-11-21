# Voice and settings: LLD

<!-- cspell:ignore Groq groq kbit -->

- Status: Draft, revised after design review
- Date: 2026-11-21
- Governs: [plan](plan.md) Delivery 1
- Requirements: [FRD](frd.md) S1, S2, V1 to V7, E1, E2, rulings 1 and 2; [HLA](hla.md)

This settles what the HLA leaves open. Code and public docs written from it state behavior in their
own words, without requirement or ruling numbers.

## Database

Migration 4, STRICT, adds one table and changes nothing that exists:

```sql
-- The voice configuration: at most one row. No row means voice is off.
CREATE TABLE voice_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT,
  api_key TEXT
) STRICT;
```

It is a typed row, as `instance` is, rather than a table of named values: each later area with
settings brings its own table.

- Turning voice off deletes the row.
- Which provider a row means is worked out from its base URL, never stored apart from it. What
  Settings say about where audio goes therefore always matches where it goes.
- A server older than migration 4 refuses the database once it has run, as for every migration.

## Bounds

Checked at the web boundary by schemas in `packages/api` (`settings.ts`), as every web route's are:

- `base_url`: at most 2,048 characters, and the base URL rule below.
- `model`: 1 to 200 characters of printable ASCII.
- `prompt`: at most 500 code points of plain text, optional.
- `api_key`: 1 to 1,024 characters of printable ASCII without spaces, optional.

## The base URL rule

A base URL is an absolute URL with no user, password, query or fragment. Its path is kept (for
example `/v1`).

- **`https:`:** any host.
- **`http:`:** only for a host on the operator's own network:
  - `localhost`;
  - or an IP literal in 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, the tailnet's
    100.64.0.0/10, or fc00::/7.

  A name other than `localhost` must use `https:`. A local server can be reached by its address, or
  by `https:` through `tailscale serve`.

- **Never**, over either scheme:
  - link-local addresses (169.254.0.0/16, fe80::/10), which include cloud metadata services;
  - 0.0.0.0, `::` and multicast.

The rule is checked when the URL is saved and again before each request. Requests refuse redirects
(`redirect: "error"`), so neither audio nor the key follows a 3xx elsewhere.

## The provider

- **Request:** `POST {base_url}/audio/transcriptions`, `multipart/form-data` built with `FormData`:
  - `file`, the recording, named `audio.webm`, `audio.m4a` or `audio.ogg` by its type;
  - `model`;
  - `response_format=json`;
  - `prompt`, when set.

  `Authorization: Bearer <key>` is sent when a key is set.

- **Answer:** JSON whose `text` is a string. That is the transcript, and it may be empty. The answer
  is read up to 1 MiB, and anything else is a failure. The server never retries.
- **Timeout:** 60 seconds, joined with the browser's request: a request the browser abandons aborts
  the call to the provider.
- **Presets**, which fill the base URL and model in the form:

  | Preset          | Base URL                         | Model                    | Key      | What Settings say about the audio           |
  | --------------- | -------------------------------- | ------------------------ | -------- | ------------------------------------------- |
  | OpenAI          | `https://api.openai.com/v1`      | `gpt-transcribe`         | Required | Goes to OpenAI, with a link to its data use |
  | Groq            | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | Required | Goes to Groq, with a link to its data use   |
  | Your own server | entered                          | entered                  | Optional | Goes to the address entered                 |

  OpenAI comes first (ruling 1). A saved configuration shows as OpenAI or Groq only when its base
  URL is exactly that preset's; any other base URL shows as the address it is.

## Errors

One new web-only code, `provider_failed` (502). Its message says which failure it was, never the
provider's body:

- the provider could not be reached, or timed out;
- the provider refused the key (401 or 403);
- the provider is rate-limiting (429);
- the provider refused the request (400 or 404), with "check the model and the base URL";
- the provider answered with status N, or with an answer that is not a transcript.

The server logs only that kind and status, never the request, the key or the audio. A failure of
`fetch` itself is caught and turned into the unreachable kind, so no stack carrying the URL is
logged.

- A transcription while voice is off is `not_found` ("voice is not set up").
- A voice change without a recent sign-in is `not_allowed` (403), as for passkeys.
- New codes are confined to the web mount, and the bridge reads only codes the agent mount sends.

## Web routes

All on the web mount, behind the operator's sign-in, Origin and CSRF checks. Each is unknown on the
agent mount, which the existing test asserts. Request and answer shapes live in `packages/api`.

| Route                        | Does                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /settings`              | `{ recent, voice }`: whether the sign-in is recent, and `voice` as `{ base_url, model, prompt, key_set }`, or `null` when off                                                                                         |
| `POST /settings/voice`       | Sets the base URL, model and prompt, and the key when given. Needs a recent sign-in. A changed base URL without a new key clears the stored key                                                                       |
| `POST /settings/voice/clear` | Turns voice off, deleting the row and its key. Needs a recent sign-in                                                                                                                                                 |
| `POST /transcriptions`       | The body is the recording, `Content-Type` `audio/webm`, `audio/mp4` or `audio/ogg` (codecs parameters allowed), within the API's 2 MiB body cap. Refuses one under 1,000 bytes as `invalid_input`. Answers `{ text }` |

The recording fits the existing body cap (see Dictation), so no route is exempt from it, and the
body-size checks stay ahead of authentication as they are.

Transcriptions spend no rate budget. The budgets guard against failed authentication and agents'
submissions, and a signed-in operator dictating is neither. A provider's own rate limit answers as
`provider_failed`.

## Web UI

### Settings

- **Navigation:** Threads, Sessions, Settings. The header loses Sign out.
- **`/settings`** holds three sections, in order:
  - Passkeys, today's Passkeys view, whole;
  - Voice;
  - Sign out.

  `/passkeys` routes to the Settings view, as `/registrations` routes to Sessions. Focus goes to the
  view's heading, as on every navigation.

- **Recent sign-in:** the view reads `recent` from `GET /settings`. Where a change needs a recent
  sign-in that the operator no longer has, the section first shows the Passkeys view's existing Sign
  in again control, so both sections behave alike.
- **Voice, off:** a sentence on what voice does and that a provider will receive the audio, and Set
  up.
- **Voice, the form:**
  - preset: OpenAI, Groq, or Your own server;
  - base URL and model, filled by the preset and editable;
  - prompt: "words to recognize, such as names";
  - key, write-only: empty, with "a key is set" when one is.

  Below them, where the audio goes. Then Save, and Turn off.

- **Try it:** once voice is saved, a microphone control in the section records and shows the
  transcript there. It runs through the same path as the composer, so it tests the configuration
  that dictation will use.

### Dictation

- **When it shows:** the thread page reads `GET /settings` when it opens. The microphone shows
  beside Send when voice is on and the browser has `getUserMedia` and a `MediaRecorder` that records
  `audio/webm;codecs=opus`, `audio/mp4` or `audio/ogg;codecs=opus`, tried in that order.
- **Recording:** one at a time, with `audioBitsPerSecond` 32,000, about 1.2 MB for five minutes.
  - The recorder shows elapsed time against 5:00.
  - It stops at 5:00 by the clock, at 1.9 MiB of data, when the page is hidden, or when the composer
    goes away, and stops every track when it does.
  - A refused or missing microphone says which.
- **The stale check:** starting a recording counts as the composer seeing the thread at that point,
  so the existing stale-write check on Send catches a message that lands during the recording.
- **Transcribing:** shows "Transcribing", with Cancel, which aborts the request.
  - The text goes in at the caret of the box that last had focus (the message, or its detail).
  - A space goes on each side where it meets other text, and that box keeps focus.
  - If the draft was sent or the thread left in the meantime, the text is dropped.
- **Failure:** says why, and keeps the draft as it was. The recording stays in the page for one
  Retry, beside Discard. Nothing is ever sent without the operator pressing Send.

### Read aloud

- A message's options gain Read aloud wherever `speechSynthesis` exists, on replaced messages too.
- It speaks the message as words:
  - its text and detail, through the existing `parseMarkdown` and `plainText`, with a pause between
    blocks, and "code block" or "diagram" in place of their contents;
  - then each ask ("Ask 1: question. Options: …");
  - and each answer ("Answered: label").
- It speaks a sentence at a time, in the browser's default voice for the page's language, and the
  option reads Stop while it speaks. Leaving the thread, or starting a recording, stops it.

## Testing

- **Migration:** a database at migration 3 opened at HEAD, untouched but for the new table.
- **Store and routes:**
  - the bounds and the base URL rule, its ranges and refusals;
  - the key never in any answer or log;
  - `not_allowed` without a recent sign-in;
  - a changed base URL clearing the key;
  - `not_found` while off;
  - the 2 MiB cap, the small-body refusal and the content types;
  - every route unknown on the agent mount.
- **Client**, against a local stub provider:
  - the multipart fields and the bearer header;
  - redirects refused;
  - the timeout, and an abandoned request aborting the call;
  - each failure kind;
  - the answer cap and its shape;
  - no provider body echoed.
- **Web units:**
  - the Settings view's states, and the moved Passkeys and Sign out;
  - the write-only key;
  - Sign in again before a voice change;
  - insertion at the caret of the right box;
  - Cancel, Retry and Discard;
  - read aloud's words for text, asks and answers.
- **Browser (Chromium, in the gate):**
  - the Settings view, and `/passkeys` leading there;
  - dictation end to end with Chromium's fake microphone through the stub provider: the text lands
    at the caret, and nothing is sent;
  - read aloud offered and stopped.
- **WebKit:** not in CI, whose gate installs Chromium only. The live run drives Playwright's WebKit
  where it installs, for the Settings view and read aloud. Dictation there is the gap ruling 2 asks
  to name, since only Chromium has a fake microphone.
