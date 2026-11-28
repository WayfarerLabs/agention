<!-- cspell:ignore automations Gatekept gatekeeping Suchman unresolve unresolving Winograd Zulip -->

# Settled threads research: shared resolution claims in conversation tools

Prior-art research for the Agention settled-threads design. Researched 2026-11-27.

This research predates the operator's rulings: where the [FRD](frd.md) (its S2 and S6) and the
[HLA](hla.md) decide otherwise, they supersede its design-decision labels and open questions, while
its dated alternatives stand as researched.

**Grading key** (used inline as (A), (B), (C), and in the sources table):

- **A**: primary docs: vendor documentation, API reference, vendor source code, or the vendor's own
  issue tracker.
- **B**: official blog, changelog, or staff announcement.
- **C**: third party: community forum, idea board, secondary write-up, or an academic paper read
  only through its abstract or secondary sources.

Source numbers like (S12) refer to the sources table at the end. A few primary pages were reached
only through a search tool's summary rather than read in full; the sources table marks them, and
claims resting on them are flagged where they appear.

**Decisions this research informs:**

- **D1**: settling is an attributed act carried by a message; the thread's state is derived from the
  latest live settle or unsettle.
- **D2**: any participant may settle or unsettle.
- **D3**: a later message from someone other than the settler revives the thread; a further settle
  does not.
- **D4**: how settling interacts with open asks.
- **D5**: a Settled mark on thread rows, a line in the timeline, and a filter.
- **D6**: settling is exposed to agents and the operator API; the server never settles on its own.
- **D7**: thread attributes set by messages as a general mechanism, with topic as the precedent.

## Executive summary

- **Two families, not to be confused.** Every system studied has a **shared, attributed resolution
  state** on the conversation unit (Zulip topic, GitHub review thread, Discussion answer, Discourse
  solved, help desk status, Google Docs comment, Basecamp to-do), a **private triage state** per
  user (Gmail archive and mute, Superhuman Done, HEY Reply Later, Slack Later and To-dos, GitHub
  notification Done, Linear Inbox, Front archive in an individual inbox), or both. Agention's
  per-participant read and archive marks are the private family. Settling is the shared family
  layered over it: a claim that "this no longer needs anyone" which each participant's private
  archive can then act on in bulk. Front is the only system that documents both layers together, and
  most of its documentation explains which action affects whom (S46). That confusion is the main
  usability risk of combining them.
- **The best precedent for D1 is the Google Drive comments API.** A comment thread is resolved or
  reopened only by posting a reply whose `action` is `resolve` or `reopen`, and the comment's
  `resolved` field is output only: "Whether the comment has been resolved by one of its replies"
  (S50, S51, S52). GitLab lets a reply carry a "Resolve thread" checkbox (S21). Elsewhere the state
  is stored on the thread but nearly always emitted as an attributed timeline event (S1, S11, S15,
  S41). The consensus is thread-level state set by an attributed event in the message stream.
- **Symmetric set and clear by any participant is the common default (D2).** Zulip shipped with
  broad permission and later added org-wide and per-channel `can_resolve_topics_group` settings
  after communities asked to restrict it (S3, S7). GitHub, Discourse, and Zendesk restrict to
  authors or privileged roles (S10, S13, S47, S41). Restriction arrives later, as configuration.
- **New activity follows one of three policies, and each has documented complaints (D3).** Staying
  resolved hides new work under the marker (Zulip, GitHub, Discourse). Reopening on any reply makes
  "thank you" reopen work: the Jira Service Management resolve-with-comment bug (S40) and an
  Intercom idea (S45) are both about the wrong party's message reviving the thread. Terminal closure
  after a grace period (Zendesk Closed, Discourse auto-close) loses the conversation. Mature help
  desks narrow which activity revives: the other party's reply, not internal notes (S41, S42, S43,
  S46); Gmail mute returns a thread only when you are addressed (S29). D3's rule, revival by someone
  other than the settler, is that narrowing.
- **Display is uniform (D5):** a glyph or collapse on the row, an attributed timeline entry, and a
  first-class filter (S4, S15, S47, S46). Zulip's choice to encode the state in the topic name broke
  links, marked every message edited, and bumped unread counts for everyone; Zulip then added a link
  form that survives resolving and made the notice unread only for participants (S5, S6, S9).
- **Almost every system exposes resolution to automation (D6):** GitHub GraphQL fields, mutations,
  and a webhook (S11, S12); Drive replies (S50); Basecamp's completion sub-resource (S54). Where
  systems settle on an external event, an integration does it and is credited: Linear and GitHub
  close on PR merge (S35, S17). Systems where the server itself settles or closes on a timer
  (Zendesk, Discourse, Linear stale issues) all pair that with terminal states that Agention does
  not want.
- **Warnings.** A resolution claim goes stale: Stack Overflow permanently unpinned accepted answers
  in 2021 (S49). Forcing every message into a speech-act category is the known failure of The
  Coordinator (S57, S59). Per-user read state is not resolution: Teams users report an answered
  question still shows unread for everyone else (S27).

## Findings by research dimension

### 1. What is marked: message act or thread state (D1, D7)

- **Drive and Docs comments: a message act with a derived thread state (S50, S51, S52, S53) (A).**
  The reply's `action` is "The action the reply performed to the parent comment. The supported
  values are: resolve, reopen." The comment's `resolved` is "Output only. Whether the comment has
  been resolved by one of its replies." "A comment can only be resolved by posting a reply." The UI
  offers Re-open on a resolved comment. This is D1 exactly: the act is a message, carries its
  author, and the state is read-only and derived. **Informs D1 and D7**: Drive shows a derived,
  read-only thread attribute set by messages, which is the shape Agention's `topic` already has (the
  thread's topic is the latest live message carrying one).
- **GitLab: a reply can carry the resolve (S21) (A).** A reply has a "Resolve thread" checkbox, so
  the resolve rides on a message; resolving also exists as a direct action. **Informs D1.**
- **Zulip: thread state implemented as a rename (S1, S2) (A).** Resolving edits the topic name to a
  check-mark prefix plus the original topic on every message (`propagate_mode: "change_all"`); "The
  empty string topic cannot be marked as resolved." The attribution lives in a Notification Bot
  message. There is no separate field. **Informs D1 and D7 as a warning**: state encoded in the
  conversation's identity caused the side effects described under dimension 5.
- **GitHub review threads, help desks, Basecamp: stored thread state (S11, S41, S42, S54) (A).**
  GitHub stores `isResolved` and `resolvedBy` on `PullRequestReviewThread`. Basecamp stores
  completion as a sub-resource carrying `creator` and `created_at`. Help desks keep a status field.
  Almost all of them also emit a timeline event, so the history is message-shaped even where the
  state is not. **Informs D1**: the attributed event is the common denominator.
- **Discourse Solved and GitHub Discussions answers: a message-level mark with a different meaning
  (S47, S13, S14) (A).** Both mark _which message_ is the answer and aggregate that to the topic.
  "This is the answer" is not "this no longer needs anyone". **Informs D1**: borrow the aggregation,
  not the meaning. GitHub's later Discussion close reasons (Resolved, Outdated, Duplicate) are the
  closest GitHub analogue to "no longer relevant" (S15) (B).
- **Slack: an attributed flag on a message with no thread state (S23, S24) (A, B).** Slack's
  triage-channel guidance uses reactions on the request message, `:eyes:` for "I'm looking at this
  for you" and `:white_check_mark:` for "I've fixed the issue", and teams build bots that scan
  reactions to track open items. It has no first-class state, filter, or revival rule; no native
  "mark thread resolved" was found in Slack help (S23, S26). **Informs D1**: a bare flag on an
  arbitrary message invites ambiguity about which flag wins, which "latest live settle or unsettle"
  removes.
- **Jira: one source of truth (S38) (A).** An issue is resolved if and only if its Resolution field
  is set, independent of status. An "Unresolved" resolution value, or a transition that moves to
  Done without a resolution, corrupts reports. **Informs D1 and D7**: one derivation, never two
  fields that can disagree.
- **The Coordinator: state derived from a sequence of typed acts (S56, S58, S59) (C).** Messages
  were typed as speech acts (request, promise, report completion, declare satisfaction) and the
  conversation state was derived from the sequence. The mechanism matches D1; the critique under
  dimension 7 bounds it.

### 2. Shared or per-user (D1, D5)

- **Private triage layers (S19, S25, S28, S29, S31, S32, S36) (A).** GitHub notification Done (kept
  under `is:done` for 3 months), Slack Saved and Later (being replaced by personal To-dos from
  October 2026), Gmail archive and mute, Superhuman Done, HEY Reply Later and Ignore, and the Linear
  Inbox (delete and snooze; "We don't support archiving notifications at this time"; a Priority tab
  since September 2026 (S37) (B)) are all per user. None can express "the agent says this is moot"
  to anyone else.
- **Revival in the private layer matches Agention's archive today.** "If someone replies to a
  message you archive, it returns to your inbox" (S28). Superhuman Done and HEY behave the same way
  (S31, S32; read through search summaries). Agention's archive mark already works like this:
  another party's message raises `last_seq` and un-archives implicitly.
- **Front documents both layers (S46) (A).** A status change in a shared inbox "impacts everyone
  viewing in the shared inbox, but does not change the conversation status for any teammates
  following the conversation"; archiving in an individual inbox affects only you unless you are the
  assignee. Ticket statuses add a third axis (Open, Waiting, Resolved: "no further action is needed
  from your team"). **Informs D1 and D5**: keep settled (shared) and archived (private) visibly
  distinct, and say plainly which one an action changes.
- **Basecamp shows the shared-versus-individual tension (S55) (B).** A user asked for per-assignee
  completion because one assignee completing a to-do completes it for all. **Informs D1**: a shared
  claim in a multi-actor thread speaks for everyone, which is why D2 and D3 keep it easy to contest.

### 3. Who may set and clear (D2)

| System                | Who may set                                                                       | Who may clear                                    | Source         |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| Zulip                 | `can_resolve_topics_group`, org-wide and per channel                              | same                                             | (S2, S3) (A)   |
| GitHub review threads | PR author or write access                                                         | same (`viewerCanUnresolve`)                      | (S10, S11) (A) |
| GitHub Discussions    | discussion author or triage role or greater                                       | same ("Unmark as answer")                        | (S13, S14) (A) |
| GitLab                | Developer or higher, or the author                                                | "any user who has permission to resolve threads" | (S21) (A)      |
| Discourse Solved      | topic author (`accept_solutions_topic_author`); admins, moderators, TL4 (default) | same                                             | (S47) (A)      |
| Stack Overflow        | the asker only                                                                    | the asker, "at any time"                         | (S48) (A)      |
| Zendesk               | agents set Solved; only the system sets Closed                                    | a requester comment reopens                      | (S41) (A)      |
| Google Docs, Front    | anyone who can comment; any teammate                                              | same                                             | (S53, S46) (A) |
| Slack reactions       | anyone                                                                            | the reactor                                      | (S23) (A)      |

- **Symmetric set and clear is the norm.** Every system above lets whoever may set also clear, apart
  from Zendesk's system-only Closed. **Informs D2.**
- **Restriction arrives later, as configuration.** Before Zulip 10.0 (feature level 367) the
  permission rode on `can_move_messages_between_topics_group` (S2). Issue #19955, opened October
  2021 and closed by PR #34818 in July 2025, added per-channel control because "Some organizations
  may prefer not to use the 'resolve topic' feature, or only use it in certain channels" (S7) (A).
  The feature had shipped publicly in Zulip 5.0 in March 2022 (S8) (B). A GitHub community thread
  complains that non-authors cannot resolve outdated threads (S20) (C), the opposite pressure.
  **Informs D2**: start with any participant, leave room for a policy knob later.
- **Gatekept resolution still goes stale.** Stack Overflow restricted acceptance to the asker and
  still had to unpin accepted answers (dimension 7). **Informs D2**: showing who and when, and
  letting anyone unsettle, matters more than gatekeeping who may settle.

### 4. How new activity interacts (D3)

**Three policies:**

- **Stays resolved; replies allowed.** Zulip: "You can still send messages to resolved topics, such
  as thank-you messages or challenges to a resolution" (S1) (A). Integrations "will still send
  messages to the original topic after a topic is resolved" (S1); a bot posting into a resolved
  topic does not revive it. GitLab: "Resolved threads are collapsed, but users can still add
  comments" (S21) (A). Discourse discourages rather than reopens, with reply education: "This topic
  has been solved. Only reply here if: you have additional details; the solution doesn't work for
  you" (S47) (A). GitHub review threads and issues behave this way in practice, though no GitHub doc
  sentence says so (see the refuted section). Risk: real new work hides under a resolved marker.
- **Reopen on a qualifying reply.** Help Scout: "If a customer replies back to a Pending or Closed
  conversation, the status will automatically be changed to Active" (S42) (A). Zendesk: a requester
  comment on Pending or Solved returns the ticket to Open and to the agent who solved it (S41) (A).
  Intercom conversations reopen when the customer writes back (S43) (A). Front archived
  conversations "will automatically reopen, and will move from the Archived tab back into the Open
  tab", governed by company bump settings; customer replies reopen regardless of ticket status (S46)
  (A). Risk: a "thank you" reopens work.
- **Terminal after a grace period.** Zendesk closes solved tickets after 4 days by default (28 if
  automations are off), and replies to Closed create a follow-up ticket that references the original
  (S41) (A). Discourse `solved_topics_auto_close_hours` closes a solved topic n hours after the last
  reply (S47) (A). GitHub Discussions can be closed (S15) (B). This conflicts with Agention never
  losing anything, though the idea that activity after settling is a visible event transfers.

**Narrowing patterns: who or what may revive.**

- **The other party's message, not your own.** Help desks revive on the customer's reply, not the
  agent's (S41, S42, S46). Jira Service Management's "Reopen on customer comment" preset had a known
  bug where resolving with a comment immediately reopened the request; the fix conditions on public
  customer comments, or on the comment being the primary action (S39, S40) (A). **Informs D3**
  directly: the settler's own closing words must not revive, which D3 achieves by excluding the
  settler.
- **External, not internal, activity.** Intercom internal notes do not reopen a conversation
  (community source, (C)); Intercom tickets in the Resolved state do not reopen on a customer reply
  unless a workflow does it (S44) (A). An Intercom idea reports resolved tickets starting to reopen
  on "a simple thank-you" and calls it a bug (S45) (C). The two disagree; see the refuted section.
- **Only when addressed.** Gmail mute keeps replies out of the inbox unless sent only to you, to a
  group you are in, or you are added to To or Cc (S29) (A). This is the cleanest documented
  selective revival rule.
- **Roles, not kinds of actor.** In Agention the operator is the customer on threads agents start
  and the agent on work the operator asks for, so a rule keyed on human versus agent would be wrong
  half the time. **Informs D3**: define revival by role in the thread (the settler versus everyone
  else), as D3 does.
- **A further settle does not revive.** No source studied treats a resolve as activity that reopens,
  and Zulip goes further: unresolving "right after you resolved it removes the original notice
  instead" (S1) (A). **Informs D3**: a settle message is the act itself, never the new activity that
  undoes it.

### 5. Settling and outstanding work (D4)

Evidence here is thin; no system documents a rule that maps directly onto Agention's open asks.

- **Discourse couples solving to assignment (S47) (A).** `assignment_status_on_solve` and
  `assignment_status_on_unsolve` change the assignment status, and
  `ignore_solved_topics_in_assigned_reminder` stops reminders for solved topics. Solving settles the
  outstanding work item along with the topic.
- **GitHub gates in the other direction (S12) (B).** A branch rule can require every conversation
  resolved before merge: open items block a terminal step rather than being cleared by it.
- **Layers can stay independent (S44) (A).** Intercom: "Setting a ticket to Resolved does not close
  the conversation."
- **Jira's warning applies (S38) (A).** If a thread can read as settled while an ask is still open,
  the two are fields that disagree. **Informs D4**: whatever the rule (settling refuses, withdraws,
  or ignores open asks), one derivation should decide what the row says. Agention's archive already
  refuses while an ask is open to the caller, and bulk archive skips threads with open asks, which
  is the nearest internal precedent.

### 6. Display, timeline, and filtering (D5)

- **A glyph or collapse on the row.** Zulip's check-mark prefix (S1), Discourse's check box (S47),
  GitHub's collapsed resolved threads and a Conversations menu listing unresolved, resolved, and
  outdated (S10) (A).
- **An attributed timeline entry.** Zulip's Notification Bot notice (S1), GitHub's Discussion close
  in the header icon and timeline (S15), Basecamp's completion `creator` and `created_at` (S54).
  Discourse makes attribution optional: `show_who_marked_solved` defaults to false (S47) (A).
  **Informs D5**: Agention's timeline line should name who settled and when, since the claim is only
  as good as its author (dimension 7).
- **A first-class filter.** Zulip `is:resolved`, `-is:resolved`, and `is:unresolved is:unread` (S4)
  (A); GitHub Discussions `is:closed`, `reason:resolved|outdated|duplicate`, and `closed:<date>`
  (S15) (B); Discourse `show_filter_by_solved_status` (S47); Basecamp listing pending by default
  with `completed=true` to filter completed (S54); Front's Resolved tab (S46); Drive's open and
  resolved filter (S53). **Informs D5**: a Settled filter is expected, and it feeds the bulk
  read-and-archive flow.
- **Bulk action over the filter.** Inbox by Gmail's bundles let you "pin the messages you want to
  keep in your inbox and sweep away the rest" (S30) (B): bulk done with pinned exceptions, the same
  shape as spot-checking settled threads and then reading and archiving the rest.
- **Keep the state out of the identity, and keep the notice quiet (S5, S6, S9).** Zulip's rename
  made every message show as edited and bumped unread counters ("too many annoying side effects",
  Lean community, 2021 (S9) (C)); a Zulip issue (#19651, URL not captured) reported that resolving
  broke message links cited in commit messages. Zulip added the `with` narrow so links survive a
  topic being "moved or resolved" (S5) (A), and issue #19709 (fixed February 2022) made the resolve
  notice unread only for topic participants, because resolving "bumps it to the top of the feed even
  though the intent is to mark it done" (S6) (A). Users can also auto-mark resolve notices as read
  (S1). **Informs D5**: the settle line must not rename the thread, and should not make the thread
  unread for anyone, or at least not for non-participants.

### 7. API and automation exposure (D6)

- **Full exposure is normal.** GitHub GraphQL: `isResolved`, `resolvedBy` ("The user who resolved
  this thread"), `isOutdated`, `isCollapsed`, `viewerCanResolve`, `viewerCanUnresolve`, and the
  `resolveReviewThread` and `unresolveReviewThread` mutations (S11) (A), with a webhook on resolve
  and unresolve (S12) (B). Drive: `replies.create` with `action` (S50). Basecamp: `POST` and
  `DELETE /todos/:id/completion.json` (S54). Zulip: no dedicated endpoint; resolving is a topic edit
  through `PATCH /messages/{id}` (S2). Intercom's API can close, snooze, and open conversations
  (S43). **Informs D6**: settle and unsettle belong in the agent tools and operator API, with the
  settler and time in read shapes.
- **Integrations settle on external events, and are credited.** Linear moves linked issues on PR
  events, by default to Done on merge; closing words ("Fixes ENG-123") apply the merge status,
  "Refs" does not; canceling an issue closes its linked open PRs (S35) (A). GitHub auto-closes
  issues from linked PRs or commits with closing keywords, only when merged to the default branch
  (S17) (A). GitLab can auto-resolve diff threads on lines a push changed (S21, S22) (A). This is
  the operator's own example, a test report for a PR already merged. **Informs D6**: in Agention the
  agent is the integration, so it settles through the same attributed act and the claim carries its
  name.
- **Server-made settling pairs with terminal states.** Zendesk's system-only Closed (S41), Discourse
  auto-close (S47), and Linear's team-level auto-close of stale issues and auto-archive of closed
  ones (S34) (B) all close on a timer, and all lead to states that refuse or redirect new activity.
  GitHub keeps "outdated" as a separate, system-computed state that does not resolve (S11).
  **Informs D6**: in every case found, a server-made close is a lifecycle step toward a terminal
  state, not a claim participants contest; Agention's choice not to settle automatically keeps every
  claim attributed to a participant.
- **A reason is common.** GitHub issues close as Done, Not planned, or Duplicate (S16, S18);
  Discussions close as Resolved, Outdated, or Duplicate (S15). "Outdated" is the operator's
  merged-PR case. See the open questions.

### 8. Warnings

- **A resolution claim goes stale.** Stack Overflow's help says the asker "may change which answer
  is accepted, or simply un-accept the answer, at any time" (S48; read through a search summary),
  and calls acceptance the asker's judgement of the best solution to their problem. In September
  2021 Stack Overflow made unpinning the accepted answer permanent after an A/B test found "no
  negative repercussions", as part of its Outdated Answers project (S49) (B). **Informs D2, D3, and
  D5**: show who and when, let anyone unsettle, and let later evidence (a counterparty's message)
  outweigh the claim.
- **Forced speech-act categories fail.** The Coordinator typed every message as a speech act.
  Suchman argued the category system imposes "discipline and control" and asked "who gets to define
  relevant categories" (S57) (C); Winograd replied in the same issue, distinguishing "formal
  structures used for communication and recording" from models of behavior (S58) (C). Adoption was
  limited because it "needed all participants to use it consistently" (S59) (C). **Informs D1 and
  D7**: an optional, explicit settle act is fine; requiring a resolution category on every message
  is the known failure.
- **Per-user read state is not resolution.** Teams has no native resolve for channel posts, and
  users running support channels report "a question answered by one member still showed as unread
  for the rest of the team" (S27) (C). This is the gap a shared claim fills. **Informs D1.**
- **Two layers confuse.** Front's documentation is mostly about which action affects whom (S46).
  **Informs D5**: the Settled mark and the participant's own archive state must read differently.

## Refuted / do not rely on

- **"Zulip's resolved state is a separate flag."** It is a topic rename with a check-mark prefix,
  applied to every message; there is no separate field (S1, S2).
- **"Replying reopens a resolved GitHub review thread."** No GitHub doc says so; community material
  treats re-review as convention. The GitLab report of a reply unresolving a discussion is
  GitLab-specific and dated 2016 (S22).
- **"Commenting reopens a closed GitHub issue."** It does not in practice, but no doc sentence was
  found either way; cite it as product behavior, not documentation. Who may reopen a closed GitHub
  issue was not confirmed from docs.
- **"Linear Inbox has archive and auto-archives notifications when the issue completes."** Not
  supported. Notifications are deleted or snoozed, and the FAQ says "We don't support archiving
  notifications at this time" (S36). Linear's auto-archive applies to issues, not inbox
  notifications (S34).
- **"Gmail has Mark as done."** That was Inbox by Gmail, shut down in 2019. Gmail has archive and
  mute. The "mark as done" wording for Inbox comes from third-party coverage; the official blog says
  "sweep away" (S30).
- **"Slack can mark a thread resolved."** Nothing in Slack help; only emoji conventions and
  workflows (S23). Slack Lists have a Completion field on items, which is item state, not
  conversation state (S26).
- **Intercom resolved tickets.** The help doc says they do not reopen on a customer reply (S44); a
  community idea reports that they started to (S45). Treat current behavior as unverified. The claim
  that Intercom internal notes do not reopen conversations rests on a community source.
- **Superhuman, HEY, Linear workflow statuses, and Stack Overflow acceptance** were read through
  search-tool summaries of their help pages (S31, S32, S33, S48); quotes are not verbatim. HEY's Set
  Aside was confirmed only through an app store listing.
- **Discourse topic timers** ("auto-close after last post" resetting on each reply) appear only in
  forum threads; no official page was found. The Discourse Solved meta topic returned 403, so the
  Discourse findings rest on the plugin's source (S47).
- **The Coordinator's state machine.** The HCI87 paper (S56) was a scan that could not be read; its
  specifics come from secondary sources.
- **No primary design rationale** was found for Zulip's resolved topics beyond the help pages and
  issues; the closest are Tim Abbott's comments in #19709 (S6) and the #19955 discussion (S7).

## Open questions

1. **Revival when the settler is not the only other party.** D3 revives on a message from anyone but
   the settler. In a thread where an agent settles and a second agent posts an automated notice
   (Zulip's integrations posting into resolved topics (S1)), should that revive? Is a message that
   only answers or declines an ask substantive activity?
2. **Is revival its own timeline event?** Help desks record reopen as a transition. Should the
   timeline say "revived by X" so the earlier settle stays visible for spot-checks, or does the
   message itself suffice?
3. **A reason on settle.** GitHub offers resolved, outdated, and duplicate (S15) and completed, not
   planned, and duplicate (S16). Should a settle carry an optional free-text or enumerated reason?
   "Outdated" is the merged-PR example.
4. **Open asks (D4).** Does settling refuse while asks are open, withdraw them as part of the act
   (like Discourse's `assignment_status_on_solve` (S47)), or leave them and show both? Prior art
   does not settle this.
5. **Notice visibility.** Should a settle line make the thread unread for anyone? Zulip settled on
   participants only (S6); Agention may want none.
6. **Instant undo.** Zulip removes the notice when an unresolve quickly follows a resolve (S1). Is
   that worth copying, given Agention's replaces and live-message rules already cover correction?
7. **A future policy knob.** Zulip and Discourse both grew "who may resolve" settings later (S3, S7,
   S47). Will multi-human use need a per-thread or per-agent restriction?
8. **Vocabulary.** The web client already uses "settled" for a muted row line about answered and
   withdrawn asks (`settledWords` in `format.tsx`). Does the new Settled mark collide with that
   wording?

## Sources

| #   | URL                                                                                                                                                                                                                                             | Angle                                                                                       | Grade |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----- |
| S1  | <https://zulip.com/help/resolve-a-topic>                                                                                                                                                                                                        | Zulip resolve as rename, notices, instant undo, replies to resolved topics, integrations    | A     |
| S2  | <https://zulip.com/api/update-message>                                                                                                                                                                                                          | Zulip resolve via topic edit, `propagate_mode`, permission history                          | A     |
| S3  | <https://zulip.com/help/restrict-resolving-topics>                                                                                                                                                                                              | `can_resolve_topics_group`, org-wide and per channel                                        | A     |
| S4  | <https://zulip.com/help/search-for-messages>                                                                                                                                                                                                    | `is:resolved` and `-is:resolved` filters                                                    | A     |
| S5  | <https://zulip.com/api/construct-narrow>                                                                                                                                                                                                        | `with` narrow so links survive resolving                                                    | A     |
| S6  | <https://github.com/zulip/zulip/issues/19709>                                                                                                                                                                                                   | resolve notice unread only for participants                                                 | A     |
| S7  | <https://github.com/zulip/zulip/issues/19955>                                                                                                                                                                                                   | per-channel resolve permission, motivation                                                  | A     |
| S8  | <https://blog.zulip.com/2022/03/29/zulip-5-0-released/>                                                                                                                                                                                         | resolved topics shipped in Zulip 5.0, March 2022                                            | B     |
| S9  | <https://leanprover-community.github.io/archive/stream/236604-Zulip-meta/topic/Resolving.20topics.html>                                                                                                                                         | community side effects: edited marks, unread bumps, request to disable                      | C     |
| S10 | <https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request>                                                                                                     | who may resolve review conversations, collapse, Conversations menu                          | A     |
| S11 | <https://docs.github.com/en/graphql/reference/pulls>                                                                                                                                                                                            | `isResolved`, `resolvedBy`, `isOutdated`, viewer permissions, mutations                     | A     |
| S12 | <https://github.blog/changelog/2021-06-16-new-tools-to-discover-and-resolve-pull-request-conversations-now-generally-available/>                                                                                                                | resolve webhook, require conversations resolved before merge                                | B     |
| S13 | <https://docs.github.com/en/discussions/collaborating-with-your-community-using-discussions/participating-in-a-discussion>                                                                                                                      | marking an answer, who may mark and unmark                                                  | A     |
| S14 | <https://docs.github.com/en/discussions/managing-discussions-for-your-community/moderating-discussions>                                                                                                                                         | marking an answer, moderation                                                               | A     |
| S15 | <https://github.blog/changelog/2023-03-14-adding-the-ability-to-close-github-discussions/>                                                                                                                                                      | close reasons Resolved, Outdated, Duplicate; filters; timeline                              | B     |
| S16 | <https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/closing-an-issue>                                                                                                                                        | issue close reasons                                                                         | A     |
| S17 | <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue>                                                                                                                              | auto-close on merge to the default branch                                                   | A     |
| S18 | <https://github.blog/changelog/2024-12-12-github-issues-projects-close-issue-as-a-duplicate-rest-api-for-sub-issues-and-more/>                                                                                                                  | Duplicate close reason added December 2024                                                  | B     |
| S19 | <https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox>                                                                                                  | per-user notification Done and Saved                                                        | A     |
| S20 | <https://github.com/orgs/community/discussions/19206>                                                                                                                                                                                           | complaint: non-authors cannot resolve outdated threads                                      | C     |
| S21 | <https://docs.gitlab.com/user/discussions/>                                                                                                                                                                                                     | GitLab resolve permissions, reply checkbox, comments on resolved threads, auto-resolve      | A     |
| S22 | <https://gitlab.com/gitlab-org/gitlab-foss/issues/36994> and <https://gitlab.com/gitlab-org/gitlab-ce/issues/24128>                                                                                                                             | auto-resolve on push; 2016 report of a reply unresolving a discussion                       | A     |
| S23 | <https://slack.com/help/articles/360000384726>                                                                                                                                                                                                  | emoji reactions as triage state                                                             | A     |
| S24 | <https://slack.com/blog/productivity/assign-and-complete-how-to-run-a-triage-channel>                                                                                                                                                           | triage channel conventions, reaction meanings                                               | B     |
| S25 | <https://slack.com/help/articles/13453851074067> and <https://slack.com/intl/en-ie/help/articles/55757634348435-Later-is-now-To-dos>                                                                                                            | per-user Saved, Later, and To-dos                                                           | A     |
| S26 | <https://slack.com/help/articles/27452748828179>                                                                                                                                                                                                | Slack Lists Completion field is item state                                                  | A     |
| S27 | <https://techcommunity.microsoft.com/t5/driving-adoption/q-amp-a-option-in-teams-channels/td-p/3040224> and <https://techcommunity.microsoft.com/t5/microsoft-teams/using-teams-for-customer-support-how-to-mark-as-read-when-you/td-p/1879980> | Teams has no resolve; answered questions stay unread for others                             | C     |
| S28 | <https://support.google.com/mail/answer/6576>                                                                                                                                                                                                   | Gmail archive and revival on reply                                                          | A     |
| S29 | <https://support.google.com/mail/answer/16594169>                                                                                                                                                                                               | Gmail mute: revival only when addressed                                                     | A     |
| S30 | <https://gmail.googleblog.com/2014/11/a-bit-about-bundles-in-inbox.html>                                                                                                                                                                        | Inbox by Gmail bundle sweep with pinned exceptions                                          | B     |
| S31 | <https://help.superhuman.com/hc/en-us/articles/47439134613773-Mark-Done> and <https://help.superhuman.com/hc/en-us/articles/46742615869075-Swipe-Your-Way-to-Inbox-Zero>                                                                        | Superhuman Done and revival (read through a search summary)                                 | A     |
| S32 | <https://www.hey.com/features/reply-later/>, <https://hey.com/how-it-works>, and <https://help.hey.com/article/764-focus-and-reply>                                                                                                             | HEY Reply Later, Focus and Reply, Ignore (read through search summaries)                    | A     |
| S33 | <https://linear.app/docs/configuring-workflows>                                                                                                                                                                                                 | Linear status categories, Duplicate (search summary; direct fetch failed)                   | A     |
| S34 | <https://linear.app/changelog/2020-08-19-auto-close-and-auto-archive>                                                                                                                                                                           | Linear auto-close of stale issues, auto-archive of closed issues                            | B     |
| S35 | <https://linear.app/docs/github>                                                                                                                                                                                                                | Linear PR automations, closing words, merge status                                          | A     |
| S36 | <https://linear.app/docs/inbox>                                                                                                                                                                                                                 | Linear Inbox delete and snooze, no archive                                                  | A     |
| S37 | <https://linear.app/changelog/2026-09-03-priority-inbox>                                                                                                                                                                                        | Linear Priority inbox tab                                                                   | B     |
| S38 | <https://support.atlassian.com/jira/kb/best-practices-on-using-the-resolution-field-in-jira-cloud/>                                                                                                                                             | Jira resolution field as the single source of truth                                         | A     |
| S39 | <https://confluence.atlassian.com/servicemanagementserver/automating-your-service-project-939926334.html>                                                                                                                                       | JSM "Reopen on customer comment" preset                                                     | A     |
| S40 | <https://jira.atlassian.com/browse/JSDSERVER-4348> and <https://jira.atlassian.com/browse/JSDCLOUD-2245>                                                                                                                                        | resolve-with-comment reopens itself; fix conditions                                         | A     |
| S41 | <https://support.zendesk.com/hc/en-us/articles/8263915942938-About-the-ticket-lifecycle-and-ticket-statuses>                                                                                                                                    | Zendesk statuses, requester reopen, system-only Closed, follow-ups                          | A     |
| S42 | <https://docs.helpscout.com/article/11-conversation-elements>                                                                                                                                                                                   | Help Scout statuses, customer reply reopens                                                 | A     |
| S43 | <https://intercom.com/help/en/articles/8363763-close-a-conversation>                                                                                                                                                                            | Intercom conversations close and reopen                                                     | A     |
| S44 | <https://www.intercom.com/help/en/articles/9730130-how-ticket-states-work>                                                                                                                                                                      | Intercom resolved tickets do not reopen; layers independent                                 | A     |
| S45 | <https://community.intercom.com/ideas/don-t-automatically-reopen-resolved-tickets-on-customer-reply-15035>                                                                                                                                      | complaint: thank-you replies reopen resolved tickets                                        | C     |
| S46 | <https://help.front.com/en/articles/2350>, <https://help.front.com/en/articles/2134>, and <https://help.front.com/en/articles/1300288>                                                                                                          | Front shared and individual layers, auto-reopen, ticket statuses                            | A     |
| S47 | <https://github.com/discourse/discourse-solved>                                                                                                                                                                                                 | Discourse Solved settings, permissions, reply education, auto-close, assignment             | A     |
| S48 | <https://stackoverflowteams.com/help/accepted-answer>                                                                                                                                                                                           | asker accepts and un-accepts (read through a search summary)                                | A     |
| S49 | <https://meta.stackoverflow.com/questions/411352>                                                                                                                                                                                               | accepted answers permanently unpinned, September 2021 (read through the Stack Exchange API) | B     |
| S50 | <https://developers.google.com/workspace/drive/api/reference/rest/v3/replies>                                                                                                                                                                   | reply `action`: resolve, reopen                                                             | A     |
| S51 | <https://developers.google.com/workspace/drive/api/reference/rest/v3/comments>                                                                                                                                                                  | comment `resolved` output only, derived from replies                                        | A     |
| S52 | <https://developers.google.com/workspace/drive/api/guides/manage-comments>                                                                                                                                                                      | resolving only by posting a reply                                                           | A     |
| S53 | <https://support.google.com/docs/answer/65129>                                                                                                                                                                                                  | Docs UI resolve, re-open, open and resolved filter                                          | A     |
| S54 | <https://github.com/basecamp/bc3-api/blob/master/sections/todos.md>                                                                                                                                                                             | completion sub-resource with creator and time, pending-by-default listing                   | A     |
| S55 | <https://signalvnoise.com/svn3/new-in-basecamp-3-decide-who-gets-notified-when-completing-a-to-do/>                                                                                                                                             | completion notifications; request for per-assignee completion                               | B     |
| S56 | <https://www.lri.fr/~mbl/ENS/CSCW/2018/papers/Winograd-HCI87.pdf>                                                                                                                                                                               | The Coordinator, speech-act typing (scan; not readable)                                     | C     |
| S57 | <https://link.springer.com/doi/10.1007/BF00749016>                                                                                                                                                                                              | Suchman, "Do categories have politics?" (abstract)                                          | C     |
| S58 | <https://www.lri.fr/~mbl/ENS/CSCW/2015/papers/Winograd-JCSCW94.pdf>                                                                                                                                                                             | Winograd's reply to Suchman                                                                 | C     |
| S59 | <https://www.dubberly.com/?p=1079>                                                                                                                                                                                                              | The Coordinator's limited adoption                                                          | C     |

### Sources that disagree

- Intercom resolved tickets: do not reopen on a customer reply (S44) versus reported to have started
  reopening on a thank-you (S45).
- Zulip resolve permission: `can_resolve_topics_group` today (S3) versus
  `can_move_messages_between_topics_group` before Zulip 10.0 (S2). These describe different versions
  and are compatible.
