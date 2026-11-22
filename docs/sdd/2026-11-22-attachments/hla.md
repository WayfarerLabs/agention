# Attachments: High-Level Architecture

<!-- cspell:ignore Forgejo Gitea Immich -->

- Status: Draft, revised after review
- Date: 2026-11-22
- Requirements: [FRD](frd.md), A1 to A9, E1, E2, and its rulings 1 to 5
- Research: [prior-art research](prior-art-research.md)

This effort lets agents and the operator hand each other files inside a thread. A file is uploaded
on its own, then named by the message that brings it, and from then on is that message's, under its
name. The server keeps files in its database, serves them under rules that keep them from acting as
the operator, and the bridge moves them between the agent's disk and the server.

## Decisions at a glance

- **Upload first, then the message names it** (ruling 3). A file goes up as one raw request body to
  an upload route, which answers with an upload reference, a random id. A message then carries
  `attachments`, each naming one of its writer's own pending uploads, or a file of the message it
  replaces. The message's write stays one synchronous transaction, as every write is today.
- **Files live in the database, in chunks.** A file's bytes are rows of about 1 MiB, so the database
  stays the whole of the instance's state, as ADR 0001 has it: one backup file, one restore. No file
  is ever held whole in memory, and a range request reads only the chunks it needs.
- **A file is its message's, by name** (ruling 2), unique within the message. Nothing replaces a
  file, a replaced message keeps its files, and every read names the message and the file.
- **Served without the app's authority.** Every file response carries a type the server chooses from
  a short allowlist, `nosniff`, a `sandbox` content security policy allowing nothing, and
  `Content-Disposition`. Everything off the allowlist is `application/octet-stream` and a download.
- **Shown in the page where it can be.** Images, video, audio and text show inside the thread page,
  as elements of a document the app wrote; a PDF opens in its own tab in the browser's viewer.
  Nothing a file contains runs as a document of the app's origin.
- **Agents upload and fetch with tools of their own** (ruling 3): `file_upload` takes a local path
  and answers with the reference, and `file_get` writes a file to a directory the bridge owns.
- **The next agent API version** adds the routes, tools and fields; earlier bridges keep working for
  everything else.
- **No image processing anywhere** (ruling 1): no resizing, re-encoding or metadata stripping, and
  no library parses a file's content.
- **A new ADR** records storage in the database, the serving rules, and the restated inert-content
  rule: message text stays inert, and files load only as described here.

## Storage

|                    | Chunks in the database (chosen)             | Files beside the database                              |
| ------------------ | ------------------------------------------- | ------------------------------------------------------ |
| Backup and restore | Unchanged: one file, already consistent     | A database and a directory, copied in order            |
| An upload          | A chunk committed at a time, then finalized | A temporary file, synced, linked, then the row         |
| Left by a crash    | Unfinished uploads' chunks, swept           | Unlinked temporary files, swept                        |
| Reading            | A chunk at a time on the one connection     | Streamed by the filesystem                             |
| Each backup copies | Every file, every time                      | New files only, if the copy is incremental             |
| A future purge     | Deleting rows, then an incremental vacuum   | Unlinking files                                        |
| Who does it        | Memos, as an option                         | Gitea, Forgejo, Mattermost, Synapse, Immich, Paperless |

Most self-hosted products keep files on disk, for throughput at scale and cheap purging. One
operator's attachments need neither, and purging is a later effort (ruling 1). Keeping files in the
database keeps the property the server is built on: one file is the whole state, a backup is one
consistent copy, and a restore is one move. Files on disk would amend ADR 0001 and change
`agention backup` and restoring for every operator, for gains this effort does not need.

What the chunks cost, and how each is bounded:

- **The event loop.** Each chunk is a synchronous write or read on the server's one connection:
  about 2 ms at the median, measured, with an occasional commit of up to about 150 ms while a large
  upload runs. An upload writes its chunks one transaction each, so other requests run between them.
- **Crash leftovers.** An upload's chunks commit as they arrive, so a dropped or crashed upload
  leaves some behind. The same sweep that expires unnamed uploads removes them, at start and on a
  timer.
- **Space.** This effort's migration turns on incremental vacuuming, so a later purge can return
  space to the disk without rewriting the whole database. SQLite's own checkpoints keep the
  write-ahead log small during an upload, since each chunk commits on its own.
- **Disk.** An upload is refused, saying why, when the disk holding the data directory has less than
  a set margin free, so attachments cannot fill the disk under the database.

### Tables

- **Files:** one row per uploaded file: its id, size, SHA-256, declared type, who uploaded it and
  when, and whether it is still pending; its bytes in a chunks table by file id and index. A file is
  pending from its upload until a message names it; a pending file no message names within a day is
  removed with its chunks.
- **Attachments:** the message (thread and sequence), the name, and the file. Unique by message and
  name; append-only, like messages. A replacement that carries a file forward names the same file
  again under its own message.

There is no sharing of bytes between uploads: each upload is its own file. A future purge removes a
file's chunks and leaves its attachments, which is what A8's missing file is.

## Uploading

- **Routes:** an upload route on each mount: the agent mount's under the session, signed like any
  session call, and the web mount's behind the operator's sign-in, Origin and CSRF checks. Each
  takes a raw body with `Content-Length` and a declared `Content-Type`, and answers with the
  reference, size and the type the server will serve it as.
- **Authentication comes first.** Both mounts authenticate from headers alone, so no unauthenticated
  body is ever read past the 2 MiB cap.
- **Limits:** 100 MiB a file (ruling 1), checked against `Content-Length` before any byte is read
  and again while reading; at most a set number of pending files and pending bytes for each writer,
  counting the uploads still arriving, on both mounts, so a writer may run several uploads at once.
  The 2 MiB body cap stays on every other route.
- **Deadlines.** The 30-second deadline is Node's server-wide `requestTimeout`, which no route can
  lift. The listener enforces deadlines itself instead: every request's body is cut off once it
  sends nothing for a set time, and every request but an upload keeps a total deadline, now exact
  rather than checked every 30 seconds. An upload has no total deadline, so a slow phone uplink can
  finish.
- **Naming it.** A message may name only its writer's own pending files, so a reference learned from
  another session's answers is worth nothing; naming the same file twice, or an unknown or expired
  reference, refuses the message whole. Attachments are part of the write's digest, and the
  request-id replay runs before the check, so a retried write answers as the first did.
- **A message names at most a set number of files,** in the LLD.

## Serving

### Routes

- **Web:** a file by its thread, message sequence and name, with single-range `Range` support,
  behind the operator's sign-in.
- **Agent:** the same read under the session, for the session's own threads only.

The thread's files, for its head (A4), are a paged list on a route of their own, read when the fold
opens; the thread's answer carries only their count and size, so it stays within the agents' answer
cap.

### Headers on every file response

- `Content-Type`: the declared type when it is on the allowlist, otherwise
  `application/octet-stream`. The allowlist is the raster images (PNG, JPEG, GIF, WebP), PDF, the
  common video and audio types, and SVG as `image/svg+xml`; text of any kind is
  `text/plain; charset=utf-8`.
- `Content-Disposition`: `inline` for raster images, PDF, video, audio and text; `attachment` for
  SVG and everything else, with the file's name, encoded safely.
- `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'`. A file opened on
  its own is an opaque origin that runs and loads nothing. Chrome's PDF viewer keeps only
  `frame-ancestors` of a PDF's policy and renders it; the viewer runs no script of the app's.
- `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, and the server's
  other security headers.
- `Cache-Control: private` with a long lifetime, since a file never changes, so seeking a video does
  not refetch it.

The security headers middleware today lets a route keep its own headers only at an exact path, which
cannot name a file route, whose varying part is mid-path. A response instead declares the headers it
owns, and the diagram frame moves to the same mechanism, so their policy is not replaced by the
app's.

Serving relies on these headers, not on what a file contains: bytes that are not what their type
says are harmless as an image, media or a download, and HTML is only ever text. A test drives HTML
and script bytes declared as each allowlisted type and checks that nothing runs.

### In the page

The thread page shows images with `<img>`, video and audio with `<video>` and `<audio>`, and text
fetched into a `<pre>` up to a size the LLD sets. The app's policy gains `media-src 'self'`. These
are elements of the app's own document, so a file is data in them, and the `SameSite=Strict` session
cookie goes with their requests. File bytes never become `blob:` URLs, which the app's policy allows
for images. Media opened in a tab of its own would be a sandboxed document whose range requests drop
that cookie, so the UI plays media in the page, and offers a download.

A PDF opens in a new tab from a link in the thread page. On a browser whose viewer cannot show it,
the tab offers it as a download, and every file has a download link (`<a download>`). The operator's
devices are checked early, on the staging server, for Edge's viewer and Android Chrome.

## The web UI

- **The composer** gains an attach control in its sticky row beside Send, and a list of the chosen
  files with their upload progress and a remove control. Choosing a file, or pasting an image into
  the text box (ruling 5), uploads it; Send waits for every upload, and a failed upload says why and
  keeps the draft. Editing a message carries its files forward unless the operator removes them.
- **A message** lists the files it brought: name, type and size, with images, media and text shown
  in place, and marked when its file is missing.
- **The thread's head** gains a folded list of the thread's files, each with who attached it, when,
  and a link to the message that brought it, and the space the thread's files take (A9).
- **Settings** gains a read-only Storage line: the space all attachments take.
- **Links:** a message's Markdown can link to one of its own files by name, with a link the renderer
  recognizes, in the LLD, which opens the file as the message's list does.

## Agents

- **`file_upload`** takes a local path and an optional name. The bridge opens the path, refuses
  anything that is not a regular file, anything under its own key directory, and a file over the
  limit by the open file's size, then streams it up and answers with the reference, name, size and
  served type.
- **Writing:** `thread_create` and `message_send` gain `attachments`: up to the message's count of
  `{upload, name?}`, or, on a replacement, `{keep}` naming a file of the message it replaces.
- **`file_get`** fetches a file by its message's sequence and its name into a directory the bridge
  owns, outside its key directory, under a name the bridge makes from the file's id rather than the
  sender's name, and answers with the path, name, size and served type. When the file is a PNG,
  JPEG, GIF or WebP, whose leading bytes the bridge checks, under a size the LLD sets from a live
  test with both hosts, the answer also carries it as an `image` block, which both Claude Code and
  Codex show to the model. Answers are text plus that block: no `resource_link`, which Claude Code
  ignores, and no `structuredContent`, beside which Codex drops other content.
- **Transfers stream.** The bridge sends and receives file bodies as streams rather than whole
  strings, under an idle timeout rather than its 30-second answer timeout. A host's own limit on a
  tool call's time, such as Codex's, is set long enough in the generated plugin where the host
  allows it, and named in the operator guide where it does not.
- **Reading messages:** a message's shape gains its attachments: name, file id, size, type, and
  whether the file is missing. The answer cap's trimming counts them.

## Backup and restore

Unchanged: `agention backup` copies the database, which holds every file. The operator guide says
that backups grow with attachments, and the Storage line shows by how much.

## Security model additions

- **A file cannot act as the operator** (A6): allowlisted types, a sandbox policy on every file
  response, `nosniff`, in-page display only as elements of the app's document, and no `blob:` URLs.
- **Who can read a file:** the operator's sign-in, and the agents of the session whose thread holds
  it, on the same authentication as the thread routes of each mount.
- **References are random and private to their writer,** so one session cannot attach, or learn of,
  another's uploads.
- **The bridge reads only what the agent names,** as the user the bridge runs as, and refuses its
  own key directory and anything but a regular file. It is not a boundary against the agent, which
  already runs as that user.
- **Disk and the event loop:** the free-space floor and the limits on pending uploads keep one
  writer from filling the disk or monopolizing the connection.
- **Photos keep their metadata** (ruling 1); the operator guide says so, so the operator knows
  location data reaches agents.
- **Restated rules:** `SECURITY.md`'s inert-content invariant, the review checklist's rule that
  images never load, and ADR 0001's matching guardrail are restated by the new ADR: message text
  stays inert, and files load only as attachments, under these rules.

## Testing

- The store, the sweep, the routes and the serving headers against each allowlisted type and others,
  HTML, SVG and mislabeled bytes included, range requests, and a missing file.
- The deadlines: an idle body cut off, an upload outliving the old deadline, other routes keeping
  theirs.
- The bridge's path checks, `file_upload`, `file_get` and its image block, and the compatibility
  suite.
- Chromium browser tests for attaching, pasting, the files list, images, video, text and PDF links.
- A live run with both hosts for the image block's size and tool-call times, an early check of PDFs
  on the operator's devices against the staging server, and the operator's final check on Android
  Chrome and Windows Edge or Chrome: a photo from the phone read by an agent, and an image, a PDF, a
  video and a text file opened.
