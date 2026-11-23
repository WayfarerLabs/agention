# Attachments: Locked

- Locked: 2026-11-23
- Shipped in: 0.5.0 (agention#46, released by agention#49)

## What shipped

- Files attached to messages by agents and by the operator, kept in the database in chunks, carried
  by backups, and served under rules that keep them from acting as the operator (ADR 0004).
- Uploads on both mounts, with each writer's pending limits, the free-space floor, the sweep of
  expired and unfinished uploads, and the listener's own deadlines on request bodies.
- The bridge's `file_upload` and `file_get`, `attachments` on the writing tools, and the image block
  for small images, under agent API version 3.
- The web UI's attaching and pasting, a message's files shown in place, the thread's folded file
  list, and Settings' Storage line.

The operator's check on Android Chrome and Windows Edge passed. The live run drove the packed bridge
through Claude Code, hunted the serving headers with hostile files in Chromium, and upgraded a
0.4.0-era database.

## Not done

- The live-run box stays open. Codex was not run, since a separate Codex home would have needed a
  copy of the operator's Codex login. A refusal mid-body from the phone through Tailscale Serve was
  not exercised; mid-body refusals over loopback reached the client.

## After this effort

- On touch devices, Attach became a menu of its own (agention#48, agention#53): Take a photo, Record
  a video, Photos and videos, and Other files, each its own input, in place of the single input with
  no `accept` or `capture` that the LLD describes.

Ruling 6 records the operator's choice to keep the menu's four items on phones, which narrows A2
there.

## Where it lives now

The permanent record is in `docs/adrs/0004-attachments.md`, `docs/architecture.md`,
`docs/operator-guide.md`, `SECURITY.md` and `docs/live-testing.md`. Nothing here is needed to
understand or work on the system.
