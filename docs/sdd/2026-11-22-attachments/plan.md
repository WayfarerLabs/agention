# Attachments: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md); details: [LLD](attachments-lld.md)
- Branch: `build/attachments`

One delivery: files attached by agents and by the operator, kept in the database, served under rules
that keep them from acting as the operator, shown in the thread, fetched by agents, and carried by
backups. Each box is checked when it is built, reviewed and green.

## Delivery 1: attachments

- [ ] [LLD](attachments-lld.md): the tables, the sweep and limits, the deadline rework, the routes
      and their shapes, the serving headers, the bridge's tools, the web UI's states, and the tests.
- [ ] The next migration and the file store: files and their chunks, attachments unique by message
      and name, incremental vacuuming, pending limits for each writer, the free-space floor, and the
      sweep of expired and unfinished uploads (A1, A3, A8).
- [ ] The listener's deadlines: a body cut off when idle on every route, an exact total deadline on
      every route but uploads, its refusal carrying the agent API version and the security headers,
      and slow unauthenticated bodies still refused.
- [ ] The upload routes on both mounts, and `attachments` on a message's write: only the writer's
      own pending files, carried forward on a replacement, inside the write's digest and after its
      replay (A1, A2, A3).
- [ ] Serving: the file read on both mounts with single ranges, the allowlist and its headers, the
      headers a response owns, and the thread's paged file list and storage totals (A4 to A6, A9).
- [ ] The bridge: `file_upload` with its path checks, `attachments` on the writing tools, `file_get`
      with its image block, streaming transfers under an idle timeout, the answer cap's count of
      attachments, the next agent API version with the compatibility suite, the usage skill and tool
      descriptions, and the generated plugins' tool timeout where a host reads one (A1, A7, E1).
- [ ] The web UI: attaching and pasting in the composer with upload progress, edits carrying files
      forward, a message's files shown in place, the thread's folded file list, a message's links to
      its own files, and Settings' Storage line (A2, A4, A5, A9).
- [ ] A check of PDFs and media on the operator's devices against the staging server, before the
      delivery is handed over, with any change to the display rules it calls for.
- [ ] Permanent docs: a new ADR for attachments, with ADR 0001's guardrail, `SECURITY.md`'s
      inert-content invariant and `docs/review-checklist.md`'s image rule restated by it;
      `SECURITY.md`'s section on attachments, files kept in the browser's cache after sign-out
      included; the architecture document and its error codes and statuses; the operator guide
      (attachments, limits, metadata kept, backup size, each host's tool timeout), `README.md`,
      `docs/live-testing.md`, and `docs/development-context.md`'s active effort (E2).
- [ ] Live run with both hosts: an agent uploading and fetching through the packed bridge, the image
      block's size confirmed, transfer times against each host's tool limit, the serving headers
      hunted with HTML, SVG and mislabeled files in Chromium, a broken image block on both hosts,
      and an upload refused mid-body from the phone through Tailscale Serve.
- [ ] The operator's check on Android Chrome and Windows Edge or Chrome against the staging server:
      a photo from the phone read by an agent, and an image, a PDF, a video and a text file an agent
      attached, opened.
- [ ] The release carrying it, through release-please.
- [ ] `locked.md` in this directory, with the final merge.
