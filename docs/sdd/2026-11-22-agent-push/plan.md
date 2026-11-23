# Agent push: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md)
- Branch: `2026-11-22-agent-push`
- Vehicle: one pull request carrying the SDD and the build (agention#67); each box is checked when
  it is built, reviewed and green.

## Delivery 1: push on Claude Code

- [ ] The host record: written under the private-file rule once a registration is approved and
      whenever the granted names change, keyed by the host session id from the environment, none
      without one, and records a week stale with no live lock pruned. Done when the bridge's tests
      show each case, including a session with no id writing nothing (HLA "The host record").
- [ ] The watcher, `agention-mcp watch`: the lock, waiting for a record and an approved
      registration, the 25-second loop with the saved cursor and the heartbeat, the notice, backoff
      on unreachable servers, and exit 0 with the heartbeat removed on a refusal it cannot outlast.
      Done when tests against the bridge's test server show a message pushed once whether or not it
      is read, a second watcher exiting at once, recovery after the server restarts, and nothing
      pushed before approval (P1 to P4, H4, C2).
- [ ] The bridge's push status: `register` says answers are pushed only with a live heartbeat, and
      the first tool answer after it goes stale says they reach the agent when it checks, once. Done
      when tests show both answers and the lapse line, and that a Codex-like environment never
      claims push (H3, H4).
- [ ] The plugin: the hook in the plugin definition, `hooks/hooks.json` generated into the Claude
      Code plugin only with the package spec of the MCP declaration, and the generated outputs
      committed. Done when the generator's tests and drift check pass and the Codex plugin is
      unchanged.
- [ ] The usage skill's "How answers reach you" for pushed and checking sessions, regenerated into
      both plugins.
- [ ] Permanent docs: a new ADR for push and its notice, with ADR 0001's "No push" marked superseded
      and its "No permissions, no harness control" and "Never holds up" amended; README;
      `docs/review-checklist.md` A1; `SECURITY.md`; `docs/architecture.md`; the operator guide;
      `docs/live-testing.md`; and the development contract (E1).
- [ ] Live run on Claude Code with the plugin from a packed build: an agent at its prompt is pushed
      when the operator starts a thread with it from the web UI, reads it and acts on it, after its
      `register` answer said answers are pushed; a server restart is recovered from; the lapse line
      appears when the watcher is stopped; and whether `/clear` and a resumed session keep push is
      recorded (definition of done, HLA "Risks and open items").
- [ ] Live check on Codex: the bridge's `register` answer says answers reach the agent when it
      checks, and the operator guide says Codex has no push (definition of done, ruling 2).
- [ ] `locked.md` in this directory, with the final merge.
