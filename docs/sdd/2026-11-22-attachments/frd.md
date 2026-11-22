# Attachments: Functional Requirements

- Status: Draft, for the operator's acceptance
- Date: 2026-11-22
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim or as close transcription.
- Origin: agention#28, with the operator's scope note that attachments go both ways and their
  sequencing note that this effort is independent of notifications (agention#30) and needs no
  settings. Agention as released in 0.4.0 is the baseline.

## Why this exists

A message carries text and detail only. When an agent wants to show the operator a screenshot, a
log, a report or a recording, it has to put it somewhere else and link to it, and when the operator
wants to show an agent a photo of a screen or a document, there is no way to at all. Both sides
should be able to hand each other a file inside the thread it belongs to, and the operator should be
able to open it on a phone without leaving Agention.

## Who this is for

- **The operator**, the one human, on a phone or a desktop browser, who opens what agents attach and
  attaches files of their own.
- **Agents**, which attach files from their own machine and read what the operator attaches.

## Functional requirements

### Attaching

**A1. Agents attach files.** An agent can attach files to a message it writes, naming each by its
path on the agent's machine, within limits on each file's size and on how many a message carries. A
file that breaks a limit is refused with the limit named, and nothing of the message is written.

**A2. The operator attaches files.** The composer can attach files from the device, a phone's camera
included, within the same limits, said in the UI. The operator sees what is attached, and can remove
it, before sending. Nothing is uploaded for good until the message is sent.

### Showing and opening

**A3. A message shows its files.** A message lists the files it carries, each with its name, type
and size, and its text and detail can link to them by name.

**A4. Files open with the browser's own viewer.** Opening a file shows it the way the browser shows
that kind of file: images, PDFs, video and audio in place where the browser can; text and code as
text; anything else as a download. Download is always offered.

**A5. A file never acts as the operator.** Whatever an attached file contains, opening it cannot run
code with the operator's sign-in, read Agention's pages, or reach Agention's API. Only the
operator's sign-in, and agents of the session the thread belongs to, can fetch a file.

### Reading

**A6. Agents read the operator's files.** An agent can fetch a file attached to a message in one of
its session's threads, the operator's or its own, within the same limits. It gets the file on its
own machine, and an image in a form a model can look at where its host supports that.

### Keeping

**A7. A file stays with its message.** A file is part of the message that carries it: it never
changes, a message that replaces it carries files of its own, and archiving a thread covers its
files. `agention backup` writes, and restoring brings back, every file with the database, as one
consistent copy.

**A8. Storage is visible.** The operator can see how much space attachments use, in total and per
thread, and the server refuses a new file, saying why, once a total limit is reached.

### Engineering

**E1. Agent API.** Attaching and fetching are new agent tools, under the next agent API version.
Bridges released before it keep working for everything else, and a server older than a bridge that
attaches says so rather than failing silently.

**E2. Collateral.** The operator guide, SECURITY.md, the architecture document and ADRs describe
attachments: what is kept, where, how files are served, the limits, backup and restore; the live
tests cover them.

## Out of scope

- Previews or conversions made on the server (thumbnails, transcoding, Office documents rendered).
- Editing a file once attached, and files shared across threads.
- Settings for attachments (the operator's sequencing note).
- Notifications (agention#30).

## Open questions for the operator

1. **Removing files.** Nothing in Agention is ever deleted today, so storage only grows. Should the
   operator be able to remove an attached file to reclaim space, leaving the message saying a file
   was there?
2. **Sizes.** What is the largest file either side should be able to attach (screen recordings are
   the large case), and is a total limit wanted, or only visibility?
3. **Photo location.** Should location and camera details be taken out of photos the operator
   attaches before they are kept?
4. **Accepting.** Do these requirements say what you want?

## Operator rulings, 2026-11-22 onward

None yet.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- The operator attaches a photo from their Android phone and an agent reads it, and opens an image,
  a PDF, a video and a text file an agent attached, on Android Chrome and Windows Edge or Chrome.
- The repository passes its documented checks in CI, and the effort ships in a release.
