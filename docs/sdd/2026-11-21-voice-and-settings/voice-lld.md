# Voice and settings: LLD

<!-- cspell:ignore Groq groq kbit -->

- Status: Built, revised after code review
- Date: 2026-11-21
- Governs: [plan](plan.md) Delivery 1
- Requirements: [FRD](frd.md) S1, S2, V1 to V7, E1, E2, rulings 1 to 4; [HLA](hla.md)

This settles what the HLA leaves open. Code and public docs written from it state behavior in their
own words, without requirement or ruling numbers.

## Database

Migration 4, STRICT, adds one table and changes nothing that exists:

```sql
-- What Settings last saved for voice: at most one row. base_url and model
-- are the values in effect when it was saved, including any the server's
-- environment supplied, so the row always records the address its key was
-- entered for.
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

## The environment

Three variables may each supply one field, exactly as entering it in Settings would (ruling 3):
`AGENTION_TRANSCRIPTION_URL`, `AGENTION_TRANSCRIPTION_MODEL` and `AGENTION_TRANSCRIPTION_KEY`.

- **At start:** `agention serve` reads them once and holds each to the same bounds and base URL
  rule. A value that breaks them stops the server with a message that names the variable and never
  shows its value. `AGENTION_TRANSCRIPTION_KEY` without `AGENTION_TRANSCRIPTION_URL` stops it too,
  so a key from the environment only ever goes to an address from it.
- **What is in effect:** for the base URL and the model, the environment's value, else the row's.
  Voice is on while both exist.
- **Which key is used:** the environment's key when it gives one. Otherwise the row's key, but only
  while the base URL in effect equals the row's `base_url`, the address it was entered for. A
  changed or newly set `AGENTION_TRANSCRIPTION_URL` therefore never carries a saved key to a new
  address; Settings says the saved key is unused, and the operator enters it again.
- **Saving:** `POST /settings/voice` leaves out the fields the environment supplies, and one that
  carries such a field is `invalid_input`. The server writes the row with the base URL and model
  then in effect, the environment's included, so both are always set. The row's key is, on every
  save:
  - the key the request gives, when it gives one;
  - otherwise the stored key, only if the `base_url` being written equals the stored one;
  - otherwise none. The environment's key is never written to the row, so it never reaches a backup.

  The comparison is against what is written, not what the request carries, so a save of only the
  prompt under a changed `AGENTION_TRANSCRIPTION_URL` drops the unused key rather than binding it to
  the new address.

- **In Settings:** every field the environment supplies is shown, read-only, with "Set by the
  server's environment": the base URL and model as their values, and a key masked. A masked key
  shows that a key is there and nothing of the key itself, since no part of a key ever reaches a
  browser (ruling 7, after release, shows its last four characters). With the base URL from the
  environment, Turn off reads Clear saved settings, which deletes the row and any saved key, and the
  section says that voice stays on until the variable is removed and the server restarted.
- **Backups** carry the row, never the environment, which stays with the service unit.
- **Documentation:** they are the server's first environment variables. The operator guide gives
  them in a mode-0600 environment file for the service unit, not inline, and `agention serve --help`
  names them.

## Bounds

Checked at the web boundary by schemas in `packages/api` (`settings.ts`), as every web route's are:

- `base_url`: at most 2,048 characters, and the base URL rule below.
- `model`: 1 to 200 characters of printable ASCII.
- `prompt`: at most 500 code points of plain text, optional.
- `api_key`: 1 to 1,024 characters of printable ASCII without spaces, optional.

## The base URL rule

A base URL is an absolute URL with no user, password, query or fragment. Its path is kept (for
example `/v1`). It is kept as the WHATWG URL parser serializes it, with trailing slashes removed,
when it is saved or read from the environment, and every comparison (with a stored base URL or a
preset's) is between those forms, so `https://api.openai.com/v1/` is the OpenAI preset's address.
The rule runs on the hostname as the WHATWG URL parser normalizes it, and an IPv4-mapped IPv6
address (`[::ffff:a9fe:a9fe]`) is judged as the IPv4 address it maps.

- **`https:`:** any host.
- **`http:`:** only for a host on the operator's own network:
  - `localhost`;
  - or an IP literal in 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, the tailnet's
    100.64.0.0/10, or fc00::/7.

  A name other than `localhost` must use `https:`. A local server can be reached by its address, or
  by `https:` through `tailscale serve`.

- **Never**, over either scheme:
  - link-local addresses (169.254.0.0/16, fe80::/10), which hold most cloud metadata services;
  - the metadata services outside them: `fd00:ec2::254`, `fd20:ce::254` and `100.100.100.200`;
  - 0.0.0.0/8, `::` and multicast.

  The server checks addresses with `net.BlockList`; the browser only normalizes the URL, so an
  address the rule refuses shows when Settings saves. A host name over `https:` is not resolved and
  checked: what keeps a request to a name honest is TLS verification of that name.

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
  the call to the provider. That relies on `@hono/node-server` aborting the request's signal when
  the browser disconnects; the client test settles it, and if it does not, the route listens for the
  incoming request's `close` instead.
- **Presets**, which fill the base URL and model in the form:

  | Preset          | Base URL                         | Model                    | Key      | What Settings say about the audio           |
  | --------------- | -------------------------------- | ------------------------ | -------- | ------------------------------------------- |
  | OpenAI          | `https://api.openai.com/v1`      | `gpt-transcribe`         | Required | Goes to OpenAI, with a link to its data use |
  | Groq            | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | Required | Goes to Groq, with a link to its data use   |
  | Your own server | entered                          | entered                  | Optional | Goes to the address entered                 |

  OpenAI comes first (ruling 1). A saved configuration shows as OpenAI or Groq only when its base
  URL is exactly that preset's; any other base URL shows as the address it is. "Required" is
  enforced on save: a save whose base URL in effect is a preset's, leaving no key in effect (none
  given, none kept by the rule under The environment, none from the environment), is
  `invalid_input`. It is not checked at start, so the environment may give a preset's base URL while
  Settings gives the key. With an `http:` base URL, Settings says that the key and the audio cross
  the local network unencrypted.

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

| Route                        | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /settings`              | `{ voice }`: `voice` as `{ on, base_url, model, prompt, key, from_environment }`, or `null` when neither the row nor the environment gives anything. `base_url` and `model` are those in effect, or `null`; `key` describes the saved key: `none`, `set`, or `unused` (a saved key for another address). A stored row that no longer passes the rules shows as invalid, with Clear, rather than failing the read; `from_environment` lists the fields the environment supplies |
| `POST /settings/voice`       | Sets the base URL, model and prompt, and the key when given, leaving out the fields the environment supplies. Needs a recent sign-in. Keeps the stored key only when no key is given and the base URL written equals the stored one                                                                                                                                                                                                                                            |
| `POST /settings/voice/clear` | Deletes the row and its key, which turns voice off unless the environment gives a base URL and model. Needs a recent sign-in                                                                                                                                                                                                                                                                                                                                                   |
| `POST /transcriptions`       | The body is the recording, `Content-Type` `audio/webm`, `audio/mp4` or `audio/ogg` (codecs parameters allowed), within the API's 2 MiB body cap. Refuses one under 1,000 bytes as `invalid_input`. Answers `{ text }`                                                                                                                                                                                                                                                          |

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

- **Recent sign-in:** the view reads `recent` where the Passkeys view already does, from
  `GET /passkeys`. Where a change needs a recent sign-in that the operator no longer has, the
  section first shows the Passkeys view's existing Sign in again control, so both sections behave
  alike.
- **Voice, off:** a sentence on what voice does and that a provider will receive the audio, and Set
  up.
- **Voice, the form:**
  - preset: OpenAI, Groq, or Your own server;
  - base URL and model, filled by the preset and editable;
  - prompt: "words to recognize, such as names";
  - key, write-only: a saved key shows masked, as an environment key does, with Replace; or "the
    saved key was for another address" when it is unused; or empty when there is none.

  A field the environment supplies is shown read-only instead (see The environment).

  Below them, where the audio goes. Then Save, and Turn off.

- **Try it:** once voice is saved, a microphone control in the section records and shows the
  transcript there. It runs through the same path as the composer, so it tests the configuration
  that dictation will use.

### Dictation

- **When it shows:** the thread page reads `GET /settings` when it opens. The microphone shows
  beside Send when voice is on and the browser has `getUserMedia` and a `MediaRecorder` that records
  `audio/webm;codecs=opus`, `audio/mp4` or `audio/ogg;codecs=opus`, tried in that order.
- **Recording:** one at a time, with `audioBitsPerSecond` 32,000, about 1.2 MB for five minutes.
  - `MediaRecorder.start(1000)`, so data arrives each second and the size can be counted.
  - The recorder shows elapsed time against 5:00.
  - It stops at 5:00 by the clock, at 1.9 MiB of data, when the page is hidden, or when the composer
    goes away, and stops every track when it does.
  - A stop on a hidden page transcribes what was recorded, as Stop does; a failure falls to Retry.
  - A refused or missing microphone says which.
- **The upload** declares the type the recorder was asked for, with its codecs, not `blob.type`.
- **The stale check:** starting a recording counts as the composer seeing the thread at that point,
  so the existing stale-write check on Send catches a message that lands during the recording. A
  recording, or one awaiting Retry, holds the draft open: the composer's basis effect keeps the
  basis while one exists, as it does while text is staged.
- **Where it shows:** the dictation controls, and what answers them (a failure, "Nothing heard"),
  sit in the composer's sticky Send row beside Send's own, so the page keeps them in view.
- **Focus** moves to the next state's main control as the controls change, and the start of a
  recording is announced once.
- **Transcribing:** shows "Transcribing", with Cancel, which aborts the request and discards the
  recording.
  - The text goes in at the caret of the box that last had focus (the message, or its detail).
  - A space goes on each side where it meets other text, and that box keeps focus.
  - An empty transcript inserts nothing and says "Nothing heard", and so does a recording too short
    to send (under 1,000 bytes), without uploading it.
  - If the draft was sent or the thread left in the meantime, the text is dropped.
- **Failure:** says why, and keeps the draft as it was. Any failure counts, including an answer that
  is not the API's JSON (Node's own 408 when the upload outlasts the server's 30-second request
  deadline). The recording stays in the page for Retry, beside Discard. Nothing is ever sent without
  the operator pressing Send.
- **The deadline** gives the upload 30 seconds: a five-minute recording needs about 330 kbit/s of
  uplink, and one stopped at 1.9 MiB about 530 kbit/s. Slower links fail with the recording kept.

### Read aloud

- A message's options gain Read aloud wherever `speechSynthesis` exists, on replaced messages too.
- It speaks the message as words:
  - its text and detail, through the existing `parseMarkdown`, then a walk of its own over the
    top-level blocks that calls `plainText` for each block's inline text, with a pause between
    blocks, and "code block" or "diagram" in place of their contents (`plainText` itself is
    unchanged);
  - then each ask ("Ask 1: question. Options: …");
  - and each answer ("Answered: label").
- It speaks a sentence at a time, in the browser's default voice for the page's language, and the
  option reads Stop while it speaks. Leaving the thread, starting a recording, or reading another
  message aloud stops it.

## Testing

- **Migration:** a database at migration 3 opened at HEAD, untouched but for the new table.
- **Store and routes:**
  - the bounds and the base URL rule, its ranges and refusals;
  - the key never in any answer or log;
  - `not_allowed` without a recent sign-in;
  - a changed base URL clearing the key;
  - `not_found` while off;
  - the 2 MiB cap, the small-body refusal and the content types;
  - every route unknown on the agent mount;
  - a preset's base URL refused without a key.
- **The environment:**
  - start refused for a value out of bounds, a base URL the rule refuses, and a key without a URL,
    each naming the variable and never printing its value;
  - environment values in effect over the row's, shown in `from_environment`, and a save carrying
    one refused;
  - a save writing the values in effect into the row;
  - a saved key unused once the base URL in effect differs from the row's, and used again when they
    match;
  - a save without a key under a changed environment base URL dropping the stored key;
  - no environment key ever written to the row;
  - `GET /settings` with only an environment base URL, and Clear saved settings leaving voice on
    under one.
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
  - Cancel, Retry and Discard, a non-JSON failure, and a hidden-page stop transcribing;
  - where focus lands as the controls change;
  - an empty transcript;
  - a recording keeping the stale-check basis on an empty composer;
  - read aloud's words for text, asks and answers, and a second message stopping the first.
- **Browser (Chromium, in the gate):**
  - the Settings view, and `/passkeys` leading there;
  - dictation end to end with Chromium's fake microphone through the stub provider: the text lands
    at the caret, and nothing is sent;
  - read aloud offered and stopped.
- **WebKit:** not in CI, whose gate installs Chromium only. The live run drives Playwright's WebKit
  where it installs, for the Settings view and read aloud. Dictation there is the gap ruling 2 asks
  to name, since only Chromium has a fake microphone.
