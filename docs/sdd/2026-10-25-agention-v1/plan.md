# Agention v1: Plan

- Status: Design approved by the operator 2026-10-25; implementation in progress; regrouped into
  three deliveries on 2026-10-27 with the operator's agreement; moved to TypeScript with the agent
  bridge the same day (FRD rulings 26 to 28); items became threads of messages with asks on
  2026-10-30 (rulings 32 to 34)
- Governing requirements: [FRD](frd.md)
- Architecture: [HLA](hla.md)
- Repository: `WayfarerLabs/agention`, whose `main` holds both the code and this SDD (FRD ruling 59)

## Delivery

Each delivery is implemented on its own branch, `build/agention-v1-<delivery>` (Delivery 1 used
`build/agention-v1`). v1 ships in three deliveries, each cut at a point where the operator can use
what has merged. Each delivery is one pull request into `main` that carries its code together with
its LLD and SDD changes. A check-off rides the pull request that proves its work, or the next one
when the proof comes after a merge, as a release's does; the last ones ride the closeout. Delivery
2's other check-offs ride the pull request after its release, which proves the release and the phone
check of its last rows. Until 2026-11-18 this SDD lived in the `wf-agentic-root` workspace, and each
delivery was paired with a workspace pull request; evidence before then cites that repository and
the earlier private Agention repository, now `WayfarerLabs/agention-archive`, whose pull requests
and commits `agention#<n>` and `agention <sha>` name there (FRD ruling 59). Each delivery has one
LLD, written before its code and detailed only where a decision is open. Every delivery goes through
the private quality loop (project review, complexity pass, and a generic correctness and security
lane for code-heavy work), batched per delivery rather than per commit, before its first handoff.

## Design

- [x] FRD, HLA and prior-art research drafted, reviewed, and revised from operator rulings.
      (wf-agentic-root#1)
- [x] Operator approval of the FRD and HLA (2026-10-25). (wf-agentic-root#1)

## Delivery 1: repository foundation

- [x] [Repository LLD](repository-lld.md): layout (Go module at the root, `apps/web`,
      `apps/agent-plugin`), task runner choice covering backend, frontend and plugin generation
      (ruling 20), CI shape, release-please with one version, Dependabot, lint and format tooling
      aligned with sibling repositories. (agention#3)
- [x] Toolchain pins (Go, Node; npm bundled with Node) with integrity checks and locked installs;
      SHA-pinned actions; `npm audit signatures`; govulncheck. (agention#3)
- [x] Public documentation skeleton (R37, R39): README, CONTRIBUTING (including the development
      contract facts: commands, checks, conventions), SECURITY, LICENSE, `docs/adrs/` with
      `.adr-dir`, and a first ADR recording the v1 architecture. (agention#3)
- [x] CI green on `main` for an empty but buildable server, web app and plugin generator.
      (agention#3)

## Delivery 2: working inbox

When this merges and its first release, 0.1.0, publishes, an agent can start a thread and ask, the
operator can see what is asked of them and answer from a phone, and the agent can read the answer,
with the server installed from npm and the plugins from the repository (ruling 50). Until that
release publishes the bridge, agents run it from a packed tarball through a locally rendered plugin,
as the LLD's plugin section describes. Rulings 32 to 34 replaced items with threads before this
delivery merged; the boxes below citing agention `670d4ec` and `0cbe6a0` record runs on the item
model.

- [ ] [Working inbox LLD](working-inbox-lld.md): the move to TypeScript in the
      [Repository LLD](repository-lld.md)'s layout; database schema, derived views and migrations
      keyed on `user_version` over `node:sqlite`, with synchronous immediate transactions; bounds
      and typed errors from shared schemas (R33); passkeys, browser sessions and `passkey-link`
      (bootstrap and recovery) carried forward; agent registration by session keys with code
      approval and key-signed tokens (rulings 26 and 27); the predecessor review's hardening items,
      each listed with its disposition; threads, messages, asks, replacement, and read and archive
      marks derived through views; the agent bridge with `register`, the thread tools and
      `message_wait` limits; the HTTP API's agent and web mounts; the web UI's routes, data hooks,
      live refresh, stale-draft handling, inert Markdown rendering (R14), design tokens with dark
      mode and accessibility.
- [ ] Repository move to TypeScript (ruling 28): npm workspaces for `packages/api`, `apps/server`,
      `apps/bridge`, `apps/web` and `apps/agent-plugin`; the plugin generator in TypeScript; checks
      and CI as the Repository LLD describes; every Go file, pin, check and Dependabot entry
      removed, including the `go` release type; ADR 0001, CONTRIBUTING, SECURITY,
      `docs/architecture.md`, the operator guide and the README updated to match.
- [ ] Identity and registration: the server's database, identity and auth modules, with session key
      registration, approval, rejection, expiry and revocation, and token verification (R1-R3,
      R5-R7), the hardening items the LLD assigns here, per-class rate budgets (R31), and boundary
      tests (unknown equals unauthorized, actor from authentication, revocation during long polls,
      neither credential working on the other mount).
- [ ] `agention serve` with the listener, TLS and origin settings and the plain-HTTP guard (R30),
      and `agention passkey-link`.
- [ ] Threads: store operations for threads, messages and marks with roles, asks (several to a
      message, numbered within the thread; impact, priority, effort, deadlines), answers (several to
      a message, each naming its ask; picks, the answerer's own words, or a decline), replacement,
      topics, references, mark read, mark unread from a message, archive through a message and bulk
      marks (R8-R20), lists of the threads not archived with filters that combine (agents, sessions
      and topics several at once), a count for each filter value, each session's and topic's roll-up
      for grouping, the five sorts, title search over a full-text index and archived threads on
      request, the thread signals and roll-ups of R21 (blocked on you, overdue), bounds (R33), and
      concurrency tests (stale writes, marks independent of writes, request-id replay and conflict,
      role and author enforcement, open-asks ordering).
- [ ] HTTP API: the agent and web mounts sharing the thread routes, typed errors on both (R33), and
      end-to-end tests over a real TLS listener.
- [ ] Agent bridge (ruling 26): `register` and the thread tools without the session envelope,
      `thread_list` with its filters, title search and topic (R18), `message_wait` holding a failed
      wait for its time (ruling 47) and answering at once with no wait, withdrawals on
      `message_send` and status on `thread_list` (ruling 48), session resolution from arguments or
      the Agentworks variables (R36), and key storage per server and session; tests against a real
      server over TLS.
- [ ] Web: the banner's tabs naming their pages; the thread list (Group and Sort controls and an
      icon-only Filters button as its head, a sheet holding every filter one row per dimension with
      a count on each value and Reset filters, Agent, Session and Topic as multi-select popups with
      search, title search, archived threads on request, the filters on as compact removable chips)
      with each thread's agent, session and topic behind letter badges, and read and archive icons,
      and the thread page as the LLD describes, with a back button, reading what is on screen,
      Archive all in its head, each message's options (mark unread from here, archive through here,
      edit, change answer), archived messages folded, read and unread icons on messages and the
      agent's reading at the foot of the operator's, each thread's number leading its title, the
      location as links, numbered asks answered on their cards, several at once (radio buttons or
      checkboxes, Other with the operator's own words, declining as a smaller link apart),
      additional information and one Send with going back after sending, and replacement for
      changing answers or editing a message (R25 and R26 for threads, R27, R29, rulings 37, 38, 40
      to 43 and 45 to 48); registration approval with the code, rejection and revocation (R5);
      component tests and a browser drive using a virtual WebAuthn authenticator.
- [ ] Withdrawals and thread status (ruling 48): the requester withdraws an open ask with a reason
      in a later message or in a replacement, never undone; a replacement of a message holding open
      asks asks again or withdraws each; a thread's status (open, answered, withdrawn, none) rolled
      up from its live asks and those a live message withdraws; on the bridge, rows, the thread page
      (the withdrawn card and the withdrawal's line) and a Status filter that takes the place of
      Open asks, with counts; store, route and component tests.
- [ ] Presence (R24, and R21's quiet and stranded; ruling 48): last seen stamped to the minute on an
      approved session's calls, quiet after `--quiet-minutes` (default 15) or when never seen, and
      stranded threads from quiet or a missing credential; shown on rows, the thread page and
      session and agent headers, and as the Read by agent filter's Stranded value with its count;
      tests.
- [ ] The app repository's permanent docs describe threads: README, SECURITY's security model,
      `docs/architecture.md`, the operator guide, and ADR 0001 with a dated amendment line.
- [ ] Several operator passkeys (ruling 35), as the LLD's Several passkeys section describes: added
      on this device, named, renamed and removed, with a recent sign-in for adding and removing, the
      last passkey kept, and removal ending the browser sessions it signed in; tests at the store,
      route and browser levels.
- [ ] The live server moved to the thread model on a fresh database, then the operator re-checks on
      their phone every ask shape answered on its card, several asks in one message answered
      together and apart, answers changed and an ask revised by replacement, archiving through a
      message and all of a thread and a thread's return on a new message, grouping, the sorts, the
      filters with their counts and title search with archived threads included and not, marking
      unread from a message, the back button, going back after sending and the location links, signs
      a second device in through cross-device sign-in and adds a passkey there, sees an ask the
      agent withdrew with its reason, each status on rows and through the Status filter, and a
      thread stranded once the agent is quiet, and the agent reads each answer through the bridge;
      and the Markdown hand check repeated in a thread.
- [x] Host verification repeated for the thread tools: the generated plugins, rendered against a
      packed bridge tarball, run the bridge on Claude Code and Codex, and Codex runs the thread
      tools without a prompt (Codex: basic plugin-integration prompts only). (agention#7 head
      `1053eed`, 2026-11-06, with the plugins rendered from that head against its packed bridge:
      Claude Code 2.1.316 loaded the generated plugin from its directory and called `register` and
      `thread_list`; Codex 0.166.0, given the generated Codex plugin's MCP entry as configuration
      rather than installing the plugin, called both without a prompt in its interactive mode, with
      the default Workspace permissions of a trusted directory, and again under `codex exec`; every
      tool carries the same annotations, so these two calls stand for all of them. The plugin's
      install path stands as `670d4ec` verified it, and since then only the plugin's description and
      skill have changed; wf-agentic-root#5)
- [ ] The thread list grouped, with ruling 41's round (rulings 40 and 41): viewed flat, by session
      (session, topic) or by agent (agent, session), through a Group control beside Sort and
      Filters, as the prior-art research found works on a phone: folding inline, depth shown by
      header styles rather than indentation, levels that do not branch skipped, every parent
      collapsible and carrying its roll-up aggregated generally as a maximum (unread threads,
      blocked on the operator, highest open priority, and archived when all are) within the active
      filters, groups placed by their first thread under the sort, and collapse state kept per
      device and view; the one list, grouped, carries session roll-ups (and by session, topic
      roll-ups) that compose upward on the client, its threads arriving group by group (R28, rulings
      38, 40 and 41). Session groups add their level in Delivery 3.
- [ ] Plugin and usage skill (R35): generated Claude Code and Codex plugins carrying the skill and
      declaring the bridge, with the Codex environment list; the skill's normal loop starting with
      `register`, one example and hard rules, including asking whenever an answer is needed and
      never blocking on the terminal, topics, asks that belong together in one message, revising an
      ask, its priority included, by replacing its message, withdrawing one with a reason, checking
      for itself what it can see and an answer it can check, and never waiting on Agention: asking
      and carrying on, checking for answers as it works, and stopping as it otherwise would (R11,
      R35; rulings 46 and 48).
- [x] Host verification: the generated plugins, rendered against a packed bridge tarball, install on
      Claude Code and Codex and run the bridge with the declared environment, and Codex runs the
      annotated tools without a prompt (Codex: basic plugin-integration prompts only). (agention
      `670d4ec`, 2026-10-28; wf-agentic-root#5)
- [x] The `@wayfarerlabs` npm organization is held before this delivery's code merges, so no one
      else can publish the bridge version the committed plugins pin (operator action). (npm
      registry, 2026-10-28; wf-agentic-root#5)
- [x] `agention-tester` subagent in the workspace (`.rulesync/subagents/`), loading the
      `integration-testing` skill and its tester method, named in `docs/projects/agention.md` before
      the live run. (wf-agentic-root#5)
- [x] Live run behind `tailscale serve` (operator runs the Tailscale commands): an agent on the
      server's VM, reaching the server at its `ts.net` origin, registers through the bridge and
      raises items across every request type and response form, the operator approves the
      registration and answers the items from a real phone, and the agent reads each response
      through the bridge. The operator chose one VM for this first run; Delivery 3's live run puts
      the agent on a separate VM, per the FRD definition of done. (agention `0cbe6a0`, 2026-10-28;
      wf-agentic-root#5)
- [x] Markdown hand check in that run: one item body holds a code block, a table, a task list,
      strikethrough, an `https` link, an `http` link, a raw `<b>` tag and an image, and its title
      holds Markdown syntax. The first five render as formatting with a working link; the `http`
      link is plain text; the tag shows literally; the image shows as a link and the browser never
      requests it; the title shows its syntax literally; and the agent reads the body back
      unchanged. (agention `0cbe6a0`, 2026-10-28, on the operator's phone; the image request was
      checked in Chromium during host verification; wf-agentic-root#5)
- [ ] Message detail (ruling 53): a message's text bounded at 1,000 characters as its summary, and
      an optional Markdown `detail` of up to 20,000 beside it, through both mounts, the bridge's
      tools and its result fitting, and replacements; the thread page's folded **Details** line
      under the text and the composer's **Details** box; the skill's rule that every message stands
      on its own, its example and the tool descriptions; then a live check on a phone of an agent's
      messages written to that rule.
- [ ] Orders and names (rulings 54 and 55): the thread list's Sort beside a separate button for its
      direction, with Latest message and Created (thread-number order within a session) among the
      sorts, each reversible while the threads it does not rank stay after the rest; the server's
      name, set by `--name` on its first start and never changed after, in the web UI's banner, page
      titles and home-screen title and on its passkeys; servers sharing a host under different
      ports, each with cookies named for its port; the guide's note that a second server runs on its
      own machine; then a live check on a phone, on a fresh database.
- [ ] Earliest due on rows (ruling 57): a thread's row shows the earliest answer-by among its open
      asks, today's as a time and another day's with its date, and its year when not this year's,
      and once it has passed, Overdue since then in place of the lead ask's overdue mark; then a
      live check on a phone.
- [ ] Unread and total on rows (ruling 58): the thread summary's count of live messages, and a row
      showing its unread messages over that count ("2/5") beside the closed envelope while any is
      unread, and otherwise the count beside the open envelope; then a live check on a phone.
- [ ] Migration 1 frozen at 0.1.0: from the first release every schema change is a new migration, so
      an operator's database survives every upgrade, and a test pinning migration 1's text fails on
      any edit to it (ruling 50).
- [ ] Release workflow (`.github/workflows/release.yml`): a `v*` tag publishes
      `@wayfarerlabs/agention` and `@wayfarerlabs/agention-mcp` to npm through trusted publishing,
      with provenance, from a publish job that runs no repository code and publishes the tarballs
      the package checks proved, in an `npm` environment that only `v*` tags may use, after the tag
      is matched to both packages' and the plugin's versions; `CONTRIBUTING.md` covers releasing,
      the operator's one-time setup and a new package's start (ruling 50).
- [ ] Operator guide for real use (R32, ruling 50): installing the server from npm, the data
      directory, running it by hand in a terminal and as a service (a systemd user unit and a
      launchd agent), `tailscale serve` on loopback, the first passkey, installing the plugins on
      Claude Code and Codex with `AGENTION_URL`, pinned to a release tag or tracking `main` (ruling
      52), approving agents, upgrading the server and the plugins, and backing up by stopping the
      server and copying the data directory until `agention backup` (Delivery 3, R34); the launchd
      service marked as not yet tested (ruling 52); the README says what is published.
- [ ] Release setup (operator action, rulings 50 to 52): a fresh public `WayfarerLabs/agention`, the
      current repository renamed and kept private as an archive, and this delivery opened in the new
      repository as a pull request; the GitHub configuration applied to it, and private
      vulnerability reporting enabled; the release-please GitHub App installed on it, its key a
      secret of a `release-please` environment only `main` may use; a ruleset on `v*` tags whose
      only bypass for creating them is the App; the `npm` environment limited to `v*` tags; a stub
      `0.0.0-placeholder` of each package published and deprecated, so the packages exist; and a
      trusted publisher on each, naming `release.yml` and the `npm` environment, set up within two
      days of the release it first publishes.
- [ ] First release, 0.1.0, through release-please once this delivery's pull request merges (the
      operator merges it when the lead says it is ready), then checked as published: provenance on
      both packages, `npx @wayfarerlabs/agention-mcp@0.1.0 --version`, the server installed with
      `npm install -g`, and each host's plugin installed from the repository's marketplace, running
      the bridge from npm and calling `register` and `thread_list` (Codex: basic plugin-integration
      prompts only); then tokens disallowed on both packages (ruling 50).
- [x] The development contract, `docs/development-context.md`, in the Agention repository for the
      TypeScript toolchain, its gates and the bridge, with this SDD moved to `docs/sdd/` and checked
      by `scripts/check-sdd.sh` in CI (ruling 59). (agention#1)

## Delivery 3: complete v1

- [ ] Completion LLD, covering only what the Working inbox LLD left open.
- [ ] Sessions: state, outcome, goal and percent through the envelope, the session log, and a
      stopped session's part in stranded (R21-R23), beside Delivery 2's last seen, quiet and
      stranded. Agention reports a goal and never manages one (ruling 48). The envelope commits even
      when the write it rides fails, so domain errors are returned after the transaction commits
      rather than thrown through it.
- [ ] Unread session state changes in the list beside threads, consecutive progress-only updates
      collapsed (R25); session groups, tags on agents and sessions, and filtering the thread list by
      group or tag (R25, R26, R28; ruling 30).
- [ ] The session-group level in the list viewed by session (group, session, topic), with its
      roll-up (R28, rulings 38 and 40).
- [ ] One view of the sessions, replacing the registrations page (R26, ruling 56): registrations
      waiting for approval on top, then each agent's sessions as compact rows under foldable agent
      headers, each with its status, when it was last seen and whether it holds a working
      credential, and Revoke in its menu, past requests folded at the bottom; designed with session
      groups and tags and shown to the operator before it is built, then checked on a phone.
- [ ] Search extended from thread titles to the text and detail of messages through a second
      full-text index on the operator's list (R25, ruling 38), the agent mount's search staying on
      titles (R18).
- [ ] Mermaid diagrams (R14, ruling 39), as the prior-art research found: Mermaid runs in a
      sandboxed iframe (an opaque origin with scripts only, its own CSP and no network, Mermaid
      never in the main bundle and loaded on the first diagram), which returns SVG that the page
      shows as an inert `blob:` image at its natural size capped at the column width; a tap opens a
      full-screen viewer with pinch, drag, double-tap, wheel and keyboard zoom and pan and zoom in,
      zoom out, fit and actual-size buttons; diagrams render one at a time within size caps,
      re-render with the theme, and fall back to their source, which also serves as their long
      description. The Completion LLD settles the page's CSP for the frame (`frame-src` for its
      route, and the route's own `frame-ancestors`) as well as `img-src blob:`.
- [ ] Tool schemas, generated plugins and the usage skill extended with the session envelope and the
      quiet-stretch check-in.
- [ ] The new tables arrive through forward migrations, tested against a database written by
      Delivery 2.
- [ ] The issuer seam kept free of v1 dependencies (R4), and backup (R34).
- [ ] Live run and real-phone check repeated over the FRD definition of done, with the plugins
      installed from the repository and the bridge from npm.
- [ ] Material decisions promoted to ADRs and permanent docs (R39), checking that ADR 0001's
      alternatives and "not doing" guardrails still match the shipped design.
- [ ] `docs/live-testing.md` extended to Delivery 3's surfaces (the session envelope, groups, tags,
      backup, and Mermaid diagrams drawn in isolation, with a `mermaid` block among the Markdown
      hand-check inputs), and the live test running the bridge from npm; and the rules
      `docs/review-checklist.md` states for them checked against what was built.
- [ ] A check that agent routes only grow: each release's agent request and response schemas accept
      what the previous release's bridge sends and reads (R33, ruling 26), in place before any
      release after 0.1.0 that changes an agent route.
- [ ] The release that completes v1, through release-please.
- [ ] `locked.md` in this directory, with the final merge.
