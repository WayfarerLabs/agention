# Read aloud and Audio Mode: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md)
- Building starts once the operator accepts the FRD. Until then the open choices are planned as
  recommended.

## Design

- [x] Requirements drafted and reviewed (project review and complexity pass), revised for both
      (agention#99).
- [x] Prior-art research, graded (agention#99).
- [x] HLA and plan reviewed (project review and complexity pass), findings disposed (agention#99).
- [x] `audio-mode-lld.md` (agention#99): the turn loop's states and transitions; the level threshold
      relative to the noise floor, with the browser's automatic gain in mind, and the caps; a turn
      with no speech; the command grammar; and each failure's words and outcome.
- [ ] The operator accepts the FRD; rulings recorded in it, and the HLA and plan updated for any
      choice answered otherwise.

## PR 1: read aloud

- [ ] String and number device choices readable outside React; voice and rate, with the default and
      a fallback for a voice no longer offered.
- [ ] Settings, Read aloud: the voice list as it loads, off-device voices marked, a sample, the
      rate.
- [ ] `speak` returning a promise, splitting a sentence too long for a browser's cut-off, with a
      watchdog per utterance; a read aloud button on each message; **Read from here**, loading the
      rest of the thread once; Stop in reach at the thread's foot.
- [ ] Unit tests for `speak` (its outcomes, the split and the watchdog), the choice and its
      fallback; browser tests for the controls.
- [ ] New ADR superseding ADR 0002's read aloud line, and ADR 0002 marked; SECURITY.md's read aloud
      paragraph; operator guide (choosing a voice and rate, voices that send text away); web UI page
      (the read controls); architecture document; live testing guide.

**Done when:** the operator reads a thread aloud from a message in Edge on Windows and on their
Android phone with a chosen voice or rate; gates and CI pass.

## PR 2: Audio Mode

Stacks on agention#70, or follows it.

- [ ] A device spike: opening the microphone for each turn on the operator's phone, with and without
      car Bluetooth audio; level traces in the car (each turn's noise floor, speech level in dBFS
      and gain setting) to set the LLD's starting values; and whether Android reports `interrupted`
      when another app takes audio focus.
- [ ] A recording step drawn out of `useDictation`, shared by dictation and Audio Mode, with
      dictation's tests unchanged.
- [ ] The view: start (shown only with a transcription provider), wake lock, state, Stop, and ending
      on every path.
- [ ] The most pressing open ask each time, an item's words, skipped asks set aside for the run, and
      passed asks offered again after the others.
- [ ] Listening: the level-based end of speech, the caps, no upload for a turn without speech, the
      plain transcription route.
- [ ] The command grammar, the confirmation state, reading back the built answer, and a cancelled
      reply added to the draft.
- [ ] Sending through `useWriter` with `seen_through` the last message read; stale answers re-read
      and re-offered; every failure in the HLA said, with its outcome.
- [ ] The two tones.
- [ ] Unit tests for the grammar and the loop; the browser test project with a recorded fake
      microphone and the stub provider.
- [ ] New ADR for Audio Mode; SECURITY.md's transcription promise restated; Settings and the guide
      on what reaches the provider while Audio Mode listens; web UI page (Audio Mode, its commands,
      how a kept reply comes back, and that Agention is not a car interface); architecture document;
      live testing guide.

**Done when:** the FRD's definition of done holds for Audio Mode on the operator's mounted Android
phone, including a failure said when the network is cut mid-answer; gates and CI pass, and the
effort ships in a release.

## Closeout

- [ ] Permanent docs carry everything the codebase relies on; nothing points into this directory.
- [ ] `locked.md` records what shipped, and what was left for the provider speech decision.
