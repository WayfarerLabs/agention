# Attachments: High-Level Architecture

<!-- cspell:ignore Forgejo Gitea Immich checkpointed -->

- Status: Draft
- Date: 2026-11-22
- Requirements: [FRD](frd.md), A1 to A9, E1, E2, and its rulings 1 to 4
- Research: [prior-art research](prior-art-research.md)

This effort lets agents and the operator hand each other files inside a thread. A file is uploaded
on its own, then named by the message that brings it, and from then on is that message's, under its
name. The server keeps files in its database, serves them under rules that keep them from acting as
the operator, and the bridge moves them between the agent's disk and the server.

## Decisions at a glance

- **Upload first, then the message names it.** A file goes up as one raw request body to an upload
  route, which answers with its SHA-256 and size. A message then carries `attachments`, each a name
  and an uploaded file's hash. The message's write stays one synchronous transaction, as every write
  is today, and a retried write names the same hashes, so the request-id replay still holds.
- **Files live in the database, in chunks.** A file's bytes are rows of about 1 MiB in a new table,
  keyed by the file's hash, so the database stays the whole of the instance's state: one backup
  file, one restore, no second store to keep consistent and no sweep of orphaned files. Reading and
  writing go a chunk at a time, so no file is ever held whole in memory, and a range request reads
  only the chunks it needs.
- **A file is its message's, by name** (ruling 2). An attachment is a row naming the message, the
  name and the hash, unique by message and name. Nothing replaces a file, a replaced message keeps
  its files, and every read names the message and the file.
- **Served without the app's authority.** Every file response carries a forced type, `nosniff`, a
  `sandbox` content security policy with nothing allowed,
  `Cross-Origin-Resource-Policy: same-origin`, and `Content-Disposition`. Only an allowlist of
  types, recognized by their leading bytes rather than by what the uploader declared, is ever served
  inline; everything else is `application/octet-stream` and a download.
- **Shown in the page where it can be.** Images, video, audio and text show inside the thread page,
  which is a document the app wrote. A PDF opens in its own tab in the browser's viewer. Nothing a
  file contains runs as a document of the app's origin.
- **The bridge reads and writes local files** (ruling 3). A `file_upload` tool uploads a local file
  and answers with its reference, which the writing tools' `attachments` name. A `file_get` tool
  fetches a file to a directory the bridge owns, and answers with its path, and with the image
  itself when it is a small enough photo or screenshot.
- **Agent API version 3** adds the routes and fields. Bridges at versions 1 and 2 keep working for
  everything else.
- **No image processing anywhere** (ruling 1): no resizing, no re-encoding, no metadata stripping.
  The server reads only the few leading bytes that identify a type.

## Storage

|                     | Chunks in the database (chosen)            | Files beside the database                              |
| ------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Backup and restore  | Unchanged: one file, already consistent    | A database and a directory, copied in order            |
| Consistency         | Transactional, like every other row        | Sync the file, then write the row; sweep orphans       |
| Reading             | A chunk at a time on the one connection    | Streamed by the filesystem                             |
| Space after a purge | Reused; returned to the disk by a vacuum   | Returned at once                                       |
| Write-ahead log     | Grows with an upload; checkpointed, capped | Unaffected                                             |
| Who does it         | Memos, as an option                        | Gitea, Forgejo, Mattermost, Synapse, Immich, Paperless |

The research leans to files on disk, mostly for throughput at scale and for reclaiming space. One
operator's attachments, read a chunk at a time, do not need the throughput, and purging is a later
effort (ruling 1). What the chunks buy is the property the server's design rests on today: the
database is the whole state, every write is a transaction, and a backup is one consistent copy.
Files on disk would need their own write ordering, an orphan sweep, a two-part backup and a two-part
restore, each a new way to lose a file.

The costs are bounded in the LLD:

- **Chunk size** of about 1 MiB keeps each read and write of the one connection to a few
  milliseconds.
- **The write-ahead log** is checkpointed after an upload completes and capped with
  `journal_size_limit`, so a 100 MiB upload does not leave a 100 MiB log behind.
- **A free-space floor:** an upload is refused, saying why, when the disk holding the data directory
  has less than a set margin free, so attachments cannot fill the disk under the database.

### Tables

- **Blobs:** one row per distinct file, by SHA-256, with its size, and its chunks in a table of
  their own. Two attachments of the same bytes share a blob.
- **Uploads:** a blob uploaded but not yet named by a message, with who uploaded it and when. A
  message's write turns its uploads into attachments in its transaction. An upload no message names
  within a set time is removed, with its blob when nothing else holds it.
- **Attachments:** the message (thread and sequence), the name, the blob's hash, the type the server
  recognized and the type the uploader declared. Append-only, like messages.

A future purge removes blobs and leaves attachments in place, which is what A8's missing file is: an
attachment whose blob is gone. Nothing in this effort removes a blob that an attachment names.

## Uploading

- **Routes:** an upload route on each mount: the agent mount's under the session, signed like any
  session call, and the web mount's behind the operator's sign-in, Origin and CSRF checks. Each
  takes a raw body with `Content-Length`, a declared `Content-Type`, and answers with the hash, size
  and recognized type.
- **Limits:** 100 MiB a file (ruling 1), checked against `Content-Length` before any byte is read
  and again while reading. The API's 2 MiB body cap stays on every other route.
- **Deadline:** the server's 30-second request deadline would refuse a large upload on a phone's
  uplink, so upload routes run under an idle timeout instead: an upload that sends nothing for a set
  time is cut off, however long it takes in all. Every other route keeps its deadline.
- **Budgets:** an upload spends the uploader's rate budget like any write.
- **Count:** a message names at most a set number of files, in the LLD.

An agent uploads each file with `file_upload` and then writes the message; the web composer uploads
each file as it is chosen, so a long upload runs while the operator types, and sends the message
once every upload has finished.

## Serving

### Routes

- **Web:** a file by its message and name, with `Range` support, behind the operator's sign-in.
  `?download` serves it as a download whatever its type.
- **Agent:** the same read under the session, for the session's own threads only.

### Headers on every file response

- `Content-Type`: the recognized type when it is on the inline allowlist;
  `text/plain; charset=utf-8` for text; otherwise `application/octet-stream`.
- `Content-Disposition`: `inline` for the allowlist, `attachment` for everything else, with the
  file's name.
- `Content-Security-Policy: sandbox; default-src 'none'`, so a file opened on its own is an opaque
  origin that runs nothing and loads nothing. Chrome's PDF viewer keeps only `frame-ancestors` of a
  PDF's policy and renders it regardless; the viewer runs no page script of the app's.
- `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, and the server's
  other security headers.

### Recognizing types

The uploader's declared type is kept and shown, never trusted for serving. The server reads a file's
leading bytes against a short table of signatures for the allowlist (PNG, JPEG, GIF, WebP, PDF, MP4,
WebM, Ogg, MP3, WAV) and recognizes text by its declared type or name together with valid UTF-8. SVG
and HTML are never inline: SVG is served as a download and shown in the page as an image, where
script never runs; HTML and every other text is text. No library parses a file's content.

### In the page

The thread page shows images with `<img>`, video and audio with `<video>` and `<audio>`, and text by
fetching it into a `<pre>` up to a size the LLD sets. The app's policy gains `media-src 'self'`. All
of these are elements of the app's own document, so a file is data in them, never a document, and
the session cookie, `SameSite=Strict`, goes with their requests. Media opened in a tab of its own
would be a sandboxed document whose range requests drop that cookie, so the UI offers media in the
page and as a download, never as a tab of its own.

A PDF opens in a new tab from a link in the thread page; the browser's viewer shows it. On a phone
whose Chrome has no viewer for it, it downloads. Every file offers Download.

## The web UI

- **The composer** gains an attach control in its sticky row beside Send, and a list of the chosen
  files with their upload progress and a remove control. Choosing a file uploads it; Send waits for
  every upload, and a failed upload says why and keeps the draft.
- **A message** lists the files it brought: name, type and size, marked when its file is missing.
- **The thread's head** gains a folded list of all the thread's files, each with who attached it,
  when, and a link to the message that brought it, and the space the thread's files take (A9).
- **Settings** gains a read-only Storage line: the space all attachments take.
- **Links:** a message's Markdown can link to one of its own files by name, with a link the renderer
  recognizes, in the LLD, which opens the file in the page as the list does.

## Agents

- **Uploading:** `file_upload` takes a local path and an optional name. The bridge opens the path,
  refuses anything that is not a regular file, its own key directory, or a file over the limit by
  the open file's size, uploads it, and answers with the reference, name, size and recognized type.
- **Writing:** `thread_create` and `message_send` gain `attachments`: up to the message's count of
  `{upload, name?}`, each naming an upload of the session's. A message naming an upload that is not
  the session's, or has expired, is refused whole.
- **Reading:** a new tool, `file_get`, fetches a file by its message's sequence and its name, into a
  directory the bridge owns under the session, and answers with the path, size, recognized type and
  hash. When the file is a PNG, JPEG, GIF or WebP under a size the LLD sets from a live test with
  both hosts, the answer also carries it as an `image` block, which both Claude Code and Codex show
  to the model. The answer is always text plus that block: no `resource_link`, which Claude Code
  ignores, and no `structuredContent`, beside which Codex drops other content.
- **Reading messages:** a message's shape gains its attachments: name, hash, size, types, and
  whether its blob is missing.
- **Version:** agent API version 3. Its routes and fields are added, nothing changes for versions 1
  and 2, and the compatibility suite drives the released bridges against it. A bridge at 3 against
  an older server already refuses the server's older answer, and says so.

## Backup and restore

Unchanged: `agention backup` copies the database, which holds every file. The operator guide says
how much larger backups grow with attachments, and the Storage line shows it.

## Security model additions

- **A file cannot act as the operator** (A6): forced types, an inline allowlist recognized by
  content, a sandbox policy on every file response, `nosniff`, and in-page display only as elements
  of the app's document.
- **Who can read a file:** the operator's sign-in, and the agents of the session whose thread holds
  it. File routes are under the same authentication as the thread routes on each mount.
- **The bridge reads only what the agent names,** as the user the bridge runs as, and refuses its
  own key directory and anything but a regular file. It is not a boundary against the agent: the
  agent already runs as that user.
- **Disk:** the free-space floor keeps attachments from filling the disk the database lives on.
- **Photos keep their metadata** (ruling 1); the operator guide says so, so the operator knows
  location data reaches agents.

## Testing

- The store, routes and serving headers against each type on the allowlist and off it, HTML and SVG
  included, and the range requests.
- The bridge's path checks, `file_upload`, `file_get`, and the compatibility suite.
- Chromium browser tests for attaching, the files list, images, video, text and PDF links.
- A live run with both hosts for the image block's size, and the operator's check on Android Chrome
  and Windows Edge and Chrome: a photo from the phone read by an agent, and an image, a PDF, a video
  and a text file opened.
