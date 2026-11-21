# Voice and settings: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md); details: [LLD](voice-lld.md)
- Branch: `build/voice-and-settings`, stacked on Agention v1's completion (agention#26) until it
  merges

One delivery: the Settings view with passkeys and signing out moved into it, a transcription
provider configured there, dictation in the composer, and reading a message aloud. Each box is
checked when it is built, reviewed and green.

## Delivery 1: voice and settings

- [x] [LLD](voice-lld.md): the settings table, the environment, the routes and their shapes, the
      presets, the caps and timeouts, the error codes, and the web UI's states (agention#33).
- [x] Migration 4 and the settings store, with the write-only key, the bounds and the base URL rule,
      and the environment variables read at start, a saved key used only at its own base URL (V3,
      ruling 3) (agention#33).
- [x] The settings routes, a recent sign-in for every voice change, and a base URL change clearing
      the key (S2, V3, V4) (agention#33).
- [x] The transcription client and `POST /transcriptions`: the OpenAI-compatible request, its caps,
      timeout and error mapping, no audio or key kept or logged (V1, V2, V5, V6) (agention#33).
- [x] The Settings view in the navigation, with Passkeys moved whole and Sign out moved from the
      header, and `/passkeys` still leading to it (S1) (agention#33).
- [x] The Voice section: presets with OpenAI first, the write-only key, where audio goes with the
      provider's terms, Turn off, and Try it through the dictation path (V2 to V4, ruling 1)
      (agention#33).
- [x] Dictation in the composer: record, the limit shown, upload, text at the cursor, failures that
      keep the draft (V5) (agention#33).
- [x] Read aloud from a message's options, on the device, with Stop (V7) (agention#33).
- [x] Every new route unknown on the agent mount, and the agent API unchanged (V6, E1)
      (agention#33).
- [x] Permanent docs: the operator guide, SECURITY.md, the architecture document, a new ADR for the
      server's part in transcription, its environment variables and the first optional paid service,
      ADR 0001's paid-services line marked superseded by it, `docs/review-checklist.md`'s rule on
      paid services, `docs/live-testing.md`, `README.md`, and `docs/development-context.md`'s active
      effort (E2) (agention#33).
- [ ] Live run with a stub provider and Chromium's fake microphone, WebKit where it runs, and the
      operator's check on Android Chrome and Windows against the staging server with a real provider
      (ruling 2).
- [ ] The release carrying it, through release-please.
- [ ] `locked.md` in this directory, with the final merge.
