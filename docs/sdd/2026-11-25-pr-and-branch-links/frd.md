# Pull request and branch links: Functional Requirements

- Status: Draft for the operator's acceptance. Four open choices are asked in Agention, each with
  the lead's recommendation, which these requirements assume until answered (see
  [Open choices](#open-choices)).
- Date: 2026-11-25
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim.
- Origin: the operator's direction in Agention, quoted under
  [The operator's direction](#the-operators-direction).

## Why this exists

Most of what agents bring the operator is about code moving through pull requests. Today a message
can say which pull request it is about only in its text, or in a generic reference (a label plus an
identifier, an https URL or a thread number, `packages/api/src/references.ts`). Neither is rolled up
for the thread, filtered or searched, so the operator cannot ask "which threads are about #135?",
and an agent cannot find the threads it should bring up to date when #135 merges.

## Who this is for

- **The operator**, who sees at a glance which pull requests and branches a thread is about, and
  narrows the thread list to one of them.
- **Agents**, which say which pull requests and branches a message concerns, and find their own
  threads about a pull request or branch when it moves, so those threads stay current.
- **Programs using the operator API**, which read and write the same lists.

## The operator's direction

Verbatim:

> Messages should be able to list any number of PRs and/or branches. These should optionally support
> full urls, which the skill should suggest wherever possible.
>
> And then, like files, these should be aggregated (and deduped) for the thread. As with files,
> these from replaced messages should be ignored in the thread-level rollup but still be present in
> the replaced message (which is always immutable).
>
> And then these should be exposed via user filters (one for PRs, one for branches). Agents should
> also have an easy way to filter by this, which they should be encouraged to do any time a PR moves
> significantly to help them keep things up to date.

And, following up:

> And visually, this should be shown but should be fairly compact (maybe folded if more than 1?).
> It's important info to be sure but it won't always be referenced. Treat it accordingly.

## Functional requirements

### On a message

**R1. Pull requests and branches on any message.** A message may list pull requests and branches,
alongside its text, references, files and asks, in any combination, including a message that carries
nothing else. Agents write them, and so do programs sending messages through the operator API. Each
list is bounded only to keep a message's size bounded, at a number no real message reaches (the HLA
sets it).

**R2. What identifies each.** A pull request is its GitHub repository and number; a branch is its
GitHub repository and name. A repository is `owner/name`. Two entries are the same pull request or
branch when these match, with the owner and name compared ignoring case, as GitHub compares them,
and the branch name compared exactly, as git does. Forges other than GitHub are not supported yet;
adding one later only adds an optional field.

**R3. A URL, whenever the agent has one.** Each entry may carry the full https URL of the pull
request or branch. It is optional, and the skill asks agents to give it whenever they have it. A URL
shows as a link only under the rule every Agention link follows (`isLinkableUrl`); anything else is
text.

**R4. Kept as written.** A message's lists are part of the message, immutable like the rest of it. A
replaced message keeps its own lists, which still show with it.

### On a thread

**R5. The thread's rollup.** A thread lists the pull requests and branches its live messages carry,
each once, however many messages name it. A message that was replaced does not count toward the
rollup; its replacement counts if it names the entry again. An entry shows as its latest live
mention wrote it, with the URL from the latest live mention that gave one.

### Seeing them

**R6. Compact on a message.** A message with one pull request or branch shows it on one short line
beneath its text: its short form (`owner/name#135`, or `owner/name:branch`), as a link when it has a
URL. With more than one, the line folds to a count ("2 pull requests, 1 branch") that unfolds to the
list.

**R7. On the thread.** The thread's head offers the rollup as a fold beside its files, hidden when
the thread has none. Thread list rows do not show them (assumed; [open choice 2](#open-choices)).

### Finding them

**R8. Two filters for the operator.** The thread list gains a pull request filter and a branch
filter, each taking several values like the topic filter, each with its counts and chip, and each
kept in the list's address so a link opens the list narrowed. The operator API's thread list takes
the same filters.

**R9. Filters for agents.** An agent can list its own session's threads about one pull request or
one branch with the tool it already uses to list threads, and reads a thread's rollup with the
thread. The skill tells agents to do this whenever a pull request moves significantly (opened, ready
for review, reviewed, merged or closed) and to bring each thread up to date: say what changed,
withdraw the asks the move settled, and archive what is done.

### Unchanged

**R10. The web composer does not write them** (assumed; [open choice 4](#open-choices)), as it does
not write references: pull requests and branches come from agents and the operator API. Nor does the
operator's start of a thread take them, as it takes no references.

**R11. Nothing is fetched.** Agention never calls a forge. Every entry is what its writer declared,
shown as inert data like references, and says nothing of the pull request's state.

## Out of scope

- A pull request's state (open, draft, merged, closed), which agents say in their text (assumed;
  [open choice 3](#open-choices)). A field for it can be added later without breaking anything; once
  added, it could never be removed.
- Forges other than GitHub (R2).
- Fetching anything from GitHub or any forge, or reacting to its webhooks.
- Commits, tags, issues and CI runs as kinds of their own; references still cover them.
- Changing generic references, which stay as they are.
- How a thread's files roll up. Today they include replaced messages' files, unlike these lists;
  making files match is its own change, asked separately.

## Definition of done

- R1 to R11 hold on `main`, each shown by tests at the level that proves it: store and HTTP tests
  for writing, reading, the rollup and the filters; the released-bridge compatibility suite for the
  agent tools; web tests and browser tests for the display and the filters.
- The architecture document, the operator guide, the API reference, the security model and review
  checklist's inert content, and the agent skill describe them, with no reference to this SDD.

## Open choices

Asked in Agention on 2026-11-25, each with the lead's recommendation, which these requirements
assume until answered:

1. Lists of their own on a message, or kinds of reference. Assumed: lists of their own (R1).
2. Pull requests and branches on thread list rows. Assumed: not on rows (R7).
3. A pull request state field. Assumed: not now (Out of scope).
4. The web composer writing them. Assumed: not now (R10).

## Operator rulings, 2026-11-25 onward

None yet.
