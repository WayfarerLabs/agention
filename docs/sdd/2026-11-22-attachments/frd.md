# Attachments: Functional Requirements

- Status: Accepted by the operator with changes, 2026-11-22 (ruling 1); A3 amended by ruling 2; E1
  by ruling 3
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
path on the agent's machine. A file may be up to 100 MiB (ruling 1), and a message carries a limited
number of files. A file that breaks a limit is refused with the limit named, and nothing of the
message is written.

**A2. The operator attaches files.** The composer can attach files from the device, a phone's camera
included, within the same limits, said in the UI. The operator sees what is attached, and can remove
it, before sending. An image pasted into the composer's text box becomes an attachment (ruling 5).
Nothing is uploaded for good until the message is sent.

**A3. A file is its message's.** A file belongs to the message that brought it, under its name, and
a message carries at most one file of each name. The same name in another message is another file,
and nothing replaces a file (ruling 2). A message that replaces another carries files of its own,
and the replaced message keeps its files, as it keeps its content.

### Showing and opening

**A4. Files show where they arrive and at the top of the thread.** A message lists the files it
brought, each with its name, type and size. The thread's head lists all of the thread's files,
folded, each with who attached it, when, and the message that brought it (ruling 1). A message's
text and detail can link to its own files by name.

**A5. Files open with the browser's own viewer.** Opening a file shows it the way the browser shows
that kind of file: images, PDFs, video and audio in place where the browser can; text and code as
text; anything else as a download. Download is always offered.

**A6. A file never acts as the operator.** Whatever an attached file contains, opening it cannot run
code with the operator's sign-in, read Agention's pages, or reach Agention's API. Only the
operator's sign-in, and agents of the session the thread belongs to, can fetch a file.

### Reading

**A7. Agents read the thread's files.** An agent can fetch any file of one of its session's threads,
the operator's or its own, by its message and name. It gets the file on its own machine, and an
image in a form a model can look at where its host supports that.

### Keeping

**A8. Files accumulate.** Nothing removes a file: a file never changes once attached, and archiving
a thread covers its files (ruling 1). `agention backup` writes, and restoring brings back, every
file with the database, as one consistent copy. A message or thread whose file is gone, as a later
purge would leave it, still shows in full, with that file marked as missing.

**A9. Storage is visible.** The operator can see how much space attachments use, in total and per
thread.

### Engineering

**E1. Agent API.** Attaching is a tool that uploads a file from the agent's machine and answers with
a reference, which the tools that write messages name; fetching is a tool of its own (ruling 3).
Both come under the next agent API version. Bridges released before it keep working for everything
else, and a server older than a bridge that attaches says so rather than failing silently.

**E2. Collateral.** The operator guide, SECURITY.md, the architecture document and ADRs describe
attachments: what is kept, where, how files are served, the limits, backup and restore; the live
tests cover them.

## Out of scope

- Purging files, such as those of threads archived longer than a set time, which a later effort may
  offer in Settings (ruling 1).
- Taking location and camera details out of photos, which a later effort may offer as an option
  (ruling 1), and any image processing on the server.
- Previews or conversions made on the server (thumbnails, transcoding, Office documents rendered).
- Editing a file in place, and files shared across threads.
- Settings for attachments (the operator's sequencing note).
- Notifications (agention#30).

## Operator rulings, 2026-11-22 onward

1. (2026-11-22) Asked whether to accept the draft, the operator chose "Accept with changes": "So my
   thinking is that files ultimately belong to the thread, although they are uploaded along with a
   specific message. I think we can use that to allow replacing of files (by uploading a new one
   with the same name). The UI should show the files in the messages that they arrive it but it
   should also show all files (folded) at the top of the thread." Asked whether the operator can
   remove files, they chose "No, keep everything": "And then I think we can just accumulate files
   for now. In the future we can offer a settings-based way to purge files from archived threads
   older than X, but that can be a future thing. Threads/messages should not break if their files
   are deleted, only show that the link is broken." Asked the largest file, they chose "100 MiB".
   Asked about photo location, they chose "Keep photos as taken": "And then if we want to add a
   convenient checkbox (or setting?) to strip photo metadata, I'm all for it. That would be really
   cool. But I'm also ok just not worrying about it for now. Note that Imagemagick just had a huge
   security issue today." Taken: A3 and A4 make files the thread's, by name, with replacement and
   the folded list at the thread's head; A8 keeps every file, and a missing file shows as missing;
   the limit is 100 MiB a file with no total limit; metadata stays as taken, and the server does no
   image processing.

2. (2026-11-22) Asked whether a file replaced by one of the same name keeps its earlier version:
   "Yeah, actually this overwrite without replace really doesn't fit out model. Files should be
   keyed by message id so that even the same name doesn't technically conflict. One message clearly
   can't have two files with the same name, which is right. A replaced message should keep its file
   for now, just like it keeps its content." Taken, amending A3 and A7 and the replacement in ruling
   1: a file is its message's, by name, unique within the message; nothing replaces a file; a
   replaced message keeps its files; files are read by message and name.

3. (2026-11-22) Asked whether agents attach through a field of local paths on the writing tools and
   fetch with a new tool: "I think this is right, although shouldn't we have a tool call to upload
   the file (into a temp location) and then it can just be referenced in the message_send?" Taken,
   amending E1: a tool uploads a local file and answers with a reference, which `thread_create` and
   `message_send` name, and an upload no message names expires; fetching is a tool of its own.

4. (2026-11-22) "Dope. Build it! Lmk if you encounter any major questions. Otherwise just make good
   decisions and let 'er rip." Taken: the requirements stand as amended, and the effort lead
   proceeds through design and build, bringing only major questions to the operator.

5. (2026-11-22) "Oh! And it would be amazing to support pasting of image data in the message reply
   text box, which would then turn into an attachment. Not required but really, really nice to
   have." Taken, extending A2: an image pasted into the composer's text box becomes an attachment.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- The operator attaches a photo from their Android phone and an agent reads it, and opens an image,
  a PDF, a video and a text file an agent attached, on Android Chrome and Windows Edge or Chrome.
- The repository passes its documented checks in CI, and the effort ships in a release.
