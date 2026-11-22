# Attachments for Agention: prior art and options

<!-- cspell:ignore anthropics Bugzilla busboy cookieless crbug Discourse EXDEV EXIF fasterthanfs -->
<!-- cspell:ignore Forgejo Gitea Gitea's Heise Immich JRASERVER Mattermost Memos navigations -->
<!-- cspell:ignore Nextcloud nosniff paperless Referer refetches Repr scriptable sindresorhus -->
<!-- cspell:ignore subresource Synapse usememos -->

Research notes, compiled 2026-11-21, for the requirements in `frd.md` beside this file: serving,
viewing and authorizing files on one origin, phone uploads, caps, storage and backup, upload
mechanics, files through MCP, and type detection. No code was changed.

Source grades: **A** primary (specs, vendor docs, project or browser source, bug trackers for status
and dates, observed responses); **B** primary but informal (a maintainer or browser-team comment, a
vendor blog read through a search summary, a draft); **C** reputable secondary (tech press,
reference sites); **D** anecdote (user issue reports, forums, blogs). Bracketed numbers cite the
sources table. **Stated** means the source says it; **Inferred** means it is reasoning from the
sources, which the source does not say. Local code is cited by path in this repository.

## Executive summary

1. **Large products put user files on a separate cookieless origin.** Same-origin products (Gitea,
   Forgejo, Mattermost, Discourse, Nextcloud, Jira) share one recipe: a server-chosen type with
   `nosniff`, inline only for an allowlist (raster images, media, sometimes PDF and text),
   `attachment` for the rest (SVG always), and `CSP: sandbox` with per-viewer exceptions.
2. **Chrome strips CSP from PDF responses** except `frame-ancestors`, so a sandbox header neither
   breaks nor protects a top-level PDF. A sandboxed frame, or a tab inheriting its flags, does block
   the viewer.
3. **Video and audio opened top-level under `CSP: sandbox` lose `Strict` and `Lax` cookies** on
   their range requests, since the document has an opaque origin. Agention's session cookie is
   `SameSite=Strict`. Media embedded in the app page is unaffected.
4. **Prior art keeps files on disk beside the database, with metadata in it.** SQLite measures
   external files as faster above about 100 KB, `node:sqlite` has no incremental blob API, and every
   surveyed self-hosted app but Memos defaults to disk. Immich states the backup order: database
   first, then files.
5. **A raw streamed body per file is the lightest upload shape available.** Hono's multipart parsing
   buffers the whole body, tus carries resumable state Agention has no use for, and the current 2
   MiB global body cap would refuse any 100 MiB file.
6. **Through MCP, `image` is the only binary block both hosts show the model.** Codex turns
   `resource_link` and embedded resources into JSON text, Claude Code reportedly ignores
   `resource_link`, and both drop `content` beside `structuredContent`. Sending takes a local path.
7. **No surveyed product lets the declared type decide the served type.** `file-type` sniffs binary
   formats; the MIME Sniffing standard guarantees a supplied `text/plain` under `nosniff` is never
   scriptable.

## Local baseline

Every response gets the same security headers from `apps/server/src/http/app.ts`: a CSP of
`default-src 'none'` with `script-src 'self'`, `img-src 'self' blob:`, `connect-src 'self'`,
`frame-src` for the diagram frame only and `frame-ancestors 'none'`, plus `nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`; a route keeps
its own value only where the diagram frame's routes do. The CSP has no `media-src`, so it falls back
to `default-src 'none'`. The session cookie is `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`
(`apps/server/src/http/web-api.ts`). The body cap is 2 MiB, a `Transfer-Encoding` body is refused
with 411, and Hono's `bodyLimit` covers all of `/api/*` (`app.ts`). The one binary upload today
reads its whole body with `arrayBuffer()` (`apps/server/src/http/transcription-route.ts`). Backup
copies one database snapshot with `node:sqlite`'s `backup()` and checks it
(`apps/server/src/database/backup.ts`). Bridge answers are one text block declaring
`anthropic/maxResultSizeChars` 40000 (`apps/bridge/src/tools.ts`, `apps/bridge/src/fit.ts`).

## Findings

### Serving files the operator did not write from one origin

- **Separate origins.** GitHub moved user content to `*.githubusercontent.com` in 2014 and its
  bounty scope relies on "the fact that we don't send any cookies to that domain" [16]. Observed
  `raw.githubusercontent.com` headers still add a sandboxing CSP, `text/plain` and `nosniff` [15].
  Google puts risky content on `*.googleusercontent.com` with a per-document URL token [17]. Matrix:
  "Clients SHOULD NOT be hosted on the same domain as the media endpoints" [7]. (Stated.)
- **Matrix spec v1.19** [7] (stated): SHOULD send `CSP: sandbox; default-src 'none';` with
  `script-src 'none'; plugin-types application/pdf; style-src 'unsafe-inline'; object-src 'self';`;
  `Content-Disposition` MUST be `inline` only for an allowlist of text, JSON, raster image, video
  and audio types, else `attachment`; the list has no PDF and no SVG. Its reasoning: with a declared
  allowlisted type, "if a HTML file is uploaded with a Content-Type of image/png, clients will just
  assume that the image is corrupted". Synapse sends that CSP plus `Referrer-Policy: no-referrer`,
  with "SVGs are _intentionally_ omitted" [8].
- **Gitea** [9] (stated, code): `nosniff` and an explicit type on every user-content response;
  sniffed text, HTML included, served as `text/plain` "intentionally ... for safety"; default CSP
  `sandbox allow-scripts ...` with the comment "Disable JS execution on the same origin, since we
  serve the file from the same origin as Gitea server" (scripts only so SVG works in the opaque
  origin); PDF gets no sandbox because "it breaks rendering in at least Safari"; audio and video get
  no CSP at all since PR #37455; `attachment` is the default when a filename is set (PR #37552).
  Forgejo has the same shape [10].
- **Mattermost** [11] (stated, code): JavaScript and `text/html` rewritten to `text/plain`; only
  raster images, some video and some audio are `inline`, so PDF and SVG download; every file
  response has `X-Frame-Options: DENY` and `frame-ancestors 'none'`; no sandbox; served through Go's
  range-aware `http.ServeContent`.
- **Discourse** [12] (stated, code): `CSP: sandbox;` on every local upload; inline only for images
  except SVG ("SVG cannot safely be shown as a document"), PDF, video and audio. CVE-2025-66488
  (HTML and XML uploads ran script on the CDN domain) was fixed by forcing `attachment`.
- **Nextcloud** [13] adds `attachment` to every WebDAV GET and views files in its own apps. **Jira**
  [14] sends `CSP: sandbox` on attachments except HTML and JavaScript, which it says "can't be
  sandboxed". (Stated.)
- **Inferred common recipe:** pin the type, inline only types the browser renders without author
  script, sandbox the rest, and do rich viewing in the app's own UI rather than by navigating to the
  file.

Bears on: A5 and A6. With one origin, the file response's own headers are the whole boundary. A file
served under the page headers in `app.ts` would run with `script-src 'self'`, so an uploaded HTML
file could load another upload served as JavaScript and act as the operator (inferred). The
`securityHeaders` middleware replaces route values today, so a file route's headers cannot come from
it unchanged.

### Browser viewers

**PDF in Chrome and Edge.**

- Stated [1]: Chromium's `plugin_response_interceptor_url_loader_throttle.cc` says "Ignore CSP
  served on a PDF response" (crbug 40328564) and calls `ClearAllButFrameAncestors`. The test
  `CSPWithSandboxDoesNotBlockPDF` pins that a PDF served with exactly
  `content-security-policy: sandbox` displays (regression test for crbug 40754148, fixed in Chrome
  91), and `CSPFrameAncestorsCanBlockEmbedding` pins that `frame-ancestors` still applies [2], [4].
- Stated [3]: `pdf_navigation_throttle.cc` cancels a PDF navigation whose sandbox flags include
  `kPlugins` with `ERR_BLOCKED_BY_CLIENT`. Inferred: this fires for an iframe `sandbox` attribute
  and for a tab that inherits sandbox flags from a sandboxed opener, and no sandbox token clears
  `kPlugins`. A PDF link inside Agention's sandboxed diagram frame would fail; one in the main page
  would not.
- Inferred: PDF safety in Chrome rests on the viewer's own isolation (PDF script has no DOM), which
  is Gitea's stated reasoning [9]. Whether Edge's Adobe-powered viewer keeps the throttle is
  unverified. 2026 reports blaming CSP sandbox for blocked PDFs [25] conflict with the source; one
  was the Acrobat extension.
- Stated [5]: pdf.js had an arbitrary-JavaScript CVE (CVE-2024-4367). Inferred: pdf.js embedded at
  the app origin would put that risk on the operator's sign-in.

**Android Chrome PDF.** Chrome for Android 135 (April 2025) gained an inline PDF viewer [24], grade
C, no Google primary found. Whether it honors CSP sandbox or `attachment`, and whether it refetches
with cookies, is unverified.

**Video and audio.**

- Embedded `<video src>` and `<audio src>` in the app page are requested by the app document with
  its cookies, and response CSP does not govern a media subresource (inferred from Fetch and CSP;
  consistent with every product surveyed).
- Opened top-level under a sandbox, the media document has an opaque origin, and requests from it
  "cannot include SameSite=Strict/Lax cookies" [21]. Jira saw video requests lacking the session
  cookie in Chrome and Safari (JRASERVER-72275) and now sends `allow-same-origin` to Chrome [14].
  Gitea sends no CSP on media [9]. Firefox 102 to 105 could not play a sandboxed top-level MP4
  (fixed in 106) [5]; old Safari controls needed script [6]. (Stated.)
- Inferred: the first navigation request may still carry a Strict cookie, since the app page
  initiates it; the range re-requests from the opaque-origin document do not.
- Chrome 135's `allow-same-site-none-cookies` restores only `SameSite=None` cookies [21].
  `sandbox allow-same-origin` without `allow-scripts` keeps the real origin, safe only while scripts
  stay off [19].

**Images and text.** Top-level images and `text/plain; charset=utf-8` render under a sandbox (Gitea
default, GitHub raw) [9], [15]. A supplied `text/plain` under `nosniff` never becomes a scriptable
type [20]. SVG is inert only in image contexts; opened top-level it is a scriptable document, which
is why Synapse, Matrix and Discourse never inline it [7], [8], [12]. Chrome cannot decode HEIC [27].

Bears on: A5 and the definition of done (image, PDF, video and text on Android Chrome and Windows
Edge or Chrome). PDF can open top-level in the browser viewer but not inside any sandboxed frame.
Top-level media under a bare sandbox conflicts with the Strict cookie unless the open does not
depend on cookies. In-page media needs `media-src`, which the current CSP lacks.

### Authorization for file URLs

- Same-origin products authorize file GETs with the session cookie (Gitea, Mattermost, Nextcloud,
  Jira) [9], [11], [13], [14]. Isolated or handed-off files use short-lived URL tokens: Google's
  per-document token [17], Discourse's S3 presigned URLs reached by redirect [12], Mattermost's
  public-link hash [11]. GitHub private-image URLs carry a `jwt`; its roughly 5-minute expiry is one
  blogger's decode (D). Google concedes URL tokens leak through `Referer` [17]. (Stated.)
- Inferred from RFC 6265bis semantics (not fetched in this pass): a Strict cookie is sent on a link
  clicked inside the app and withheld on an open from another site or app (a notification, an
  Android intent, another app given the URL). Both Lax and Strict are lost inside sandboxed
  documents [21].
- Matrix moved media to `Authorization` headers in v1.11; browsers cannot add headers to `<img>`, so
  Element uses a service worker, which Firefox reportedly skips for `<video>` [7], [5]. Inferred
  alternative: `fetch()` to a `blob:` URL, which holds the whole file in memory and cannot stream.
- Range: Mattermost and Gitea serve through range-aware primitives, and `@hono/node-server`'s
  `serveStatic` implements single byte ranges [9], [11], [23]; semantics per RFC 9110 [31].
- Stated [22]: Android documents that Chrome downloads carried session cookies (2018 context).
  Inferred and unverified: modern Chrome downloads with the profile's cookies and hands the saved
  file to other apps by `content://` URI, so an external viewer does not refetch.

Bears on: A6 (only the operator's sign-in and the session's agents fetch a file). Cookie auth covers
in-page elements and in-app links; a short-lived token bound to one file covers top-level media and
external apps without `allow-same-origin`. The existing `no-referrer` and `no-store` headers address
the leak Google names (inferred). Agents fetch through the bridge's own key, not cookies.

### Phone uploads

- Slack strips EXIF, GPS included, from uploads (2020 statement, verified by TechCrunch) [26];
  Discourse defaults `strip_image_metadata: true` [12]. Matrix has no stripping requirement [7].
  (Stated.)
- Chrome cannot decode HEIC in `<img>`, `createImageBitmap` or canvas [27]. Android cameras mostly
  default to JPEG; what the photo picker hands `<input type=file>` for HEIF originals is unverified.
- Inferred: re-encoding through `createImageBitmap` and canvas drops all metadata and keeps the
  visual orientation (default `imageOrientation: "from-image"`), but cannot handle HEIC in Chrome.
- Stated [35]: the Claude API accepts JPEG, PNG, GIF and WebP only.

Bears on: A2, A7, and the out-of-scope ruling to keep photos as taken with no server image
processing. Stripping is out of scope; a HEIC original can neither show inline in Chrome nor reach
the model as an image without a conversion somewhere.

### Caps in other products

| Product    | Per file                                               | Other                                   | Source |
| ---------- | ------------------------------------------------------ | --------------------------------------- | ------ |
| Slack      | 1 GB                                                   | 10 files at once                        | [18]   |
| GitHub     | images 10 MB; video 10 or 100 MB (plan); other 25 MB   | n/a                                     | [16]   |
| Gitea      | `MAX_SIZE` 100 MB                                      | `MAX_FILES` 5 per upload                | [9]    |
| Mattermost | `MaxFileSize` 100 MiB                                  | retention off by default                | [11]   |
| Synapse    | `max_upload_size` 50M                                  | `max_pending_media_uploads` 5; no total | [8]    |
| Discourse  | 10 MB                                                  | n/a                                     | [12]   |
| Claude API | 10 MB base64 per image (5 MB on Bedrock); 8000x8000 px | downscaled to a 1,568 or 2,576 px edge  | [35]   |

Stated: a proxy in front often caps first (nginx `client_max_body_size`, per Mattermost and Synapse
docs) [8], [11]. Totals where they exist are optional and off by default (Synapse, Forgejo soft
quota); Immich shows usage per user [8], [10], [41].

Bears on: A1 and A2. 100 MiB matches Gitea and Mattermost, the largest self-hosted defaults. The
count limits found are both 5 (Gitea per upload, Synapse pending uploads). Tailscale Serve body
limits were not checked. A photo above the API's 10 MB base64 limit cannot reach the model as an
`image` block unchanged.

### Storage

- Stated [28]: "For BLOBs larger than 100KB, reads from a separate file are faster" (measured 2011,
  updated 2022). The "35% faster than the filesystem" result is for blobs of about 10 KB, and the
  same page says "The filesystem will generally be faster for larger blobs".
- Stated [29]: `node:sqlite` exposes no blob open, read or write; BLOBs bind and return whole as
  `Uint8Array` (Node 26.13.1 docs; probed locally on Node 24.18.0). Inferred: a blob in the database
  is materialized whole on the server's one synchronous connection, blocking the event loop.
- Stated [28]: the WAL is recycled, not truncated, unless `journal_size_limit` is set, and its size
  for one transaction is roughly proportional to the transaction; deleting rows does not shrink the
  file without `VACUUM` or incremental vacuum. Inferred: a 100 MiB blob writes about twice and
  leaves a WAL of that size behind.
- Stated: Gitea, Forgejo, Mattermost, Synapse, Immich and Paperless keep files on disk, metadata in
  the database, Gitea and Synapse in short-prefix directories [8] to [11], [41], [42]. Memos alone
  defaults to the database; its docs name "heavier database backups" as the cost [43].
- Stated [30]: `rename(2)` is atomic within a filesystem and fails with `EXDEV` across mounts;
  making a new directory entry durable needs an fsync of the directory. Inferred: content addressing
  by SHA-256 with `link(2)` gives immutability, deduplication, verifiable backups and an idempotent
  upload (`EEXIST` means already stored), provided the temp file lives in the data directory.
- Write order (inferred, consistent with Immich): fsync and link the file, fsync the directory, then
  commit the row, so a crash leaves at worst an orphan file. Synapse issue 18915 shows orphans from
  failing a quota after writing [8].
- Backup order, stated [41]: "back up the database first, then the filesystem", because the reverse
  can leave the database pointing at missing files. Paperless's sanity checker and Forgejo's
  `doctor` report missing files, hash mismatches and orphans [10], [42].
- Inferred: a backup that snapshots the database and then copies exactly the files the snapshot
  references, verifying each hash, is consistent by construction; it holds while nothing deletes a
  referenced file before the copy ends.

Bears on: A3, A8 and A9. Files never change and nothing removes them, so an immutable
content-addressed store needs no deletion path in this effort; replacement by name is a new row, and
shared content is stored once. The backup becomes a database copy plus a file tree, not one file,
and restore has a natural check (every referenced hash present). Per-thread usage is a sum over
rows; total usage is over distinct files.

### Upload mechanics

- Stated [23]: Hono's `bodyLimit`, given a `Content-Length` and no `Transfer-Encoding`, compares the
  header and reads nothing; otherwise it buffers up to the limit. `parseBody` calls `arrayBuffer()`
  and then builds a `FormData`, so multipart is held whole, at least twice. `@hono/node-server`
  gives the request a streaming body via `Readable.toWeb`.
- Stated [31]: tus has creation, `HEAD` offsets, `PATCH` and expiry state. Inferred:
  disproportionate for one operator's files up to 100 MiB, where a failed upload is retried whole.
  The draft MCP files extension uses a single `PUT` per file [33].
- Streaming multipart needs a parser such as `busboy` (last published 2022) [45]. Inferred: one file
  per request needs nothing multipart carries that headers cannot.
- Prior art for the two-step shape: Mattermost's `POST /api/v4/files` returns ids that a post then
  carries; Gitea's attachment row may have no issue yet "when creating"; Slack's MCP server gets an
  upload URL, posts the bytes, then completes [9], [11], [18]. `Repr-Digest` (RFC 9530) can carry a
  client hash [31].
- Inferred from local source: with the declared length checked against the per-file cap before
  reading, the body can stream through a byte counter and SHA-256 into an exclusive temp file and be
  linked into place, with the temp removed on every failure path and a startup sweep for stale ones.

Bears on: A1 and A2. "Nothing is uploaded for good until the message is sent" fits staged uploads
that a message then claims, with unclaimed ones expired after a grace period, as Synapse does with
`unused_expiration_time` [8]. The 2 MiB `bodyLimit`, as configured, refuses any declared length
above 2 MiB.

### Files through MCP

- Stated [32]: tool results carry `text`, `image`, `audio`, `resource_link` and embedded `resource`
  (text or base64 `blob`); a tool returning `structuredContent` "SHOULD also return the serialized
  JSON in a TextContent block". The 2026-07-28 changelog deprecates Roots ("pass directories or
  files via tool parameters") and leaves content types unchanged.
- **Claude Code**, stated [34]: "When an MCP tool returns a PNG, JPEG, GIF, or WebP image, Claude
  sees the image inline", possibly scaled down, and the original is saved to the session's
  `tool-results` directory with its path given to Claude (v2.1.283+); image data still counts
  against `MAX_MCP_OUTPUT_TOKENS` (default 25,000). How it counts (base64 length or visual tokens)
  is not documented.
- Claude Code issues [36], grade D for the behavior and A for status: `resource_link` "silently
  ignored" (#53453, closed not planned 2026-05-29); `content` dropped when `structuredContent` is
  present (#64316, #45575 and others).
- **Codex**, stated from source [37]: `image` becomes a model image input; `resource_link` and
  embedded `resource` become text holding the block's JSON, so an embedded blob reaches the model as
  base64 text. When `structuredContent` is present, only its JSON reaches the model and every
  content block, images included, is dropped; a maintainer called this "by design", citing Claude
  Code [38]. Codex tool calls time out after 60 s by default [39].
- Sending, stated [40]: the filesystem server reads paths inside allowed directories, resolving
  symlinks; Playwright MCP's upload takes absolute paths and calls its root restriction "a
  convenience defense to catch unintended file access, not a secure boundary". Inferred: the bridge
  runs as the agent's user, so a path argument grants no new read; the real risks are a
  prompt-injected send (which reaches only the operator's server) and the bridge's own key file.
- The draft `io.modelcontextprotocol/files` extension (2026-11-10) states it is a draft with no
  reference implementation and that the file "should go directly to its destination", not through
  the model [33].

Bears on: A1, A7 and E1. Bytes in tool arguments would pass through the model's output; a path
argument keeps them out (inferred). For reading, a local file plus a text answer works on both
hosts; an `image` block is the one way to let the model see a photo, limited to JPEG, PNG, GIF and
WebP within the API's size limits. `resource_link`, embedded resources and `structuredContent` each
lose content on at least one host.

### Type detection

- Stated [44]: "don't trust the Content-Type header as it can be spoofed"; signature checks should
  not be used on their own; generate server-side names.
- Stated [45]: `file-type` 22.3.0 (2026-10-29, Node 22+, ESM) detects binary formats by magic
  number, HEIC included, "not text-based formats like .txt, .csv, .svg"; its stream helper samples
  4,100 bytes. It clears the seven-day hold-back; provenance is not yet checked.
- Stated [19], [20]: with `nosniff` the browser uses the supplied type as is; a missing type is
  sniffed and can become HTML.
- Inferred: in these terms the surveyed recipe records declared and sniffed types, serves inline
  only allowlisted sniffed types, serves text (no binary signature) as `text/plain; charset=utf-8`,
  and serves the rest as `application/octet-stream` with `attachment`.

Bears on: A4 (type shown), A5 (text and code shown as text) and A6. Declared types are display hints
only; sniffing fits a streaming upload because it needs only the first 4 KB.

## Refuted or do not rely on

- "Chrome will not render a top-level PDF served with `CSP: sandbox`", and its converse, "the
  sandbox protects PDFs in Chrome": Chromium strips it, and a regression test pins the render [1],
  [2]. The 2026 reports saying otherwise are grade D [25].
- "An iframe with `sandbox="allow-same-origin"` makes Chrome's PDF viewer work": one third-party
  claim, contradicted by `pdf_navigation_throttle.cc` [3]. PDFs in sandboxed frames are a dead end.
- "A bare sandbox works for media everywhere": refuted by Jira, Firefox 102 to 105 and old Safari
  [5], [6], [14].
- "`nosniff` alone makes inline serving safe" (a declared `text/html` or `image/svg+xml` stays
  live), "SVG is safe because it is an image" (only in image contexts), and "CORP stops a file
  opened in a tab" (it does not apply to navigations).
- The Atlassian KB on blank Chrome PDFs cites a bug fixed in 2013 [14].
- "SQLite is 35% faster than the filesystem" for attachments: measured on 10 KB blobs [28].
- Incremental blob streaming from `node:sqlite`: not available in Node 24 or 26 [29].
- Hono `bodyLimit` as a streaming guard, and `parseBody` for large uploads [23].
- `resource_link`, embedded binary resources, or `structuredContent` beside an image as the way to
  hand an agent a file [36] to [38].
- MCP Roots for confining paths: deprecated [32]. The draft files extension: experimental [33].
  Codex `openai/fileParams` uploads to OpenAI's backend, not a self-hosted server (secondary sources
  only).
- GitHub's 5-minute `jwt` expiry and Signal's client-side EXIF stripping: secondary blogs only.

## Open questions

1. Does a top-level video under a bare sandbox still lose the Strict cookie on current Chrome, as
   Jira saw in 2021? A short live test on the staging server would settle it.
2. Does Windows Edge's Adobe-powered viewer strip CSP like Chrome, and does Android Chrome's viewer
   honor sandbox, `attachment` and cookies? Both need the operator's devices.
3. What does Android Chrome's picker hand the composer for HEIF originals: HEIC or a JPEG?
4. How does Claude Code count an `image` block against `MAX_MCP_OUTPUT_TOKENS`, and does Codex's
   output truncation apply to image data? Needs a live test with a multi-MB photo on both hosts.
5. Does Tailscale Serve cap or buffer 100 MiB bodies, and does a 100 MiB send fit inside Codex's 60
   s default tool timeout on the operator's links?
6. Should `agention backup` stay one archive file or become a directory? A directory allows hard
   links or rsync of immutable files; an archive keeps today's one-file shape.
7. Where does a model-sized image rendition come from, given no server image processing: the web UI
   at upload (canvas, not HEIC), the bridge, or nowhere (agents get the original only)?

## Sources

| #   | Source                                                                                            | Grade | Used for                                           |
| --- | ------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------- |
| 1   | Chromium `chrome/browser/plugins/plugin_response_interceptor_url_loader_throttle.cc` (HEAD)       | A     | CSP stripped on PDF responses                      |
| 2   | Chromium `chrome/browser/pdf/pdf_extension_test.cc` and its mock headers                          | A     | Sandbox does not block PDF; frame-ancestors kept   |
| 3   | Chromium `components/pdf/browser/pdf_navigation_throttle.cc`                                      | A     | Sandboxed frames cancel PDF loads                  |
| 4   | issues.chromium.org 40754148, 40328564, 41131921; Chromium security-dev thread                    | A, B  | Bug statuses; fixed in Chrome 91                   |
| 5   | Bugzilla 1781063, 1653678, 1893645, 1921989 (some via search excerpt)                             | A     | Firefox sandboxed media, pdf.js CVE, SW and video  |
| 6   | WebKit bugs 225865, 223576                                                                        | A     | Safari media and PDF under CSP                     |
| 7   | Matrix spec v1.19 content repository; Matrix v1.11 blog; Element service worker (via search)      | A     | CSP, disposition, inline list, header auth         |
| 8   | Synapse `synapse/media/_base.py`, config docs, issue 18915                                        | A     | Headers, SVG omitted, caps, orphan bug             |
| 9   | Gitea `modules/httplib/serve.go`, PRs #37455 and #37552, `models/repo/attachment.go`, cheat sheet | A     | Same-origin recipe, PDF and media exceptions, caps |
| 10  | Forgejo `modules/httplib/serve.go`, storage and quota docs                                        | A     | SVG and PDF CSP, doctor check, soft quota          |
| 11  | Mattermost `server/platform/shared/web/files.go`, file storage and API docs                       | A     | Inline list, attachment default, two-step upload   |
| 12  | Discourse `uploads_controller.rb`, `lib/file_helper.rb`, nginx sample, `site_settings.yml`        | A     | Sandbox, inline-safe list, caps, metadata strip    |
| 13  | Nextcloud `apps/dav/lib/Connector/Sabre/FilesPlugin.php`                                          | A     | WebDAV attachment, Android filename quirk          |
| 14  | Atlassian Jira security-header and PDF KBs; JRASERVER-72275                                       | A     | Media cookie loss under sandbox                    |
| 15  | `raw.githubusercontent.com` response headers (observed 2026-11-21)                                | A     | Defense in depth on an isolated origin             |
| 16  | GitHub changelogs (2014-04-25, 2023-05-09), Docs on attaching files, bounty scope                 | A     | Domain isolation, caps                             |
| 17  | Google Security Blog, "Content hosting for the modern web" (2012, via search summary)             | B     | Sandbox domains, URL tokens and Referer leak       |
| 18  | Slack docs (file object, help 201330736, Slack MCP server)                                        | A     | Bearer auth, 1 GB cap, upload-then-complete        |
| 19  | MDN: CSP `sandbox`, `X-Content-Type-Options`, HTTP range requests                                 | A     | Header semantics                                   |
| 20  | WHATWG MIME Sniffing standard                                                                     | A     | `nosniff`; text/plain never scriptable             |
| 21  | Privacy Sandbox blog, `allow-same-site-none-cookies`                                              | A     | Cookies in opaque-origin sandboxed documents       |
| 22  | Android developers, "Unsafe Download Manager"                                                     | A     | Chrome downloads carried cookies (historical)      |
| 23  | Local `node_modules`: Hono 4.13.18 `body-limit`, `utils/body.js`; `@hono/node-server` 2.1.8       | A     | Buffering, streaming body, byte ranges             |
| 24  | Droid Life, Heise (Chrome for Android 135 PDF viewer)                                             | C     | Android inline PDF viewer                          |
| 25  | Rock RMS issue #7153 and similar project issues                                                   | D     | Conflicting PDF field reports                      |
| 26  | TechCrunch on Slack EXIF stripping                                                                | C     | Slack strips GPS                                   |
| 27  | caniuse HEIF/HEIC                                                                                 | B     | Chrome cannot decode HEIC                          |
| 28  | sqlite.org: intern-v-extern-blob, fasterthanfs, wal, pragma                                       | A     | Blob crossover, WAL growth, vacuum                 |
| 29  | nodejs.org/api/sqlite.html (v26.13.1); local Node 24.18.0 probe                                   | A     | No blob streaming API                              |
| 30  | man7.org rename(2), fsync(2)                                                                      | A     | Atomic rename, EXDEV, directory fsync              |
| 31  | RFC 9530; RFC 9110; tus.io resumable-upload protocol                                              | A     | Repr-Digest; Range semantics                       |
| 32  | MCP spec 2025-11-25 (tools, resources); 2026-07-28 changelog                                      | A     | Content types, Roots deprecated                    |
| 33  | MCP blog, file uploads and downloads draft (2026-11-10)                                           | B     | Draft files extension                              |
| 34  | code.claude.com/docs/en/mcp                                                                       | A     | Image blocks, output limits                        |
| 35  | platform.claude.com vision docs                                                                   | A     | Image formats, sizes, downscaling                  |
| 36  | anthropics/claude-code issues #53453, #64316, #45575 and others                                   | D     | resource_link ignored, structuredContent overrides |
| 37  | openai/codex `codex-rs/protocol/src/models/mcp_content.rs`, `models.rs` (2026-11-19)              | A     | Codex content mapping                              |
| 38  | openai/codex#10334, maintainer comment                                                            | B     | structuredContent drops content "by design"        |
| 39  | Codex MCP docs (learn.chatgpt.com)                                                                | A     | Tool timeout, output limit                         |
| 40  | modelcontextprotocol/servers filesystem README; microsoft/playwright-mcp README                   | A     | Path arguments and their confinement               |
| 41  | docs.immich.app backup and restore                                                                | A     | Database-first backup order, quotas                |
| 42  | paperless-ngx `docs/administration.md`                                                            | A     | Backup, sanity checker                             |
| 43  | usememos.com storage docs                                                                         | A     | Database default and its cost                      |
| 44  | OWASP File Upload cheat sheet                                                                     | A     | Type spoofing, signatures, naming                  |
| 45  | sindresorhus/file-type readme; npm registry (file-type, busboy)                                   | A     | Detection scope, versions, dates                   |
