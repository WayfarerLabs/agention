# Voice and settings: Functional Requirements

- Status: Draft for the operator's acceptance
- Date: 2026-11-21
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim or as close transcription.
- Origin: agention#29, and the operator's direction that this effort comes first of the three that
  follow v1, creates the web UI's settings, and moves passkeys and signing out into them. Agention
  v1 (its SDD in `docs/sdd/2026-10-25-agention-v1/`) is the baseline.

## Why this exists

The operator answers agents mostly from a phone. Typing a long answer there is slow. Speaking it,
reviewing the text, and sending it would be faster, as long as what agents receive stays ordinary
text and the operator stays in control of what is sent.

Turning voice on means choosing where the audio goes, which is a server setting the web UI has no
place for yet. This effort creates that place, the settings, and gathers into it what is already the
operator's to configure: passkeys and signing out.

## Who this is for

- **The operator**, the one human, on a phone or a desktop browser.
- **Agents** are unaffected: they read and write text as they do now.

## Functional requirements

### Settings

**S1. One place for settings.** The web UI has a Settings view beside Threads and Sessions. It holds
the operator's passkeys (what the Passkeys view holds today), signing out, and voice. The Passkeys
view and the header's sign-out control move into it, and nothing is lost in the move.

**S2. Changing a secret needs a recent sign-in.** Setting, replacing or clearing a provider key, or
changing where a key is sent, needs a recent sign-in, as adding or removing a passkey does.

### Voice

**V1. Voice is optional and off until configured.** The server offers voice only once the operator
has configured a transcription provider in Settings. Until then, and after the operator clears it,
the composer is exactly as it is today.

**V2. A provider the operator chooses.** A provider is a service that speaks the widely used
OpenAI-compatible transcription interface: its address, a model, and a key when it needs one. The
settings offer presets for common hosted providers and for a transcription server on the operator's
own network, and accept any other compatible address.

**V3. A key is written, never read back.** The server keeps a provider's key private and never sends
it back to any browser or agent, nor logs it. Settings show only whether a key is set. Changing the
provider's address clears its key, since whoever runs that address would receive it. A key supplied
by the server's environment shows as managed there and cannot be changed in the web UI.

**V4. Where the audio goes is said.** Settings say which provider receives the operator's audio, and
link to what that provider says about keeping it and training on it, so turning voice on is an
informed choice. A test control confirms the configuration works.

**V5. Dictation in the composer.** With voice on, the composer offers a microphone control. The
operator records, the server has the recording transcribed, and the text is inserted where the
cursor was, for the operator to edit. Nothing is ever sent without the operator sending it. A
recording has a length limit, said in the UI, and a failed transcription says why and keeps the
draft as it was.

**V6. No audio is kept.** The server passes a recording to the provider and keeps neither the audio
nor a transcript beyond returning the text. Only the operator's sign-in can use transcription;
agents cannot.

**V7. Read aloud.** Any message can be read aloud on request, by the browser's own speech, on the
device, with no server setting. Nothing is read aloud unless the operator asks.

### Engineering

**E1. Agents unchanged.** No agent route, tool or answer changes, and the agent API version stays as
it is.

**E2. Collateral.** The operator guide, SECURITY.md, the architecture document and ADRs describe the
settings, voice, where audio goes, and how a provider key is kept; the live tests cover them.

## Out of scope

- Reading messages aloud automatically, and server-side speech synthesis.
- Running a speech model inside the Agention server.
- Notifications (agention#30) and attachments (agention#28), which are their own efforts.
- Settings beyond those named here.

## Open questions

- Which provider the settings suggest first, if any (the operator's ask).
- Whether the operator uses Agention as a Home Screen app on the iPhone, where recording has known
  problems to test for (the operator's ask).

## Operator rulings, 2026-11-21 onward

None yet.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- The operator dictates and sends a message from a real phone with a configured provider, and reads
  a message aloud.
- The repository passes its documented checks in CI, and the effort ships in a release.
