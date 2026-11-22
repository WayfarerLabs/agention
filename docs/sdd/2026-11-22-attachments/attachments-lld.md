# Attachments: LLD

<!-- cspell:ignore Forgejo Gitea Immich statfs bavail bsize ndjson jsonl heic heif webm oga flac -->
<!-- cspell:ignore immutable codecs cookieless Mbit Synapse -->

- Status: Draft
- Date: 2026-11-22
- Requirements: [FRD](frd.md) A1 to A9, E1, E2, rulings 1 to 5; [HLA](hla.md), revised after review
- Research: [prior-art research](prior-art-research.md)

This settles what the HLA leaves open. Code and public docs written from it state behavior in their
own words, without requirement or ruling numbers. Another effort may land a migration, an ADR and an
agent API version first, so this document names them as "the next": the migration is the one after
the last that has shipped (5 if this effort merges first), the ADR is 0004, and the agent API
version is `agentApi.version` plus one (3 if this effort merges first). No shape, test or doc
hard-codes the migration's number; tests read `migrations.length` and `agentApi.version`.

Where it touches the security headers middleware, the listener's deadlines or the web mount's
authentication, each change sits in one module of its own with a one-line hook at the call site, so
a rebase over the other effort stays mechanical.

## Constants

Shared values live in a new `packages/api/src/files.ts`, so the server, the bridge and the web UI
read one source; server-only values live beside the code that uses them.

| Constant                | Value                                  | Where                     | Why                                                          |
| ----------------------- | -------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| `maxFileBytes`          | 100 MiB (104,857,600 bytes)            | `packages/api`            | Ruling 1                                                     |
| `maxAttachments`        | 10 a message                           | `packages/api`            | Slack's 10; Gitea and Synapse use 5                          |
| `fileName`              | 1 to 200 code points, rules below      | `packages/api`            | Fits a path segment and a header                             |
| `maxPendingFiles`       | 20 a writer                            | `packages/api`            | Two full messages' worth                                     |
| `maxPendingBytes`       | 1 GiB a writer                         | `packages/api`            | One full message of 100 MiB files, with room                 |
| `pendingLifetime`       | 24 hours from the upload's completion  | `packages/api`            | Outlives an agent's turn (Synapse's 24 hours)                |
| `chunkBytes`            | 1 MiB                                  | server, `store/files.ts`  | Measured: p50 1.7 to 2.1 ms a commit, p99 under 110 ms       |
| `sweepInterval`         | 10 minutes, and once at start          | server, `store/files.ts`  |                                                              |
| `vacuumStep`            | 2,048 pages (8 MiB) a step             | server, `store/files.ts`  | Measured: 12 to 15 ms a step                                 |
| `freeSpaceFloor`        | 1 GiB, beyond every upload arriving    | server, `http/uploads.ts` | Keeps room for the database and its log                      |
| `journalSizeLimit`      | 16 MiB                                 | server, `database.ts`     | Truncates a log a backup's long read let grow                |
| `timeouts.headers`      | 10 seconds, checked every second       | server, `http/listener`   | Unchanged value; now checked every second                    |
| `timeouts.request`      | 30 seconds, every request but uploads  | server, `http/deadlines`  | Unchanged value; now enforced to the second                  |
| `timeouts.bodyIdle`     | 30 seconds without a byte              | server, `http/deadlines`  | Every request, uploads included                              |
| `transferIdle`          | 30 seconds without a byte              | bridge, `agent-api.ts`    | Replaces the answer timeout for file bodies                  |
| `uploadDrainFloor`      | 64 KiB a second                        | bridge, `agent-api.ts`    | An upload's answer also has its size at this rate            |
| `maxImageBlockBytes`    | 3.5 MiB                                | bridge, `file-tools.ts`   | Base64 stays under 5 MB, the strictest host limit found      |
| `fetchedFileLifetime`   | 7 days                                 | bridge, `file-tools.ts`   | Fetched files are a cache                                    |
| `codexToolTimeout`      | 600 seconds                            | `plugin.json`             | 100 MiB at about 1.4 Mbit/s                                  |
| `inlineImageBytes`      | 2 MiB                                  | web, `views/thread/files` | Screenshots show at once; phone photos on demand             |
| `textPreviewBytes`      | 256 KiB                                | web, `views/thread/files` | Read with a `Range` request                                  |
| `uploadIdle` (browser)  | 60 seconds without progress            | web, `api.ts`             | Longer than the server's, so the server's answer comes first |
| `Cache-Control` (files) | `private, max-age=31536000, immutable` | server, `http/files.ts`   | A file never changes                                         |

## Database

### The next migration

STRICT tables, append-only where the HLA says so, with the rules each trigger names. Times are Unix
milliseconds, as everywhere.

```sql
-- Every uploaded file. Its bytes are rows of file_chunks, 1 MiB each but the
-- last, numbered from 0. size is the length the upload declared,
-- known before any byte arrives. A file is incomplete until every byte has
-- arrived (completed_at, with its SHA-256), and pending until a message first
-- names it (attached_at). ref is the random reference an upload answers with
-- and messages name it by. A file belongs to the session it was uploaded
-- under and to the actor that uploaded it; registration_id records the
-- credential behind an agent's upload. name and type are as the uploader
-- gave them: the name the file is attached under unless the message names
-- another, and the declared type, which serving maps onto its allowlist.
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE CHECK (length(ref) = 22),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 127),
  size INTEGER NOT NULL CHECK (size >= 0),
  actor_id INTEGER NOT NULL REFERENCES actors (id),
  session_id INTEGER NOT NULL REFERENCES sessions (id),
  registration_id INTEGER REFERENCES registrations (id),
  created_at INTEGER NOT NULL,
  sha256 BLOB CHECK (sha256 IS NULL OR length(sha256) = 32),
  completed_at INTEGER,
  attached_at INTEGER,
  CHECK ((sha256 IS NULL) = (completed_at IS NULL)),
  CHECK (attached_at IS NULL OR completed_at IS NOT NULL)
) STRICT;

CREATE INDEX files_pending ON files (actor_id) WHERE attached_at IS NULL;

CREATE TRIGGER files_fixed BEFORE UPDATE ON files
WHEN new.id IS NOT old.id OR new.ref IS NOT old.ref OR new.name IS NOT old.name
  OR new.type IS NOT old.type OR new.size IS NOT old.size OR new.actor_id IS NOT old.actor_id
  OR new.session_id IS NOT old.session_id OR new.registration_id IS NOT old.registration_id
  OR new.created_at IS NOT old.created_at
  OR (old.completed_at IS NOT NULL AND (new.completed_at IS NOT old.completed_at
    OR new.sha256 IS NOT old.sha256))
  OR (old.attached_at IS NOT NULL AND new.attached_at IS NOT old.attached_at)
BEGIN
  SELECT RAISE(ABORT, 'a file changes only as its upload arrives and a message first names it');
END;
CREATE TRIGGER files_attached_kept BEFORE DELETE ON files WHEN old.attached_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an attached file is never removed');
END;

-- A file's bytes, in order. A rowid table on purpose: rows of 1 MiB would
-- make a WITHOUT ROWID b-tree's pages hold one row each.
CREATE TABLE file_chunks (
  file_id INTEGER NOT NULL REFERENCES files (id),
  idx INTEGER NOT NULL CHECK (idx >= 0),
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
) STRICT;

CREATE TRIGGER file_chunks_fixed BEFORE UPDATE ON file_chunks
BEGIN
  SELECT RAISE(ABORT, 'a file''s bytes never change');
END;
CREATE TRIGGER file_chunks_kept BEFORE DELETE ON file_chunks
WHEN (SELECT attached_at FROM files WHERE id = old.file_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an attached file keeps its bytes');
END;

-- The files each message carries, in the order it gave them, each under a
-- name unique within the message. A message carries a file it uploaded, or
-- one the message it replaces carries, which it names again. Append-only, as
-- messages are. Naming a file attaches it, for good.
CREATE TABLE attachments (
  thread_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files (id),
  PRIMARY KEY (thread_id, seq, position),
  UNIQUE (thread_id, seq, name),
  FOREIGN KEY (thread_id, seq) REFERENCES messages (thread_id, seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX attachments_files ON attachments (file_id);

CREATE TRIGGER attachments_no_update BEFORE UPDATE ON attachments
BEGIN
  SELECT RAISE(ABORT, 'attachments are append-only');
END;
CREATE TRIGGER attachments_no_delete BEFORE DELETE ON attachments
BEGIN
  SELECT RAISE(ABORT, 'attachments are append-only');
END;
CREATE TRIGGER attachments_attach AFTER INSERT ON attachments
BEGIN
  UPDATE files SET attached_at = (
    SELECT created_at FROM messages WHERE thread_id = new.thread_id AND seq = new.seq
  ) WHERE id = new.file_id AND attached_at IS NULL;
END;
```

- **What the schema holds.** Nothing removes an attached file or its bytes, and no chunk changes
  (A8, ruling 1), by the triggers; a file is attached only once complete, by the `CHECK` that
  `attachments_attach` would otherwise break. The store holds the cross-row rules, as the schema's
  convention has it (`migrations.ts:177-181`): that a message names only its writer's own pending
  uploads of its own session, and a file of another message only by keeping one of the message it
  replaces, all in `checkAttachments`.
- **Missing.** A file is missing when its last chunk is gone: for `size > 0`, no row at
  `idx = (size - 1) / chunkBytes`. A future purge deletes all of a file's chunks, so that one lookup
  finds what it leaves; a read that meets a gap mid-file fails the stream. A zero-byte file is never
  missing. A future purge changes `file_chunks_kept` in its own migration.
- **One chunk size.** Every file is written in `chunkBytes` chunks. A release that changes it adds a
  per-file column in its own migration, `DEFAULT 1048576`, so every older row reads right.
- **Indexes.** `files.ref` (unique) finds an upload by reference; `files_pending` serves the
  per-writer limits and the sweep; `file_chunks`' key serves every read and range; `attachments`'
  key serves a message's files and a thread's, and `attachments_files` the distinct-file queries and
  the foreign key check when the sweep deletes a pending file.
- **Older servers** refuse the database once it has run, as for every migration.

### Incremental vacuum

Turning `auto_vacuum` on needs care, measured on Node 24.18 and 26.13.1:

- `PRAGMA auto_vacuum = INCREMENTAL` takes effect only on a database with no tables, and only
  outside a transaction: set inside `BEGIN IMMEDIATE` on an empty file it is ignored. Every
  migration runs in a transaction (`apps/server/src/database/database.ts:93-121`), so it cannot be
  part of the migration.
- On a database that has tables, the switch needs `VACUUM`, which refuses to run in a transaction
  and rewrites the whole file. In WAL mode it works and writes the whole database through the log.

So `Database.open` gains one step after `#migrate()`, in a module of its own
(`database/vacuum-mode.ts`):

- **The step.** When `PRAGMA auto_vacuum` reads 0 (none), it runs
  `PRAGMA auto_vacuum = INCREMENTAL`, `VACUUM`, then `PRAGMA wal_checkpoint(TRUNCATE)`. A new
  database takes it too, just after its migrations (measured: 1.1 ms for a fresh schema). The check
  reads the header, not the migration number, so a backup restored from an older release converts
  too, and a database already converted never vacuums again.
- **Failure.** The migrations have committed by then, and an older release refuses the migrated
  database, so a failed step must not keep the server from starting. On any error, `SQLITE_FULL` or
  `SQLITE_BUSY` after `busy_timeout` among them, it logs the reason and the space the step needs,
  and the open carries on in mode none. Nothing in this effort needs the mode but returning swept
  pages to the disk; until it converts, freed pages stay in the file for reuse. The header check
  retries at the next open. A switch that succeeds on a database that held data before the open logs
  a line saying so; a new database's switch logs nothing. The server's every log line carries its
  `agention:` prefix.
- **Cost and space.** Once per database, before the server listens, in time proportional to the
  database (measured: 41 MB in 86 to 218 ms). `VACUUM` builds its temporary copy where SQLite puts
  temporary files, since `node:sqlite` is built with `TEMP_STORE=1`: `SQLITE_TMPDIR`, else `TMPDIR`,
  else `/var/tmp`, else `/tmp`, not beside the database; that needs free space of about the
  database's size there. It then writes the whole database through the log beside the database
  (measured: about 1.05 times its size), which the checkpoint empties. The operator guide's upgrade
  note names both. A database without attachments is small. `VACUUM` takes the write lock, so a
  second process opening at the same time waits on `busy_timeout`, and whichever opens first
  (normally `agention serve`) converts. A crash during it leaves the database as it was, since
  `VACUUM` is atomic.
- **The method.** `Database` exposes only `prepare` and `transaction` (`database.ts:60-82`), and a
  prepared `PRAGMA incremental_vacuum(N)` frees one page per `run()` in `node:sqlite`, so it gains
  `vacuumStep(pages)`, which runs it through `exec` outside any transaction and frees all `pages`,
  and `freePages()`, which reads `PRAGMA freelist_count`.
- **Page size** stays 4,096. Changing it needs a database out of WAL mode, and 1 MiB chunks read in
  about 1.1 ms at the median at this size.
- `PRAGMA journal_size_limit` is set at every open beside the other pragmas. No explicit checkpoint
  runs after uploads: each chunk commits on its own, and SQLite's automatic checkpoint kept the log
  at about 4 MiB through 500 MiB of chunk commits.

## The upload store

`apps/server/src/store/files.ts` holds the file operations; the write path's checks stay in
`threads.ts`. Every operation is a synchronous transaction, as every store operation is.

- **Begin** (one transaction): authorize the session (`authorizeSession`, `store/threads.ts:44-52`);
  then refuse `maxPendingFiles` pending files of this actor, arriving or complete and not expired,
  and pending bytes of those files, counted by declared `size`, plus this upload's, over
  `maxPendingBytes`. An expired upload can no longer be named, so it no longer counts. Then insert
  the file row, incomplete, with a new `ref` (16 random bytes, base64url without padding: 22
  characters), and add its id to the process's set of uploads in flight. A writer may run several
  uploads at once, as the operator does from two devices; those limits bound what one writer holds,
  arriving or not.
- **A chunk** (one transaction each): check the credential again (`checkCredential`), so a revoked
  agent's upload stops within a chunk; insert the chunk. The route gathers the body into
  `chunkBytes` buffers, so a chunk is written once full, or at the end.
- **Complete** (one transaction): check that the bytes received equal `size`, then set `sha256` and
  `completed_at`; the id leaves the set.
- **Abort**, on any failure after begin (a stream error, a deadline, a revoked credential, a size
  mismatch, shutdown): delete the file's chunks and its row in one transaction (measured in review:
  about 2 ms for 100 MiB, since SQLite frees overflow pages without rewriting them); the id leaves
  the set. An Abort that itself fails is logged, and leaves the rows for the sweep.
- **Expiry:** a pending file expires `pendingLifetime` after `completed_at`. A message naming one
  that has expired but is not yet swept is refused as if it were gone, and it leaves its writer's
  pending limits at once.

### The sweep

`sweepFiles(store)` runs once as `agention serve` starts, before it listens, then every
`sweepInterval` on a timer that shutdown clears and that never holds the process open. It removes:

- **at start:** every incomplete file, since none can be arriving before the server listens: what a
  crash or a failed Abort left;
- **on the timer:** complete pending files past `pendingLifetime`, and incomplete files whose ids
  are not in the set of uploads in flight, which only a failed Abort leaves.

The set is in memory because only `agention serve` takes uploads (`apps/server/src/cli.ts:122-127`).
Two servers on one database are already unsupported, since a long poll's notifier is in-process
(`docs/architecture.md` "Store"); one would sweep the other's uploads in flight, and the operator
guide says to run one. A slow upload is never swept, however long a chunk takes to fill.

Each file goes as Abort removes one. When the pass freed any pages (`freePages()` above 0), it then
calls `vacuumStep(2048)` repeatedly, each followed by `setImmediate`, until the free list is empty,
so space returns to the disk without holding the connection more than about 15 ms at a time. That
exercises the path a future purge uses. A database the one-time step has not yet converted skips the
vacuum. A failure in a pass is logged and the next pass tries again.

### The free-space floor

Before Begin, the upload route reads `await fs.promises.statfs(dataDirectory)`, on the data
directory's real path, and the bytes still to arrive across every incomplete file, in one query:

```sql
SELECT COALESCE(SUM(
  f.size - (SELECT count(*) FROM file_chunks c WHERE c.file_id = f.id) * 1048576
), 0) FROM files f WHERE f.completed_at IS NULL
```

An incomplete file's chunks are all full ones, the last being written only at the end, so that is
exact. The upload is refused as `storage_full` when
`bavail * bsize - arriving - size < freeSpaceFloor`. `bavail` counts the blocks an unprivileged user
may take, which is what the server can. It covers every writer's uploads, however many run at once.

## Deadlines in the listener

`timeouts.request` today is Node's `server.requestTimeout` (`apps/server/src/http/listener.ts:93`,
`:143`), which is server-wide, cannot be lifted per request, and is checked only every
`connectionsCheckingInterval`, 30 seconds by default, so it fires between 30 and 60 seconds. The
listener replaces it with its own, in a new module, `apps/server/src/http/deadlines.ts`, which
`listen` calls from `serve` with one line.

- **Node's settings.** `createServer` gets `connectionsCheckingInterval: 1000`, so the headers
  deadline Node keeps fires within a second of its 10; `server.requestTimeout = 0` turns Node's
  whole-request deadline off. Measured on Node 24.18: with `requestTimeout` 0, `headersTimeout`
  still answers 408 on time.
- **What the listener tracks.** Each request whose body is not yet complete, from when its headers
  arrive: when it arrived, its socket's `bytesRead` at the last check, and when that last grew.
  `socket.bytesRead` grows as bytes arrive whether or not a route is reading them, so it measures
  the client, not the route. One `setInterval` of a second, which never holds the process open and
  stops on close, checks them all, and drops a request once its body is complete
  (`request.complete`) or its connection has closed, not when its answer finishes: a request
  answered before its body is complete, such as a refusal or a `GET` carrying a body, keeps its
  deadlines, so the rest of its body cannot hold the connection open. A long poll's request is
  complete once its headers arrive, so no deadline ever touches the wait.
- **The deadlines.** A request is cut when its body has sent nothing for `timeouts.bodyIdle`, or,
  unless it is an upload, when it is still incomplete `timeouts.request` after its headers arrived.
  An upload has no total deadline, so a slow phone uplink finishes.
- **The cut.** If its response has not started, the listener answers 408 with the API's error JSON,
  `invalid_input`, "the request body stopped arriving" or "the request took longer than 30 seconds
  to arrive", and `Connection: close`, then destroys the request once that answer is written; if the
  response has started, it destroys the request, and if the response has finished, the socket. The
  answer is written outside Hono, so the module adds what the app's middleware would have: the
  security headers, from the same table `securityHeaders` uses, and on `/api/agent/` paths the agent
  API version header, without which a bridge would read the answer as a server older than itself
  (`apps/bridge/src/agent-api.ts:138-140`, `:165-176`). The route's body read then fails, and an
  upload aborts and removes its partial file. The route then answers too, to a response the 408 has
  ended: `deadlines.ts` replaces that response's `writeHead` with one that does nothing, so the
  route's headers go nowhere rather than reaching the adapter as an error of its own, and the `end`
  that follows finds the response finished. A test pins that.
- **Which requests are uploads.** `isUploadRequest(method, url)` in
  `apps/server/src/http/uploads.ts` matches `POST` whose path is
  `^/api/(agent|web)/s/[^/?#]+/[^/?#]+/uploads$`, query ignored, judged on the path Hono routes: the
  URL as the adapter builds it for Hono, parsed with `URL.parse`, so dot segments are resolved. The
  listener calls it on the request's target under a placeholder host, which changes nothing, and the
  body cap on the request Hono sees, so the listener, the body cap and the router all decide from
  the same path.
- **Slow unauthenticated bodies.** Both mounts authenticate from headers alone, before reading a
  byte (`agent-api.ts:94-104`, `web-api.ts:146-156`), and every check before them reads headers
  only. A refusal (version, authentication, size, a limit, an unknown route) leaves the body unread,
  and `@hono/node-server` 2.1.8 then drains it for at most 500 ms or 64 MiB before closing the
  connection (`drainIncoming`, `dist/index.mjs:826-864`), so no refused upload holds the server
  longer. A plain Node server drains a refused body whole, which an earlier measurement here showed
  and which the adapter's bound replaces. The refusal goes out before the drain, so a client that
  keeps sending still reads it, which the live run checks on real links. Every other path keeps the
  2 MiB cap and the 30-second deadline, as today.
- **The body cap.** Hono's `bodyLimit` takes one fixed `maxSize`, so the app holds two instances,
  `maxFileBytes` and `maxBodyBytes` (`app.ts:127-137`), and a middleware picks one per request with
  `isUploadRequest` on the path Hono routes. With a `Content-Length` it only compares the header and
  reads nothing. An upload over 100 MiB is answered 413 naming the limit, and the route counts the
  bytes again as they arrive.
- **Docs.** `docs/architecture.md` "Serving" and the operator guide's statement of the deadline say:
  10 seconds for headers; 30 for a whole request but an upload; any request body cut off after 30
  seconds without a byte.

## Routes and shapes

All shapes are zod schemas in `packages/api`: the new `files.ts`, and additions to `threads.ts`,
`settings.ts` and `errors.ts`. The file routes join `threadRoutes` (`thread-routes.ts:28-54`), so
they are the same handlers on both mounts under `/s/:agent/:session`, behind each mount's own
authentication, with no change to it.

### Names and types

- **`fileName`:** `singleLineText({ min: 1, max: 200 })` (`text.ts:53-60`), so no control or
  invisible format characters, and also no `/` or `\`, not `.` or `..`, and no white space at either
  end. Stored as written. Two names in one message are the same name when equal after NFC
  normalization, case kept, as suggested answers' labels are compared
  (`packages/api/src/threads.ts:99-104`).
- **`fileRef`:** `^[A-Za-z0-9_-]{22}$`.
- **Declared type:** the `Content-Type` essence, lowercased, when it is `token/token` of at most 127
  characters, otherwise `application/octet-stream`. A few aliases map to their standard names:
  `image/jpg` to `image/jpeg`; `audio/x-wav` and `audio/wave` to `audio/wav`; `audio/x-m4a` to
  `audio/mp4`; `audio/mp3` to `audio/mpeg`; `audio/x-flac` to `audio/flac`.
- **`typeOfName(name)`:** a fixed extension table, for clients that have no type: the bridge always,
  and the web UI when `File.type` is empty. Raster images, SVG, PDF, the media types in the table
  under Serving, `.heic` and `.heif` as `image/heic`, a list of text and source extensions (`txt`,
  `md`, `log`, `csv`, `tsv`, `json`, `jsonl`, `ndjson`, `xml`, `yaml`, `yml`, `toml`, `ini`, `sh`,
  `py`, `js`, `ts`, `tsx`, `go`, `rs`, `java`, `c`, `h`, `cpp`, `rb`, `sql`, `diff`, `patch`,
  `html`, `css` and the like) as `text/plain`, and anything else as `application/octet-stream`.
- **`servedTypeOf(declared)`** and **`dispositionOf(served)`:** the allowlist under Serving, as pure
  functions the server serves by and the web UI chooses its display by.

### Upload

`POST /s/:agent/:session/uploads?name=<fileName>`, on both mounts. The body is the file's bytes,
with `Content-Length` (a chunked body is 411, as everywhere) and the declared `Content-Type`.

- **Order:** the app's checks (host, `Transfer-Encoding`, the body cap at `maxFileBytes`); the
  mount's checks and authentication; `name`; the free-space floor; Begin; the body, a chunk at a
  time; Complete.
- **Answer:** `uploadResult`:

  ```ts
  { upload: fileRef, name: fileName, size: number, type: string, served_type: string,
    expires_at: timestamp }
  ```

- **Rate budgets:** an agent's upload spends one request of its key's budget, as any call; an
  operator's spends none, as transcriptions spend none (`web-api.ts:262-267`). A burst of uploads
  can therefore be `rate_limited`; the operator guide and `file_upload`'s description say so.

### Removing an upload

`POST /s/:agent/:session/uploads/:ref/remove`, on both mounts, each write a POST naming its action
as the API's other removals are (`/groups/:id/remove`). It removes one of the writer's own completed
uploads that no message names, uploaded in that session, with its chunks, in one transaction, so it
leaves the writer's pending limits at once. Any other reference (another writer's, another
session's, one attached, one still arriving, or one naming nothing) is `not_found` at `upload`, in
the same words, as `checkAttachments` refuses another's upload. `ref` is parsed as a `fileRef`. The
answer is `{}`.

An upload still arriving cannot be removed by reference: its writer learns the reference only from
the upload's answer, once every byte has arrived. Ending the request is how its writer stops it, and
Abort removes what arrived, as the web UI's Remove does by aborting its request while bytes remain.
Once every byte has gone the server may already have completed it, so Remove waits for the answer
and removes it by its reference. The bridge has no tool for it.

### Writing: the `attachments` field

`threadCreateInput` and `messageFields` gain `attachments`, which `message_send`'s and
`thread_create`'s tools take from them (`tools.ts:166`, `:188-192`). `threadStartInput`, the
operator's start of a thread, does not: the new-thread sheet has no attach control in this effort.

```ts
attachment = z.object({
  upload: fileRef.optional(), // one of the writer's own pending uploads
  name: fileName.optional(), // with upload: the name to attach it under; by default its own
  keep: fileName.optional(), // a file of the message this one replaces, by its name there
}); // exactly one of upload and keep; name only with upload
attachments = z.array(attachment).min(1).max(maxAttachments);
// no upload named twice; no two names given, kept or named, equal after NFC
```

- **`needsAPart`** (`packages/api/src/threads.ts:313-342`) counts `attachments`, so a message may be
  a file alone, and a replacement that keeps files does not retract.
- **Checks, in the write's fixed order** (`store/threads.ts:23-27`): authorize, digest, replay,
  roles, staleness, then the message rules, where `checkAttachments` runs last, after the
  replacement's own checks:
  - each `upload` names a file whose `actor_id` is the writer, whose `session_id` is the thread's,
    complete, not attached, and not past `pendingLifetime`; anything else, another writer's upload
    or another session's included, is `invalid_input` at `attachments.N.upload`, "names no upload of
    yours waiting to be attached in this session: upload the file again", the same for each, so a
    reference learned elsewhere tells nothing;
  - each `keep` needs `replaces`, else `invalid_input` at `attachments.N.keep`, "keeps a file only
    on a message that replaces another"; and must name a file of the replaced message, else
    `invalid_input`, "names no file of message M";
  - the names resolved (given, kept, or the upload's own) are distinct after NFC, else
    `invalid_input` at `attachments.N.name`, "another file of this message has this name".
- **Digest and replay.** `attachments` is part of the parts the digest covers (`addThread`'s
  `{ title, ...parts }`, `sendMessage`'s `parts`, `store/threads.ts:477`, `:561-565`), and replay
  runs before the checks, so a retry whose first attempt consumed its uploads answers as the first
  did, and the same request id with other attachments is `request_id_conflict`.
- **Writing.** `appendMessage` (`store/threads.ts:164-250`) inserts the message's attachment rows,
  in the order given, after its withdrawals; the trigger marks each file attached.

### Reading: messages, the thread and its files

- **A message** gains `attachments`, in the order given:

  ```ts
  attachments?: { name: string, file: fileRef, size: number, type: string, missing?: true }[]
  ```

  `type` is the declared type; a reader derives the served type with `servedTypeOf`. A kept file has
  the same `file` in both messages. `readMessages` (`thread-reads.ts:524-610`) reads them for the
  page in one more query over the span, as it does asks.

- **The thread answer** (`threadGetResult`) gains `files: { count, bytes }`, over the thread's
  distinct files, each counted once however many messages carry it (A9's per-thread figure).
- **The thread's file list** is a route of its own, `GET /threads/:n/files?cursor=&limit=`, read
  when the web UI unfolds the thread's head list:

  ```ts
  { files: { seq, name, file, size, type, missing?: true, author, created_at }[], next?: cursor }
  ```

  Each file is listed once, with the first message that carried it, which brought it: its sequence,
  author and time. Newest first, by that sequence and then the message's order; `limit` is
  `pageLimit`; `cursor` is an opaque cursor of the kind `store/opaque-cursors.ts` makes, holding the
  last entry's sequence and position. The agent mount has it too, as the shared routes do, and no
  tool uses it, as no tool marks a thread unread.

### Reading a file

`GET` (and `HEAD`) `/threads/:n/messages/:seq/files/:name?file=<fileRef>`, on both mounts; `:name`
is percent-encoded and Hono decodes it.

- **Authorization:** the thread is the session's, the message the thread's, and the name the
  message's, all in one snapshot; any miss is `not_found`. A missing file is `not_found`, "this
  file's contents are missing".
- **The file's ref in the URL.** `file`, when given, must be the ref of the file the message carries
  under that name, else `not_found`. The web UI always gives it, from the message's
  `attachments[].file`, so the browser's cache key names the bytes: after a restore from an older
  backup, a new message that reuses a thread's number and sequence and a file's name is a different
  URL, and no cached copy of the old file shows in its place. The bridge gives it too, from the
  message it reads first (`file_get` below), so a file is fetched only by a reference that names it.
- **The body** streams: a `ReadableStream` whose `pull` reads one chunk in its own transaction,
  which checks the credential again, so other requests run between chunks and a revoked agent's
  download stops within one. A chunk missing mid-file errors the stream, which ends the connection,
  and is logged.
- **Range:** a single `Range: bytes=a-b`, `bytes=a-` or `bytes=-n` is answered 206 with
  `Content-Range`, reading only the chunks it covers and trimming the first and last. Several
  ranges, or another unit, are ignored and answered 200 whole. A range starting at or beyond the
  size, any range of an empty file included, is 416 with `Content-Range: bytes */size` and the API's
  error JSON, `invalid_input`, "the range is outside the file".
- **No conditional requests.** The bytes at a URL never change and are cached as `immutable`, so
  `If-None-Match` and `If-Range` are ignored: honoring them could only give the same answer. The
  `ETag` stays, as the strong validator a browser's cache needs to keep range answers.
- **`HEAD`** answers as `GET` and reads no chunk.

### Storage (A9)

`GET /settings` gains `storage`:

```ts
storage: { count: number, bytes: number }
```

The same totals shape as the thread answer's `files`. `count` and `bytes` count every completed file
the database holds, pending ones included, since that is the disk they take; an upload still
arriving is not yet a file. The thread answer's `files` gives the per-thread figure.

### Error codes and statuses

| Situation                                                   | Code            | Status |
| ----------------------------------------------------------- | --------------- | ------ |
| Upload over 100 MiB by `Content-Length`                     | `invalid_input` | 413    |
| Upload sent chunked                                         | `invalid_input` | 411    |
| A body stopped, or took over 30 seconds                     | `invalid_input` | 408    |
| Pending count or bytes at their limit, naming which         | `invalid_input` | 400    |
| Disk under the free-space floor                             | `storage_full`  | 507    |
| Bytes received differ from `Content-Length`                 | `invalid_input` | 400    |
| `attachments` refused (see Writing)                         | `invalid_input` | 400    |
| Unknown thread, message, name, or a file's contents missing | `not_found`     | 404    |
| An upload to remove that is not the writer's pending one    | `not_found`     | 404    |
| Range outside the file                                      | `invalid_input` | 416    |

- **`storage_full`** is the one new code, on both mounts, so it is part of the next agent API
  version: "the server's disk is too full to take this file until space is freed on it", worded for
  either reader, since the web UI shows it to the operator as the upload's failure.
- **408 and 416** join 411 and 413 as the statuses `invalid_input` takes for bodies and ranges
  (`packages/api/src/errors.ts:40-44`): `timedOutBodyStatus` and `unsatisfiableRangeStatus`.

## Serving headers

### The allowlist

| Declared type, after aliases                                                                                    | `Content-Type`              | `Content-Disposition` | In the page                       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------- | --------------------------------- |
| `image/png`, `image/jpeg`, `image/gif`, `image/webp`                                                            | the same                    | `inline`              | `<img>`                           |
| `image/svg+xml`                                                                                                 | `image/svg+xml`             | `attachment`          | `<img>`                           |
| `application/pdf`                                                                                               | `application/pdf`           | `inline`              | Open, in a new tab                |
| `video/mp4`, `video/webm`, `video/ogg`                                                                          | the same                    | `inline`              | `<video controls preload="none">` |
| `audio/mpeg`, `audio/mp4`, `audio/ogg`, `audio/webm`, `audio/wav`, `audio/flac`                                 | the same                    | `inline`              | `<audio controls preload="none">` |
| `text/*`, `application/json`, `application/xml`, `application/x-ndjson`, `application/yaml`, `application/toml` | `text/plain; charset=utf-8` | `inline`              | `<pre>`, fetched when shown       |
| Anything else, HEIC and `text/html`'s lookalikes such as `application/xhtml+xml` included                       | `application/octet-stream`  | `attachment`          | Download only                     |

SVG is served as itself so `<img>` draws it, which it does only then (observed in Chromium), and as
an attachment so opening it on its own downloads it rather than running it as a document. HTML is
text. No served type is a script or style type, so the app's `script-src 'self'` and
`style-src 'self'` can never be pointed at a file.

### Every file response

- `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`, and `ETag: "<sha256 in hex>"`, strong,
  since the bytes never change.
- `Content-Disposition`, per RFC 6266 with RFC 5987's extended value:
  `<disposition>; filename="<fallback>"; filename*=UTF-8''<encoded>`. The fallback replaces every
  character outside printable ASCII, and `"`, `\` and `%`, with `_`; the encoded value is the name's
  UTF-8 with every byte outside RFC 5987's `attr-char` (letters, digits and ``!#$&+-.^_`|~``)
  written as `%XX`. `encodeURIComponent` is not enough, since it leaves `'()*` as they are.
- `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'`.
- `Cross-Origin-Resource-Policy: same-origin`.
- `Cache-Control: private, max-age=31536000, immutable`: seeking a video or reopening a photo does
  not fetch it again on a phone's data plan. A file stays in the browser's cache after sign-out,
  which SECURITY.md says.
- The server's other security headers, unchanged: `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and HSTS, and on the agent mount the agent API version.

### The headers middleware

`securityHeaders` (`app.ts:42-60`) keeps a route's own value only for headers that `OwnHeaders`
names for the exact path (`app.ts:53`, `diagram-frame.ts:73`, `:97`), and a file's path is a
pattern, with its varying part in the middle, so a prefix rule would not reach it. A route declares
its own instead: a helper, `ownHeaders(c, ["content-security-policy", "cache-control"])`, records on
the request's context the headers the route set for itself, and the middleware keeps those and sets
the rest. The diagram frame's two routes move to the same helper and the path map goes, so one rule
covers every route that sets its own. The helper and the middleware's reading of it are one small
module, `http/own-headers.ts`.

The app's own policy gains `media-src 'self'` (`app.ts:30-36`), so in-page video and audio load, and
nothing else.

## The bridge

New tools in `apps/bridge/src/file-tools.ts`, registered with the others, annotated alike.

### `file_upload`

- **Input:** `{ path, name? }`. `path` is an absolute path, else `invalid_input`; `name` is a
  `fileName`, by default the path's last segment, which must itself be one, else `invalid_input`
  asking for `name`.
- **Opening:** `open(path, O_RDONLY | O_NONBLOCK | O_NOCTTY)`, so a FIFO cannot hang the call and a
  terminal never becomes the bridge's controlling terminal, then `fstat` the descriptor and refuse:
  - anything but a regular file;
  - a size over `maxFileBytes`, naming 100 MiB, before any byte is sent;
  - any file of the bridge's own: the path's real path (`fs.realpath`) at or under the real path of
    `~/.config/agention`, where every session's key lives, so a key named directly or through a
    symlink is refused, for every session, since sessions sharing a home share keys (SECURITY.md
    "Isolation between sessions"). When `~/.config/agention` does not exist, there is no key to
    protect, and the check is skipped. Fetched files live outside that tree, so an agent may send
    one on. The check keeps the agent from handing a credential to the server by mistake; it is no
    boundary against the agent, which runs as the same user and could read the key itself, so a hard
    link it made on purpose is out of its scope.
- **The type:** `typeOfName(name)`. The bridge reads no file's content to choose it.
- **Streaming:** `AgentApi` gains `upload`, which sends a `fs.createReadStream` of the descriptor
  with `start` 0 and `end` the `fstat` size minus one, since `end` is inclusive, and no stream at
  all for an empty file, with `Content-Length` set to that size, so Node never chunks it. A file
  that shrinks while it is read ends short, and the bridge aborts with "the file changed while it
  was read"; one that grows sends only its first `size` bytes. The answer is read and its version
  checked as for every request. Once the body is written, the answer has `answerTimeout` and the
  file's size at `uploadDrainFloor`, 64 KiB a second (100 MiB: about 27 minutes more): writing ends
  when the socket's buffers and those on the way, a proxy's or a tunnel's, have taken the bytes,
  which the live run measured at megabytes the server had yet to receive. A refusal the server
  answers before the body is all sent needs nothing special in the bridge: the server's adapter
  drains a refused upload's body for a bounded time before closing the connection, so the refusal
  stays readable as any answer is.
- **Answer:** the server's `uploadResult`, with the text "Name it in `attachments` of `message_send`
  or `thread_create` as `{upload}` before `expires_at`".

### `file_get`

- **Input:** `{ thread, seq, name }`.
- **The message first:** it reads the thread from just before `seq`, one message
  (`after: seq - 1, limit: 1`), through the shared message schema, for the file's reference and
  declared type under that name, compared as names are; a message or name it does not find is
  `not_found`. Only a reference that parses as `fileRef` names a file. It then reads the file with
  `?file=<ref>`.
- **The directory:** one flat cache, `~/.cache/agention/files/`, under the private-file rule
  (`ensurePrivateDirectory`), outside the key tree. A ref is 128 random bits, so the files of every
  server and session can share it.
- **The file's name** is `<file ref>.<extension>`, the extension the bridge's own for the served
  type (`png`, `jpg`, `gif`, `webp`, `svg`, `pdf`, `mp4`, `webm`, `ogv`, `mp3`, `m4a`, `ogg`, `wav`,
  `flac`, `txt`, else `bin`), never anything from the sender's name. An answer that states no
  `Content-Length`, or one over `maxFileBytes`, is refused before anything is written, so a server
  at the wrong origin cannot fill the disk. The body streams into `.<random>.part` in that
  directory, created with mode 0600, and is renamed into place once it ends: Node holds a body to
  its `Content-Length`, so a body short of it fails the read. A failure removes the `.part` file.
  Fetching the same file again replaces it.
- **Cleanup:** each call first removes every entry of that directory modified more than
  `fetchedFileLifetime` ago, `.part` files included, so ended sessions' files go too.
- **Answer:** `{ path, name, size, type, served_type }` as text, and, when the served type is a
  raster image, its leading bytes carry that type's signature (PNG, JPEG, GIF or WebP, from the
  first 12 bytes; the bridge's one reading of a file's content), and its size is at most
  `maxImageBlockBytes`, an `image` block with its base64 and type. Over the limit, the text says
  "too large to show here; read the file at path". The text and the block are the whole result: no
  `resource_link`, no `structuredContent` (HLA, Agents). The live run sends both hosts a broken
  block; if neither fails the whole call over one, the signature check goes.
- `tools.ts`'s `tool` helper gains a way for a tool to add content blocks after its text; every
  other tool answers as now.

### Timeouts

- **Transfers** run under `transferIdle` instead of `answerTimeout`: an `AbortController` aborted
  when 30 seconds pass with no byte read from the file into the socket, or none of the answer read,
  re-armed on each. After the upload's body is sent, the answer has the usual `answerTimeout`.
- **Hosts.** Codex kills a tool call after 60 seconds by default. Its plugin loader deserializes a
  plugin's `.mcp.json` entry into the same `McpServerConfig` as `config.toml`, whose
  `tool_timeout_sec` it honors (read in `openai/codex` at `1476a08`, 2026-11-22:
  `codex-rs/codex-mcp/src/plugin_config.rs` `normalize_plugin_mcp_server`, and
  `codex-rs/config/src/mcp_types.rs`, fields `tool_timeout_sec` and `startup_timeout_sec`). So
  `apps/agent-plugin/plugin.json`'s `mcpServer` gains `toolTimeoutSeconds: 600`, which the generator
  writes into the Codex plugin as `tool_timeout_sec`. It applies to every tool of the server;
  `message_wait` keeps its own 55-second budget. Claude Code's plugin format sets no such value, so
  Claude Code's default limit is long enough, so the generated plugin sets nothing for it, and the
  live run measures that default against a slow upload.
- **What the agent is told** when a call cannot finish: an idle transfer fails with "the transfer
  stalled for 30 seconds; try again, and tell the operator if it keeps happening"; a host that kills
  the call cancels it, and the server removes the partial upload. The tools' descriptions say a
  large file on a slow link can outlast the host's limit on one call.

### Messages, the answer cap and the version

- `fit.ts`'s list of text-bearing fields (`fit.ts:60-74`) gains `["attachments"]`, so a message
  still over the cap at one element leaves out its file list whole, named in `omitted`, as
  `references` can go. Ten names at their bound add at most about 9 KB to a message.
- The tool and field descriptions say how files go: upload first, then name the upload; a
  replacement keeps a file only by `{keep}`; a message's text links to its own files as
  `[label](attachment:name)`; `file_get` reads any file of the session's threads by message and
  name.
- **The next agent API version** covers the upload route, the file and file-list routes, the
  `attachments` field, the `files` summary and `storage_full`. Released bridges keep working for
  everything else: answers pass through as JSON (`tools.ts:103`), so they show agents `attachments`
  and `files` they cannot fetch, which CONTRIBUTING "The agent API" allows. A bridge of the new
  version facing an older server is refused on every call, saying so (`agent-api.ts:165-176`).
- **The compatibility suite** (`released-bridges.compat.ts`) adds, for each released bridge: the
  operator uploads a file and writes a message carrying it; the bridge's `thread_get` reads that
  message, its `attachments` and the thread's `files` passing through; the bridge replaces a message
  of its own that the test gave a file through the API, and the replacement, without `keep`, leaves
  the file with the message it replaced; `message_wait` wakes on the message with a file.

## The web UI

New code in `apps/web/src/views/thread/files/`: `attach.ts` (the upload queue), `AttachList.tsx`
(the composer's list), `FileList.tsx` (a message's list and the head's), `FileView.tsx` (in-place
display); `api.ts` gains `uploadFile`.

### Attaching

- **The control:** an Attach button, its icon alone with the label "Attach files", in the Send row
  beside Send, opening a hidden `<input type="file" multiple>` with no `accept` and no `capture`, so
  Android offers the camera among its sources.
- **Paste:** on the message box and the Details box, a paste whose clipboard holds one or more image
  files (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) attaches them and inserts no text;
  any other paste is the browser's own. A pasted image is named `pasted-YYYYMMDD-HHMMSS.<ext>` in
  local time, `-2`, `-3` and so on after it when the name is taken in the draft.
- **The list:** above the Send row, each file with its name, size, and state: waiting, uploading
  with a `<progress>`, uploaded, failed with why and Retry, or expired with Upload again; each with
  Remove. It says the limits once: "Up to 10 files, 100 MiB each."
- **Uploading:** one file at a time, in the order chosen, starting as soon as it is chosen or
  pasted, so the bar shows one file filling the link. `uploadFile` uses `XMLHttpRequest`, since
  `fetch` reports no upload progress: the body is the `File`, so the browser sends its length;
  headers carry the declared type (`File.type`, else `typeOfName`) and the CSRF token;
  `upload.onprogress` drives the bar; no progress for `uploadIdle` aborts it as a network failure;
  there is no total deadline. Answers are read as `exchange` reads them (`api.ts:114-162`), so a
  refusal shows the API's message. The draft keeps each `File`, so Retry and Upload again send it
  again.
- **Limits in the browser:** a file over 100 MiB, or an eleventh, is refused in the list with the
  limit named, without uploading.
- **Remove** aborts an upload in progress while bytes remain, which the server then removes. Once
  the last progress event says every byte has gone (`sent` equals the file's size), it does not
  abort, since the server may already have completed the upload: the file leaves the list and the
  queue moves on, and when the upload answers, the draft calls the remove route with its reference.
  A finished one it removes through the route as it drops it from the draft, reading its reference
  from the file's state. So a removed file stops counting against the operator's pending limits at
  once. Two cases leave an upload to expire, the next refusal at the limit saying so: a removal that
  fails, and a Remove in the moment before the list shows what the upload last did, which aborts an
  upload whose last byte has gone unreported, or drops one whose answer the list has not yet
  rendered.
- **Send waits:** Send is unavailable while any file is waiting, uploading, failed or expired, with
  the Send row saying which ("Uploading 2 of 3 files", "A file did not upload: retry or remove it").
  A message may be files alone. `contentOf` (`writer.ts:197-213`) adds `attachments`: kept files as
  `{ keep }`, then uploads as `{ upload, name }`, in the list's order. A refusal naming
  `attachments.N.upload` marks that file expired. A stale write keeps the files with the draft; a
  write that lands clears the files it sent, as it clears the text it sent.
- **Editing** a message, and changing a message's answers, load its files into the list as kept,
  which Remove drops from the replacement; the replaced message keeps them either way. Removing what
  is staged drops the kept files and keeps new uploads.

### Showing files

- **In a message:** under its text, detail and references, a list of its files: name, type, size;
  Download for every file present (`<a download>` naming it); every element and link loads the
  file's URL with its `file` ref; and by served type:
  - images up to `inlineImageBytes` show at once as `<img loading="lazy">`, scaled to the column;
    larger ones behind Show image;
  - video and audio as their players, `preload="none"`, so nothing loads until played;
  - text behind Show text, fetched with `Range: bytes=0-262143` into a `<pre>`, decoded as UTF-8
    with replacement, with "Showing the first 256 KiB; download it for the rest" when it is longer;
  - PDF as Open, a link opening the file in a new tab (`target="_blank"`, `rel="noopener"`), since
    Chromium shows no PDF in a frame;
  - anything else as Download alone.

  A missing file shows its name, type and size marked Missing, with no controls. No file's bytes
  ever become a `blob:` or `data:` URL: every element loads the file's own URL, with its headers.

- **Replaced messages** list their files in their folded body as they show everything else.
- **The thread's head:** when `files.count` is above 0, a fold under the header, "Files (12, 340
  MiB)", folded on every visit. Unfolding reads the file list, 50 at a time with Show more, and
  rereads it as the thread refreshes while open. Each entry gives the name, type, size, who attached
  it, when, a link to its message (`#message-<seq>`, as the jump to unread moves there), and
  Download, or Missing.
- **Settings** gains a Storage section, read-only, after Voice: "Attachments take 1.2 GiB in 340
  files, and every backup copies them." It reads `storage` from `GET /settings`.
- **Links in Markdown:** a link whose destination is `attachment:` and a name, percent-encoded where
  needed (`attachment:build%20log.txt`) or in angle brackets (`<attachment:build log.txt>`), is live
  when the name, decoded and NFC-normalized, is one of that message's own files. It acts as the name
  in the message's list does: an image, media or text opens in place in the list and takes focus
  there; a PDF opens in its tab; anything else downloads. Any other `attachment:` link is its text,
  as a URL the link rule refuses is today. An image written with that destination is such a link
  too: Markdown images still never load. `Markdown` gains an optional `files` context that
  `MessageBody` and `MessageDetail` pass (`Messages.tsx:108-131`, `:836-898`), so a message links
  only to its own files.
- **`carriesNothing`** (`Messages.tsx:183-193`) counts attachments, so a replacement carrying only
  files does not read as a retraction.

### Focus

Every move of focus below runs in a layout effect, never a passive one, so it lands in the commit
that changes the controls, the rule `fix/focus-in-commit` adds to `docs/architecture.md`'s Web UI
section (not yet on `main` at this branch's base; this effort follows it either way).

- Choosing files leaves focus on Attach, where the picker returns it.
- Remove moves focus to the next file's Remove, else the previous one's, else Attach.
- Retry and Upload again move focus to that file's Remove, which stays through the upload.
- Show image and Show text keep focus on their control, which becomes Hide with `aria-expanded`.
- An `attachment:` link that opens a file in place moves focus to that file's entry.
- Send's existing behavior is unchanged.

## Collateral

### ADR 0004: attachments in the database, served inert

- **Context:** A1 to A9; one operator's files, up to 100 MiB each, kept for good; one origin; one
  SQLite file as the whole state (ADR 0001 "One Node server and one SQLite database").
- **Decision:** files as 1 MiB chunks in the database; upload first, then a message names the
  upload; a file is its message's, by name; serving by an allowlist of types, `nosniff`, a sandbox
  policy and disposition, cached privately for good; in-page display as elements of the app's own
  document, never `blob:` or `data:` URLs; the listener's own deadlines, with no total deadline for
  uploads; incremental vacuum from this release on.
- **Alternatives:** files on disk, named by their hash (incremental backups and cheap purges, at the
  price of a two-part backup and restore and an amendment of ADR 0001); a separate cookieless origin
  for files (the large products' answer, which one operator's single origin cannot have);
  short-lived signed URLs; multipart and resumable (tus) uploads; type detection on the server;
  server-side previews.
- **Consequences:** backups grow with every file and are never incremental; each chunk is a
  synchronous commit, with pauses of up to about 150 ms during a large upload; the future purge
  deletes rows and runs incremental vacuum; a file opened on its own is a sandboxed document, so
  media opened in a tab of its own fails, which the page avoids.
- **Supersedes** ADR 0001's "so no content makes the browser fetch anything" in "Text is Markdown,
  rendered inert" (`docs/adrs/0001-agention-v1-architecture.md:134-135`); ADR 0001's Status gains
  the line, as it has for ADR 0002.

### The restated rules

- **SECURITY.md "Inert content"** keeps every word about Markdown, which still loads no image, and
  adds that files attached to messages load only as Attachments says. A new "Attachments" subsection
  states: who can read a file; the allowlist, headers and in-page display; no `blob:` or `data:`
  URLs; references private to their writer; the bridge's refusals and its fetch directory; the disk
  floor and pending limits; photos keeping their metadata, location included, which reaches agents;
  files cached in the browser after sign-out; and that in Chrome and Edge a PDF's safety rests on
  the browser's viewer, which ignores a PDF's sandbox policy. Firefox, whose viewer is pdf.js, is
  untested for that: the operator's devices run Chrome and Edge, and the section says so rather than
  claim it.
- **`docs/review-checklist.md` A9** becomes: no Markdown image loads, and an attached file loads
  only through the file routes, with their headers, as an `<img>`, `<video>` or `<audio>` of the
  app's page, as text the page fetched, or as a PDF in a tab: never in a frame, and never as a
  `blob:` or `data:` URL.
- **`docs/architecture.md`:** "Database" (the tables, chunks, the vacuum mode), "Store" (uploads,
  the sweep), "HTTP API" (the routes, the body cap, the codes), "Serving" (the deadlines), "Agent
  bridge" (the tools, the fetch directory, the timeouts) and "Web UI" (attaching and showing).
- **`docs/operator-guide.md`:** the limits; backups growing with attachments and needing free space
  equal to the database; the upgrade's one-time conversion and the space it needs, in SQLite's
  temporary directory and beside the database; running one server per database; the Storage line;
  photos keeping their location; the free-space floor; the fetch cache on agent machines,
  `~/.cache/agention/files/`, which may be cleared; Codex's timeout set by the plugin, and Claude
  Code's `MCP_TOOL_TIMEOUT`; a proxy in front capping bodies (Tailscale Serve, by the live run);
  that "Open video in new tab" from a context menu fails, by design.
- **The usage skill** and the tool descriptions: uploading, naming, keeping, linking and fetching.
- **`docs/live-testing.md`:** the attachment hunts below.

## Testing

- **Migration:**
  - a database at the migration before opened at HEAD gains the tables and converts to incremental
    vacuum once, its data unchanged, and a second open does not vacuum again;
  - a new database converts just after its migrations;
  - the step forced to fail: the open logs and succeeds in mode none, and the next open converts;
  - every trigger refuses what it names: an attached file deleted, its chunks deleted or changed, an
    attachment changed or deleted; and the `CHECK` refuses attaching an incomplete file.
- **Store:**
  - Begin's two limits, counting uploads still arriving, and two uploads of one writer at once;
  - chunks, completion with the hash, a size mismatch, Abort in one transaction;
  - removing an upload: the writer's own, its chunks with it, freeing its place at once; another
    writer's, another session's, an attached, an arriving and an unknown reference `not_found`;
  - the credential checked again per chunk;
  - `checkAttachments`: another writer's, another session's, an unknown, an expired and an attached
    reference all refused alike; `keep` with and without `replaces`; NFC-equal names; ten and
    eleven;
  - replay of a write whose uploads were consumed, and `request_id_conflict` with other attachments;
  - distinct files per thread, the totals, the file list's order and paging;
  - missing by fixture: a file whose chunks a test removed after dropping the trigger reads as
    missing in messages and lists, and its read is `not_found`;
  - the sweep: at start, every incomplete file removed; on the timer, expired files and incomplete
    files not in flight removed, while an upload in flight that has not filled a chunk for minutes
    and attached files stay; pages returned to the disk, asserting the number of `vacuumStep` calls,
    not only that pages come back.
- **Routes:**
  - the upload on both mounts, its answer, and each code in the table;
  - removing an upload on both mounts, the other writer's refused, and a malformed reference;
  - an unauthenticated, an unversioned and an over-size upload refused before the body is read, the
    server reading no more than the adapter's drain allows;
  - the free-space floor, with `statfs` stubbed and other writers' uploads arriving;
  - the file read on both mounts, another session's thread `not_found`, and a `file` ref that is not
    the message's file's `not_found`;
  - ranges: each form, several ranges answered whole, 416 with `Content-Range`, an empty file,
    `HEAD` reading no chunk, `If-None-Match` and `If-Range` ignored;
  - the 2 MiB cap kept on every other route.
- **Headers:**
  - for each allowlisted type and others (HTML, SVG, HEIC, a type with parameters, none, malformed):
    the served type, disposition, policy, CORP, `ETag` and caching;
  - a property test that no file response carries a type outside the served set, over generated
    declared types;
  - `Content-Disposition` for ASCII, quotes, `%`, `'()*`, non-ASCII and the longest name;
  - `ownHeaders`: the diagram frame's and the file routes' policies kept, every other route's
    replaced.
- **Deadlines:**
  - an idle upload body cut at 30 seconds and its partial file gone; an upload trickling a byte a
    second past 30 seconds finishing; a non-upload body cut at 30 seconds whole, to the second; a
    long poll outliving both; headers still cut at 10;
  - the listener's 408 carrying the security headers, and on the agent mount the agent API version,
    read through the bridge's `AgentApi` as the server's own refusal, not as an older server;
  - a fake clock drives the module, and one test with real timers checks the wiring.
- **Bridge:**
  - `file_upload`: a relative path, a directory, a FIFO (no hang), a device, a file over the limit,
    a key file by path and by symlink, another session's key, a fetched file sent on, an empty file,
    a file that shrinks or grows while read, a refusal answered mid-body;
  - the type from the extension;
  - `file_get`: its directory under the private-file rule, the naming, `.part` and rename, cleanup
    by age of files and `.part` files alike, the image block for each raster type, none over the
    limit or for a lying signature, none for SVG;
  - the transfer idle timeout both ways;
  - an upload's answer waiting `answerTimeout` and its size at `uploadDrainFloor` once its bytes are
    written, against a stand-in server that takes them and does not answer;
  - `fit.ts` leaving out `attachments`;
  - the generated Codex plugin carrying `tool_timeout_sec`, and plugin drift.
- **Compatibility:** the released-bridge additions above.
- **Web units:**
  - paste: images attach, text pastes, mixed clipboards;
  - the queue: one at a time, progress, idle abort, Retry, Remove of each state, a finished one
    removed from the server, one whose every byte has gone removed once it answers, one with bytes
    remaining aborted, expiry on refusal;
  - Send unavailable until uploads finish, and a message of files alone;
  - `contentOf` with kept and new files; edit and answer changes loading kept files;
  - display by served type and size threshold, missing files, the text preview's range;
  - `attachment:` links, live and not, and an image written with one;
  - the head fold and its paging; the Storage line;
  - focus after each control change, judged inside `waitFor` the first time the change shows.
- **Browser (Chromium, in the gate):**
  - attach a file and paste an image, send, see both in the message and the head list;
  - an image, a video (played and sought, counting the fetches the seek makes), audio and text shown
    in place;
  - a PDF opening in a tab;
  - every file downloading;
  - served bytes of HTML and script declared as each allowlisted type, opened in the page and on
    their own: nothing runs;
  - an SVG drawn in `<img>` and downloaded when opened.
- **Live run** (the `integration-testing` method, `docs/live-testing.md`):
  - the image block's limit: 0.5, 2 and 3.5 MiB photos through `file_get` in Claude Code and Codex,
    lowering `maxImageBlockBytes` if a host refuses, truncates or errs;
  - a broken `image` block (bytes that are not the image its type says) in each host, to learn
    whether a host fails the whole call or only shows an error, which decides whether `file_get`
    keeps its signature check;
  - a refusal mid-body (a pending limit or `storage_full`) of an upload from the phone over mobile
    data, and from the bridge through Tailscale Serve, arriving named rather than as a reset
    connection; if it does not, the adapter's drain is revisited;
  - tool-call times: a 100 MiB upload over a throttled link in each host, confirming Codex honors
    the plugin's `tool_timeout_sec` and measuring Claude Code's default;
  - a 100 MiB body through Tailscale Serve to the staging server;
  - early, on the staging server, PDFs in Windows Edge's viewer and Android Chrome's;
  - the chunk commit times on the operator's host class, against the 150 ms seen here;
  - the operator's acceptance: a photo from the Android phone read by an agent, and an image, a PDF,
    a video and a text file an agent attached opened on Android Chrome and Windows Edge or Chrome.
