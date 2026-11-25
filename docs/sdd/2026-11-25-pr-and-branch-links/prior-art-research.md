# Prior-art research: PR and branch links on threads

Research date: 2026-11-25. Scope: how established trackers and chat tools link pull requests and
branches to work items, the identity formats they use, compact display patterns, and prior art for
state that a client declares rather than state fetched from the forge. Each finding is tied to a
design implication (marked **Implication**) for Agention. Source IDs such as [S1] refer to the
sources table at the end.

## Executive summary

- Every tool studied keys a PR on a repository identity plus a per-repository number, and a branch
  on a repository identity plus the exact branch name. None uses the URL as the primary identity
  except Linear's generic attachments, which use the URL as an idempotency key per issue [S6].
  Agention should key on structured fields and treat the URL as display data.
- Owner and repository names on GitHub are case-insensitive [S3]; branch names are case-sensitive
  everywhere because git refs are [S13], [S14]. Dedupe keys should fold case for host, owner and
  repo on known case-insensitive hosts, and never fold branch names.
- Forges disagree on state vocabularies (GitHub: OPEN, CLOSED, MERGED plus an `isDraft` flag [S4];
  GitLab: opened, closed, merged, locked plus `draft` [S11]; Bitbucket: OPEN, MERGED, DECLINED,
  SUPERSEDED [S17]). Atlassian's push-based connector normalizes to open, draft, merged, declined,
  unknown [S9]. A small enum of open, draft, merged, closed, with "not declared" allowed, covers the
  common ground.
- Pushed (client-declared) state has strong prior art: GitHub commit statuses [S5], Jira's
  development-information and Teamwork Graph APIs [S8], [S9], and Linear attachments [S6]. All
  resolve conflicts with a latest-wins rule ordered by a sequence the server can compare, and all go
  stale when the pusher stops pushing [S10].
- Compact displays converge on one pattern: a single aggregate state plus a count, expanding to a
  list of per-item chips with state badges (Jira dev panel [S7], GitHub issue list counts [S12],
  GitHub Projects "Linked pull requests" field [S19]).
- The main risk for Agention is staleness presented as truth. Tools that fetch live state still show
  stale PR states when an event is missed [S10]; Agention, which never fetches, must label state as
  "as last reported" with its age and reporter.

## 1. Linking in issue trackers and chat tools

### 1.1 GitHub

- **Identity.** Issues and PRs share one number space per repository: the REST API "considers every
  pull request an issue" [S15]. References are `#26`, `GH-26` or `owner/repo#26`, and a full PR URL
  is autolinked and shortened to its number [S1]. Commits use `owner/repo@sha` [S1].
  **Implication:** a PR identity is (host, owner, repo, number); the same number can never be both
  an issue and a PR in one repo, so a number alone is unambiguous within a repo.
- **How links are made.** Closing keywords (`close`, `fixes`, `resolves` and variants) in a PR body
  or commit message link an issue, but only when the PR targets the default branch; otherwise they
  are ignored [S2]. Manual links go through the "Development" sidebar, from either side [S2]. An
  issue can link up to 10 PRs and a PR up to 10 issues [S2]. **Implication:** GitHub caps the list
  at 10 per item; Agention needs a cap too (a thread could accumulate many), and the cap should be
  documented as a limit rather than silently truncated.
- **Branches.** An issue's Development section can also hold branches created from it, several per
  issue; when a PR is opened from a linked branch, the PR "replaces the linked branch" [S16].
  **Implication:** a branch and the PR whose head it is are the same unit of work. If agents may
  declare a PR's head branch, the rollup can fold the branch under its PR and a branch filter can
  match the PR. Without that field the two stay separate entries.
- **Dedupe and removal.** Keyword links can only be removed by editing the PR text; manual links can
  be unlinked in the sidebar [S2]. **Implication:** GitHub derives links from current text, which
  matches Agention's rule of rolling up only live (non-replaced) messages: replacing the message
  removes the link, with no separate unlink operation.
- **State display.** The issue page shows the linked PR with its status; issue lists show a count of
  linked PRs and support a `linked:pr` filter [S12]. Projects offer a "Linked pull requests" field
  showing each PR's state on cards and table rows [S19]. **Implication:** the thread list needs only
  a count (or the aggregate state), with the per-PR badges in the thread view. A "has any PR" filter
  is cheap and proven useful.

### 1.2 Linear

- **How links are made.** An issue ID in a branch name, PR title or PR description links the PR;
  magic words (`Fixes ENG-123`) also drive workflow, and `skip`/`ignore` suppress a link [S18].
  Linear offers "Copy git branch name" so branch names carry the ID [S18].
- **Multiple PRs.** Several PRs can link to one issue; status automation fires only when the last
  linked PR reaches the required state [S18]. **Implication:** an aggregate over several PRs needs
  an explicit rule ("all merged" versus "any open"); Agention should pick one and state it.
- **State and display.** Automation reacts to drafted, opened, review requested, ready for merge and
  merged; the attachment shows reviewers and review state, and all linked PRs are listed in the
  issue details [S18].
- **Attachments API (client-declared).** Any integration can attach a URL with title, subtitle, icon
  and metadata; "Attachment URL is used as an idempotent value if used in conjunction with the same
  issue id", so re-sending the same URL updates rather than duplicates [S6]. Integrations keep the
  subtitle current themselves (for example "Open" to "Resolved"), and a subtitle placeholder can
  render a relative time such as "since 3 days" [S6]. Attachments can be looked up by URL to find
  the issue [S6]. **Implication:** this is the closest prior art to Agention. Reverse lookup (PR to
  threads) is the agent filter Agention plans. The relative-time placeholder is a ready pattern for
  "as of".

### 1.3 Jira

- **How links are made.** Development activity links only when a branch, commit or PR includes the
  issue key; branches and PRs created from the panel get the key automatically [S7].
- **Compact summary.** The panel shows one state per kind with a count: PRs show OPEN if any is
  open, else MERGED if any merged, else DECLINED, with the count in that state beside it [S7].
  **Implication:** adopt this precedence for the thread-level badge (open beats merged beats closed,
  with draft as a kind of open), and show the count.
- **Dedupe.** The detail dialog "may show duplicates", but the counts at the top and the panel
  summary are unique counts [S7]. Linked development information cannot be removed [S7].
  **Implication:** dedupe at rollup time, not in storage, and never show a count that disagrees with
  the list it summarizes.
- **Push API.** Providers push branches and PRs with `id`, `issueKeys`, `status`, `url`,
  `displayId`, `lastUpdate` and an `updateSequenceId`; stored data is replaced only when the
  incoming sequence is higher [S8]. The newer Teamwork Graph connector uses `updateSequenceNumber`
  with last-write-wins, a required `lastUpdatedAt`, and statuses `open`, `draft`, `merged`,
  `declined`, `unknown` [S9]. **Implication:** order competing declarations by a server-assigned
  sequence (Agention's message order), not by agent-supplied timestamps. Keep an explicit "unknown"
  or "not declared" value.
- **Staleness.** Atlassian documents PRs stuck at "Open" after merge when a GitHub event never
  arrives; the fix is a backfill or touching the PR [S10]. Jira automation exposes only Open,
  Merged, Declined, with Draft an open feature request [S20].

### 1.4 GitLab

- **Identity.** MRs use `!123`, `project!123` within a namespace, or `namespace/project!123`; issues
  use `#`; commits `namespace/project@sha` [S21]. The API returns `references.short` (`!123`),
  `relative` and `full` (`gitlab-org/gitlab!123`) [S11]. Paths may nest groups. **Implication:** a
  "repo" is a path that may contain several slashes; do not assume exactly `owner/repo` for
  non-GitHub hosts.
- **How links are made.** Mentioning an issue in a commit or MR description cross-links it; a branch
  whose name starts with the issue number and a hyphen links the issue and its MR [S22].
- **State.** `state` is `opened`, `closed`, `merged` or `locked`; `draft` is a separate boolean
  [S11]. The `+` reference suffix renders the title and `+s` a summary, which refreshes only on page
  reload [S21].

### 1.5 Slack with the GitHub app

- **Subscriptions** are per repository with feature filters (`pulls`, `reviews`, `branches` and so
  on) and label filters; per-PR subscriptions are not documented [S23].
- **Threading.** Each PR or issue gets a parent card that "always shows the latest status", with
  later events as thread replies and state changes also posted to the channel [S23].
  **Implication:** this is the "one card per PR, updated in place" model; Agention inverts it (one
  thread per work item, PRs rolled up), but the lesson holds: show the latest state once, not a
  history of states, and keep history in the message stream.
- **Unfurls** are suppressed when a message has three or more links or the same link was shared in
  the channel within 30 minutes [S23]. Unfurls are produced by the app via `chat.unfurl` on a
  `link_shared` event [S24]. **Implication:** rich rendering does not scale past a few links per
  message; fold to chips beyond a small number.

## 2. Identity formats and normalization

| Forge           | PR reference        | PR URL path                           | Branch (in repo)  |
| --------------- | ------------------- | ------------------------------------- | ----------------- |
| GitHub, GHES    | `owner/repo#123`    | `/owner/repo/pull/123`                | `/tree/<b>`       |
| GitLab          | `group/project!123` | `/group/project/-/merge_requests/123` | `/-/tree/<b>`     |
| Bitbucket Cloud | none standard       | `/ws/repo/pull-requests/123`          | `/branch/<b>`     |
| Gitea, Forgejo  | `owner/repo#123`    | `/owner/repo/pulls/123`               | `/src/branch/<b>` |

Compare views: GitHub `/compare/base...head` [S25] (cross-fork heads use `owner:branch`, matching
the REST `head` filter format `user:ref-name` [S26]); Gitea and Forgejo `/compare/base...head` with
`owner/repo:branch` for forks [S27]; GitLab `/-/compare/a...b`. GitHub and GitLab rows are from
official docs [S1], [S11], [S28]; Bitbucket paths are from general knowledge and Gitea paths from
router source, so treat them as unverified.

- **Case.** GitHub's REST docs say of both `owner` and `repo`: "The name is not case sensitive"
  [S3]. Git ref names are case-sensitive, Bitbucket confirms `Feature1` and `feature1` can coexist,
  and Microsoft recommends lowercase names to avoid collisions on case-insensitive filesystems
  [S13], [S14]. **Implication:** dedupe key folds host, owner and repo to lowercase for github.com
  (and plausibly all hosts, see open questions); branch names are compared byte for byte. Keep the
  casing an agent sent for display (most recent wins).
- **Branch names with slashes.** In web URLs, GitHub and Gitea keep the slash literal (Gitea escapes
  each segment separately with `PathEscapeSegments` [S27]); GitLab's API requires `%2F` for slashes
  in branch names and for `namespace/project` [S28]. **Implication:** store the raw branch name,
  never an encoded one; decode nothing; if Agention ever derives a URL, escape per segment for web
  paths. Prefer the agent's URL to deriving one.
- **Valid branch names.** `git check-ref-format` forbids spaces, control characters, `~`, `^`, `:`,
  `?`, `*`, `[`, backslash, `..`, `@{`, a leading or trailing `/`, consecutive slashes, a trailing
  `.`, components starting with `.` or ending `.lock`, and the name `@`; branches may not start with
  `-` [S13]. **Implication:** validate declared branch names against these rules so filters behave,
  and reject rather than normalize (git's `--normalize` only collapses slashes).
- **Hosts.** GitHub Enterprise Server, GitLab self-managed and Gitea instances use arbitrary hosts
  with the same paths. **Implication:** include the host in the identity, lowercase it, strip a
  default port and `www.`, and default it to `github.com` only when omitted. Strip a trailing `.git`
  from repo names (GitHub's `repo` parameter is "without the .git extension" [S3]).
- **URL is not identity.** One PR has many URLs: `/pull/123`, `/pull/123/files`, `/issues/123`
  (shared number space [S15]), and old owner or repo names after a rename. **Implication:** do not
  dedupe on URL; when two declarations of one PR carry different URLs, keep the latest.

## 3. Compact UI patterns

- **Aggregate badge plus count** on the item: Jira's dev panel shows one state with the count in
  that state [S7]; GitHub's issue list shows a linked-PR count [S12]. **Implication:** the thread
  row carries one chip such as "2 PRs, open" colored by aggregate state.
- **Per-item chips with state color** in the detail view: GitHub Development sidebar and Projects
  field [S12], [S19], Linear attachments with status subtitle [S6]. Use the short reference
  (`repo#123`, dropping the owner when all items share it) as the chip label and the URL as the
  link.
- **Folding.** GitHub caps links at 10 [S2], Slack stops unfurling at three links [S23], and Jira
  hides detail behind a dialog [S7]. **Implication:** show the first few chips (open first, then
  draft, then merged, then closed) and fold the rest behind "+N more".
- **History versus current.** Slack keeps the parent card current and pushes history into the thread
  [S23]; GitHub keeps cross-reference events in the timeline. **Implication:** the thread header
  shows the rollup; each message keeps its own declared PRs as historical record, so the message
  stream is the history and needs no separate log.

## 4. Agent-declared state

- **Prior art.** GitHub commit statuses are declared by external services, one latest state per
  `context`, combined into an overall state [S5]. Jira's development-information API [S8] and
  Teamwork Graph connectors [S9] accept pushed PR and branch state with last-write-wins on a
  sequence number. Linear attachments let integrations push and refresh a status subtitle [S6].
  Kubernetes separates desired `spec` from observed `status`, records `observedGeneration` and
  `lastTransitionTime`, and calls status "the most recent observations of actual state" [S29].
- **Staleness risks.** The pusher stops (agent session ends, crashes or forgets), so the last
  declared state persists indefinitely; Jira shows this failure even with webhooks [S10]. Two agents
  can disagree; out-of-order arrival can regress a state (merged back to open).
- **Signals used.** Relative "since" timestamps [S6], `lastUpdatedAt` and `lastUpdatedBy` [S9],
  `observedGeneration` [S29], and explicit `unknown` [S9]. **Implication:** every displayed state
  carries "reported by `<agent>`, `<relative time>`" and links to the message that declared it. Use
  server message order for latest-wins. Treat an undeclared state as unknown, not open. Consider
  de-emphasizing states older than a threshold.

## Refuted / do-not-rely-on

- "Owner and repo names on GitHub are case-sensitive": refuted by GitHub's REST docs [S3]. A
  community claim that git transport needs exact case [S30] is old and unverified; do not use it to
  choose canonical casing.
- "Branch names can be folded to lowercase for dedupe": refuted; git refs are case-sensitive and
  distinct branches differing only in case exist [S13], [S14].
- "Draft is a PR state": on GitHub it is a flag orthogonal to OPEN [S4], on GitLab a boolean [S11];
  Jira automation does not expose it [S20]. Modelling draft as an enum value is a simplification
  valid only for open PRs.
- "Slack's GitHub app can subscribe to one PR": not documented; subscriptions are per repo [S23].
- "Jira DevInfo uses `updateSequenceNumber`": that name is Teamwork Graph's [S9]; DevInfo uses
  `updateSequenceId` [S8]. Do not conflate the two APIs.
- GitLab issue sections titled "Related merge requests" and "Related branches" could not be
  confirmed in current docs [S22]; do not cite them.
- Bitbucket's SUPERSEDED state is listed by third parties [S17] but no official definition was
  found.
- The Linear GitHub integration page returned only a stub containing text addressed to AI agents; it
  was treated as untrusted and not used. Linear findings rest on [S6] and [S18].

## Open questions

1. Should Agention fold owner and repo case on every host, or only on github.com? GitLab and Gitea
   case behavior was not verified.
2. Should a PR declaration optionally carry its head branch, so branch filters match PRs and the
   rollup folds the branch under the PR (GitHub's "PR replaces branch" [S16])?
3. Should merged be terminal, so a later "open" declaration for a merged PR is rejected or flagged
   (GitHub cannot reopen a merged PR), or is plain latest-wins by message order enough?
4. Aggregate rule for the thread badge: Jira precedence (any open wins) [S7] or Linear's "all must
   reach the state" [S18]? These answer different questions (is work active versus is work done).
5. Per-thread cap on distinct PRs and branches, and whether exceeding it rejects the message or
   folds the display.
6. Should GitLab-style nested paths and `!` references be accepted now, or should the first version
   accept GitHub-shaped `owner/repo` only with the host as a free field?
7. Staleness threshold: should Agention visually age states after some interval, and should agents
   be nudged to re-declare?

## Sources

| ID  | Source                                                          | Grade         |
| --- | --------------------------------------------------------------- | ------------- |
| S1  | docs.github.com: Autolinked references and URLs                 | Official docs |
| S2  | docs.github.com: Linking a pull request to an issue             | Official docs |
| S3  | docs.github.com: REST API, pulls (owner/repo parameters)        | Official docs |
| S4  | docs.github.com: GraphQL reference, pulls (PullRequestState)    | Official docs |
| S5  | docs.github.com: REST API, commit statuses                      | Official docs |
| S6  | linear.app/developers/attachments                               | Official docs |
| S7  | support.atlassian.com: View development information for issue   | Official docs |
| S8  | developer.atlassian.com: Jira DevInfo REST API (truncated read) | Official docs |
| S9  | developer.atlassian.com: Teamwork Graph pull request object     | Official docs |
| S10 | support.atlassian.com KB: GitHub PR status not updated in Jira  | Official docs |
| S11 | docs.gitlab.com: Merge requests API                             | Official docs |
| S12 | github.blog 2020-02-06: issue and pull request linking          | Vendor blog   |
| S13 | git-scm.com: git-check-ref-format; git mailing list on case     | Official docs |
| S14 | support.atlassian.com KB: Case-sensitivity in Bitbucket Cloud   | Official docs |
| S15 | docs.github.com: REST API, issues                               | Official docs |
| S16 | docs.github.com: Creating a branch for an issue; github.blog    | Official docs |
| S17 | developer.atlassian.com Bitbucket pullrequests; CData listing   | Third party   |
| S18 | linear.app/docs/github                                          | Official docs |
| S19 | docs.github.com: About pull request fields; changelog 2025-11   | Official docs |
| S20 | community.atlassian.com: Draft state in pullRequest.state       | Third party   |
| S21 | docs.gitlab.com: GitLab Flavored Markdown references            | Official docs |
| S22 | docs.gitlab.com: Cross-linking issues                           | Official docs |
| S23 | github.com/integrations/slack README                            | Official docs |
| S24 | api.slack.com: Unfurling links                                  | Official docs |
| S25 | docs.github.com: Using query parameters to create a PR          | Official docs |
| S26 | docs.github.com: REST API, list pull requests `head` filter     | Official docs |
| S27 | Forgejo and Gitea router and template source (mirror)           | Third party   |
| S28 | docs.gitlab.com: REST API, namespaced paths and encoding        | Official docs |
| S29 | kubernetes/community: API conventions (status, conditions)      | Official docs |
| S30 | `metacpan` App::GitHub::FindRepository; CircleCI forum          | Third party   |

S12 and S19 changelog details came partly from search snippets; S8 was read from a truncated page.
