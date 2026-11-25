# Session monitoring and nudge: Plan

- Requirements: [FRD](frd.md); architecture: [HLA](hla.md)
- Vehicles: the SDD lands first, in agention#120. Each pull request below branches from `main`, and
  checks its boxes when they are built, reviewed and green. 1b and 1c each need only 1a merged, so
  1c runs whenever its captures arrive; pull request 2 needs 1b.

## Delivery 1: monitoring

### Pull request 1a: the observer, the reporter and the server

- [ ] Captures: Claude Code and Codex at their current releases, in a clean scratch home with
      default settings, for the prompt, a running turn, the permission and trust dialogs, and Claude
      Code's vim normal and shell modes; scrubbed and reviewed. Done when each is committed beside
      its profile with its snapshot fields, and the Codex `clientInfo` name and version are
      recorded.
- [ ] `packages/harness-observer`: `Pane` and its tmux adapter, `Profile`, `HarnessProfiles` and the
      registry, the Claude Code, Codex and generic profiles, and `Observer.observations`. Done when
      the profiles pass against their captures, and the observation order and sampling pass against
      a real tmux server running the scripted harness, including unknown for a dead pane, more than
      one pane, a host without the terminal and a missing `/proc` (HLA "The harness observer").
- [ ] Agent API version 5: `GET` and `POST .../monitor`, the `background` flag on
      `POST /registrations`, the migration, the stamps, the claim rule, and the derivations
      (connected, quiet from check-ins, condition only while connected, stranded by M6 without its
      nudge branches, and the older-bridge rule). Done when the store's and the HTTP tests show
      each, including a bridge pinned back below version 5, and `docs/api/openapi.json` is
      regenerated.
- [ ] The reporter in the bridge: its start triggers, the pending read, the long poll, the claim and
      the report, carried from agention#67's loop. Done when tests against the bridge's test server
      show it starting at bridge start for the default session's stored key and on approval with no
      tool call, recovering from a server restart, standing down when replaced and taking over on a
      tool call, reporting only on change, and failing as the release lines require against a server
      below version 5 (M1, M7, M9, C1, C2).
- [ ] Configuration: the options and variables, the plugin forwarding on both hosts, and CF4's
      cases. Done when the bridge's tests show each case in the log with the tools unaffected and no
      pane text in any log line (M8), and the generator's drift check passes; the `register`
      answer's part comes with T1 in pull request 2.
- [ ] The operator API's session reads carry connection, last check-in, condition, stopped-by and
      the profile. Done when the operator API's tests show them and no agent route returns them
      (M8).
- [ ] The web UI's "not connected" stranded reason, which 1a's new stranded cause needs. Done when
      its tests show the tag, the reason and the New thread sheet's clause.
- [ ] The ADR for monitoring: the bridge reads its harness's terminal and reports only derived
      conditions, as advisory observations under ADR 0001's honor system. Done when the project
      review finds it complete.
- [ ] Collateral for 1a: `docs/architecture.md`, `SECURITY.md`, `docs/review-checklist.md`, the
      operator guide (presence, stranded threads, the operator API's session reads, and monitoring's
      configuration), README, `docs/live-testing.md`, the bridge's usage text and README,
      `CONTRIBUTING.md` (tmux among the prerequisites and dependencies), CI installing tmux, and the
      development contract. Done when the project review finds none stale.

### Pull request 1b: the sessions view

- [ ] The sessions view shows connection, last check-in and condition, flags sessions at a prompt or
      stopped by something with a filter listing them, and names the condition in a stranded
      thread's reason (M4, M6). Done when the browser tests show each.
- [ ] The operator guide describes monitoring as the operator sees it. Done when the project review
      finds none stale.
- [ ] Live under Agentworks, configured by hand until Agentworks ships the socket path, on Claude
      Code and Codex: connection, activity and the conditions of the definition of done, a session
      approved at its prompt starting to report, and one of several Codex bridges reporting. Done
      when the pull request records the live evidence as `docs/live-testing.md` describes.

### Pull request 1c: usage limits

- [ ] Usage-limit screens: the Claude Code screens the operator captures at a limit one of their
      sessions reached on its own, and the Codex samples the operator provides, each scrubbed and
      reviewed. Done when they are committed beside their profiles.
- [ ] The Claude Code and Codex profiles report a usage limit, with its reset time where the screen
      shows it. Done when their tests read the new captures and the observer reports the session
      stopped by a usage limit with any prompt beside it.

## Delivery 2: the nudge

### Pull request 2

- [ ] `Observer.nudge()` with every N4 and N5 check. Done when tests against a real tmux server and
      the scripted harness show a nudge sent at a still prompt and abandoned at each step: a dialog,
      someone typing, copy mode, the warning typed over, a line that will not clear, and a message
      that does not submit.
- [ ] Agent API version 6: the due answer, the outcome in the report, the check-in stamp against the
      latest nudge, "not responding to the nudge", and M6's nudge branches. Done when the store's
      and HTTP tests show a nudge due at most once between check-ins, across a bridge restart and a
      takeover.
- [ ] The bridge's nudge: the warning and message, retrying while not ready, reporting the outcome,
      and T1's `register` answer, with CF4's cases in it. Done when tests against the bridge's test
      server and a real tmux server show it end to end.
- [ ] The usage skill's step 5 and the tools' descriptions, regenerated into both plugins; the
      nudge's ADR, superseding ADR 0001's "No push" for agents and amending "No permissions, no
      harness control"; review checklist A1 and A6; and the rest of E1. Done when the drift check
      passes and the project review finds none stale.
- [ ] Live under Agentworks on Claude Code and Codex: the nudge cases of the definition of done.
      Done when the pull request records the live evidence as `docs/live-testing.md` describes.
- [ ] `locked.md` in this directory, with the final merge.
