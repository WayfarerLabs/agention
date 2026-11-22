# Agention v1: Locked

- Locked: 2026-11-22, after the operator's check of 0.4.0 (FRD ruling 88)
- Shipped in: 0.1.0 to 0.4.0, published with provenance through trusted publishing

## What shipped

v1 shipped in four deliveries, each one pull request into `main` that the operator could use once it
merged, with smaller pull requests between them (agention#7, #19, #22 and #23, in 0.2.0 to 0.3.0):

1. **Repository foundation** (agention#3 in the earlier private repository): the monorepo, its
   gates, and the development contract.
2. **Working inbox** (agention#1, released as 0.1.0): threads of messages with asks, the operator's
   web UI with passkeys, the agent bridge and the generated plugins for Claude Code and Codex, and
   the release pipeline.
3. **Sessions** (agention#20, released as 0.3.0): `session_update` and the session log, one view of
   the sessions in place of the registrations page, threads the operator starts on a session, the
   agent API version, and the check that agent routes only grow.
4. **Complete v1** (agention#26, released as 0.4.0): session groups and tags, the list viewed by
   group, session updates kept in the sessions view, search of message text, Mermaid diagrams drawn
   in isolation, and `agention backup`.

0.4.0 also carries the voice and settings effort (ruling 87), which locks in its own directory.

## Where it lives now

The permanent record is in `docs/architecture.md`, `docs/adrs/0001-agention-v1-architecture.md`,
`docs/operator-guide.md`, `SECURITY.md`, `docs/live-testing.md`, `docs/review-checklist.md`,
`README.md`, `CONTRIBUTING.md` and `docs/development-context.md`. Nothing here is needed to
understand or work on the system.

## Boxes left open

- **The live server moved to the thread model on a fresh database, with the operator's re-check of
  its list.** The move and a phone re-check happened during Delivery 2 (rulings 56 to 58), but the
  record does not show every item of the box's list checked in that pass. Later checks covered the
  same surfaces on newer builds: Delivery 4's live run and the operator's check of 0.4.0 (ruling
  88). It stays open rather than be checked on inference.
- **First release, 0.1.0, checked as published.** 0.1.0 shipped with provenance on both packages,
  through its release pull request (agention#5), and both packages disallow publishing with tokens
  (ruling 89). The record does not show the box's install and host checks run against 0.1.0 itself:
  `npx` printing its version, the server installed globally, and each host's plugin calling
  `register` and `thread_list`. The operator has used the published plugins on every release since.
