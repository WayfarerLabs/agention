# 4. Attachments in the database, served inert

Date: 2026-11-22

## Status

Accepted. Supersedes, in [ADR 0001](0001-agention-v1-architecture.md), "so no content makes the
browser fetch anything" in "Text is Markdown, rendered inert", and the "never executed or fetched"
of its trust model, as far as files go: message text stays inert, and files load only as
attachments, under the rules below.

## Context

Agents and the operator need to hand each other files inside a thread: a screenshot, a log, a build
report, a photo taken on the phone. A file can be large, up to 100 MiB here, and is kept for good,
as the rest of a thread's history is. Agents run on machines with no browser, and read and write
files on their own disks.

Two parts of ADR 0001 bear on this. The database is the instance's whole state: one file, one
backup, one restore. And content is inert: a script running in the web UI's origin could write as
the operator, whom every approved agent obeys, so no message content may run there, and until now
none made the browser fetch anything. A file is content of any kind, from anyone who can write to a
thread, and the server has one origin, shared by the web UI and everything it serves.

## Decision

- **Files live in the database, in chunks.** A file's bytes are rows of 1 MiB, written one
  transaction each as they arrive, so other requests run between them, and read the same way, so a
  range reads only the chunks it covers and no file is ever held whole in memory. Each chunk checks
  the credential again, so a revoked agent's transfer stops within one. The database stays the whole
  state: a backup is still one consistent copy and a restore one move. Most self-hosted products
  keep files on disk, named by their hash, for incremental backups and cheap purges; that would make
  every backup and restore two parts, copied in order, for gains one operator's files do not need.
- **Freed space goes back to the disk.** The database uses incremental vacuuming, so pages a removed
  upload frees return to the disk a few megabytes at a time, without rewriting the file. SQLite
  takes the mode only on an empty database or through a `VACUUM` that rewrites it, neither inside a
  transaction, so it cannot be a migration: the first open of a database still without it switches
  it once, after its migrations. A switch that fails, for lack of disk among other causes, is logged
  and the server starts anyway; freed pages then stay in the file for reuse, and the next start
  tries again.
- **Upload first, then the message names it.** A file goes up as one raw request body, with its
  `Content-Length` and declared type, to an upload route on each mount, which answers with a random
  reference. A message then carries `attachments`, each naming one of its writer's own pending
  uploads in that session, or keeping a file of the message it replaces. A message's write stays one
  small, synchronous transaction, inside the request id's digest and after its replay, as every
  write is. An upload no message names expires a day after it completes, and a sweep removes it, and
  whatever an interrupted upload left. Each writer holds at most a set number of pending uploads and
  bytes, and an upload is refused while the disk would keep less than a set margin free, so
  attachments cannot fill the disk under the database. A multipart message write would have made
  every write carry its files; resumable uploads were more than one operator's links need.
- **A file is its message's, by name.** Each file is attached under a name unique within its
  message, attachments are append-only as messages are, and nothing replaces or removes an attached
  file. A replaced message keeps its files, and its replacement carries one only by keeping it.
  Every read names the thread, the message and the name.
- **Files are served without the app's authority.** A file is answered as a type the server chooses
  from a short allowlist, raster images, PDF, common video and audio, and SVG, with text of any kind
  as `text/plain; charset=utf-8` and everything else as `application/octet-stream`. Every file
  response carries `nosniff`, a `sandbox` content security policy that allows nothing and no
  framing, `Cross-Origin-Resource-Policy: same-origin`, and a `Content-Disposition`: an attachment
  for SVG and for everything off the allowlist, so opening one on its own downloads it. A file
  opened on its own is a document of an opaque origin that runs and loads nothing. Serving relies on
  these headers, never on what a file contains: the server detects no type and parses no file, and
  nothing resizes, re-encodes or strips metadata from one. A response declares the security headers
  it sets for itself, and the app's middleware sets every other. The large products serve files from
  a separate origin that carries no cookies; one operator's single origin cannot have one, so the
  headers carry that weight.
- **Files show in the page, never as documents of its origin.** Images, video and audio show as
  `<img>`, `<video>` and `<audio>` elements of the web UI's own page, and text as text the page
  fetched into it; a PDF opens in its own tab, in the browser's viewer. No file shows in a frame or
  becomes a `blob:` or `data:` URL: every element loads the file's own URL, with its headers. The
  web UI's content security policy gains `media-src 'self'` for the players, and nothing else. Files
  are cached privately, for good, since the bytes at a URL never change.
- **Agents move files with tools of their own.** `file_upload` sends a file from the agent's machine
  by its path, refusing anything but a regular file and the bridge's own key directory, and
  `file_get` writes a file a message carries into a directory the bridge owns, named by its
  reference rather than by its sender's name. A raster image small enough also comes back as an
  image the host shows the model. The bridge streams both under an idle limit rather than its answer
  deadline. These are the next agent API version; earlier bridges keep working for everything else.
- **The listener keeps its own deadlines.** Node's whole-request timeout is server-wide, cannot be
  lifted for one request, and fires up to 30 seconds late. The listener enforces its own instead:
  headers within 10 seconds, a body cut off after 30 seconds without a byte, and every request but
  an upload whole within 30 seconds, to the second. An upload has no total deadline, so a slow phone
  uplink finishes.
- **Inert content, restated.** A message's text, detail and references stay inert: Markdown images
  still never load, and a Markdown link to a file reaches only a file of the message's own. Files
  load only as attachments, under these rules.

## Consequences

- Backups grow with every file and are never incremental; Settings show how much space attachments
  take.
- Each chunk is a synchronous commit on the server's one connection, so a large upload adds brief
  pauses to other requests.
- The first start after the upgrade rewrites the database once, needing about its size free in
  SQLite's temporary directory and as much again beside it.
- The set of uploads in flight is in the server's process, so one server runs per database, as the
  long poll's notifier already requires.
- A file stays in the browser's cache after sign-out, as the price of not fetching a video again on
  every seek.
- Media opened in a tab of its own is a sandboxed document whose range requests carry no session, so
  the page plays media in place and offers a download.
- In a browser whose PDF viewer ignores a PDF's sandbox policy, as Chrome's does, a PDF's safety
  rests on that viewer.
- Photos keep their metadata, location included, which reaches agents that fetch them.
- A future purge of files deletes their chunks and runs the incremental vacuum; their attachments
  stay, shown as missing.
