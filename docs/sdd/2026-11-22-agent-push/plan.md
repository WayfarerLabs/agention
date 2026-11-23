# Agent push: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md)
- Branch: `2026-11-22-agent-push`
- Vehicle: one pull request carrying the SDD and the build (agention#67); each box is checked when
  it is built, reviewed and green.

## Delivery 1: push on Claude Code

- [ ] The host directory: found from the watcher's `CLAUDE_PID` and the bridge's ancestors, under
      the private-file rule, with the `watcher` lock, `hooked` mark, `wake` file and `cursor`, and
      directories of dead processes removed. Done when the bridge's tests show the bridge finding
      its host's directory, finding none without a mark, and pruning a dead one (HLA "The host
      directory").
- [ ] The bridge's wait: started only for a Claude Code client whose host has the mark, reading a
      pending registration's state every 15 seconds without submitting, the 25-second loop with the
      cursor saved before the wake file, the cursor discarded for other granted names, backoff on an
      unreachable server, and giving up only on what it cannot outlast. Done when tests against the
      bridge's test server show a message pushed once whether or not it is read and across a bridge
      restart, push starting after approval with no tool call, recovery after the server restarts,
      nothing running for a client that is not Claude Code, and the notice holding only fixed words
      and integers (P1 to P4, H4, C2).
- [ ] Telling the agent: `register` says answers are pushed exactly when the HLA says, the lapse
      line appears once on the next tool answer after the wait gives up, and `toolMeta` counts it.
      Done when tests show both answers, the lapse line and a Codex client never told push (H3, H4).
- [ ] The watcher and the plugin: the shell watcher, and the hook in the plugin definition,
      generated into the Claude Code plugin only, on `SessionStart` and `Stop` with `asyncRewake`
      and the day-long timeout. Done when tests run the watcher itself and show it exiting 0 without
      Agention's variables, one watcher per host process, exit 2 only after taking a wake file with
      the notice on stderr, exit 0 when its host process is gone, and the generator's tests and
      drift check pass with the Codex plugin unchanged.
- [ ] The usage skill's loop, step 5, and the `register` and `message_wait` descriptions for pushed
      and checking sessions, regenerated into both plugins. Done when the generated outputs are
      committed and the drift check passes.
- [ ] Permanent docs: the new ADR, superseding ADR 0001's "No push" for agents and amending its "No
      permissions, no harness control" and "Never holds up"; README; `docs/review-checklist.md` A1;
      `SECURITY.md` "The agent bridge" and "Files it writes"; `docs/architecture.md`; the operator
      guide, with push's needs on Claude Code, none on Codex, the day-long limit and stranded
      threads; `docs/live-testing.md`; and the development contract (E1). Done when each describes
      push as built and the project review finds none stale.
- [ ] Live run on Claude Code with the plugin from a packed build: an agent at its prompt is pushed
      when the operator starts a thread with it from the web UI, reads it and acts on it, after its
      `register` answer said answers are pushed; a woken turn longer than a minute shows no lapse
      line; push starts after an approval given while the agent waits; a server restart is recovered
      from; push survives `/clear`; a message during a turn is recorded; an untrusted folder or
      `--bare` is told it checks; and `/exit` leaves no watcher (definition of done, HLA "Risks and
      open items").
- [ ] Live check on Codex: the bridge's `register` answer says answers reach the agent when it
      checks, and nothing runs in the background (definition of done, ruling 2).
- [ ] `locked.md` in this directory, with the final merge.
