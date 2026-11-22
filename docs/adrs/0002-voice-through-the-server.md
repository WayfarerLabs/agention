# 2. Voice through the server, and the first optional paid service

Date: 2026-11-21

## Status

Accepted. Supersedes the "no paid services" line of [ADR 0001](0001-agention-v1-architecture.md), in
its Context and in "Repository and supply chain".

## Context

The operator answers agents mostly from a phone, where typing a long answer is slow. Speaking it,
reading the text, and sending it would be faster, as long as what agents receive stays ordinary text
and the operator stays in control of what is sent. Reading a message aloud helps the same person
away from the screen.

Good speech recognition is a hosted service, usually a paid one, behind a key. The browsers' own
speech recognition sends audio to a service the browser chooses, which in Chrome is Google's and in
Safari is undocumented, and Firefox has none. A speech model inside Agention would mean native code,
model downloads and seconds of CPU per recording on the operator's own machine. Speech synthesis, by
contrast, is in every supported browser, on the device.

ADR 0001 says Agention uses no paid services. A transcription provider the operator chooses and pays
for is one.

## Decision

- **Voice is optional and off by default.** Agention works fully without it. The operator turns it
  on by choosing a transcription provider in the web UI's Settings, and Agention uses no paid
  service by default: a provider is one the operator opts into, and can be a server on their own
  network that costs nothing. This narrows ADR 0001's "no paid services" to "none by default".
- **The server relays.** The browser records and sends the recording to Agention, which calls the
  provider with the key it holds and returns only the text. The key never reaches a browser or an
  agent, and no provider's origin enters the web UI's content security policy. The cost is one
  operator-only endpoint and one hop for at most 2 MiB; the recording is sized to fit the API's
  existing body cap and request deadline, so no route is exempt from them. The server keeps neither
  the audio nor the text.
- **One provider interface.** The server reaches providers through one interface, implemented first
  for the widely used OpenAI-compatible `POST {base}/audio/transcriptions`, with `fetch` and
  `FormData` and no provider SDK. Settings offer OpenAI first, then Groq and a server of the
  operator's own; a provider with an API of its own would be a new implementation and preset.
- **Settings live in the database.** One typed row holds what Settings saved, so a backup carries
  it. The provider is worked out from the base URL, never stored apart from it, so what Settings say
  about where audio goes always matches where it goes. A saved key goes only to the base URL it was
  entered for, so changing the address clears it.
- **The server's first environment variables.** `AGENTION_TRANSCRIPTION_URL`,
  `AGENTION_TRANSCRIPTION_MODEL` and `AGENTION_TRANSCRIPTION_KEY` may each supply one field exactly
  as entering it in Settings would, under the same rules, read once at start. A value from the
  environment wins, shows in Settings as set there, and cannot be changed in the web UI. A key from
  the environment needs the address from it too, so it only ever goes to an address the environment
  gives, and it stays with the service unit rather than in backups.
- **Changes need a recent sign-in.** Every voice change needs the same ten-minute sign-in as adding
  or removing a passkey, so a browser left signed in cannot redirect the operator's audio or key.
- **The base URL is held to a rule.** `https` reaches any host; plain `http` only `localhost` and
  addresses on the operator's own network; link-local addresses, where most cloud metadata services
  live, and the named metadata addresses outside them, never. A host name over `https` is not
  resolved and judged by address: TLS verification is what protects there. It carries no user, query
  or fragment, the saved one is checked again for each request, and its requests follow no redirect.
- **Read aloud stays in the browser.** `speechSynthesis`, on the device, only when asked; no server
  part and no setting.

## Consequences

- Agents are unaffected: every new route is on the web mount alone, and the agent API's version does
  not change.
- Turning voice on sends the operator's recordings to a third party they choose, under its terms;
  Settings say where they go and link to the hosted providers' terms, and warn when a plain `http`
  address carries them unencrypted.
- A backup holds a key saved in Settings, as it already holds the instance's own secrets, and is an
  owner-only file. A key from the environment lives in the service unit's owner-only environment
  file instead.
- A slow uplink can fail a long recording against the 30-second request deadline; the web UI keeps
  the recording for a retry.
- Another provider with its own API, or another optional paid service, needs a decision of its own.
