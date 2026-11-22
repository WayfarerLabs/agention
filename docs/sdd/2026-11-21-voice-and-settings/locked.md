# Voice and settings: Locked

- Locked: 2026-11-22
- Shipped in: 0.4.0 (agention#33), with Agention v1's completion (ruling 5)

## What shipped

- The Settings view, holding passkeys, signing out and voice, with `/passkeys` leading to it.
- An optional transcription provider, configured in Settings or the server's environment, called
  only by the server, with a write-only key used only at the address it was entered for. Ruling 7,
  after release, asks for a saved key shown masked in its field, ending in its last four characters,
  which a change after this effort delivers.
- Dictation in the composer and reading a message aloud on the device.
- ADR 0002, which records the server's part in transcription, its environment variables and the
  first optional paid service, and supersedes ADR 0001's paid-services line.

The operator's check on Android Chrome and Windows passed with a real provider (ruling 6). Dictation
in Apple browsers is a named gap, since WebKit could not run on the test host.

## Where it lives now

The permanent record is in `docs/architecture.md`, `docs/adrs/0002-voice-through-the-server.md`,
`docs/operator-guide.md`, `SECURITY.md` and `docs/live-testing.md`. Nothing here is needed to
understand or work on the system.

## What follows

Better read aloud and an Audio Mode (agention#37), and provider-agnostic voice settings with voice
context and a better Settings layout (agention#38), are their own efforts.
